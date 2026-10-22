import { config } from '../core/config.ts'
import { JsonStore } from '../core/store.ts'
import { log } from '../core/log.ts'
import { deliver } from '../chat/reply.ts'
import { appendTurn, setServerState, sessionKey } from '../chat/session.ts'
import { pickModel } from '../chat/utility.ts'
import { markdownEnabled } from '../chat/format.ts'
import { runComputer } from '../computer/agent.ts'
import { ComputerQueue, type ComputerJob } from '../computer/queue.ts'
import { registry, type ToolCtx } from './registry.ts'

const store = new JsonStore<ComputerJob[]>('computer-jobs.json', [])
export const computerQueue = new ComputerQueue(store.data, () => store.save())

export function computerOwner(event: any) {
  return JSON.stringify([String(event.self_id), String(event.user_id), String(event.group_id ?? '')])
}

function activate(job: ComputerJob, ctx: ToolCtx) {
  const cfg = { ...ctx.eff.tools.computer }
  const convKey = sessionKey(ctx.e, ctx.eff.chat.sessionScope)
  computerQueue.activate(job, (entry, signal) => runComputer(entry, {
    cfg, eff: ctx.eff, signal, quota: { userId: ctx.e.user_id, groupId: ctx.e.group_id, isAdmin: ctx.isAdmin }, changed: () => computerQueue.touch(), markdown: markdownEnabled(ctx.e, ctx.eff.reply),
  }), async (entry, result) => {
    const text = `[电脑任务 ${entry.id}${result.waiting ? ' 等待回复' : ''}]\n${result.report}`
    const eff = { ...ctx.eff, sticker: { ...ctx.eff.sticker, enable: false }, reply: { ...ctx.eff.reply, quote: 'never' as const, atUser: false } }
    let sent = 0
    const event = Object.create(ctx.e)
    event.reply = async (...args: any[]) => {
      const response = await ctx.e.reply(...args)
      const error = Array.isArray(response?.error) ? response.error.length > 0 : Boolean(response?.error)
      if (!response?.message_id && (response === false || error || response?.status === 'failed' || (response?.retcode != null && response.retcode !== 0)))
        throw new Error('电脑任务报告发送失败')
      sent++
      return response
    }
    await deliver(event, text, eff, { startedAt: Date.now(), convKey, images: result.images })
    if (!sent) throw new Error('电脑任务报告达到发送频率上限')
    appendTurn(convKey, { role: 'user', content: [{ type: 'text', text: `电脑任务 ${entry.id}：${entry.task}` }] }, { role: 'assistant', content: text })
    setServerState(convKey, undefined)
    log.info(`电脑任务 ${entry.id} ${entry.status} steps=${entry.steps ?? 0} input=${entry.inputTokens ?? 0} output=${entry.outputTokens ?? 0} cacheRead=${entry.cacheReadTokens ?? 0} cacheWrite=${entry.cacheWriteTokens ?? 0}`)
  })
}

export function registerComputerTool() {
  registry.register({
    name: 'computer_task', source: 'builtin',
    description: '委托独立电脑代理使用持久像素桌面：截图、浏览网页、观看图片/视频或运行长期任务。先读取 computer-use 技能。start 排队，当前回复发送后才开始，完成后自动回报；不要循环轮询。status/cancel/respond 查询、取消或回复暂停任务。',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'status', 'cancel', 'respond'] }, task: { type: 'string' }, id: { type: 'string' }, response: { type: 'string' } }, required: ['action'] },
    available: ctx => process.platform === 'win32' && ctx.eff.tools.computer.enable && (ctx.eff.tools.computer.access === 'all' || ctx.isAdmin),
    async run(args, ctx) {
      const cfg = ctx.eff.tools.computer
      const identity = computerOwner(ctx.e)
      if (args.action === 'start') {
        if (ctx.turn.computerJob) return `本轮已创建电脑任务 ${ctx.turn.computerJob}，请先回复用户，勿重复提交。`
        const selected = pickModel([cfg.model || ctx.eff.model], true)
        if (!selected || selected.model.toolUse === false) return { content: '电脑代理未配置可用的视觉/工具模型', isError: true }
        const task = String(args.task ?? '').trim()
        if (!task || task.length > 12000) return { content: '请提供不超过12000字的完整任务及必要上下文', isError: true }
        const job = computerQueue.submit(identity, task, cfg.maxQueue)
        job.requesterText = String(ctx.e.msg ?? '').slice(0, 12000)
        ctx.turn.computerJob = job.id
        ;(ctx.turn.afterReply ??= []).push(() => activate(job, ctx))
        return `电脑任务 ${job.id} 已排队。现在简短回复用户；回复发送后独立代理才开始，完成后会自动再次回报。不必等待或轮询。`
      }
      const job = computerQueue.get(String(args.id ?? ''), identity)
      if (!job) return { content: '找不到属于你在此会话中的任务，请提供任务 id', isError: true }
      if (args.action === 'cancel') computerQueue.cancel(job)
      else if (args.action === 'respond') {
        const response = String(args.response ?? '').trim()
        if (!response || response.length > 6000) return { content: '请提供不超过6000字的用户回复', isError: true }
        computerQueue.resume(job, String(ctx.e.msg || response).slice(0, 6000), cfg.maxQueue)
        ;(ctx.turn.afterReply ??= []).push(() => activate(job, ctx))
      } else if (args.action !== 'status') return { content: '未知任务操作', isError: true }
      return JSON.stringify({ id: job.id, status: job.status, report: job.report, steps: job.steps, inputTokens: job.inputTokens, outputTokens: job.outputTokens, cacheReadTokens: job.cacheReadTokens, cacheWriteTokens: job.cacheWriteTokens, deliveryError: job.deliveryError })
    },
  })
}
