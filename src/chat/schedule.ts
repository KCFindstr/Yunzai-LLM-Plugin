import { config } from '../core/config.ts'
import { log } from '../core/log.ts'
import { JsonStore } from '../core/store.ts'
import { formatNow, truncate } from '../core/util.ts'
import { seg } from '../core/yunzai.ts'
import { conversationLocks } from './coordination.ts'
import { sessionKey } from './session.ts'
import type { TurnOutcome, TurnRequest } from './agent.ts'

/**
 * Scheduled wake-ups: the model (or an admin in the web panel) leaves itself a task to do later in the same
 * conversation, once or on a repeat. Tasks persist across restarts; when one is due, a stand-in event for the
 * original chat is rebuilt from the saved ids and the task runs as a normal turn whose reply goes to that chat.
 * Times are China time (UTC+8, no DST), like every other date in the plugin.
 */

export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'interval'
export const REPEATS: Repeat[] = ['none', 'daily', 'weekdays', 'weekly', 'interval']
export type TaskStatus = 'active' | 'done' | 'cancelled' | 'failed' | 'missed'

export interface ScheduledTask {
  id: string
  /** What to do when it fires, written as a note to the bot itself. */
  task: string
  /** The message that asked for it, for context when it fires. */
  request?: string
  createdAt: number
  updatedAt: number
  createdBy: 'chat' | 'web'
  selfId: string
  userId: string
  userName: string
  groupId?: string
  groupName?: string
  /** The requester was an admin when the task was created; the wake-up turn runs with the same rights. */
  admin: boolean
  nextAt: number
  repeat: Repeat
  everyMinutes?: number
  status: TaskStatus
  runs: number
  /** Scheduled from a wake-up turn: how many wake-ups led here (bounds self-rescheduling loops). */
  chain: number
  lastRunAt?: number
  lastResult?: string
  lastError?: string
  lastRolloutId?: string
}

const TZ_OFFSET = 8 * 3600_000
const MINUTE = 60_000
const DAY = 86400_000
/** A one-off task that could not run for this long (bot offline) is dropped as missed. */
const ONE_OFF_GRACE = DAY
/** A repeat that is this late skips to its next time instead of running late. */
const REPEAT_GRACE = 30 * MINUTE
/** Finished tasks stay visible in the web panel this long. */
const KEEP_FINISHED = 30 * DAY
const MAX_STORED = 1000
export const MAX_TASK_CHARS = 500
export const MAX_HORIZON = 366 * DAY
const TICK_MS = 15_000

const store = new JsonStore<ScheduledTask[]>('schedules.json', [])
if (!Array.isArray(store.data)) store.data = []
const running = new Set<string>()

export const listTasks = () => store.data
export const getTask = (id: string) => store.data.find(t => t.id === id)
export const isRunning = (id: string) => running.has(id)

function save() {
  const cutoff = Date.now() - KEEP_FINISHED
  const keep = store.data.filter(t => t.status === 'active' || t.updatedAt > cutoff)
  if (keep.length > MAX_STORED) keep.splice(0, keep.length - MAX_STORED)
  store.data = keep
  store.save()
}

// ---------- time ----------

/** UTC+8 wall clock of a timestamp: day of week (0 = Sunday) and the timestamp of that local midnight. */
const local = (ts: number) => {
  const d = new Date(ts + TZ_OFFSET)
  return { weekday: d.getUTCDay(), midnight: ts - ((ts + TZ_OFFSET) % DAY) }
}

/**
 * "2026-10-29 08:00", "2026-10-29T08:00", "10-29 08:00" or "08:00" in China time. A date without a year is
 * this year, or next year once it has passed; a bare time is the next time the clock shows it.
 */
export function parseTime(text: string, now = Date.now()): number | undefined {
  const m = String(text ?? '').trim().match(/^(?:(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})[ T]+)?(\d{1,2})[:：](\d{2})(?::\d{2})?$/)
  if (!m) return undefined
  const [, y, mo, d, hh, mm] = m
  if (Number(hh) > 23 || Number(mm) > 59) return undefined
  if (!mo) {
    const today = local(now).midnight + (Number(hh) * 60 + Number(mm)) * MINUTE
    return today > now ? today : today + DAY
  }
  const at = (year: number) => {
    const ts = Date.UTC(year, Number(mo) - 1, Number(d), Number(hh), Number(mm)) - TZ_OFFSET
    // reject 02-30 and the like, which Date.UTC rolls over into the next month
    return new Date(ts + TZ_OFFSET).getUTCDate() === Number(d) ? ts : undefined
  }
  const year = new Date(now + TZ_OFFSET).getUTCFullYear()
  if (y) return at(Number(y))
  const ts = at(year)
  return ts != null && ts <= now ? at(year + 1) : ts
}

