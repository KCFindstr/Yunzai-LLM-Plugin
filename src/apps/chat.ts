import { DISPATCHED } from '../commands/dispatch.ts'
import { config } from '../core/config.ts'
import type { PluginConfig } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { formatDuration, formatUsd, pick, sleep, truncate } from '../core/util.ts'
import { compactSession, runTurn, type TurnOutcome } from '../chat/agent.ts'
import { recordGroupMessage } from '../chat/groupLog.ts'
import { extractInput, getQuoted } from '../chat/message.ts'
import { Cooldown } from '../chat/ratelimit.ts'
import { deliver } from '../chat/reply.ts'
import { sessionKey } from '../chat/session.ts'
import { pickModel } from '../chat/utility.ts'
import { BasePlugin } from './base.ts'
import { conversationLocks as locks } from '../chat/coordination.ts'
import { observeUsers } from '../chat/roster.ts'

const userCd = new Cooldown()
const quotaNotice = new Cooldown()
const errorNotice = new Cooldown()

const EMPTY_AT = ['在呢', '嗯？', '怎么啦', '咋了', '我在~', '？']
const ERROR_LINES = ['唔，我这边网络有点问题，等会儿再试试吧', '脑子卡住了…稍后再问我一次吧', '刚刚走神了，过会儿再来找我吧']

type Reason = 'at' | 'alias' | 'prefix' | 'reply' | 'private'

const inList = (list: (string | number)[], v: any) => list.some(x => String(x) === String(v))

/** Decide whether this message is addressed to us. Only explicit invocations count. */
export async function triggerReason(e: any, cfg: PluginConfig): Promise<Reason | undefined> {
  if (e[DISPATCHED] || !cfg.enable) return undefined
  if (String(e.user_id) === String(e.self_id)) return undefined
  if (inList(cfg.trigger.userBlacklist, e.user_id)) return undefined
  if (e.group_id) {
    if (cfg.trigger.groupWhitelist.length && !inList(cfg.trigger.groupWhitelist, e.group_id)) return undefined
    if (inList(cfg.trigger.groupBlacklist, e.group_id)) return undefined
    if (!config.effective(e.group_id).enable) return undefined
    if (cfg.trigger.at && e.atBot) return 'at'
    if (cfg.trigger.alias && e.hasAlias) return 'alias'
    if (e.msg && cfg.trigger.prefixes.some(p => p && e.msg.startsWith(p))) return 'prefix'
    if (cfg.trigger.replyToBot && e.reply_id && (await getQuoted(e))?.fromBot) return 'reply'
    return undefined
  }
  if (e.message_type !== 'private' && !e.isPrivate) return undefined
  if (cfg.trigger.private === 'off') return undefined
  if (cfg.trigger.private === 'master' && !config.isAdmin(e)) return undefined
  return 'private'
}

function hasContent(e: any): boolean {
  return (e.message ?? []).some(
    (s: any) =>
      (s?.type === 'text' && String(s.text ?? '').trim()) ||
      (s?.type === 'at' && String(s.qq) !== String(e.self_id)) ||
      ['image', 'mface', 'face', 'file', 'json', 'xml', 'forward'].includes(s?.type),
  )
}

function quotaText(out: Extract<TurnOutcome, { kind: 'quota' }>): string {
  const b = out.block
  const win = b.window === '5h' ? '5小时' : '本周'
  const when = b.resetInMs > 0 ? `，大约 ${formatDuration(b.resetInMs)} 后恢复` : ''
  const usage = `（${formatUsd(b.used)}/${formatUsd(b.limit)}）`
  if (b.scope === 'user') return `你${win}的聊天额度用完啦${usage}${when}~`
  if (b.scope === 'group') return `本群${win}的聊天额度用完啦${usage}${when}`
  return `我${win}的额度用完了${usage}${when}，先休息一下~`
}

export class LLMChat extends BasePlugin {
  constructor() {
    super({
      name: 'LLM对话',
      dsc: '@机器人 智能对话（不会抢占其它插件的指令）',
      event: 'message',
      priority: config.get().trigger.priority,
      rule: [{ reg: '[\\s\\S]*', fnc: 'onMessage', log: false }],
    })
  }

  async init() {
    const B = globalThis.Bot
    if (!B?.on) return
    const listener = (e: any) => {
      try {
        recordGroupMessage(e)
      } catch {}
    }
    B.on('message.group', listener)
    this.addCleanup?.(() => B.off?.('message.group', listener))
  }

  async onMessage(): Promise<boolean> {
    const e = this.e
    observeUsers(e)
    const cfg = config.get()
    const reason = await triggerReason(e, cfg)
    if (!reason) return false

    const eff = config.effective(e.group_id)
    const isAdmin = config.isAdmin(e)
    if (!hasContent(e) && !e.reply_id) {
      const usable = Boolean(pickModel([eff.model, ...cfg.fallbackModels]))
      if (usable && cfg.trigger.emptyAtReply && reason === 'at' && userCd.pass(`empty:${e.self_id}:${e.user_id}`, 30))
        await e.reply(pick(EMPTY_AT))
      return true
    }
    const convKey = sessionKey(e, eff.chat.sessionScope)
    if (locks.pending(convKey) >= eff.chat.maxPending) {
      if (errorNotice.pass(`busy:${convKey}`, 15)) await e.reply('这会儿消息有点多，稍后再叫我一下吧')
      return true
    }
    const startAt = isAdmin ? Date.now() : userCd.reserve(`${e.self_id}:${e.user_id}`, cfg.trigger.userCooldown)

    await locks.run(convKey, async () => {
      await sleep(startAt - Date.now())
      const startedAt = Date.now()
      let afterReply: (() => void)[] | undefined
      try {
        const model = pickModel([eff.model, ...cfg.fallbackModels])?.model
        const input = await extractInput(e, {
          includeImages: eff.chat.includeImages,
          maxImages: eff.chat.maxImages,
          includeQuoted: eff.chat.includeQuoted,
          vision: model?.vision !== false,
        })
        if (reason === 'prefix') {
          const p = cfg.trigger.prefixes.find(x => input.text.startsWith(x))
          if (p) input.text = input.text.slice(p.length).trim()
        }

        const out = await runTurn({ e, eff, input, isAdmin, convKey })
        afterReply = out.afterReply
        if (out.kind === 'quota') {
          if (quotaNotice.pass(`${e.self_id}:${e.user_id}:${out.block.scope}`, cfg.quota.notifyCooldown))
            await e.reply(quotaText(out), Boolean(e.group_id))
          return
        }
        if (out.kind === 'error') {
          // not set up yet: stay silent for regular users, only tell admins how to fix it
          if (out.unconfigured && !isAdmin) {
            log.warn(out.message)
            return
          }
          const key = e.group_id ? `g${e.group_id}` : `p${e.user_id}`
          if (eff.reply.errorNotice && errorNotice.pass(key, eff.reply.errorCooldown))
            await e.reply(isAdmin ? `LLM 出错：${truncate(out.message, 150)}` : pick(ERROR_LINES), Boolean(e.group_id))
          return
        }
        const suppressText = Boolean(out.dispatched) && !eff.tools.botCommand.ack
        await deliver(e, out.text, eff, { startedAt, convKey, suppressText, images: out.images })
        await compactSession(convKey, eff, { userId: e.user_id, groupId: e.group_id, isAdmin })
      } catch (err: any) {
        log.error('处理对话失败', err)
      } finally {
        for (const start of afterReply ?? []) start()
      }
    })
    return true
  }
}
