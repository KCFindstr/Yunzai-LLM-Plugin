import type { QuotaCtx } from '../billing/ledger.ts'
import type { ChatSection, ThinkingJudgeConfig, ThinkingLevel, ThinkingSetting } from '../core/configTypes.ts'
import { brief, log } from '../core/log.ts'
import { utilityCandidates, utilityChat } from './utility.ts'

/** Requests that benefit from deeper reasoning or research. */
const COMPLEX =
  /为什么|原理|分析|推导|证明|计算|算一下|算算|代码|编程|程序|脚本|bug|报错|异常|比较|对比|区别|优缺点|利弊|如何实现|怎么实现|怎么做|方案|规划|计划|攻略|配队|养成|推荐|详细|具体|解释|总结|归纳|翻译|写一[篇段个份首]|帮我写|数学|方程|题目|论文|评价|考证|查一?下|搜一?下|最新|新闻|版本|history|explain|analy[sz]e|compare|implement|debug|calculate|summari[sz]e|translate/i
const QUESTION = /[?？]|吗$|呢$|吗[?？!！。]*$|怎么|如何|什么|哪|多少|几[个点号时]|是不是|能不能|可以吗|谁/

export type MessageKind = 'casual' | 'question' | 'complex'

/** Heuristic, no API call: complex (reasoning/research cues or long), question, or casual chit-chat. */
export function classifyMessage(text: string, opts: { images?: number; quoted?: boolean } = {}): MessageKind {
  const t = text.replace(/【[^】]*】/g, '').trim()
  if (!t) return opts.images ? 'question' : 'casual'
  if (COMPLEX.test(t) && t.length >= 6) return 'complex'
  if (t.length > 80) return 'complex'
  if (QUESTION.test(t) || opts.images || (opts.quoted && t.length > 10)) return 'question'
  return 'casual'
}

/** System prompt for the model judge (stable, so providers can cache it). */
export const JUDGE_PROMPT = [
  '你是消息分类器。QQ群里的聊天机器人收到一条消息，判断回复它需要多少思考。只输出一个英文单词：casual、question 或 complex。',
  'casual：闲聊、打招呼、玩梗、逗机器人、问机器人自己（你是谁/你喜欢什么/你觉得呢）、让机器人执行查询指令（查面板、深渊、体力等）、让机器人记住某事或发表情。',
  'question：有明确答案、一两步就能答的问题：一个事实、定义、日期、价格、版本、属性、简单用法、短句翻译、常识科普。',
  'complex：需要多步推理或综合信息：配队/抽卡/资源规划、比较分析、写代码或排查报错、计算、写文章、制定计划、整理攻略、汇总多个来源的新闻、根据对方给出的条件出主意。',
].join('\n')

export function judgeUserText(text: string, opts: { images?: number; quotedText?: string }): string {
  const lines = [`消息：${text.slice(0, 600) || '（空）'}`]
  if (opts.images) lines.push(`（附带 ${opts.images} 张图片）`)
  if (opts.quotedText) lines.push(`引用的消息：${opts.quotedText.slice(0, 300)}`)
  return lines.join('\n')
}

export function parseJudge(out: string): MessageKind | undefined {
  const m = /casual|question|complex/i.exec(out)
  return m ? (m[0].toLowerCase() as MessageKind) : undefined
}

const KIND_CRITERIA: Record<MessageKind, string> = {
  casual: '闲聊、打招呼、玩梗、逗机器人、问机器人自己、让机器人执行查询指令/记住某事/发表情',
  question: '有明确答案、一两步就能答的问题：事实、定义、日期、价格、版本、简单用法、短句翻译、常识科普',
  complex: '需要多步推理或综合信息：规划、比较分析、写代码/排查报错、计算、写文章、制定计划、整理攻略、汇总新闻、按条件出主意',
}

export interface JudgeInput {
  text: string
  images?: number
  quoted?: boolean
  quotedText?: string
}

