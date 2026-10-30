import type { EffectiveConfig, ModelConfig } from '../core/configTypes.ts'
import { brief, log } from '../core/log.ts'
import { truncate } from '../core/util.ts'
import type { ToolCall, ToolResult, ToolSpec } from '../llm/types.ts'
import type { FilePart, ImagePart } from '../llm/types.ts'
import { prepareRuntimeTools, runtimeToolReady } from '../core/setup.ts'

export interface TurnState {
  toolCalls?: number
  helperCalls?: Record<string, number>
  /** Command dispatched to another plugin this turn (ends the loop). */
  dispatched?: string
  commands: number
  searches: number
  fetches: number
  memoryWrites?: number
  execRuns?: number
  imageRequests?: number
  /** Video/audio/document bytes read_file added this reply. */
  fileBytes?: number
  /** Tool-produced or URL images, sent after the text reply. */
  images: Buffer[]
  memoryChanged?: boolean
  /** run_code / render_html workspace shared within this reply (deleted when the reply ends) */
  sandboxSession?: string
  afterReply?: (() => void)[]
  computerJob?: string
  agyJob?: string
  lensSearches?: number
  asyncResult?: { kind: 'agy'; id: string }
  /** Exact initiating model request options, kept in memory for asynchronous completion. */
  sessionConfig?: import('../chat/agent.ts').SessionRequestConfig
  /** Current/quoted image bytes already loaded for this turn; never persisted in the chat transcript. */
  inputImages?: ImagePart[]
  imageScope?: string
  imageRefs?: import('../chat/images.ts').SavedImage[]
  computerResult?: { id: string; images: Buffer[] }
  rolloutId?: string
  /** Background results that led to this turn; jobs started now are one level deeper. */
  chainDepth?: number
  /** Scheduled wake-ups that led to this turn (0 for a user message); tasks scheduled now are one deeper. */
  scheduleChain?: number
  /** Tasks the schedule tool created this turn. */
  scheduled?: number
}

export interface ToolCtx {
  e: any
  eff: EffectiveConfig
  isAdmin: boolean
  model: ModelConfig
  turn: TurnState
  signal?: AbortSignal
}

export interface ToolOutput {
  content: string
  isError?: boolean
  /** Stop the agent loop after this round (result already delivered by other means). */
  terminal?: boolean
  images?: ImagePart[]
  files?: FilePart[]
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, any>
  source?: 'builtin' | 'custom' | 'http'
  /** Local helper: excluded from the main call/round budgets. */
  budgetExempt?: boolean
  available?(ctx: ToolCtx): boolean
  /** per-reply cap, appended to the description sent to the model (e.g. "最多调用 3 次") */
  limit?(ctx: ToolCtx): string | undefined
  /** Current enforced allowance, read after every call in a parallel batch has settled. */
  remaining?(ctx: ToolCtx): string
  /** Overrides the default 60 s limit for tools that wait on a slow call (e.g. a model describing a video). */
  timeoutMs?: number
  run(args: Record<string, any>, ctx: ToolCtx): Promise<ToolOutput | string>
}

/** Maximum images explicitly attached to a reply. */
export const MAX_IMAGES_PER_TURN = 2
/**
 * Helper tools (budgetExempt) have their own per-reply limits and do not use up chat.maxToolCalls;
 * the rounds they run in still count toward chat.maxToolRounds.
 */
const DEFAULT_HELPER_LIMITS: Record<string, number> = { send_image: 2, read_file: 8, load_skill: 8, list_stickers: 4 }
export function helperToolLimit(ctx: Pick<ToolCtx, 'eff'>, name: string): number {
  const key = { send_image: 'sendImage', read_file: 'readFile', load_skill: 'loadSkill', list_stickers: 'listStickers' }[name]
  const tool = key ? ctx.eff.tools[key as 'sendImage' | 'readFile' | 'loadSkill' | 'listStickers'] : undefined
  return tool?.maxPerTurn ?? DEFAULT_HELPER_LIMITS[name] ?? 32
}
export function helperToolRemaining(ctx: ToolCtx, name: string): number {
  return Math.max(0, helperToolLimit(ctx, name) - (ctx.turn.helperCalls?.[name] ?? 0))
}
const MAX_RESULT_CHARS = 8000
const TOOL_TIMEOUT_MS = 60_000

