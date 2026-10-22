import { seg } from '../core/yunzai.ts'

function validMentionId(id: string, selfId: unknown): boolean {
  return id !== 'all' && id !== 'you' && id !== String(selfId) && /^[\w:\uF03A-]+$/.test(id)
}

export function replyMentions(text: string, e: any, budget = { remaining: 5 }): string | any[] {
  if (!e?.group_id) return text
  const parts: any[] = []
  const append = (value: string) => {
    if (!value) return
    if (parts.at(-1)?.type === 'text') parts.at(-1).text += value
    else parts.push({ type: 'text', text: value })
  }
  const pattern = /```[^\n]*\n?[\s\S]*?(?:```|$)|~~~[^\n]*\n?[\s\S]*?(?:~~~|$)|(?<!`)(`+)(?!`)[^\n]*?\1(?!`)|\[at:([^\]\s]+)\]/g
  let offset = 0
  let converted = false
  for (const match of text.matchAll(pattern)) {
    append(text.slice(offset, match.index))
    const id = match[2]
    if (id && validMentionId(id, e.self_id) && budget.remaining > 0) {
      parts.push(seg().at(id))
      budget.remaining--
      converted = true
    } else append(match[0])
    offset = match.index + match[0].length
  }
  append(text.slice(offset))
  return converted ? parts : text
}
