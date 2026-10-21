import type { EffectiveConfig, ReplySection } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { randFloat, sleep, truncate } from '../core/util.ts'
import { botNickname, sendApi, sendForward, seg } from '../core/yunzai.ts'
import { markdownEnabled } from './format.ts'
import { chooseSticker, extractStickerMarkers, sendSticker } from '../stickers/picker.ts'
import { messagesSince, recordBotMessage } from './groupLog.ts'
import { limiter } from './ratelimit.ts'

/**
 * QQ shows Markdown literally; turn the common constructs into plain chat text.
 * Line-start patterns use [ \t] rather than \s so they never swallow the blank lines that separate paragraphs.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code: string) => code.trimEnd())
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '$2')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, t: string, u: string) => (t === u ? u : `${t} ${u}`))
    .replace(/^[ \t]*[-*+][ \t]+/gm, '· ')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')
}

export interface Prepared {
  bubbles: string[]
  /** long text sent as one forward message instead */
  forward?: string
  stickerNames: string[]
}

/**
 * Turn model text into what gets sent. Plain-text mode strips Markdown and may split short multi-part replies
 * into bubbles; Markdown mode (e.g. QQBot) keeps the text intact as one message.
 */
export function prepareReply(raw: string, cfg: ReplySection, markdown = false): Prepared {
  const { text: noMarkers, names } = extractStickerMarkers(raw)
  let text = cfg.stripMarkdown && !markdown ? stripMarkdown(noMarkers) : noMarkers
  text = text.replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return { bubbles: [], stickerNames: names }
  if (markdown) return { bubbles: [text], stickerNames: names }
  if (text.length > cfg.maxChars) {
    if (cfg.longText === 'forward') return { bubbles: [], forward: text, stickerNames: names }
    text = truncate(text, cfg.maxChars)
  }
  const paras = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean)
  // Separate bubbles only for short multi-part replies, like people do; otherwise one message.
  if (cfg.maxBubbles > 1 && paras.length > 1 && paras.length <= cfg.maxBubbles && paras.every(p => p.length <= 120))
    return { bubbles: paras, stickerNames: names }
  if (cfg.maxBubbles > 1 && paras.length > cfg.maxBubbles && text.length <= 240) {
    const head = paras.slice(0, cfg.maxBubbles - 1)
    const tail = paras.slice(cfg.maxBubbles - 1).join('\n')
    return { bubbles: [...head, tail], stickerNames: names }
  }
  return { bubbles: [text], stickerNames: names }
}

function typingDelay(len: number, cfg: ReplySection): number {
  const t = cfg.typing
  const ms = (len / Math.max(1, t.charsPerSecond)) * 1000 * randFloat(0.8, 1.25)
  return Math.min(t.maxDelay, Math.max(t.minDelay, ms))
}

function groupKey(e: any) {
  return e.group_id ? `g:${e.self_id}:${e.group_id}` : `p:${e.self_id}:${e.user_id}`
}

async function takeSlot(e: any, cfg: ReplySection, waitMs: number): Promise<boolean> {
  if (!(await limiter.take(groupKey(e), cfg.groupRate, waitMs))) return false
  return limiter.take('global', cfg.globalRate, waitMs)
}

async function showTyping(e: any, cfg: ReplySection) {
  if (e.group_id || !cfg.privateTyping) return
  try {
    await sendApi(e, 'set_input_status', { user_id: String(e.user_id), event_type: 1 })
  } catch {}
}

/**
 * Send the model's reply like a person would: short pause scaled to length, at most a few bubbles,
 * quote only when the conversation has moved on, and never exceed the group/global rate limits.
 */
export async function deliver(
  e: any,
  raw: string,
  eff: EffectiveConfig,
  opts: { startedAt: number; convKey: string; suppressText?: boolean; images?: Buffer[] },
) {
  const cfg = eff.reply
  const prep = prepareReply(raw, cfg, markdownEnabled(e, cfg))
  const sticker = chooseSticker(opts.convKey, prep.stickerNames, eff.sticker)
  const elapsed = Date.now() - opts.startedAt

  if (!opts.suppressText && (prep.bubbles.length || prep.forward)) {
    await showTyping(e, cfg)
    if (!(await takeSlot(e, cfg, 15000))) {
      log.warn('达到发送频率上限，放弃本次回复')
      return
    }
    const first = prep.forward ? 30 : prep.bubbles[0].length
    await sleep(typingDelay(first, cfg) - elapsed)

    const quote =
      Boolean(e.message_id) &&
      (cfg.quote === 'always' || (cfg.quote === 'auto' && Boolean(e.group_id) && (messagesSince(e) >= 2 || Date.now() - opts.startedAt > 25000)))
    const at = cfg.atUser && Boolean(e.group_id) && !quote

    if (prep.forward) {
      if (quote || at) await e.reply('内容有点长，我整理在下面啦', quote, { at })
      await sendForward(e, [prep.forward], botNickname(e))
      recordBotMessage(e, truncate(prep.forward, 100), opts.convKey)
    } else {
      for (let i = 0; i < prep.bubbles.length; i++) {
        const b = prep.bubbles[i]
        if (i > 0) {
          if (!(await takeSlot(e, cfg, 8000))) {
            // out of budget: merge the rest into one last message
            const rest = prep.bubbles.slice(i).join('\n')
            await e.reply(rest)
            recordBotMessage(e, rest, opts.convKey)
            break
          }
          await showTyping(e, cfg)
          await sleep(typingDelay(b.length, cfg))
        }
        await e.reply(b, i === 0 && quote, i === 0 && at ? { at: true } : {})
        recordBotMessage(e, b, opts.convKey)
      }
    }
  }

  // tool-rendered images (render_html) follow the text; they are the answer, so wait longer for a slot
  for (const img of opts.images ?? []) {
    if (!(await takeSlot(e, cfg, 20000))) {
      log.warn('达到发送频率上限，渲染图片未发送')
      break
    }
    await e.reply(seg().image(img))
    recordBotMessage(e, '[图片]', opts.convKey)
  }

  if (sticker && (await takeSlot(e, cfg, 3000))) {
    await sleep(randFloat(600, 1800))
    if (await sendSticker(e, sticker, eff.sticker)) recordBotMessage(e, `[表情:${sticker.name}]`, opts.convKey)
  }
}
