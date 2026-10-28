import { chatImageScope, imageLabel, pruneImages, saveImage, type SavedImage } from '../chat/images.ts'
import { config } from '../core/config.ts'
import { isTextMime } from '../core/util.ts'
import { acceptsFile } from '../llm/common.ts'
import { fileKind } from '../llm/types.ts'
import { checkQuota } from '../billing/ledger.ts'
import { utilityChat } from '../chat/utility.ts'
import { readLocalFile } from './imageFiles.ts'
import { registry, toolUnavailable, type ToolCtx } from './registry.ts'

/** Text per read_file call; tool results are capped at 8000 characters. */
const TEXT_CHUNK = 6000
/** Video/audio/PDF bytes one reply may add to the context (Gemini takes 100 MB inline per request). */
const MAX_FILE_BYTES_PER_TURN = 60 * 1024 * 1024

const DESCRIBE_PROMPT = '你替另一个看不到这个文件的模型查看它。详细客观地描述内容：视频按时间顺序写出画面、动作和关键时间点，转写说话与屏幕文字；音频转写说话并描述声音；文档概括结构并摘录要点。若给了关注的问题，优先回答它。只写看到或听到的，不猜测，不提自己是辅助模型。'

/** The vision model, else the default model, when it can read this type natively. */
function fileReader(mime: string, ctx: ToolCtx): string | undefined {
  return [config.get().visionModel, config.defaultModelId()].find(id => {
    const model = config.getModel(id), provider = model && config.getProvider(model.provider)
    return model && provider && config.hasKey(provider) && model.vision !== false && acceptsFile(provider, mime)
      && !checkQuota(model, { userId: ctx.e.user_id, groupId: ctx.e.group_id, isAdmin: ctx.isAdmin })
  })
}

export const scopeForImages = (ctx: ToolCtx) => ctx.turn.imageScope ?? chatImageScope(ctx.e)
export function currentImages(ctx: ToolCtx): SavedImage[] {
  return ctx.turn.imageRefs ??= (ctx.turn.inputImages ?? []).map(part => saveImage(scopeForImages(ctx), part))
}
export function registerImageTools() {
  pruneImages()
  setInterval(pruneImages, 3600_000).unref()
  registry.register({
    name: 'read_file', budgetExempt: true, source: 'builtin',
    description: '按路径读取文件并加入你的上下文（不会发送给用户）：本对话附件（[图片N]/[视频N]/[音频N]/[文件N] 标注中的 /work/attachments 路径）、AGY 输出（/work/agy/<会话>/out/...）或本次回复代码目录中的文件。图片作为原生图片；视频、音频、PDF 由模型原生理解，当前模型不支持时由可读取的辅助模型代看并返回文字描述；文本文件返回文字，较长时用 offset 续读。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: '文本文件从第几个字开始读，默认 0' },
        question: { type: 'string', description: '可选：由辅助模型代看时希望它关注的问题' },
      },
      required: ['path'], additionalProperties: false,
    },
    // a helper model describing a long video can take well over the default minute
    timeoutMs: 180_000,
    async run(args, ctx) {
      if (typeof args.path !== 'string' || !args.path.trim()) {
        return { content: '缺少 path 参数，请提供要读取的文件路径', isError: true }
      }
      try {
        const { file, part } = await readLocalFile(args.path.trim(), ctx)
        if (part.type === 'image') {
          if (ctx.model.vision === false) return { content: '当前模型不支持读取图片', isError: true }
          const refs = currentImages(ctx)
          if (!refs.some(ref => ref.path === file.path)) refs.push(file)
          return { content: imageLabel(file), images: [part] }
        }
        if (isTextMime(file.mime)) {
          const text = Buffer.from(part.data, 'base64').toString('utf8')
          const offset = Math.min(text.length, Math.max(0, Math.floor(Number(args.offset) || 0)))
          const end = Math.min(text.length, offset + TEXT_CHUNK)
          return `${imageLabel(file)}（${file.mime}，共 ${text.length} 字，本次第 ${offset}–${end} 字${end < text.length ? `；用 offset=${end} 继续读` : ''}）\n${text.slice(offset, end)}`
        }
        const provider = config.getProvider(ctx.model.provider)
        const kind = fileKind(file.mime)
        const native = provider && acceptsFile(provider, file.mime)
        const used = (ctx.turn.fileBytes ?? 0) + file.bytes
        if (used > MAX_FILE_BYTES_PER_TURN) return { content: `本次回复读取的${kind}等文件总量已达上限，请先回复用户`, isError: true }
        if (!native) {
          const helper = fileReader(file.mime, ctx)
          if (helper) {
            ctx.turn.fileBytes = used
            const question = typeof args.question === 'string' && args.question.trim() ? args.question.trim().slice(0, 500) : ''
            const { text, model } = await utilityChat({
              candidates: [helper], system: DESCRIBE_PROMPT, maxTokens: 2000, signal: ctx.signal,
              quotaCtx: { userId: ctx.e.user_id, groupId: ctx.e.group_id, isAdmin: ctx.isAdmin },
              user: [{ type: 'text', text: question ? `关注的问题：${question}` : `请描述这个${kind}。` }, { ...part, name: file.name }],
            })
            if (!text.trim()) throw Error(`辅助模型 ${model.id} 没有返回内容`)
            return `${imageLabel(file)}（${file.mime}）当前模型无法直接读取，以下是辅助模型 ${model.id} 的描述，不是你亲眼所见：\n${text.trim()}`
          }
          // Only suggest tools this turn can actually call.
          const options = [!toolUnavailable('run_code', ctx) && `用 run_code 处理 ${file.path}`, !toolUnavailable('agy', ctx) && '交给 agy'].filter(Boolean)
          return { content: `当前模型无法直接读取${kind}（${file.mime}），也没有可读取它的辅助模型。${options.length ? `可${options.join('，或')}。` : ''}`, isError: true }
        }
        ctx.turn.fileBytes = used
        return { content: `${imageLabel(file)}（${file.mime}，${(file.bytes / 1048576).toFixed(1)} MB）已作为原生${kind}加入上下文`, files: [{ ...part, name: file.name }] }
      } catch (err: any) {
        return { content: `读取文件失败：${err?.message ?? err}`, isError: true }
      }
    },
  })
}
