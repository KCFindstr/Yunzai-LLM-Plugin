import { checkQuota, record, type QuotaBlock, type QuotaCtx } from '../billing/ledger.ts'
import { computeCost, resolvePrice } from '../billing/pricing.ts'
import { config } from '../core/config.ts'
import type { EffectiveConfig, ThinkingLevel } from '../core/configTypes.ts'
import { brief, log } from '../core/log.ts'
import { Semaphore, sha1 } from '../core/util.ts'
import { botNickname } from '../core/yunzai.ts'
import { addUsage, chat, emptyUsage, LLMError, partsToText, usesServerState, type Msg, type ServerState, type UserMsg } from '../llm/index.ts'
import { registry, type ToolCtx, type TurnState } from '../tools/registry.ts'
import type { ExtractedInput } from './message.ts'
import { resolveThinking } from './thinking.ts'
import { markHandled } from './groupLog.ts'
import { markdownEnabled } from './format.ts'
import { buildHeader, buildMemoryBlock, buildSystemPrompt, SUMMARY_PROMPT } from './prompt.ts'
import { maybeCompact } from '../memory/compact.ts'
import { memoryHash } from '../memory/store.ts'
import { appendTurn, getSession, peekSession, setServerState, setSummary, truncateIfNeeded } from './session.ts'
import { pickModel, utilityCandidates, utilityChat, type Picked } from './utility.ts'

const NATIVE_SEARCH_TYPES = new Set(['anthropic', 'openai-responses', 'gemini'])
const semaphore = new Semaphore(3)

type Feature = 'nativeSearch' | 'thinking' | 'tools'
/** Features a model's endpoint rejected (HTTP 400), dropped for the rest of the process lifetime. */
const degraded = new Map<string, Set<Feature>>()

export function degradedFeatures(modelId: string): Feature[] {
  return [...(degraded.get(modelId) ?? [])]
}

/** Pick which optional feature to drop after a 400, or undefined if the error isn't about one. */
function featureToDrop(err: any, on: Record<Feature, boolean>): Feature | undefined {
  if (!(err instanceof LLMError) || ![400, 422].includes(err.status ?? 0)) return undefined
  const msg = `${err.message} ${err.body ?? ''}`.toLowerCase()
  if (on.nativeSearch && /search|grounding|server tool|tool type|web_search|google_search|url_context|combin/.test(msg)) return 'nativeSearch'
  if (on.thinking && /reason|thinking|effort|output_config/.test(msg)) return 'thinking'
  // generic tool complaint: the built-in search tool is the more exotic suspect, drop it first
  if (/tool|function/.test(msg)) return on.nativeSearch ? 'nativeSearch' : on.tools ? 'tools' : undefined
  return undefined
}

export interface TurnRequest {
  e: any
  eff: EffectiveConfig
  input: ExtractedInput
  isAdmin: boolean
  convKey: string
}

export type TurnOutcome =
  | { kind: 'reply'; text: string; modelId: string; cost: number; dispatched?: string; images: Buffer[]; thinking: ThinkingLevel }
  | { kind: 'quota'; block: QuotaBlock; modelId: string }
  | { kind: 'error'; message: string; unconfigured?: boolean }

function selectModel(eff: EffectiveConfig, ctx: QuotaCtx): { picked?: Picked; block?: { block: QuotaBlock; modelId: string } } {
  const ids = [...new Set([eff.model, ...config.get().fallbackModels].filter(Boolean))]
  let first: { block: QuotaBlock; modelId: string } | undefined
  for (const id of ids) {
    const p = pickModel([id])
    if (!p) continue
    const block = checkQuota(p.model, ctx)
    if (!block) return { picked: p }
    first ??= { block, modelId: p.model.id }
  }
  return { block: first }
}

export async function runTurn(req: TurnRequest): Promise<TurnOutcome> {
  semaphore.max = Math.max(1, req.eff.reply.concurrency || 3)
  return semaphore.run(() => runTurnInner(req))
}