/** The first time after `now` a repeat that was due at `from` comes round again; undefined for one-off tasks. */
export function nextOccurrence(from: number, repeat: Repeat, everyMinutes: number | undefined, now = Date.now()): number | undefined {
  if (repeat === 'none') return undefined
  if (repeat === 'interval') {
    const step = Math.max(1, everyMinutes ?? 0) * MINUTE
    return from + Math.max(1, Math.ceil((now - from + 1) / step)) * step
  }
  const step = repeat === 'weekly' ? 7 * DAY : DAY
  let t = from + step
  if (t <= now) t += Math.ceil((now - t + 1) / step) * step
  if (repeat === 'weekdays') while ([0, 6].includes(local(t).weekday)) t += DAY
  return t
}

export function describeRepeat(t: Pick<ScheduledTask, 'repeat' | 'everyMinutes'>): string {
  if (t.repeat === 'daily') return '每天'
  if (t.repeat === 'weekdays') return '每个工作日'
  if (t.repeat === 'weekly') return '每周'
  if (t.repeat === 'interval') {
    const m = t.everyMinutes ?? 0
    return m % 1440 === 0 ? `每 ${m / 1440} 天` : m % 60 === 0 ? `每 ${m / 60} 小时` : `每 ${m} 分钟`
  }
  return '一次性'
}

// ---------- create / edit ----------

export interface ScheduleLimits { maxPerUser: number; minInterval: number }

export interface NewTask {
  task: string
  nextAt: number
  repeat: Repeat
  everyMinutes?: number
}

/** Why `t` is not a valid schedule; undefined when it is. */
export function validateTask(t: NewTask, limits: Pick<ScheduleLimits, 'minInterval'>, now = Date.now()): string | undefined {
  if (!t.task.trim()) return '缺少任务内容'
  if (t.task.length > MAX_TASK_CHARS) return `任务内容过长（${t.task.length} 字），请缩减至 ${MAX_TASK_CHARS} 字以内`
  if (!REPEATS.includes(t.repeat)) return `不支持的重复方式「${t.repeat}」`
  if (!Number.isFinite(t.nextAt)) return '时间无效'
  if (t.nextAt < now + 30_000) return '时间必须在至少 1 分钟之后'
  if (t.nextAt > now + MAX_HORIZON) return '只能安排一年以内的任务'
  if (t.repeat === 'interval') {
    if (!Number.isFinite(t.everyMinutes) || t.everyMinutes! < limits.minInterval) return `重复间隔至少 ${limits.minInterval} 分钟`
    if (t.everyMinutes! > 30 * 1440) return '重复间隔最多 30 天'
  }
}

/** Active tasks of `userId` (across chats) and of everyone. */
export function activeCounts(userId: string) {
  const active = store.data.filter(t => t.status === 'active')
  return { user: active.filter(t => t.userId === userId).length, total: active.length }
}
export const MAX_ACTIVE_TOTAL = 200

export function addTask(owner: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt' | 'status' | 'runs' | keyof NewTask>, t: NewTask): ScheduledTask {
  const now = Date.now()
  let id: string
  do id = `s${now.toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`
  while (getTask(id))
  const task: ScheduledTask = { ...owner, id, task: t.task.trim(), nextAt: t.nextAt, repeat: t.repeat,
    ...(t.repeat === 'interval' ? { everyMinutes: t.everyMinutes } : {}), createdAt: now, updatedAt: now, status: 'active', runs: 0 }
  store.data.push(task)
  save()
  return task
}

export function updateTask(task: ScheduledTask, t: NewTask) {
  Object.assign(task, { task: t.task.trim(), nextAt: t.nextAt, repeat: t.repeat, updatedAt: Date.now() })
  if (t.repeat === 'interval') task.everyMinutes = t.everyMinutes
  else delete task.everyMinutes
  save()
}

