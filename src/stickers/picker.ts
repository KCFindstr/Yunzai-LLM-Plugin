import fs from 'node:fs'
import path from 'node:path'
import { imageSize } from 'image-size'
import type { StickerSection } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { chance } from '../core/util.ts'
import { Cooldown } from '../chat/ratelimit.ts'
import { downscaleImage } from '../render/browser.ts'
import { listStickers, markUsed, resolveSticker, stickerFile, type Sticker } from './store.ts'

// [表情:名称] 【表情：名称】 ［sticker:名称］ （表情:名称） (表情:名称)
const MARKER = /[[【［（(]\s*(?:表情|表情包|sticker)\s*[:：]\s*([^\]】］）)\n]{1,30})[\]】］）)]/gi
const cooldown = new Cooldown()
const lastSent = new Map<string, string>()

/** Pull `[表情:名称]` markers out of model text. */
export function extractStickerMarkers(text: string): { text: string; names: string[] } {
  const names: string[] = []
  const clean = text.replace(MARKER, (_, n: string) => {
    names.push(n.trim())
    return ''
  })
  return { text: clean.replace(/[ \t]+\n/g, '\n').trim(), names }
}

/** A sticker the model can refer to: recognised by the vision model, or named by an admin. */
export function isUsable(s: Sticker): boolean {
  return s.indexed || (Boolean(s.name) && s.name !== '未命名')
}

/** Prompt section listing usable stickers (stable order: by id). */
export function stickerPromptLines(max: number): string[] {
  return listStickers()
    .filter(isUsable)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, Math.max(0, max))
    .map(s => `- ${s.name}：${s.use || s.desc || '（无说明）'}`)
}

/** Decide whether to actually send a sticker the model asked for (probability + cooldown + no repeats). */
export function chooseSticker(convKey: string, names: string[], cfg: StickerSection): Sticker | undefined {
  if (!cfg.enable || !names.length) return undefined
  if (!cooldown.ready(convKey, cfg.cooldown)) return undefined
  if (!chance(cfg.probability)) return undefined
  for (const n of names) {
    const s = resolveSticker(n)
    if (!s || lastSent.get(convKey) === s.id) continue
    cooldown.hit(convKey)
    lastSent.set(convKey, s.id)
    return s
  }
  return undefined
}

/**
 * QQ renders big images as ordinary pictures even with sub_type=1, so stickers are sent as a copy whose longer
 * side is at most `max` px (cached next to the original). GIFs keep their animation and are sent as-is.
 */
export async function sendableImage(file: string, max: number): Promise<Buffer> {
  const buf = fs.readFileSync(file)
  if (!max) return buf
  let dim: { width?: number; height?: number; type?: string }
  try {
    dim = imageSize(buf)
  } catch {
    return buf
  }
  if (dim.type === 'gif' || Math.max(dim.width ?? 0, dim.height ?? 0) <= max) return buf
  const cached = path.join(path.dirname(file), `${path.parse(file).name}.s${max}.png`)
  if (fs.existsSync(cached)) return fs.readFileSync(cached)
  try {
    const out = await downscaleImage(buf, `image/${dim.type === 'jpg' ? 'jpeg' : dim.type}`, max)
    fs.writeFileSync(cached, out)
    return out
  } catch (err: any) {
    log.warn(`表情缩放失败，发送原图: ${err?.message ?? err}`)
    return buf
  }
}

export async function stickerSegment(s: Sticker, cfg: Pick<StickerSection, 'sendAs' | 'maxSendSize'>): Promise<any | undefined> {
  if (s.kind === 'mface' && s.mface) return { type: 'mface', ...s.mface, summary: s.mface.summary ?? `[${s.name}]` }
  const f = stickerFile(s)
  if (!f || !fs.existsSync(f)) return undefined
  const file = await sendableImage(f, cfg.maxSendSize ?? 240)
  return cfg.sendAs === 'image' ? { type: 'image', file } : { type: 'image', file, sub_type: 1, summary: '[动画表情]' }
}

export async function sendSticker(e: any, s: Sticker, cfg: Pick<StickerSection, 'sendAs' | 'maxSendSize'>): Promise<boolean> {
  const seg = await stickerSegment(s, cfg)
  if (!seg) return false
  try {
    const res = await e.reply(seg)
    if (res?.error && s.kind === 'mface' && s.file) {
      // market faces can fail (expired key / not owned): fall back to the preview image
      const fallback = await stickerSegment({ ...s, kind: 'image' }, cfg)
      if (fallback) await e.reply(fallback)
    }
    markUsed(s)
    return true
  } catch (err: any) {
    log.warn(`发送表情失败: ${err?.message ?? err}`)
    return false
  }
}
