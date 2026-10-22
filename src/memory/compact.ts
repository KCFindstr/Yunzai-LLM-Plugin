import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { utilityCandidates, utilityChat } from '../chat/utility.ts'
import { isSensitive, limitsOf, listMemory, replaceMemory, usage, type MemScope } from './store.ts'

const running = new Set<string>()

const PROMPT = (max: number, chars: number) =>
  `你在整理聊天机器人的长期记忆。合并重复或相近的条目，删除过时、琐碎或互相矛盾中较旧的信息，保留对以后聊天有用的事实。
要求：每条一句话，不超过${chars}字；最多保留${max}条；不要编造新信息。只输出一个 JSON 字符串数组，例如 ["喜欢被叫阿明","主玩原神，常用胡桃"]。`

/**
 * Consolidate a memory list once it passes `threshold` of its budget, targeting ~60% so new facts fit.
 * The model's output is validated against the hard limits; on any problem the list is left unchanged.
 */
export async function maybeCompact(scope: MemScope, key: string, ctx: { userId?: string | number; groupId?: string | number }) {
  const cfg = config.get().memory
  if (!cfg.autoCompact) return
  const u = usage(scope, key)
  if (u.ratio < 0.8 || running.has(`${scope}:${key}`)) return
  running.add(`${scope}:${key}`)
  try {
    const lim = limitsOf(scope)
    const target = Math.max(3, Math.floor(lim.maxEntries * 0.6))
    const list = listMemory(scope, key)
    const snapshot = JSON.stringify(list)
    const { text } = await utilityChat({
      candidates: utilityCandidates(),
      system: PROMPT(target, lim.entryMaxChars),
      user: [{ type: 'text', text: list.map(m => `- ${m.text}`).join('\n') }],
      maxTokens: 800,
      quotaCtx: { userId: ctx.userId, groupId: ctx.groupId, isAdmin: true },
    })
    const m = /\[[\s\S]*\]/.exec(text.replace(/```(?:json)?/g, ''))
    const arr: unknown = m ? JSON.parse(m[0]) : undefined
    if (!Array.isArray(arr)) throw new Error('输出不是 JSON 数组')
    const texts = arr.map(x => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean)
    const total = texts.reduce((a, t) => a + t.length, 0)
    if (!texts.length) throw new Error('结果为空')
    if (texts.length > lim.maxEntries || total > lim.maxChars || texts.some(t => t.length > lim.entryMaxChars || isSensitive(t)))
      throw new Error('结果超出限制')
    if (texts.length >= list.length && total >= u.chars) throw new Error('没有缩减')
    if (JSON.stringify(listMemory(scope, key)) !== snapshot) return
    replaceMemory(scope, key, texts)
    log.info(`长期记忆整理 ${scope}:${key} ${list.length}条/${u.chars}字 -> ${texts.length}条/${total}字`)
  } catch (err: any) {
    log.warn(`长期记忆整理失败 ${scope}:${key}: ${err?.message ?? err}（保持原样）`)
  } finally {
    running.delete(`${scope}:${key}`)
  }
}
