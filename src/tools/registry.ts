import type { EffectiveConfig, ModelConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { truncate } from '../core/util.ts'
import type { ToolCall, ToolResult, ToolSpec } from '../llm/types.ts'

export interface TurnState {
  /** Command dispatched to another plugin this turn (ends the loop). */
  dispatched?: string
  commands: number
  searches: number
  fetches: number
  memoryWrites?: number
  memoryChanged?: boolean
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
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, any>
  source?: 'builtin' | 'custom' | 'http'
  available?(ctx: ToolCtx): boolean
  run(args: Record<string, any>, ctx: ToolCtx): Promise<ToolOutput | string>
}

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
    if (!ctx.eff.tools.enable) return []
    const disabled = new Set(ctx.eff.tools.disabled ?? [])
    return this.all().filter(d => !disabled.has(d.name) && !hide.has(d.name) && (d.available?.(ctx) ?? true))
  }

  specs(defs: ToolDef[]): ToolSpec[] {
    return defs.map(d => ({ name: d.name, description: d.description, parameters: d.parameters }))
  }

  async execute(calls: ToolCall[], ctx: ToolCtx, offered: ToolDef[]): Promise<{ results: ToolResult[]; terminal: boolean }> {
    const allowed = new Map(offered.map(d => [d.name, d]))
    let terminal = false
    const results = await Promise.all(
      calls.map(async (call): Promise<ToolResult> => {
        const def = allowed.get(call.name)
        if (!def) return { id: call.id, name: call.name, content: `工具 ${call.name} 不可用`, isError: true }
        if (call.args?._invalid_json)
          return { id: call.id, name: call.name, content: '参数不是合法 JSON，请重试', isError: true }
        try {
          const started = Date.now()
          const out = await Promise.race([
            def.run(call.args ?? {}, ctx),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('工具执行超时')), TOOL_TIMEOUT_MS).unref?.()),
          ])
          const o: ToolOutput = typeof out === 'string' ? { content: out } : out
          if (o.terminal) terminal = true
          log.info(`工具 ${call.name} ${o.isError ? '失败' : '完成'} (${Date.now() - started}ms)`)
          return { id: call.id, name: call.name, content: truncate(o.content || '(无结果)', MAX_RESULT_CHARS), isError: o.isError }
        } catch (err: any) {
          log.warn(`工具 ${call.name} 出错: ${err?.message ?? err}`)
          return { id: call.id, name: call.name, content: `执行出错: ${err?.message ?? err}`, isError: true }
        }
      }),
    )
    return { results, terminal }
  }
}

export const registry = new Registry()
