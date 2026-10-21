import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { log } from './log.ts'

/** Plugin classes exported by this plugin; used to recognise our own rules in the loader. */
export const ownClasses = new Set<Function>()

let loaderOverride: any
let cfgOverride: any
const modCache = new Map<string, Promise<any>>()

export function setLoaderForTest(l: any, yzCfg?: any) {
  loaderOverride = l
  cfgOverride = yzCfg
}

/**
 * Import a Yunzai core module (e.g. lib/plugins/loader.js) as the *same* instance Yunzai uses.
 * The URL is derived from our own module URL (walking up until `rel` exists) so it is byte-identical to the URL
 * Yunzai imported it with — a different spelling would create a second instance (and the loader would clobber
 * `global.plugin`).
 */
async function importYunzai(rel: string): Promise<any | undefined> {
  if (!modCache.has(rel))
    modCache.set(
      rel,
      (async () => {
        let dirUrl = new URL('./', import.meta.url)
        for (let i = 0; i < 6; i++) {
          const candidate = new URL(rel, dirUrl)
          if (fs.existsSync(fileURLToPath(candidate))) return (await import(candidate.href)).default
          const parent = new URL('../', dirUrl)
          if (parent.href === dirUrl.href) break
          dirUrl = parent
        }
        return undefined
      })().catch(err => {
        log.warn(`加载 ${rel} 失败: ${err?.message ?? err}`)
        return undefined
      }),
    )
  return modCache.get(rel)
}

/** Yunzai's puppeteer renderer (shares the bot's Chromium). Undefined outside Yunzai. */
export async function getYunzaiRenderer(): Promise<any | undefined> {
  if (loaderOverride) return undefined
  return importYunzai('lib/puppeteer/puppeteer.js')
}

/** Yunzai's config singleton (lib/config/config.js), used for group enable/disable lists. */
export async function getYunzaiCfg(): Promise<any | undefined> {
  if (loaderOverride) return cfgOverride
  return importYunzai('lib/config/config.js')
}

/** Locate Yunzai's PluginsLoader singleton. */
export async function getLoader(): Promise<any | undefined> {
  if (loaderOverride) return loaderOverride
  const loader = await importYunzai('lib/plugins/loader.js')
  if (!loader?.priority) {
    log.warn('未找到 Yunzai PluginsLoader，自然语言指令功能不可用')
    return undefined
  }
  if (!warnedForeignLoader && ownClasses.size && !loader.priority.some((p: any) => ownClasses.has(p.class))) {
    warnedForeignLoader = true
    log.warn('PluginsLoader 实例中未找到本插件（可能存在重复加载），指令调度可能异常')
  }
  return loader
}
let warnedForeignLoader = false

/** Yunzai root directory (cwd in production). */
export function yunzaiRoot(): string {
  return process.cwd()
}

export function pluginsDir(): string {
  return path.join(yunzaiRoot(), 'plugins')
}

export function botNickname(e: any, fallback = ''): string {
  return fallback || e?.bot?.nickname || e?.bot?.info?.nickname || globalThis.Bot?.[e?.self_id]?.nickname || '机器人'
}

export function senderName(e: any): string {
  return String(e?.sender?.card || e?.sender?.nickname || e?.user_id || '某人')
}

export async function sendApi(e: any, action: string, params: Record<string, any> = {}): Promise<any> {
  const fn = e?.bot?.sendApi ?? globalThis.Bot?.[e?.self_id]?.sendApi
  if (typeof fn !== 'function') throw new Error(`当前适配器不支持 ${action}`)
  return fn(action, params)
}

export function seg() {
  return (
    globalThis.segment ?? {
      image: (file: any, name?: string) => ({ type: 'image', file, name }),
      at: (qq: any, name?: string) => ({ type: 'at', qq, name }),
      reply: (id: any) => ({ type: 'reply', id }),
    }
  )
}

/** Send a forward (合并转发) message made of text/segment nodes; falls back to plain text. */
export async function sendForward(e: any, nodes: any[], title?: string): Promise<any> {
  const Bot = globalThis.Bot
  const nickname = title || botNickname(e)
  const user_id = e?.self_id
  try {
    const target = e.group?.makeForwardMsg ? e.group : e.friend
    const make = target?.makeForwardMsg ?? Bot?.makeForwardMsg
    if (typeof make === 'function') {
      const msg = await make.call(target ?? Bot, nodes.map(message => ({ message, nickname, user_id })))
      return await e.reply(msg)
    }
  } catch (err: any) {
    log.warn('发送合并转发失败，改为普通消息', err?.message ?? err)
  }
  return e.reply(nodes.map(n => (typeof n === 'string' ? n : '')).filter(Boolean).join('\n\n'))
}
