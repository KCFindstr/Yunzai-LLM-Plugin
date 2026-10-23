import type { EffectiveConfig, ModelConfig } from '../core/configTypes.ts'
import { brief, log } from '../core/log.ts'
import { truncate } from '../core/util.ts'
import type { ToolCall, ToolResult, ToolSpec } from '../llm/types.ts'
import type { ImagePart } from '../llm/types.ts'

export interface TurnState {
  toolCalls?: number
  /** Command dispatched to another plugin this turn (ends the loop). */
  dispatched?: string
  commands: number
  searches: number
  fetches: number
  memoryWrites?: number
  execRuns?: number
  imageRequests?: number
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
  /** Current/quoted image bytes already loaded for this turn; never persisted in the chat transcript. */
  inputImages?: ImagePart[]
  computerResult?: { id: string; images: Buffer[] }
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
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, any>
  source?: 'builtin' | 'custom' | 'http'
  available?(ctx: ToolCtx): boolean
  /** per-reply cap, appended to the description sent to the model (e.g. "最多调用 3 次") */
  limit?(ctx: ToolCtx): string | undefined
  /** Current enforced allowance, read after every call in a parallel batch has settled. */
  remaining?(ctx: ToolCtx): string
  run(args: Record<string, any>, ctx: ToolCtx): Promise<ToolOutput | string>
}

/** Shared reply-image allowance for rendering, code output and public URL images. */
export const MAX_IMAGES_PER_TURN = 2
const MAX_RESULT_CHARS = 8000
const TOOL_TIMEOUT_MS = 60_000

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
    if (!ctx.eff.tools.enable || ctx.eff.chat?.maxToolCalls === 0) return []
    // Worker data may only be summarized; it must never authorize side effects or bypass privacy filtering.
    if (ctx.turn.asyncResult) return []
    const disabled = new Set(ctx.eff.tools.disabled ?? [])
    return this.all().filter(d => !disabled.has(d.name) && !hide.has(d.name) && (d.available?.(ctx) ?? true))
  }

  specs(defs: ToolDef[], ctx: ToolCtx): ToolSpec[] {
    return defs.map(d => {
      const limit = d.limit?.(ctx)
      return { name: d.name, description: limit ? `${d.description}（每次回复${limit}）` : d.description, parameters: d.parameters }
    })
  }

  async execute(calls: ToolCall[], ctx: ToolCtx, offered: ToolDef[], onResult?: (result: ToolResult, ms: number) => void): Promise<{ results: (ToolResult & { remaining: string; globalRemaining: number })[]; terminal: boolean }> {
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
        if ((ctx.turn.toolCalls ?? 0) >= maxCalls) return done({ id: call.id, name: call.name, content: '所有工具的全局调用次数已用完，请直接给出最终回复', isError: true })
        ctx.turn.toolCalls = (ctx.turn.toolCalls ?? 0) + 1
        const def = allowed.get(call.name)
        if (!def) {
          log.warn(`模型调用了未提供的工具 ${call.name}(${brief(call.args ?? {})})`)
          return done({ id: call.id, name: call.name, content: `工具 ${call.name} 不可用`, isError: true })
        }
        if (call.args?._invalid_json)
          return done({ id: call.id, name: call.name, content: '参数不是合法 JSON，请重试', isError: true })
        try {
          const out = await Promise.race([
            def.run(call.args ?? {}, ctx),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('工具执行超时')), TOOL_TIMEOUT_MS).unref?.()),
          ])
          const o: ToolOutput = typeof out === 'string' ? { content: out } : out
          if (o.terminal) terminal = true
          log.info(`工具 ${call.name}(${brief(call.args ?? {})}) ${o.isError ? '失败' : '完成'} ${Date.now() - started}ms → ${(o.content ?? '').length}字`)
          log.debug(`工具 ${call.name} 结果：${brief(o.content, 600)}`)
          return done({ id: call.id, name: call.name, content: truncate(o.content || '(无结果)', MAX_RESULT_CHARS), isError: o.isError,
            ...(o.images?.length ? { images: o.images } : {}) })
        } catch (err: any) {
          log.warn(`工具 ${call.name}(${brief(call.args ?? {})}) 出错: ${err?.message ?? err}`)
          return done({ id: call.id, name: call.name, content: `执行出错: ${err?.message ?? err}`, isError: true })
        }
      }),
    )
    return { results: results.map(result => {
      const def = allowed.get(result.name)
      return { ...result, remaining: !def ? '不可用' : def.remaining?.(ctx) ?? (def.limit ? '剩余次数未提供' : '无单独次数上限'), globalRemaining: Math.max(0, maxCalls - (ctx.turn.toolCalls ?? 0)) }
    }), terminal }
  }
}

export const registry = new Registry()