export interface Judgement {
  kind: MessageKind
  /** who decided: skipped the judge (obvious), the judge, or the keyword fallback */
  source: 'obvious' | 'model' | 'systemone' | 'heuristic'
  ms: number
}

/** Cases not worth a judge call: nothing to read, a few characters of chit-chat, or a wall of text. */
function obvious(t: string, input: JudgeInput): MessageKind | undefined {
  if (!t) return input.images ? 'question' : 'casual'
  if (t.length <= 4 && !/[?？]/.test(t) && !input.quoted) return 'casual'
  if (t.length > 300) return 'complex'
  return undefined
}

async function judgeWithModel(input: JudgeInput, cfg: ThinkingJudgeConfig, quotaCtx: QuotaCtx): Promise<MessageKind | undefined> {
  const { text } = await utilityChat({
    candidates: utilityCandidates(cfg.model || undefined),
    system: JUDGE_PROMPT,
    user: [{ type: 'text', text: judgeUserText(input.text, input) }],
    maxTokens: 8,
    thinking: 'off',
    temperature: 0,
    quotaCtx,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  return parseJudge(text)
}

/** TypeSafe System One API (Jev), also served by self-hosted Kev. */
async function judgeWithSystemOne(input: JudgeInput, cfg: ThinkingJudgeConfig): Promise<MessageKind | undefined> {
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({
      model: cfg.systemoneModel,
      state: judgeUserText(input.text, input),
      questions: { kind: { type: 'choice', instructions: 'QQ群聊天机器人回复这条消息需要多少思考？', criteria: KIND_CRITERIA } },
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  })
  if (!res.ok) throw new Error(`System One HTTP ${res.status}`)
  const j: any = await res.json()
  return parseJudge(String(j?.answers?.kind?.choice ?? ''))
}

/** Classify a message for thinking=auto; any judge failure or timeout falls back to the keyword heuristic. */
export async function judgeMessage(input: JudgeInput, cfg: ThinkingJudgeConfig, quotaCtx: QuotaCtx): Promise<Judgement> {
  const started = Date.now()
  const done = (kind: MessageKind, source: Judgement['source']) => ({ kind, source, ms: Date.now() - started })
  const t = input.text.replace(/【[^】]*】/g, '').trim()
  const fast = obvious(t, input)
  if (fast) return done(fast, 'obvious')
  if (cfg.mode !== 'heuristic') {
    try {
      const kind = cfg.mode === 'systemone' ? await judgeWithSystemOne({ ...input, text: t }, cfg) : await judgeWithModel({ ...input, text: t }, cfg, quotaCtx)
      if (kind) return done(kind, cfg.mode)
      log.info('思考强度判断：无法解析结果，改用关键词规则')
    } catch (err: any) {
      log.info(`思考强度判断失败（${err?.message ?? err}），改用关键词规则`)
    }
  }
  return done(classifyMessage(t, input), 'heuristic')
}

/**
 * Resolve a thinking setting for this message. `auto` maps the message kind through chat.autoThinking.
 * Note: on Anthropic, changing effort between turns invalidates the cached message prefix, so `auto` trades some
 * cache hits for cheaper casual replies there; Gemini/OpenAI caches are unaffected.
 */
export async function resolveThinking(setting: ThinkingSetting, chat: ChatSection, input: JudgeInput, quotaCtx: QuotaCtx): Promise<ThinkingLevel> {
  if (setting !== 'auto') return setting
  const levels = chat.autoThinking
  if (levels.casual === levels.question && levels.question === levels.complex) return levels.casual
  const j = await judgeMessage(input, chat.thinkingJudge, quotaCtx)
  log.info(`思考强度 ${levels[j.kind]}（${j.kind}，由 ${j.source} 判断${j.source === 'obvious' ? '' : `，${j.ms}ms`}）：${brief(input.text, 40)}`)
  return levels[j.kind]
}