const toolTimeout = Symbol('tool timeout')

/**
 * Why the tool's own gate (`available`) rejects this ctx. Admin-only tools say so to non-admins;
 * a tool without `available` never fails this check.
 */
export function toolAccessError(name: string, ctx: ToolCtx): (ToolOutput & { adminOnly?: true }) | undefined {
  const def = registry.get(name)
  if (!def?.available || def.available(ctx)) return
  if (!ctx.isAdmin && def.available({ ...ctx, isAdmin: true }))
    return { content: `权限不足：工具「${name}」仅限管理员使用。当前对话由普通用户触发，无法调用此工具，请告知用户该操作需要管理员权限。`, isError: true, adminOnly: true }
  return { content: `工具「${name}」当前未启用或不适用于本对话`, isError: true }
}

/** Why a tool cannot be called this turn; undefined when it can. */
export function toolUnavailable(name: string, ctx: ToolCtx): (ToolOutput & { adminOnly?: true }) | undefined {
  if (!registry.get(name)) return { content: `工具「${name}」不存在，请检查工具名称是否正确`, isError: true }
  if (!ctx.eff.tools.enable) return { content: '工具功能已被全局禁用', isError: true }
  if (ctx.eff.tools.disabled?.includes(name)) return { content: `工具「${name}」已被管理员在配置中禁用`, isError: true }
  const denied = toolAccessError(name, ctx)
  if (denied) return denied
  if (!runtimeToolReady(name, ctx.eff)) return { content: `工具「${name}」未启用或运行环境未就绪，暂时无法使用`, isError: true }
}

class Registry {
  private tools = new Map<string, ToolDef>()

