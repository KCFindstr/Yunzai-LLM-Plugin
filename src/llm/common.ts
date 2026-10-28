import type { ProviderConfig, ThinkingLevel } from '../core/configTypes.ts'
import type { FilePart, ImagePart, Part, ToolResult } from './types.ts'
import { fileKind } from './types.ts'

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
 * Tool-result images and files as user-message parts, each batch labelled with its tool, for APIs whose tool results
 * are text-only. Images are dropped for models without vision: the result text already says what was fetched.
 */
export function toolImages(results: ToolResult[], vision: boolean): Part[] {
  return results.flatMap(r => {
    const parts: Part[] = [...(vision ? r.images ?? [] : []), ...r.files ?? []]
    return parts.length ? [{ type: 'text' as const, text: `【工具 ${r.name} 返回的${r.files?.length ? '文件' : '图片'}】` }, ...parts] : []
  })
}

/** Gemini Interactions content type and mime spelling for each stored media type. */
const GEMINI_FILES: Record<string, [string, string]> = {
  'video/mp4': ['video', 'video/mp4'], 'video/webm': ['video', 'video/webm'], 'video/quicktime': ['video', 'video/mov'],
  'video/x-msvideo': ['video', 'video/avi'], 'video/3gpp': ['video', 'video/3gpp'], 'video/mpeg': ['video', 'video/mpeg'],
  'audio/mpeg': ['audio', 'audio/mp3'], 'audio/wav': ['audio', 'audio/wav'], 'audio/ogg': ['audio', 'audio/ogg'],
  'audio/flac': ['audio', 'audio/flac'], 'audio/mp4': ['audio', 'audio/m4a'], 'audio/aac': ['audio', 'audio/aac'],
  'audio/webm': ['audio', 'audio/webm'], 'application/pdf': ['document', 'application/pdf'],
}
export const geminiFile = (part: FilePart) => {
  const [type, mime] = GEMINI_FILES[part.mime] ?? []
  return type ? { type, data: part.data, mime_type: mime } : undefined
}

/** Whether a provider's API takes this media type as native input; text files are always passed as text instead. */
export function acceptsFile(provider: Pick<ProviderConfig, 'type' | 'baseUrl'>, mime: string): boolean {
  switch (provider.type) {
    case 'gemini': return mime in GEMINI_FILES
    case 'anthropic':
    case 'openai-responses': return mime === 'application/pdf'
    // Compatible chat endpoints rarely accept file parts; only OpenAI itself and OpenRouter document them.
    case 'openai': return mime === 'application/pdf' && /api\.openai\.com|openrouter\.ai/i.test(provider.baseUrl || 'https://api.openai.com/v1')
    default: return false
  }
}

export const filePlaceholder = (part: FilePart) => `[${fileKind(part.mime)}${part.name ? `:${part.name}` : ''}（当前模型无法直接读取）]`

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
