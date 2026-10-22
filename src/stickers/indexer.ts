import fs from 'node:fs'
import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { extractJson, utilityCandidates, utilityChat } from '../chat/utility.ts'
import { stickerFile, uniqueName, updateSticker, type Sticker } from './store.ts'

const INDEX_PROMPT = `你在帮QQ聊天机器人整理表情包库。请看图片，只输出一个JSON对象，不要其他文字，五个字段都必须填写：
{"name":"2-6个字的简短名称，口语化、能概括这个表情（如：狗头保命、猫猫震惊、委屈巴巴）","desc":"画面内容与情绪，20字以内","use":"适合在什么聊天场景发，20字以内","tags":["3到6个情绪/场景标签"],"text":"图中的文字，没有则为空字符串"}`

export type IndexMode = 'full' | 'fill'

/** A sticker lacks recognition output a vision pass would provide (usage, tags). */
export function stickerIncomplete(s: Sticker): boolean {
  return !s.use?.trim() || !s.tags?.length
}

const complete = (j: any) => j && String(j.name ?? '').trim() && String(j.desc ?? '').trim() && String(j.use ?? '').trim() && Array.isArray(j.tags) && j.tags.length

/**
 * Recognise a sticker with the vision model.
 * - `full`: replace name, description, usage, tags and text with the model's reading.
 * - `fill`: keep what is already filled in (a hand-given name/description) and fill only the empty fields.
 * `dryRun` returns the result without saving (the web editor previews it). Retries once if fields come back empty.
 */
export async function indexSticker(
  s: Sticker,
  opts: { hint?: string; userId?: string; mode?: IndexMode; dryRun?: boolean } = {},
): Promise<Sticker> {
  const file = stickerFile(s)
  if (!file || !fs.existsSync(file)) throw new Error('表情文件不存在')
  const data = fs.readFileSync(file).toString('base64')
  const fill = opts.mode === 'fill'
  const known = fill
    ? [s.name && s.name !== '未命名' && `名称：${s.name}`, s.desc && `描述：${s.desc}`, s.use && `适用场景：${s.use}`].filter(Boolean).join('；')
    : ''
  const ask = (retry: boolean) => utilityChat({
    candidates: utilityCandidates(config.get().sticker.indexModel, true),
    vision: true,
    system: INDEX_PROMPT,
    user: [
      { type: 'image', data, mime: s.mime ?? 'image/png' },
      {
        type: 'text',
        text: [
          opts.hint ? `管理员备注：${opts.hint}` : '请分析这个表情包。',
          known ? `已有信息（参考并保持一致）：${known}` : '',
          retry ? '上一次的输出缺少字段：use 和 tags 必须填写，tags 至少3个。请输出完整的JSON。' : '',
        ].filter(Boolean).join('\n'),
      },
    ],
    maxTokens: 400,
    quotaCtx: { userId: opts.userId, isAdmin: true },
  })
  let j = extractJson((await ask(false)).text)
  if (!complete(j)) {
    const again = extractJson((await ask(true)).text)
    if (again && (complete(again) || !j)) j = again
  }
  if (!j || (!fill && !String(j.name ?? '').trim())) throw new Error('识别结果无法解析')

  const tags = (Array.isArray(j.tags) ? j.tags : []).map((t: any) => String(t).trim()).filter(Boolean).slice(0, 8)
  const read = {
    name: String(j.name ?? '').trim(),
    desc: String(j.desc ?? '').trim().slice(0, 40),
    use: String(j.use ?? '').trim().slice(0, 40),
    tags,
    text: String(j.text ?? '').trim().slice(0, 60),
  }
  const keepName = fill && s.name && s.name !== '未命名'
  const patch: Partial<Sticker> = {
    name: keepName ? s.name : uniqueName(read.name || s.name, s.id),
    desc: fill && s.desc ? s.desc : read.desc,
    use: fill && s.use ? s.use : read.use,
    tags: fill && s.tags?.length ? s.tags : read.tags,
    text: fill && s.text ? s.text : read.text,
    indexed: true,
  }
  if (!opts.dryRun) {
    updateSticker(s.id, patch)
    log.info(`表情 ${s.id} ${fill ? '补全' : '识别为'}「${patch.name}」${patch.use ? ` · ${patch.use}` : ''}`)
  }
  return { ...s, ...patch }
}
