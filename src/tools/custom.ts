import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { config } from '../core/config.ts'
import type { HttpToolConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { TOOLS_DIR } from '../core/paths.ts'
import { isPlainObject, truncate } from '../core/util.ts'
import { registry, type ToolDef } from './registry.ts'

function fillTemplate(v: any, args: Record<string, any>): any {
  if (typeof v === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(v)
    if (whole) return args[whole[1]]
    return v.replace(/\{\{(\w+)\}\}/g, (_, k) => String(args[k] ?? ''))
  }
  if (Array.isArray(v)) return v.map(x => fillTemplate(x, args))
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillTemplate(x, args)]))
  return v
}

async function callHttpTool(t: HttpToolConfig, args: Record<string, any>): Promise<string> {
  const url = t.url.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(args[k] ?? '')))
  const method = (t.method ?? 'GET').toUpperCase()
  const init: RequestInit = {
    method,
    headers: { ...(t.body != null ? { 'content-type': 'application/json' } : {}), ...(t.headers ?? {}) },
    signal: AbortSignal.timeout(20000),
  }
  if (t.body != null && method !== 'GET') init.body = JSON.stringify(fillTemplate(t.body, args))
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${truncate(text, 200)}`)
  return truncate(text, t.maxChars ?? 4000)
}

function asToolDef(raw: any, source: 'custom'): ToolDef | undefined {
  const run = raw?.run ?? raw?.handler
  if (!raw?.name || !raw?.description || typeof run !== 'function') return undefined
  return {
    name: raw.name,
    description: raw.description,
    parameters: raw.parameters ?? { type: 'object', properties: {} },
    source,
    available: typeof raw.available === 'function' ? raw.available : undefined,
    run: async (args, ctx) => {
      const out = await run(args, ctx)
      if (typeof out === 'string') return out
      if (out && typeof out.content === 'string') return out
      return JSON.stringify(out ?? null)
    },
  }
}

/** (Re)load tools/*.js|mjs and config.tools.http. */
export async function loadCustomTools(): Promise<string[]> {
  registry.unregisterWhere(d => d.source === 'custom' || d.source === 'http')
  const names: string[] = []
  try {
    if (fs.existsSync(TOOLS_DIR))
      for (const f of fs.readdirSync(TOOLS_DIR)) {
        if (!/\.(m?js)$/.test(f)) continue
        try {
          const mod = await import(`${pathToFileURL(path.join(TOOLS_DIR, f)).href}?t=${Date.now()}`)
          const defs = Array.isArray(mod.default) ? mod.default : [mod.default ?? mod.tool]
          for (const d of defs) {
            const def = asToolDef(d, 'custom')
            if (def) {
              registry.register(def)
              names.push(def.name)
            } else log.warn(`自定义工具 ${f} 导出格式不正确（需要 name/description/run）`)
          }
        } catch (err: any) {
          log.error(`加载自定义工具 ${f} 失败: ${err.message}`)
        }
      }
  } catch {}
  for (const t of config.get().tools.http) {
    if (!t?.name || !t?.url || !t?.description) continue
    registry.register({
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: 'object', properties: {} },
      source: 'http',
      run: args => callHttpTool(t, args),
    })
    names.push(t.name)
  }
  return names
}