async function runTurnInner(req: TurnRequest): Promise<TurnOutcome> {
  const { e, eff, input, isAdmin, convKey } = req
  const quotaCtx: QuotaCtx = { userId: e.user_id, groupId: e.group_id, isAdmin }
  const { picked, block } = selectModel(eff, quotaCtx)
  if (!picked) {
    if (block) return { kind: 'quota', ...block }
    return { kind: 'error', unconfigured: true, message: '没有可用的模型，请检查模型与 API Key 配置（#llm模型列表 / #llm设置密钥）' }
  }
  const { model, provider } = picked
  const price = resolvePrice(model)
  const dropped = degraded.get(model.id) ?? new Set<Feature>()
  let thinking: ThinkingLevel = dropped.has('thinking')
    ? 'off'
    : await resolveThinking(
        model.thinking ?? eff.chat.thinking,
        eff.chat,
        { text: input.text, images: input.images.length, quoted: Boolean(input.quoted), quotedText: input.quoted?.text },
        quotaCtx,
      )
  const temperature = model.temperature ?? eff.chat.temperature
  const maxTokens = model.maxTokens ?? eff.chat.maxOutputTokens

  const turn: TurnState = { commands: 0, searches: 0, fetches: 0, images: [] }
  const ctx: ToolCtx = { e, eff, isAdmin, model, turn }
  let nativeSearch =
    !dropped.has('nativeSearch') &&
    eff.tools.enable &&
    eff.tools.webSearch.enable &&
    eff.tools.webSearch.provider === 'native' &&
    NATIVE_SEARCH_TYPES.has(provider.type) &&
    model.nativeSearch !== false
  let offered = model.toolUse === false || dropped.has('tools') ? [] : registry.forTurn(ctx)
  let specs = registry.specs(offered)

  const botName = config.get().persona.botName || botNickname(e)
  const markdown = markdownEnabled(e, eff.reply)
  const makeSystem = () =>
    buildSystemPrompt({ isGroup: Boolean(e.group_id), botName, eff, tools: offered.map(t => t.name), nativeSearch, markdown })
  let system = makeSystem()
  const session = getSession(convKey, eff.chat.sessionTimeout)
  const text = input.text || (input.images.length ? '（发了图片）' : '（只@了你，没说话）')

  // Long-term memory: a stable prefix message (cache-friendly; only changes when memory changes). In a shared
  // group session the speaker varies, so their personal memory rides in this turn's header instead.
  const memOn = config.get().memory.enable
  const shared = Boolean(e.group_id) && eff.chat.sessionScope === 'group'
  const memPrefix = memOn ? buildMemoryBlock(e, { user: !shared, group: true }) : ''
  const memTurn = memOn && shared ? buildMemoryBlock(e, { user: true, group: false }) : ''
  const header = buildHeader(e, eff, input, isAdmin, { conv: convKey, memory: memTurn })
  // from now on this message lives in the session history; keep it out of future ambient-chat windows
  markHandled(e, convKey)

  const userMsg: UserMsg = { role: 'user', content: [{ type: 'text', text: header.sent + text }, ...input.images] }
  const storedUser: UserMsg = {
    role: 'user',
    content: [{ type: 'text', text: header.stored + text + (input.images.length ? ' [图片]'.repeat(input.images.length) : '') }],
  }

  const prefix: Msg[] = []
  if (memPrefix) prefix.push({ role: 'user', content: [{ type: 'text', text: memPrefix }] })
  if (session.summary) prefix.push({ role: 'user', content: [{ type: 'text', text: `【之前对话的摘要】\n${session.summary}` }] })
  const msgs: Msg[] = [...prefix, ...session.messages, userMsg]
  // memory is part of the prefix, so a server-side chain built on older memory must not be reused
  const stateKey = `${provider.type}:${model.model}:${memoryHash([memPrefix])}`
  const serverState = usesServerState(provider)
  let state: ServerState | undefined
  if (serverState && session.state?.key === stateKey && session.state.len === session.messages.length)
    state = { previousId: session.state.previousId, skip: prefix.length + session.messages.length }
  const cacheKey = `yzllm-${sha1(`${system}|${convKey}`).slice(0, 16)}`

  let usage = emptyUsage()
  let cost = 0
  let finalText = ''
  let cleanEnd = false
  let lastResponseId: string | undefined
  const maxRounds = Math.max(1, eff.chat.maxToolRounds + 1)
  const started = Date.now()

  let retriedStateless = false
  const call = async () => {
    for (;;) {
      try {
        return await chat({ model, provider, system, messages: msgs, tools: specs, nativeSearch, thinking, maxTokens, temperature, cacheKey, state })
      } catch (err) {
        // server-side chain expired/unknown: resend the full transcript once
        if (state && !retriedStateless && err instanceof LLMError && [400, 404].includes(err.status ?? 0)) {
          retriedStateless = true
          state = undefined
          log.warn(`服务端会话状态失效，改为发送完整上下文重试: ${err.message.slice(0, 100)}`)
          continue
        }
        // only before any tool round, so the transcript never references a tool we stop offering
        const drop = msgs.length === prefix.length + session.messages.length + 1 ? featureToDrop(err, { nativeSearch, thinking: thinking !== 'off', tools: specs.length > 0 }) : undefined
        if (!drop) throw err
        if (!degraded.has(model.id)) degraded.set(model.id, new Set())
        degraded.get(model.id)!.add(drop)
        log.warn(`模型 ${model.id} 的接口不支持 ${drop}，已自动关闭该功能后重试（${(err as Error).message.slice(0, 120)}）`)
        if (drop === 'nativeSearch') nativeSearch = false
        if (drop === 'thinking') thinking = 'off'
        if (drop === 'tools') {
          offered = []
          specs = []
        }
        system = makeSystem()
      }
    }
  }

  try {
    for (let round = 0; round < maxRounds; round++) {
      const res = await call()
      const c = computeCost(res.usage, price)
      cost += c
      usage = addUsage(usage, res.usage)
      record(model, quotaCtx, c, res.usage)
      msgs.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls, native: res.native, responseId: res.responseId })
      lastResponseId = res.responseId
      state = res.responseId && serverState ? { previousId: res.responseId, skip: msgs.length } : undefined

      if (res.pause) continue
      if (!res.toolCalls.length) {
        finalText = res.text
        cleanEnd = true
        if (res.stopReason === 'refusal' && !finalText) finalText = '这个我不太方便回答呢'
        break
      }
      finalText = res.text
      if (res.text) log.debug(`[${model.id}] 第${round + 1}轮附带文字：${brief(res.text, 300)}`)
      if (round >= maxRounds - 1) break
      const { results, terminal } = await registry.execute(res.toolCalls, ctx, offered)
      if (round === maxRounds - 2)
        for (const r of results) r.content += '\n（工具调用次数已用完，请直接给出最终回复）'
      msgs.push({ role: 'tool', results })
      if (terminal) break
      if (checkQuota(model, quotaCtx)) break
    }
  } catch (err: any) {
    log.error(`LLM 调用失败 [${model.id}]: ${err?.message ?? err}`)
    if (!finalText && !turn.dispatched) return { kind: 'error', message: err?.message ?? String(err) }
  }

  log.info(
    `[${model.id}] ${Date.now() - started}ms think=${thinking} in=${usage.input} cache=${usage.cacheRead}/${usage.cacheWrite + usage.cacheWrite1h} out=${usage.output}${usage.reasoning ? `(思考${usage.reasoning})` : ''}${usage.webSearches ? ` 自带搜索${usage.webSearches}次` : ''} $${cost.toFixed(5)}${turn.dispatched ? ` cmd=${turn.dispatched}` : ''}`,
  )
  if (finalText) log.debug(`[${model.id}] 回复：${brief(finalText, 500)}`)

  if (turn.memoryChanged) {
    const mctx = { userId: e.user_id, groupId: e.group_id }
    maybeCompact('user', String(e.user_id), mctx).catch(() => {})
    if (e.group_id) maybeCompact('group', String(e.group_id), mctx).catch(() => {})
  }

  const notes = [
    turn.dispatched && `（已为对方执行指令 ${turn.dispatched}）`,
    turn.images.length && `（已发送 ${turn.images.length} 张渲染图片）`,
  ].filter(Boolean)
  const persisted = [finalText, ...notes].filter(Boolean).join('\n') || '…'
  appendTurn(convKey, storedUser, { role: 'assistant', content: persisted })
  const after = peekSession(convKey)
  // A chain that ended with unanswered tool calls can't be continued with a new user turn.
  setServerState(
    convKey,
    serverState && cleanEnd && lastResponseId && after ? { key: stateKey, previousId: lastResponseId, len: after.messages.length } : undefined,
  )
  return { kind: 'reply', text: finalText, modelId: model.id, cost, dispatched: turn.dispatched, images: turn.images, thinking }
}

/** Post-turn housekeeping: chunked truncation, optional summary of the dropped part. Never blocks the reply. */
export async function compactSession(convKey: string, eff: EffectiveConfig, ctx: QuotaCtx) {
  const dropped = truncateIfNeeded(convKey, eff.chat)
  if (!dropped.length || !eff.chat.summarize) return
  try {
    const prev = peekSession(convKey)?.summary
    const transcript = dropped
      .map(m => (m.role === 'user' ? `对方: ${partsToText(m.content)}` : m.role === 'assistant' ? `你: ${m.content}` : ''))
      .filter(Boolean)
      .join('\n')
    const { text } = await utilityChat({
      candidates: utilityCandidates(),
      system: SUMMARY_PROMPT,
      user: [{ type: 'text', text: `${prev ? `已有摘要：${prev}\n\n` : ''}新的聊天记录：\n${transcript}` }],
      maxTokens: 500,
      quotaCtx: ctx,
    })
    if (text.trim()) setSummary(convKey, text.trim().slice(0, 800))
  } catch (err: any) {
    log.warn(`生成对话摘要失败: ${err?.message ?? err}`)
  }
}
