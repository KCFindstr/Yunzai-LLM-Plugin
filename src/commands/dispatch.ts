import { log } from '../core/log.ts'
import { getLoader } from '../core/yunzai.ts'

/** Marker on synthesized events so our own chat handler ignores them. */
export const DISPATCHED = 'llmDispatched'

/**
 * Re-dispatch `command` through Yunzai's real PluginsLoader as if the same user had sent it (with an @bot so
 * onlyReplyAt groups accept it). Permissions, group enable/disable and cooldown logic all apply unchanged.
 */
export async function dispatchCommand(e: any, command: string): Promise<{ replied: boolean }> {
  const loader = await getLoader()
  if (!loader?.deal) throw new Error('PluginsLoader 不可用')

  let replied = false
  const target = e.group?.sendMsg ? e.group : e.friend
  const raw = target?.sendMsg?.bind(target) ?? e.reply
  const e2: any = {
    post_type: e.post_type ?? 'message',
    message_type: e.message_type,
    sub_type: e.sub_type,
    self_id: e.self_id,
    user_id: e.user_id,
    group_id: e.group_id,
    guild_id: e.guild_id,
    channel_id: e.channel_id,
    group_name: e.group_name,
    sender: e.sender ? { ...e.sender } : undefined,
    time: Math.floor(Date.now() / 1000),
    message_id: e.message_id,
    seq: e.seq,
    rand: e.rand,
    adapter_id: e.adapter_id,
    adapter_name: e.adapter_name,
    message: [...(e.group_id ? [{ type: 'at', qq: e.self_id }] : []), { type: 'text', text: command }],
    raw_message: command,
    [DISPATCHED]: true,
    reply: async (...args: any[]) => {
      replied = true
      return raw(...args)
    },
  }
  for (const k of ['bot', 'friend', 'group', 'member'])
    if (e[k] !== undefined) Object.defineProperty(e2, k, { value: e[k], configurable: true })

  // The original @-message already put this user/group on cooldown; that must not swallow the command.
  if (e.group_id) {
    delete loader.groupCD?.[e.group_id]
    delete loader.singleCD?.[`${e.group_id}.${e.user_id}`]
  }
  if (loader.msgThrottle) delete loader.msgThrottle[`${e.self_id}:${e.user_id}:${command}`]

  log.mark(`自然语言指令 -> ${command}`)
  await loader.deal(e2)
  return { replied }
}
