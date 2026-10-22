import type { ReplySection } from '../core/configTypes.ts'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { markdownEnabled } from '../chat/format.ts'
import { botNickname, seg } from '../core/yunzai.ts'
import { isLongResponse, renderCommandResponse } from '../render/response.ts'
import { detectImageMime } from '../core/util.ts'

const originalEvents = new WeakMap<object, any>()
const batches = new WeakMap<object, { sections: string[]; media: any[] }>()

function capture(batch: { sections: string[]; media: any[] }, message: any) {
  if (typeof message === 'string') { if (message.trim()) batch.sections.push(message); return }
  if (Array.isArray(message)) { for (const part of message) capture(batch, part); return }
  if (message?.type === 'text') return capture(batch, message.text ?? message.data?.text)
  if (message?.type === 'node') return capture(batch, message.data?.content ?? message.message)
  if (message) batch.media.push(message)
}

function imageSource(segment: any): string | undefined {
  if (segment?.type !== 'image') return undefined
  const data = segment.data ?? segment
  let file = data.file ?? data.url
  try {
    if (typeof file === 'string') {
      if (/^https?:\/\//i.test(file)) return file
      if (/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,/i.test(file)) return file
      if (file.startsWith('base64://')) file = Buffer.from(file.slice(9), 'base64')
      else {
        const path = file.startsWith('file:') ? fileURLToPath(file) : file
        if (fs.statSync(path).size > 8 * 1024 * 1024) return undefined
        file = fs.readFileSync(path)
      }
    }
    if (!Buffer.isBuffer(file) || file.length > 8 * 1024 * 1024) return undefined
    const mime = detectImageMime(file)
    return mime ? `data:${mime};base64,${file.toString('base64')}` : undefined
  } catch { return undefined }
}

export async function flushCommand(e: any) {
  const batch = batches.get(e)
  if (!batch) return
  batches.delete(e)
  if (!batch.sections.length && !batch.media.length) return
  const sources = batch.media.map(imageSource)
  const native = batch.media.filter((_segment, index) => !sources[index])
  const original = originalEvents.get(e) ?? e
  if (!batch.sections.length && sources.every(source => !source)) return original.reply(native.length === 1 ? native[0] : native)
  const image = seg().image(await renderCommandResponse(batch.sections, botNickname(e), sources.filter((source): source is string => Boolean(source))))
  return original.reply(native.length ? [image, ...native] : image)
}

export async function commandForward(e: any, nodes: string[], title?: string) {
  const batch = batches.get(e)
  if (batch) { batch.sections.push(...nodes); return { pending: true } }
  const original = originalEvents.get(e) ?? e
  return original.reply(seg().image(await renderCommandResponse(nodes, title || botNickname(e))))
}

export function commandMarkdown(text: string): string {
  const code = (value: string) => {
    const longest = Math.max(0, ...(value.match(/`+/g) ?? []).map(run => run.length))
    const fence = '`'.repeat(longest + 1)
    return `${fence} ${value} ${fence}`
  }
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/[\\`*_{}\[\]<>()#+!|~]/g, '\\$&')
  const inline = (value: string) => {
    const tokens = /#llm[^\s，。；（）()]+|\$[+-]?\d*(?:\.\d+)?|<[^>\n]+>/gi
    let output = ''
    let offset = 0
    for (const token of value.matchAll(tokens)) {
      output += escape(value.slice(offset, token.index)) + code(token[0])
      offset = token.index! + token[0].length
    }
    return output + escape(value.slice(offset))
  }
  return text.replace(/\r\n?/g, '\n').split('\n').map(raw => {
    const line = raw.trim()
    const heading = /^【([^】]+)】(.*)$/.exec(line)
    if (heading) return `\n## ${escape(heading[1])}\n${heading[2] ? `\n${inline(heading[2])}\n` : ''}`
    const command = /^(?:例：)?(#llm.*)$/.exec(line)
    if (command) {
      const [syntax, ...description] = command[1].split(' — ')
      return `- ${line.startsWith('例：') ? '例：' : ''}${code(syntax)}${description.length ? ` — ${inline(description.join(' — '))}` : ''}`
    }
    if (line.startsWith('• ')) return `- ${inline(line.slice(2))}`
    if (raw.startsWith('  ') && line.startsWith('@')) return `- ${inline(line)}`
    return line ? `\n${inline(line)}\n` : ''
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function commandEvent(e: any, reply: ReplySection, batch = false): any {
  const markdown = markdownEnabled(e, reply)
  const format = (message: any): any => {
    if (typeof message === 'string') return markdown ? commandMarkdown(message) : message
    if (Array.isArray(message)) return message.map(format)
    if (message?.type === 'text') {
      if (typeof message.text === 'string') return { ...message, text: markdown ? commandMarkdown(message.text) : message.text }
      if (typeof message.data?.text === 'string') return { ...message, data: { ...message.data, text: markdown ? commandMarkdown(message.data.text) : message.data.text } }
    }
    return message
  }
  const wrapped = Object.create(e, {
    reply: { value: async (message: any, ...args: any[]) => {
      const pending = batches.get(wrapped)
      if (pending) { capture(pending, message); return { pending: true } }
      if (typeof message === 'string' && isLongResponse(message)) return commandForward(wrapped, [message])
      const textOf = (part: any) => typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? part.data?.text ?? '' : ''
      const parts = Array.isArray(message) ? message : [message]
      const text = parts.map(textOf).join('\n')
      if (isLongResponse(text)) {
        const image = await renderCommandResponse([text], botNickname(e))
        return e.reply([seg().image(image), ...parts.filter(part => !textOf(part))], ...args)
      }
      if (Array.isArray(message) && message.length && message.every(part => part?.type === 'node')) {
        const nodes = message.map(part => part.data?.content ?? part.message)
        if (nodes.every(node => typeof node === 'string')) return commandForward(wrapped, nodes)
      }
      return e.reply(format(message), ...args)
    }, configurable: true },
  })
  originalEvents.set(wrapped, e)
  if (batch) batches.set(wrapped, { sections: [], media: [] })
  return wrapped
}
