import type { ComputerJob } from '../computer/queue.ts'
import { releaseRolloutJob, trackRolloutJob } from '../chat/rollouts.ts'
import type { ToolCtx, ToolOutput } from './registry.ts'

/** Refuse to start or resume a job once background results have chained `max` times in a row. */
export function chainLimitError(ctx: ToolCtx, max: number): ToolOutput | undefined {
  const depth = ctx.turn.chainDepth ?? 0
  if (depth > max)
    return { content: `流程限制：这是第 ${depth} 次后台结果回复，已超过连续发起后台任务的上限（${max} 次），请直接回复用户，需要继续时等待用户新消息。`, isError: true }
}

/** The job's result comes back to this turn's rollout, which stays waiting until then. */
export function bindJobToTurn(job: ComputerJob, ctx: ToolCtx) {
  job.rolloutId = ctx.turn.rolloutId
  job.chainDepth = ctx.turn.chainDepth ?? 0
  trackRolloutJob(job.rolloutId, job.id)
}

/** A cancelled job never reports back, so its rollout must not keep waiting. */
export function releaseCancelledJob(job: ComputerJob) {
  releaseRolloutJob(job.rolloutId, job.id, '后台任务已取消，不会再回到此对话')
}
