import type { ThinkingLevel } from '../core/configTypes.ts'
import type { ImagePart, Part, ToolResult } from './types.ts'

let seq = 0
export const genCallId = (prefix = 'call') => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}`

export function parseArgs(raw: any): Record<string, any> {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    const fenced = raw.replace(/^```(?:json)?\s*|\s*```$/g, '')
    try {
      return JSON.parse(fenced)
    } catch {
      return { _invalid_json: raw.slice(0, 500) }
    }
  }
}

export function dataUrl(img: ImagePart): string | undefined {
  if (img.data) return `data:${img.mime || 'image/png'};base64,${img.data}`
  return img.url
}

/**
 * Tool-result images as user-message parts, each batch labelled with its tool, for APIs whose tool results are
 * text-only. Empty for models without vision: the result text already says what was fetched.
 */
export function toolImages(results: ToolResult[], vision: boolean): Part[] {
  if (!vision) return []
  return results.flatMap(r => r.images?.length ? [{ type: 'text' as const, text: `【工具 ${r.name} 返回的图片】` }, ...r.images] : [])
}

/** OpenAI reasoning_effort / Responses reasoning.effort mapping. */
export function openaiEffort(t: ThinkingLevel): string | undefined {
  switch (t) {
    case 'off':
      return undefined
    case 'max':
      return 'xhigh'
    default:
      return t
  }
}

/** Anthropic output_config.effort mapping. */
export function anthropicEffort(t: ThinkingLevel): string | undefined {
  switch (t) {
    case 'off':
      return undefined
    case 'minimal':
      return 'low'
    default:
      return t
  }
}

/** Gemini generation_config.thinking_level mapping (low|medium|high). */
export function geminiThinking(t: ThinkingLevel): string | undefined {
  switch (t) {
    case 'off':
      return undefined
    case 'minimal':
    case 'low':
      return 'low'
    case 'medium':
      return 'medium'
    default:
      return 'high'
  }
}