export function cancelTask(task: ScheduledTask): boolean {
  if (task.status !== 'active') return false
  task.status = 'cancelled'
  task.updatedAt = Date.now()
  save()
  return true
}

export function removeTask(task: ScheduledTask) {
  store.data = store.data.filter(t => t !== task)
  save()
}

/** "下次 2026-10-29 周四 08:00（每天）" for the model and logs. */
export function taskLine(t: ScheduledTask): string {
  const when = t.status === 'active' ? `下次 ${formatNow(new Date(t.nextAt))}` : { done: '已完成', cancelled: '已取消', failed: '失败', missed: '已错过' }[t.status as Exclude<TaskStatus, 'active'>]
  return `${t.id}｜${when}（${describeRepeat(t)}）｜${t.userName}：${truncate(t.task, 80)}`
}

// ---------- firing ----------

/** Rebuild an event for the chat the task belongs to; undefined while that bot or chat is unreachable. */
export function wakeEvent(t: ScheduledTask): any {
  const bot = globalThis.Bot?.[t.selfId]
  const target = t.groupId ? bot?.pickGroup?.(isNaN(Number(t.groupId)) ? t.groupId : Number(t.groupId)) : bot?.pickFriend?.(isNaN(Number(t.userId)) ? t.userId : Number(t.userId))
  if (typeof target?.sendMsg !== 'function') return undefined
  const sender = { user_id: t.userId, nickname: t.userName, card: t.userName }
  const e: any = {
    post_type: 'message', message_type: t.groupId ? 'group' : 'private', sub_type: 'normal',
    self_id: t.selfId, user_id: t.userId, group_id: t.groupId, group_name: t.groupName, sender,
    message: [], msg: '', raw_message: '', time: Math.floor(Date.now() / 1000),
    isGroup: Boolean(t.groupId), isPrivate: !t.groupId, isMaster: t.admin, bot,
    adapter_id: bot?.adapter?.id, adapter_name: bot?.adapter?.name,
    scheduledTask: t.id,
    // the Yunzai reply signature: (message, quote, { at })
    reply: (msg: any, _quote?: boolean, data?: { at?: boolean }) =>
      target.sendMsg(data?.at && t.groupId ? [seg().at(t.userId), ' ', ...(Array.isArray(msg) ? msg : [msg])] : msg),
  }
  if (t.groupId) e.group = target
  else e.friend = target
  return e
}

export function wakePrompt(t: ScheduledTask, now = Date.now()): string {
  const late = now - t.nextAt
  const who = `${t.userName}(平台ID ${t.userId})`
  return [
    '【定时任务·到点提醒，不是新的用户消息】',
    `这是你在 ${formatNow(new Date(t.createdAt))} ${t.createdBy === 'web' ? `由管理员在网页面板为 ${who} 设置` : `应 ${who} 的请求设置`}的定时任务（${describeRepeat(t)}${t.repeat !== 'none' ? `，第 ${t.runs + 1} 次` : ''}，ID ${t.id}）。`,
    t.request ? `当时的原话：${truncate(t.request, 300)}` : '',
    `任务：${t.task}`,
    late > 2 * MINUTE ? `原定 ${formatNow(new Date(t.nextAt))}，因机器人离线晚了约 ${Math.round(late / MINUTE)} 分钟；已经没有意义时只回复 [skip]。` : '',
    `现在照任务去做：提醒就直接说出提醒的内容${t.groupId ? `，并用 [at:${t.userId}] 提醒对方` : ''}；需要查询或执行的先用工具做完再回复。用你平常的语气，像自己记着这件事，不提定时任务、ID 或内部机制。确实不需要发消息时只回复 [skip]。`,
  ].filter(Boolean).join('\n')
}

export interface FireDeps {
  runTurn: (request: TurnRequest) => Promise<TurnOutcome>
  deliver: typeof import('./reply.ts').deliver
  compactSession?: typeof import('./agent.ts').compactSession
}