  register(def: ToolDef) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) {
      log.warn(`工具名不合法，已忽略: ${def.name}`)
      return
    }
    this.tools.set(def.name, def)
  }

  unregisterWhere(pred: (d: ToolDef) => boolean) {
    for (const [k, d] of this.tools) if (pred(d)) this.tools.delete(k)
  }

  get(name: string) {
    return this.tools.get(name)
  }

  all(): ToolDef[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Tools offered this turn, in deterministic order (stable tool list = stable prompt cache). */
  forTurn(ctx: ToolCtx, hide: Set<string> = new Set()): ToolDef[] {
    if (!ctx.eff.tools.enable || ctx.eff.chat?.maxToolRounds === 0) return []
    const disabled = new Set(ctx.eff.tools.disabled ?? [])
    return this.all().filter(d => !disabled.has(d.name) && !hide.has(d.name) && (!d.budgetExempt || helperToolLimit(ctx, d.name) > 0) && (ctx.eff.chat?.maxToolCalls !== 0 || d.budgetExempt) && (d.available?.(ctx) ?? true) && runtimeToolReady(d.name, ctx.eff))
  }

  specs(defs: ToolDef[], ctx: ToolCtx): ToolSpec[] {
    return defs.map(d => {
      const limit = d.limit?.(ctx) ?? (d.budgetExempt ? `最多调用 ${helperToolLimit(ctx, d.name)} 次` : undefined)
      return { name: d.name, description: limit ? `${d.description}（每次回复${limit}）` : d.description, parameters: d.parameters }
    })
  }

  async execute(calls: ToolCall[], ctx: ToolCtx, offered: ToolDef[], onResult?: (result: ToolResult, ms: number) => void): Promise<{ results: (ToolResult & { remaining: string; globalRemaining: number })[]; terminal: boolean }> {
    await prepareRuntimeTools(ctx.eff, calls.map(call => call.name), ctx.isAdmin)
    const allowed = new Map(offered.map(d => [d.name, d]))
    let terminal = false
    const maxCalls = ctx.eff.chat?.maxToolCalls ?? 20
    const results = await Promise.all(
      calls.map(async (call): Promise<ToolResult> => {
        const started = Date.now()
        const done = (result: ToolResult) => {
          // Observability must never change a tool's result or interrupt parallel calls.
          try { onResult?.(result, Date.now() - started) } catch { /* best effort */ }
          return result
        }
        // Reserve synchronously before awaiting: parallel calls cannot overrun the global allowance.
        const def = allowed.get(call.name)
        const helper = this.tools.get(call.name)?.budgetExempt === true
        if (!helper && (ctx.turn.toolCalls ?? 0) >= maxCalls) return done({ id: call.id, name: call.name, content: '普通工具的全局调用次数已用完；仍可使用辅助工具，或直接给出最终回复', isError: true })
        if (helper && helperToolRemaining(ctx, call.name) === 0) return done({ id: call.id, name: call.name, content: '本次回复该工具调用次数已用完', isError: true })
        if (helper) {
          const counts = ctx.turn.helperCalls ??= {}
          counts[call.name] = (counts[call.name] ?? 0) + 1
        }
        else ctx.turn.toolCalls = (ctx.turn.toolCalls ?? 0) + 1
        if (!def || (def.available && !def.available(ctx)) || !runtimeToolReady(call.name, ctx.eff)) {
          log.warn(`模型调用了未提供的工具 ${call.name}(${brief(call.args ?? {})})`)
          const content = toolUnavailable(call.name, ctx)?.content ?? `工具「${call.name}」本轮未提供`
          return done({ id: call.id, name: call.name, content, isError: true })
        }
        if (call.args?._invalid_json)
          return done({ id: call.id, name: call.name, content: '参数不是合法 JSON 格式，请检查参数语法后重试', isError: true })
        try {
          const out = await Promise.race([
            def.run(call.args ?? {}, ctx),
            new Promise<never>((_, rej) => setTimeout(() => rej(toolTimeout), def.timeoutMs ?? TOOL_TIMEOUT_MS).unref?.()),
          ])
          const o: ToolOutput = typeof out === 'string' ? { content: out } : out
          if (o.terminal) terminal = true
          log.info(`工具 ${call.name}(${brief(call.args ?? {})}) ${o.isError ? '失败' : '完成'} ${Date.now() - started}ms → ${(o.content ?? '').length}字`)
          log.debug(`工具 ${call.name} 结果：${brief(o.content, 600)}`)
          return done({ id: call.id, name: call.name, content: truncate(o.content || '(无结果)', MAX_RESULT_CHARS), isError: o.isError,
            ...(o.images?.length ? { images: o.images } : {}), ...(o.files?.length ? { files: o.files } : {}) })
        } catch (err: any) {
          const rawMsg = err === toolTimeout ? '工具执行超时' : err?.message ?? String(err)
          log.warn(`工具 ${call.name}(${brief(call.args ?? {})}) 出错: ${rawMsg}`)
          const content = err === toolTimeout ? `工具「${call.name}」执行超时（超过 ${(def.timeoutMs ?? TOOL_TIMEOUT_MS) / 1000} 秒未响应）`
            : /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(rawMsg) ? `工具「${call.name}」网络请求失败：无法连接到目标服务（${rawMsg}）`
            : `执行出错: ${rawMsg}`
          return done({ id: call.id, name: call.name, content, isError: true })
        }
      }),
    )
    return { results: results.map(result => {
      const def = allowed.get(result.name) ?? (this.tools.get(result.name)?.budgetExempt ? this.tools.get(result.name) : undefined)
      return { ...result, remaining: !def ? '不可用' : def.budgetExempt ? `剩余 ${helperToolRemaining(ctx, def.name)} 次${def.remaining ? '；' + def.remaining(ctx) : ''}` : def.remaining?.(ctx) ?? (def.limit ? '剩余次数未提供' : '无单独次数上限'), globalRemaining: Math.max(0, maxCalls - (ctx.turn.toolCalls ?? 0)) }
    }), terminal }
  }
}

export const registry = new Registry()
