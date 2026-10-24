import { checkQuota, record, type QuotaBlock, type QuotaCtx } from '../billing/ledger.ts'
import { computeCost, resolvePrice } from '../billing/pricing.ts'
import { config } from '../core/config.ts'
import { prepareRuntimeTools } from '../core/setup.ts'
import { ensureCatalog } from '../commands/catalog.ts'
import type { EffectiveConfig, ThinkingLevel } from '../core/configTypes.ts'
import { brief, log } from '../core/log.ts'
import { Semaphore, sha1 } from '../core/util.ts'
import { botNickname, senderName } from '../core/yunzai.ts'
import { addUsage, chat, emptyUsage, LLMError, partsToText, usesServerState, type Msg, type ServerState, type UserMsg } from '../llm/index.ts'
import { cleanupSandbox } from '../tools/exec.ts'
import { registry, type ToolCtx, type TurnState } from '../tools/registry.ts'
import type { ExtractedInput } from './message.ts'
import { resolveThinkingDecision, type ThinkingDecision } from './thinking.ts'
import { markHandled } from './groupLog.ts'
import { markdownEnabled } from './format.ts'
import { buildHeader, buildMemoryBlock, buildSystemPrompt, SUMMARY_PROMPT } from './prompt.ts'
import { maybeCompact } from '../memory/compact.ts'
import { memoryHash } from '../memory/store.ts'
import { appendTurn, getSession, peekSession, indexArchive, pendingArchive, recallSession, setEpisode, setServerState, setSummary, truncateIfNeeded } from './session.ts'
import { pickModel, utilityCandidates, utilityChat, type Picked } from './utility.ts'
import { recordTurn } from './turnLog.ts'
import { recordRolloutContext, recordRolloutEvent, recordRolloutImages, startRollout, updateRollout } from './rollouts.ts'
import { agyHistoryText } from '../agy/history.ts'
import { localDay, parseDateHints } from './dates.ts'
import { maintainArchive } from './archiveJobs.ts'
import { recallSources } from '../memory/tool.ts'

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
  modelId?: string
  computerResult?: { id: string; images: Buffer[] }
  asyncResult?: { kind: 'agy'; id: string }
}

export type TurnOutcome = (
  | { kind: 'reply'; text: string; modelId: string; cost: number; dispatched?: string; images: Buffer[]; thinking: ThinkingLevel }
  | { kind: 'quota'; block: QuotaBlock; modelId: string }
  | { kind: 'error'; message: string; unconfigured?: boolean }
) & { afterReply?: (() => void)[] }

function selectModel(eff: EffectiveConfig, ctx: QuotaCtx, exact?: string): { picked?: Picked; block?: { block: QuotaBlock; modelId: string } } {
  const ids = exact ? [exact] : [...new Set([eff.model, ...config.get().fallbackModels].filter(Boolean))]
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
  const rolloutId = startRollout({ conv: req.convKey, input: req.input.text || (req.input.images.length ? '（发了图片）' : '（只@了你，没说话）'),
    inputImageCount: req.input.images.length, source: req.asyncResult?.kind ?? (req.computerResult ? 'computer' : 'chat'),
    jobId: req.asyncResult?.id ?? req.computerResult?.id })
  const ref: { turn?: TurnState; rolloutId: string } = { rolloutId }
  try {
    const result = await semaphore.run(() => {
      updateRollout(rolloutId, { status: 'running' })
      return runTurnInner(req, ref)
    })
    if (result.kind === 'reply') {
      const text = result.text || (result.dispatched ? `（执行指令 ${result.dispatched}）` : '（无文字回复）')
      recordRolloutEvent(rolloutId, { kind: 'reply', text })
      updateRollout(rolloutId, { status: 'completed', reply: text })
    } else {
      recordRolloutEvent(rolloutId, { kind: 'error', text: result.kind === 'quota' ? '额度已用完，未调用模型' : result.message, isError: true })
      updateRollout(rolloutId, { status: result.kind === 'quota' ? 'blocked' : 'failed', ...(result.kind === 'quota' ? { model: result.modelId } : {}) })
    }
    return { ...result, afterReply: ref.turn?.afterReply }
  } catch (error: any) {
    recordRolloutEvent(rolloutId, { kind: 'error', text: error?.message ?? String(error), isError: true })
    updateRollout(rolloutId, { status: 'failed' })
    throw error
  } finally {
    // run_code / render_html workspace lives only for this reply
    if (ref.turn?.sandboxSession) cleanupSandbox(req.eff.tools.exec, ref.turn.sandboxSession)
  }
}