/** Run one due task in its conversation; records the outcome on the task. */
export async function fireTask(t: ScheduledTask, e: any, deps?: FireDeps): Promise<void> {
  const eff = config.effective(t.groupId)
  const convKey = sessionKey(e, eff.chat.sessionScope)
  const agent = deps ?? { ...await import('./agent.ts'), deliver: (await import('./reply.ts')).deliver }
  await conversationLocks.run(convKey, async () => {
    const startedAt = Date.now()
    let afterReply: (() => void)[] | undefined
    try {
      const out = await agent.runTurn({ e, eff, isAdmin: t.admin, convKey, scheduled: { id: t.id, chain: t.chain + 1 },
        input: { text: wakePrompt(t, startedAt), images: [], imageSegments: [] } })
      afterReply = out.afterReply
      if (out.kind === 'quota') throw Error('额度已用完，未执行')
      if (out.kind === 'error') throw Error(out.message)
      t.lastRolloutId = (out as any).rolloutId
      if (out.skipped) { t.lastResult = '（判断无需发消息）'; return }
      let sent = 0
      const event = Object.create(e)
      event.reply = async (...args: any[]) => {
        const response = await e.reply(...args)
        const failed = response === false || (Array.isArray(response?.error) ? response.error.length > 0 : Boolean(response?.error))
          || response?.status === 'failed' || (response?.retcode != null && response.retcode !== 0)
        if (!response?.message_id && failed) throw Error('消息发送失败')
        sent++
        return response
      }
      const suppressText = Boolean(out.dispatched) && !eff.tools.botCommand.ack
      await agent.deliver(event, out.text, { ...eff, reply: { ...eff.reply, quote: 'never', atUser: false } }, { startedAt, convKey, suppressText, images: out.images })
      if (out.text.trim() && !suppressText && !sent) throw Error('消息未能发送')
      t.lastResult = truncate(out.text || (out.dispatched ? `（执行指令 ${out.dispatched}）` : '（无文字回复）'), 300)
      await agent.compactSession?.(convKey, eff, { userId: t.userId, groupId: t.groupId, isAdmin: t.admin })
    } finally {
      for (const start of afterReply ?? []) start()
    }
  })
}

/** Run what is due, skip what is too late, and move repeats on. */
export async function tick(now = Date.now(), deps?: FireDeps) {
  const due = store.data.filter(t => t.status === 'active' && t.nextAt <= now && !running.has(t.id))
  for (const t of due) {
    const late = now - t.nextAt
    if (late > (t.repeat === 'none' ? ONE_OFF_GRACE : REPEAT_GRACE)) {
      log.warn(`定时任务 ${t.id} 已错过（晚了 ${Math.round(late / MINUTE)} 分钟）`)
      t.lastError = `${formatNow(new Date(t.nextAt))} 机器人不在线，已错过`
      t.updatedAt = now
      if (t.repeat === 'none') t.status = 'missed'
      else t.nextAt = nextOccurrence(t.nextAt, t.repeat, t.everyMinutes, now)!
      save()
      continue
    }
    if (!config.get().enable) continue
    // bot not connected yet (e.g. right after a restart): try again next tick
    const e = wakeEvent(t)
    if (!e) continue
    running.add(t.id)
    const scheduledAt = t.nextAt
    void (async () => {
      try {
        await fireTask(t, e, deps)
        t.lastError = undefined
        log.info(`定时任务 ${t.id} 已执行`)
      } catch (err: any) {
        t.lastError = truncate(err?.message ?? String(err), 300)
        log.warn(`定时任务 ${t.id} 执行失败: ${t.lastError}`)
      } finally {
        running.delete(t.id)
        t.runs++
        t.lastRunAt = Date.now()
        t.updatedAt = t.lastRunAt
        // an edit while it ran wins; cancelling while it ran also keeps the cancellation
        if (t.status === 'active' && t.nextAt === scheduledAt) {
          const next = nextOccurrence(scheduledAt, t.repeat, t.everyMinutes, Math.max(Date.now(), scheduledAt))
          if (next == null) t.status = t.lastError ? 'failed' : 'done'
          else t.nextAt = next
        }
        save()
      }
    })()
  }
}

let timer: NodeJS.Timeout | undefined
export function startScheduler() {
  if (timer) return
  timer = setInterval(() => { tick().catch(err => log.warn('定时任务检查失败', err)) }, TICK_MS)
  timer.unref?.()
}
export function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = undefined
}

/** Tests: start from an empty schedule. */
export function resetSchedules() {
  store.data = []
  running.clear()
}
