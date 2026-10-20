import fs from 'node:fs'
import type { StickerSection } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { chance } from '../core/util.ts'
import { Cooldown } from '../chat/ratelimit.ts'
import { listStickers, markUsed, resolveSticker, stickerFile, type Sticker } from './store.ts'

const MARKER = /[[【［]\s*(?:表情|表情包|sticker)\s*[:：]\s*([^\]】］\n]{1,30})[\]】］]/gi
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

/** Prompt section listing usable stickers (stable order: by id). */
export function stickerPromptLines(max: number): string[] {
  return listStickers()
    .filter(s => s.indexed)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, Math.max(0, max))
    .map(s => `- ${s.name}：${s.use || s.desc}`)
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

export function stickerSegment(s: Sticker, sendAs: StickerSection['sendAs']): any | undefined {
  if (s.kind === 'mface' && s.mface)
    return { type: 'mface', ...s.mface, summary: s.mface.summary ?? `[${s.name}]` }
  const f = stickerFile(s)
  if (!f || !fs.existsSync(f)) return undefined
  const file = fs.readFileSync(f)
  return sendAs === 'image' ? { type: 'image', file } : { type: 'image', file, sub_type: 1, summary: '[动画表情]' }
}

export async function sendSticker(e: any, s: Sticker, sendAs: StickerSection['sendAs']): Promise<boolean> {
  const seg = stickerSegment(s, sendAs)
  if (!seg) return false
  try {
    const res = await e.reply(seg)
    if (res?.error && s.kind === 'mface' && s.file) {
      // market faces can fail (expired key / not owned): fall back to the preview image
      const fallback = stickerSegment({ ...s, kind: 'image' }, sendAs)
      if (fallback) await e.reply(fallback)
    }
    markUsed(s)
    return true
  } catch (err: any) {
    log.warn(`发送表情失败: ${err?.message ?? err}`)
    return false
  }
}
