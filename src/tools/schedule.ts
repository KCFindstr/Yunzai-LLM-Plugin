import { formatNow, truncate } from '../core/util.ts'
import { senderName } from '../core/yunzai.ts'
import { activeCounts, addTask, cancelTask, describeRepeat, listTasks, MAX_ACTIVE_TOTAL, MAX_TASK_CHARS, parseTime, REPEATS, taskLine, validateTask, type Repeat, type ScheduledTask } from '../chat/schedule.ts'
import { registry, toolAccessError, type ToolCtx } from './registry.ts'

const MAX_PER_TURN = 3

/** Tasks the caller may see and cancel here: their own in this chat; an admin sees everyone's in this chat. */
function visible(ctx: ToolCtx): ScheduledTask[] {
  const e = ctx.e
  return listTasks().filter(t => t.status === 'active' && t.selfId === String(e.self_id)
    && (t.groupId ?? '') === String(e.group_id ?? '') && (ctx.isAdmin || t.userId === String(e.user_id)))
}

/** A weekday repeat starting on a weekend starts on the Monday after. */
function firstWeekday(ts: number): number {
  while ([0, 6].includes(new Date(ts + 8 * 3600_000).getUTCDay())) ts += 86400_000
  return ts
}

export function registerScheduleTool() {
  registry.register({
    name: 'schedule', source: 'builtin',
    description: `定时任务：让你在稍后或按周期回到当前对话做一件事，例如「10分钟后提醒我关火」「明早8点叫我起床」「每个工作日9点提醒打卡」「每天早上播报天气」「半小时后再看看那个网页更新没有」。create 用 at（北京时间 "YYYY-MM-DD HH:mm"，可省略日期表示下一次到这个时刻）或 delayMinutes 指定首次时间；repeat 为 none/daily/weekdays/weekly/interval（interval 需 everyMinutes）。task 写给到点时的你自己：要做什么、提醒谁、提醒什么，写清楚具体内容，不要只写"提醒他"。到点时你会在本对话收到这条任务并照做后回复，可以使用工具。list 查看本对话中进行中的任务，cancel 按 id 取消。设置后用一句话告诉对方时间即可，不提 ID 或内部机制；对方说"取消提醒"时先 list 再 cancel。`,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'cancel'] },
        task: { type: 'string', description: `到点时要做的事（${MAX_TASK_CHARS} 字以内）` },
        at: { type: 'string', description: '北京时间，"2026-10-29 08:00" 或 "08:00"' },
        delayMinutes: { type: 'number', description: '多少分钟后（与 at 二选一）' },
        repeat: { type: 'string', enum: REPEATS },
        everyMinutes: { type: 'number', description: 'repeat=interval 时的间隔分钟数' },
        id: { type: 'string', description: 'cancel 的任务 ID' },
      },
      required: ['action'],
    },
    available: ctx => ctx.eff.tools.schedule.enable && (ctx.eff.tools.schedule.access === 'all' || ctx.isAdmin),
    limit: () => `最多新建 ${MAX_PER_TURN} 个`,
    remaining: ctx => `剩余新建 ${Math.max(0, MAX_PER_TURN - (ctx.turn.scheduled ?? 0))} 个`,
    async run(args, ctx) {
      const denied = toolAccessError('schedule', ctx)
      if (denied) return denied
      const cfg = ctx.eff.tools.schedule, e = ctx.e
      if (args.action === 'list') {
        const tasks = visible(ctx)
        return tasks.length ? `现在 ${formatNow()}\n${tasks.map(taskLine).join('\n')}` : '本对话没有进行中的定时任务'
      }
      if (args.action === 'cancel') {
        const task = visible(ctx).find(t => t.id === String(args.id ?? '').trim())
        if (!task) return { content: `本对话中没有 ID 为「${args.id ?? ''}」的进行中任务，请先 list 查看`, isError: true }
        cancelTask(task)
        return `已取消：${taskLine(task)}`
      }
      if (args.action !== 'create') return { content: `未知操作「${args.action}」（支持：create, list, cancel）`, isError: true }

      if ((ctx.turn.scheduled ?? 0) >= MAX_PER_TURN) return { content: `本次回复最多新建 ${MAX_PER_TURN} 个定时任务`, isError: true }
      const chain = ctx.turn.scheduleChain ?? 0
      if (chain > cfg.maxChain)
        return { content: `流程限制：这是连续第 ${chain} 次由定时任务触发，已达上限（${cfg.maxChain} 次），不能再设置新的定时任务；请直接回复，需要继续时等对方再来找你。`, isError: true }
      const userId = String(e.user_id)
      const counts = activeCounts(userId)
      if (!ctx.isAdmin && counts.user >= cfg.maxPerUser)
        return { content: `对方已有 ${counts.user} 个进行中的定时任务（上限 ${cfg.maxPerUser}），请先取消不需要的再设置`, isError: true }
      if (counts.total >= MAX_ACTIVE_TOTAL) return { content: '定时任务总数已达上限，暂时不能再设置', isError: true }

      const now = Date.now()
      const repeat = (args.repeat || 'none') as Repeat
      let nextAt: number | undefined
      if (args.at != null && String(args.at).trim()) {
        nextAt = parseTime(String(args.at), now)
        if (nextAt == null) return { content: `无法识别时间「${args.at}」，请用北京时间 "YYYY-MM-DD HH:mm" 或 "HH:mm"`, isError: true }
      } else if (Number.isFinite(Number(args.delayMinutes)) && Number(args.delayMinutes) > 0) nextAt = now + Number(args.delayMinutes) * 60_000
      else if (repeat === 'interval' && Number(args.everyMinutes) > 0) nextAt = now + Number(args.everyMinutes) * 60_000
      else return { content: '缺少时间：请提供 at 或 delayMinutes', isError: true }
      if (repeat === 'weekdays') nextAt = firstWeekday(nextAt)
      const draft = { task: String(args.task ?? ''), nextAt, repeat, everyMinutes: repeat === 'interval' ? Number(args.everyMinutes) : undefined }
      const invalid = validateTask(draft, cfg, now)
      if (invalid) return { content: invalid, isError: true }

      const task = addTask({
        createdBy: 'chat', request: truncate(String(e.msg ?? ''), 300) || undefined,
        selfId: String(e.self_id), userId, userName: senderName(e),
        groupId: e.group_id != null ? String(e.group_id) : undefined, groupName: e.group_name ? String(e.group_name) : undefined,
        admin: ctx.isAdmin, chain,
      }, draft)
      ctx.turn.scheduled = (ctx.turn.scheduled ?? 0) + 1
      return `已设置：${formatNow(new Date(task.nextAt))}（${describeRepeat(task)}）。现在 ${formatNow()}。请用一句话告诉对方，不提 ID。`
    },
  })
}
