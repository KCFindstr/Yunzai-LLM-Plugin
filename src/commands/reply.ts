import type { ReplySection } from '../core/configTypes.ts'
import { markdownEnabled } from '../chat/format.ts'
import { sendForward } from '../core/yunzai.ts'

const originalEvents = new WeakMap<object, any>()

export function commandForward(e: any, nodes: string[], title?: string) {
  const original = originalEvents.get(e)
  if (original) return original.reply(nodes.map(commandMarkdown).join('\n\n'))
  return sendForward(e, nodes, title)
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

export function commandEvent(e: any, reply: ReplySection): any {
  if (!markdownEnabled(e, reply)) return e
  const format = (message: any): any => {
    if (typeof message === 'string') return commandMarkdown(message)
    if (Array.isArray(message)) return message.map(format)
    if (message?.type === 'text') {
      if (typeof message.text === 'string') return { ...message, text: commandMarkdown(message.text) }
      if (typeof message.data?.text === 'string') return { ...message, data: { ...message.data, text: commandMarkdown(message.data.text) } }
    }
    return message
  }
  const wrapped = Object.create(e, {
    reply: { value: (message: any, ...args: any[]) => e.reply(format(message), ...args), configurable: true },
  })
  originalEvents.set(wrapped, e)
  return wrapped
}
