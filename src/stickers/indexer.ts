import fs from 'node:fs'
import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { extractJson, utilityCandidates, utilityChat } from '../chat/utility.ts'
import { stickerFile, uniqueName, updateSticker, type Sticker } from './store.ts'

const INDEX_PROMPT = `你在帮QQ聊天机器人整理表情包库。请看图片，只输出一个JSON对象，不要其他文字：
{"name":"2-6个字的简短名称，口语化、能概括这个表情（如：狗头保命、猫猫震惊、委屈巴巴）","desc":"画面内容与情绪，20字以内","use":"适合在什么聊天场景发，20字以内","tags":["3到6个情绪/场景标签"],"text":"图中的文字，没有则为空字符串"}`

export async function indexSticker(s: Sticker, opts: { hint?: string; userId?: string } = {}): Promise<Sticker> {
  const file = stickerFile(s)
  if (!file || !fs.existsSync(file)) throw new Error('表情文件不存在')
  const data = fs.readFileSync(file).toString('base64')
  const { text } = await utilityChat({
    candidates: utilityCandidates(config.get().sticker.indexModel, true),
    vision: true,
    system: INDEX_PROMPT,
    user: [
      { type: 'image', data, mime: s.mime ?? 'image/png' },
      { type: 'text', text: opts.hint ? `管理员备注：${opts.hint}` : '请分析这个表情包。' },
    ],
    maxTokens: 400,
    quotaCtx: { userId: opts.userId, isAdmin: true },
  })
  const j = extractJson(text)
  if (!j?.name) throw new Error(`识别结果无法解析: ${text.slice(0, 80)}`)
  const patch: Partial<Sticker> = {
    name: uniqueName(String(j.name), s.id),
    desc: String(j.desc ?? '').slice(0, 40),
    use: String(j.use ?? '').slice(0, 40),
    tags: (Array.isArray(j.tags) ? j.tags : []).map(String).slice(0, 8),
    text: String(j.text ?? '').slice(0, 60),
    indexed: true,
  }
  updateSticker(s.id, patch)
  log.info(`表情 ${s.id} 识别为「${patch.name}」`)
  return { ...s, ...patch }
}
