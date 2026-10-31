import type { ReplySection } from '../core/configTypes.ts'

/** A standalone control reply that means the model has nothing to send. */
export const SKIP_REPLY = /^\s*[\[［【]?\s*(skip|不回复|跳过)\s*[\]］】]?\s*$/i

/** True when the event comes from the official QQ bot platform adapter (TRSS QQBot-Plugin). */
export function isQQBotEvent(e: any): boolean {
  const name = String(e?.adapter_name ?? e?.bot?.adapter?.name ?? e?.bot?.version?.name ?? '')
  return /qqbot/i.test(name)
}

/** Whether replies for this event are written and sent as Markdown. */
export function markdownEnabled(e: any, reply: ReplySection): boolean {
  if (e?.isPrivate || e?.message_type === 'private' || (!e?.group_id && !e?.guild_id && !e?.channel_id)) return false
  if (reply.markdown === 'auto') return isQQBotEvent(e)
  return reply.markdown === true
}