async function runTurnInner(req: TurnRequest, ref: { turn?: TurnState; rolloutId: string }): Promise<TurnOutcome> {
  const { e, eff, input, isAdmin, convKey } = req
  const quotaCtx: QuotaCtx = { userId: e.user_id, groupId: e.group_id, isAdmin }
  const { picked, block } = selectModel(eff, quotaCtx, req.modelId)
  if (!picked) {
    if (block) return { kind: 'quota', ...block }
    return { kind: 'error', unconfigured: true, message: '没有可用的模型，请检查模型与 API Key 配置（#llm模型列表 / #llm设置密钥）' }
  }
  const { model, provider } = picked
  updateRollout(ref.rolloutId, { model: model.id })
  const price = resolvePrice(model)
  const dropped = degraded.get(model.id) ?? new Set<Feature>()
  const thinkingSetting = model.thinking ?? eff.chat.thinking
  if (thinkingSetting === 'auto' && !dropped.has('thinking')) recordRolloutEvent(ref.rolloutId, { kind: 'progress', text: '正在判断思考强度' })
  const decision: ThinkingDecision = dropped.has('thinking')
    ? { setting: thinkingSetting, level: 'off', source: 'unsupported', ms: 0 }
    : await resolveThinkingDecision(
        thinkingSetting,
        eff.chat,
        { text: input.text.replaceAll('[at:you]', '').trim(), images: input.images.length, quoted: Boolean(input.quoted), quotedText: input.quoted?.text },
        quotaCtx,
      )
  let thinking = decision.level
  updateRollout(ref.rolloutId, { thinking, thinkingDecision: decision })
  recordRolloutEvent(ref.rolloutId, { kind: 'thinking', thinking,
    text: decision.source === 'unsupported' ? '接口不支持思考强度设置' : thinkingSetting === 'auto' ? '自动思考强度已确定' : '使用配置的思考强度' })
  const temperature = model.temperature ?? eff.chat.temperature
  const maxTokens = model.maxTokens ?? eff.chat.maxOutputTokens

  const turn: TurnState = { commands: 0, searches: 0, fetches: 0, images: [] }
  if (!req.computerResult && !req.asyncResult) turn.inputImages = input.images
  turn.asyncResult = req.asyncResult
  turn.computerResult = req.computerResult
  turn.computerJob = req.computerResult?.id
  ref.turn = turn
  const ctx: ToolCtx = { e, eff, isAdmin, model, turn }
  let nativeSearch =
    !dropped.has('nativeSearch') &&
    eff.tools.enable &&
    eff.tools.webSearch.enable &&
    eff.tools.webSearch.provider === 'native' &&
    NATIVE_SEARCH_TYPES.has(provider.type) &&
    model.nativeSearch !== false
  if (model.toolUse !== false && !dropped.has('tools') && !turn.asyncResult) await prepareRuntimeTools(eff, undefined, isAdmin)
  let offered = model.toolUse === false || dropped.has('tools') ? [] : registry.forTurn(ctx)
  let specs = registry.specs(offered, ctx)
  if (offered.some(tool => tool.name === 'run_bot_command')) await ensureCatalog()

  const botName = config.get().persona.botName || botNickname(e)
  const markdown = markdownEnabled(e, eff.reply)
  const makeSystem = () =>
    buildSystemPrompt({ isGroup: Boolean(e.group_id), botName, eff, tools: offered.map(t => t.name), nativeSearch, markdown })
  let system = makeSystem()
  const session = getSession(convKey, eff.chat.sessionTimeout)
  // Apply lowered limits and recover from skipped post-reply housekeeping before building a request.
  truncateIfNeeded(convKey, eff.chat)
  const text = input.text || (input.images.length ? '（发了图片）' : '（只@了你，没说话）')

  // Long-term memory: a stable prefix message (cache-friendly; only changes when memory changes). In a shared
  // group session the speaker varies, so their personal memory rides in this turn's header instead.
  const memOn = config.get().memory.enable
  const shared = Boolean(e.group_id) && eff.chat.sessionScope === 'group'
  const nudge = offered.some(t => t.name === 'memory')
  const memPrefix = memOn ? buildMemoryBlock(e, { user: !shared, group: true, nudge }) : ''
  const memTurn = memOn && shared ? buildMemoryBlock(e, { user: true, group: false, nudge }) : ''
  // bounded so a slow embedding API can't hold up the reply; recallSession falls back to keyword matching
  // a date in the message ("昨天…", "上周六…") narrows recall to those days; today's chat is already in context
  const range = parseDateHints(input.text)
  const dated = range && !(range.from === localDay() && range.to === localDay()) ? range : undefined
  const recalled = (await recallSession(convKey, input.text, dated ? 3 : 2, {
    automatic: true,
    range: dated,
    extra: recallSources(e, eff.chat.sessionScope),
    signal: AbortSignal.timeout(2500),
  })).map(text => text.slice(0, dated ? 500 : 350))
  const context = [memTurn, recalled.length ? `【相关旧聊天·参考】\n${recalled.join('\n')}` : ''].filter(Boolean).join('\n')
  const header = buildHeader(e, eff, input, isAdmin, { conv: convKey, memory: context })
  // Mark for background archiving; the ordered group window still includes overlapping exchanges.
  if (!req.computerResult && !req.asyncResult) markHandled(e, convKey)

  const userMsg: UserMsg = { role: 'user', content: [{ type: 'text', text: header.sent + text }, ...input.images] }
  const storedUser: UserMsg = {
    role: 'user',
    content: [{ type: 'text', text: header.stored + text + (input.images.length ? ' [图片]'.repeat(input.images.length) : '') }],
  }

  const prefix: Msg[] = []
  const messageSources: ('memory' | 'summary' | 'history' | 'current')[] = []
  if (memPrefix) { prefix.push({ role: 'user', content: [{ type: 'text', text: memPrefix }] }); messageSources.push('memory') }
  if (session.summary) { prefix.push({ role: 'user', content: [{ type: 'text', text: `【之前对话的摘要】\n${session.summary}` }] }); messageSources.push('summary') }
  const msgs: Msg[] = [...prefix, ...session.messages, userMsg]
  messageSources.push(...session.messages.map(() => 'history' as const), 'current')
  // memory is part of the prefix, so a server-side chain built on older memory must not be reused
  // Gemini system instructions/tools are interaction-scoped: resend them without discarding history.
  // Prefix memory is part of stored history and must still match. Bind ids to their provider/endpoint too.
  const statePrefix = provider.type === 'gemini' ? [memPrefix] : [memPrefix, system, JSON.stringify(specs)]
  const stateKey = `${model.provider}:${provider.type}:${provider.baseUrl ?? ''}:${model.model}:${memoryHash(statePrefix)}`
  const serverState = usesServerState(provider, model)
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
        if (msgs.length === prefix.length + session.messages.length + 1)
          recordRolloutContext(ref.rolloutId, { system, tools: specs, messages: msgs, nativeSearch, messageSources, current: { ...header.context, text },
            history: { turns: session.messages.length / 2, messages: session.messages.length, maxTurns: eff.chat.historyMaxTurns } })
        return await chat({ model, provider, system, messages: msgs, tools: specs, nativeSearch, thinking, maxTokens, temperature, cacheKey, state })
      } catch (err) {
        // server-side chain expired/unknown: resend the full transcript once
        if (state && !retriedStateless && err instanceof LLMError && [400, 404].includes(err.status ?? 0)) {
          retriedStateless = true
          state = undefined
          recordRolloutEvent(ref.rolloutId, { kind: 'progress', text: '服务端会话状态失效，使用完整上下文重试' })
          log.warn(`服务端会话状态失效，改为发送完整上下文重试: ${err.message.slice(0, 100)}`)
          continue
        }
        // only before any tool round, so the transcript never references a tool we stop offering
        const drop = msgs.length === prefix.length + session.messages.length + 1 ? featureToDrop(err, { nativeSearch, thinking: thinking !== 'off', tools: specs.length > 0 }) : undefined
        if (!drop) throw err
        if (!degraded.has(model.id)) degraded.set(model.id, new Set())
        degraded.get(model.id)!.add(drop)
        recordRolloutEvent(ref.rolloutId, { kind: 'progress', text: `接口不支持 ${drop}，关闭该功能后重试` })
        log.warn(`模型 ${model.id} 的接口不支持 ${drop}，已自动关闭该功能后重试（${(err as Error).message.slice(0, 120)}）`)
        if (drop === 'nativeSearch') nativeSearch = false
        if (drop === 'thinking') {
          thinking = 'off'
          updateRollout(ref.rolloutId, { thinking })
        }
        if (drop === 'tools') {
          offered = []
          specs = []
        }
        system = makeSystem()
      }
    }
  }

  const turnInfo = () => ({
    rolloutId: ref.rolloutId,
    at: started, conv: convKey, userId: e.user_id != null ? String(e.user_id) : undefined, userName: senderName(e),
    groupId: e.group_id != null ? String(e.group_id) : undefined, model: model.id, input: text, cost, ms: Date.now() - started,
    tools: msgs.flatMap(m => (m.role === 'assistant' ? (m.toolCalls ?? []).map(call => call.name) : [])),
    tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, ...(usage.inputIncomplete ? { inputIncomplete: true } : {}) },
  })
  try {
    for (let round = 0; round < maxRounds; round++) {
      const step = round + 1, callStarted = Date.now()
      recordRolloutEvent(ref.rolloutId, { kind: 'progress', text: '等待模型响应', step })
      const res = await call()
      const c = computeCost(res.usage, price)
      cost += c
      usage = addUsage(usage, res.usage)
      record(model, quotaCtx, c, res.usage)
      updateRollout(ref.rolloutId, { steps: step, cost, tokens: turnInfo().tokens })
      recordRolloutEvent(ref.rolloutId, { kind: 'response', text: res.text || (res.toolCalls.length ? '模型请求调用工具' : res.pause ? '模型请求继续处理' : '（无可见文字）'),
        step, thinking, reasoning: res.reasoning, reasoningTokens: res.usage.reasoning,
        ms: Date.now() - callStarted, inputTokens: res.usage.input, outputTokens: res.usage.output })
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
      for (const call of res.toolCalls) recordRolloutEvent(ref.rolloutId, { kind: 'tool', text: round >= maxRounds - 1 ? '已达到工具轮数上限，未执行' : '正在执行',
        step, tool: call.name, callId: call.id, args: agyHistoryText(call.args), phase: round >= maxRounds - 1 ? 'skipped' : 'running' })
      if (round >= maxRounds - 1) break
      const { results, terminal } = await registry.execute(res.toolCalls, ctx, offered, (result, ms) => {
        const images = recordRolloutImages(ref.rolloutId, result.images)
        recordRolloutEvent(ref.rolloutId, { kind: 'tool', text: result.content, step, tool: result.name,
          callId: result.id, phase: 'completed', ms, isError: result.isError, images,
          omittedImages: (result.images?.length ?? 0) - images.length })
      })
      const roundsLeft = Math.max(0, maxRounds - round - 2)
      for (const result of results) result.content += `\n【工具余量】${result.name}：${result.remaining}；全局剩余 ${result.globalRemaining} 次；剩余工具轮次 ${roundsLeft}${roundsLeft && result.globalRemaining ? '。' : '，请直接给出最终回复。'}`
      msgs.push({ role: 'tool', results })
      if (terminal) break
      if (checkQuota(model, quotaCtx)) break
    }
  } catch (err: any) {
    log.error(`LLM 调用失败 [${model.id}]: ${err?.message ?? err}`)
    if (!finalText && !turn.dispatched) {
      recordTurn({ ...turnInfo(), reply: '', error: err?.message ?? String(err) })
      return { kind: 'error', message: err?.message ?? String(err) }
    }
    recordRolloutEvent(ref.rolloutId, { kind: 'error', text: err?.message ?? String(err), isError: true })
  }

  log.info(
    `[${model.id}] ${Date.now() - started}ms think=${thinking} in=${usage.input} cache=${usage.cacheRead}/${usage.cacheWrite + usage.cacheWrite1h} out=${usage.output}${usage.reasoning ? `(思考${usage.reasoning})` : ''}${usage.webSearches ? ` 自带搜索${usage.webSearches}次` : ''} $${cost.toFixed(5)}${usage.inputIncomplete ? ' (上游历史用量可能缺失)' : ''}${turn.dispatched ? ` cmd=${turn.dispatched}` : ''}`,
  )
  if (finalText) log.debug(`[${model.id}] 回复：${brief(finalText, 500)}`)
  recordTurn({ ...turnInfo(), reply: finalText || (turn.dispatched ? `（执行指令 ${turn.dispatched}）` : '') })

  if (turn.memoryChanged) {
    const mctx = { userId: e.user_id, groupId: e.group_id }
    maybeCompact('user', String(e.user_id), mctx).catch(() => {})
    if (e.group_id) maybeCompact('group', String(e.group_id), mctx).catch(() => {})
  }

  const notes = [
    turn.dispatched && `（已为对方执行指令 ${turn.dispatched}）`,
    turn.images.length && `（已发送 ${turn.images.length} 张图片）`,
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

/**
 * Post-turn housekeeping: chunked truncation, then one utility call that both summarizes the not-yet-summarized
 * archive chunks into a recall episode and folds them into the rolling summary. Never blocks the reply.
 */
export async function compactSession(convKey: string, eff: EffectiveConfig, ctx: QuotaCtx) {
  const session = peekSession(convKey)
  const prev = session?.summary
  const dropped = truncateIfNeeded(convKey, eff.chat)
  if (!eff.chat.summarize) return
  if (dropped.length) {
    const transcript = dropped
      .map(m => (m.role === 'user' ? `对方: ${partsToText(m.content)}` : m.role === 'assistant' ? `你: ${m.content}` : ''))
      .filter(Boolean).join('\n')
    setSummary(convKey, [prev, transcript].filter(Boolean).join('\n').slice(-800))
  }
  // includes chunks archived at idle expiry, which had no chance to be summarized then
  const pending = pendingArchive(convKey).slice(-3)
  if (pending.length) await summarizePending(convKey, session, prev, pending, ctx)
  // chatter summaries and daily digests for this conversation (also done every few minutes in the background)
  await maintainArchive(convKey, ctx)
}

async function summarizePending(convKey: string, session: ReturnType<typeof peekSession>, prev: string | undefined, pending: ReturnType<typeof pendingArchive>, ctx: QuotaCtx) {
  try {
    const { text } = await utilityChat({
      candidates: utilityCandidates(),
      system: SUMMARY_PROMPT,
      user: [{ type: 'text', text: `${prev ? `已有摘要：${prev}\n\n` : ''}新的聊天记录：\n${pending.map(entry => entry.text).join('\n')}` }],
      maxTokens: 700,
      quotaCtx: ctx,
    })
    if (peekSession(convKey) !== session) return
    const parsed = parseSummary(text)
    if (parsed.summary) setSummary(convKey, parsed.summary.slice(0, 800))
    // an unparseable reply still settles the chunks (kept raw) so they aren't re-merged into the summary every turn
    setEpisode(convKey, pending, parsed.episode?.slice(0, 400))
    // embed the new episode now, off the reply path, so the next recall needn't
    await indexArchive(convKey).catch(err => log.warn(`旧聊天向量索引失败: ${err?.message ?? err}`))
  } catch (err: any) {
    log.warn(`生成对话摘要失败: ${err?.message ?? err}`)
  }
}

export function parseSummary(text: string): { episode?: string; summary?: string } {
  const m = text.match(/片段[:：]\s*([\s\S]*?)\n\s*摘要[:：]\s*([\s\S]*)/)
  if (m) return { episode: m[1].trim() || undefined, summary: m[2].trim() || undefined }
  // model ignored the format: still usable as a rolling summary
  return { summary: text.trim() || undefined }
}
