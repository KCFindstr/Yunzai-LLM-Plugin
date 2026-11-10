import { deepMerge } from '../core/util.ts'
import { acceptsFile, filePlaceholder, genCallId, geminiThinking, parseArgs, toolImages } from './common.ts'
import { joinUrl } from './http.ts'
import type { Adapter, ChatParams, ChatResult, Part } from './types.ts'
import { joinThinking, LLMError } from './types.ts'
import { vertexRequest } from './vertexAuth.ts'

/** Vertex Gemini generateContent: Cloud OAuth, full contents, and native thought-signature replay. */
export const vertex: Adapter = {
  async chat(p: ChatParams): Promise<ChatResult> {
    const project = p.provider.project?.trim()
    const location = p.provider.location?.trim() || 'global'
    if (!project) throw new LLMError('Vertex AI 提供商未配置 project（Google Cloud 项目 ID）')
    const base = p.provider.baseUrl || (location === 'global' ? 'https://aiplatform.googleapis.com' : `https://${location}-aiplatform.googleapis.com`)
    const root = /\/v1\/?$/.test(base) ? base : joinUrl(base, 'v1')
    const model = p.model.model.replace(/^models\//, '')
    const url = joinUrl(root, `projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`)
    const vision = p.model.vision !== false
    const parts = (content: Part[]) => content.map(c => {
      if (c.type === 'text') return { text: c.text }
      if (c.type === 'file') return acceptsFile(p.provider, c.mime) ? { inlineData: { mimeType: c.mime, data: c.data } } : { text: filePlaceholder(c) }
      if (vision && c.data) return { inlineData: { mimeType: c.mime || 'image/png', data: c.data } }
      if (vision && c.url) return { fileData: { mimeType: c.mime || 'image/png', fileUri: c.url } }
      return { text: '[图片]' }
    })
    const contents: any[] = []
    for (const m of p.messages) {
      if (m.role === 'user') contents.push({ role: 'user', parts: parts(m.content) })
      else if (m.role === 'assistant') {
        if (m.native?.provider === 'vertex' && m.native.model === p.model.model) {
          contents.push(m.native.data)
          continue
        }
        const output: any[] = m.content ? [{ text: m.content }] : []
        for (const tc of m.toolCalls ?? []) output.push({ functionCall: { name: tc.name, args: tc.args }, thoughtSignature: 'skip_thought_signature_validator' })
        if (output.length) contents.push({ role: 'model', parts: output })
      } else {
        // v1 matches parallel responses by name/order; optional call IDs are only in v1beta1.
        contents.push({ role: 'user', parts: m.results.map(r => ({ functionResponse: { name: r.name, response: r.isError ? { error: r.content } : { output: r.content } } })) })
        const media = toolImages(m.results, vision)
        if (media.length) contents.at(-1).parts.push(...parts(media))
      }
    }
    const generationConfig: any = { maxOutputTokens: p.maxTokens }
    const level = geminiThinking(p.thinking)
    generationConfig.thinkingConfig = { includeThoughts: true, ...(level ? { thinkingLevel: level } : {}) }
    // Newer Gemini models ignore custom sampling; retain the shared overrides for older models.
    if (p.temperature != null) generationConfig.temperature = p.temperature
    if (p.model.topP != null) generationConfig.topP = p.model.topP
    let body: any = { contents, systemInstruction: { parts: [{ text: p.system }] }, generationConfig }
    const tools: any[] = []
    if (p.tools.length) tools.push({ functionDeclarations: p.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) })
    if (p.nativeSearch) tools.push({ googleSearch: {} }, { urlContext: {} })
    if (tools.length) body.tools = tools
    if (p.model.extraBody) body = deepMerge(body, p.model.extraBody)
    const res = await vertexRequest(p.provider, url, body, p.signal)
    const candidate = res?.candidates?.[0]
    if (!candidate?.content) throw new LLMError(`Vertex AI 未返回内容: ${res?.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'unknown'}`)
    const output = candidate.content.parts ?? []
    const usage = res.usageMetadata ?? {}
    const thought = usage.thoughtsTokenCount ?? 0
    const cached = usage.cachedContentTokenCount ?? 0
    return {
      text: output.filter((part: any) => part.text && !part.thought).map((part: any) => part.text).join(''),
      reasoning: joinThinking(...output.filter((part: any) => part.thought).map((part: any) => part.text)),
      toolCalls: output.filter((part: any) => part.functionCall).map((part: any) => ({ id: part.functionCall.id || genCallId(), name: part.functionCall.name, args: parseArgs(part.functionCall.args) })),
      usage: { input: Math.max(0, (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0) - cached), cacheRead: cached, cacheWrite: 0, cacheWrite1h: 0,
        output: (usage.candidatesTokenCount ?? 0) + thought, reasoning: thought, webSearches: candidate.groundingMetadata?.webSearchQueries?.length ?? 0 },
      native: { provider: 'vertex', model: p.model.model, data: candidate.content },
      stopReason: candidate.finishReason ?? 'unknown',
    }
  },
}
