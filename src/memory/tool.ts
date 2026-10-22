import { config } from '../core/config.ts'
import { registry } from '../tools/registry.ts'
import { addMemory, deleteMemory, renderMemory, updateMemory, usage, type MemScope, type WriteResult } from './store.ts'
import { groupSessionsFor, recallSession, sessionKey } from '../chat/session.ts'
import { localDay, parseDateHints, type DayRange } from '../chat/dates.ts'
import { groupsWithUser } from '../chat/roster.ts'

/**
 * Extra sessions a conversation may recall from, beyond its own:
 * - a per-member group conversation also searches the group-wide archive (where the group's chatter is kept);
 * - with `memory.crossChatRecall`, a private chat searches the groups the person is in (content already visible
 *   to them there). Groups never see private chats.
 */
export function recallSources(e: any, scope: string): { key: string; label: string }[] {
  if (e?.self_id == null) return []
  if (e.group_id) return scope === 'group' ? [] : [{ key: `${e.self_id}:g${e.group_id}`, label: '群聊' }]
  if (!config.get().memory.crossChatRecall || e.user_id == null) return []
  return groupSessionsFor(e.self_id, e.user_id, groupsWithUser(e.self_id, e.user_id))
}

/** Day range from tool arguments: explicit from/to or date ("2026-10-20" or a phrase like "上周六"), else the query. */
function rangeOf(args: Record<string, any>): DayRange | undefined {
  const iso = (v: any) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : undefined)
  const from = iso(args.from), to = iso(args.to)
  if (from || to) return { from: from ?? '0000-01-01', to: to ?? localDay() }
  if (typeof args.date === 'string' && args.date.trim()) return iso(args.date) ? { from: iso(args.date)!, to: iso(args.date)! } : parseDateHints(args.date)
  return parseDateHints(String(args.query ?? ''))
}

export function memoryKey(scope: MemScope, e: any): string | undefined {
  if (scope === 'user') return e?.user_id != null ? String(e.user_id) : undefined
  return e?.group_id != null ? String(e.group_id) : undefined
}

function groupWritable(ctx: { e: any; isAdmin: boolean }) {
  const mode = config.get().memory.groupWrite
  return Boolean(ctx.e?.group_id) && (mode === 'all' || (mode === 'admin' && ctx.isAdmin))
}

export function registerMemoryTool() {
  registry.register({
    name: 'recall', source: 'builtin',
    description:
      '检索当前会话更早的聊天：每段聊天摘要（保留30天）和每天一条的「当日概要」（保留更久），按语义和关键词综合匹配。' +
      '需要之前的约定、称呼、话题细节，或被问到某天/某段时间聊过什么时，先查再答；可按日期筛选。仅当前会话，最多返回5条。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的事或话题的简短描述，尽量带上当时可能出现的人名、游戏名等关键词，如「阿明 周六 看猫的约定」；只按日期查时可留空' },
        date: { type: 'string', description: '只看某一天：YYYY-MM-DD，或「昨天」「上周六」「10月20日」这类说法' },
        from: { type: 'string', description: '日期范围起点 YYYY-MM-DD（含）' },
        to: { type: 'string', description: '日期范围终点 YYYY-MM-DD（含）' },
        count: { type: 'integer', description: '返回条数，1-5，默认3' },
      },
    },
    async run(args, ctx) {
      const range = rangeOf(args)
      const hits = await recallSession(sessionKey(ctx.e, ctx.eff.chat.sessionScope), String(args.query ?? ''), Number(args.count) || 3, { range, extra: recallSources(ctx.e, ctx.eff.chat.sessionScope) })
      return hits.join('\n\n') || (range ? `${range.from === range.to ? range.from : `${range.from} 至 ${range.to}`} 没有找到旧聊天记录` : '没有匹配的旧聊天片段')
    },
  })
  registry.register({
    name: 'memory',
    source: 'builtin',
    description:
      '管理长期记忆（跨会话保留）。scope=user 记关于当前对方的事；scope=group 记本群的约定、梗、常识。' +
      '积极主动：对方透露称呼、身份、喜好/雷区、常玩的游戏角色、计划约定、纠正你的地方等以后用得上的信息时，当场 add，不必等对方要求，宁可多记（满了会自动整理）。' +
      '每条一句话写明主语；相近条目用 update 改写，过时或错误用 delete；read 查看全部条目。不记一次性闲聊、推测和密码/证件号/手机号等敏感信息。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'add', 'update', 'delete'] },
        scope: { type: 'string', enum: ['user', 'group'] },
        id: { type: 'string', description: 'update/delete 时填写记忆编号，如 m3' },
        text: { type: 'string', description: 'add/update 时的内容，一句话' },
      },
      required: ['action', 'scope'],
    },
    available: ctx => config.get().memory.enable,
    limit: () => `最多修改 ${config.get().memory.maxWritesPerTurn} 次`,
    async run(args, ctx) {
      const scope: MemScope = args.scope === 'group' ? 'group' : 'user'
      const key = memoryKey(scope, ctx.e)
      if (!key) return { content: '缺少对象', isError: true }
      if (args.action === 'read') return renderMemory(scope, key).join('\n') || '暂无记忆'
      if (scope === 'group' && !groupWritable(ctx)) return { content: '当前不能修改群记忆', isError: true }
      if (!['add', 'update', 'delete'].includes(args.action)) return { content: '未知记忆操作', isError: true }
      const max = config.get().memory.maxWritesPerTurn
      if ((ctx.turn.memoryWrites ?? 0) >= max) return { content: `本轮最多修改 ${max} 次记忆`, isError: true }
      ctx.turn.memoryWrites = (ctx.turn.memoryWrites ?? 0) + 1
      ctx.turn.memoryChanged = true
      const u = () => {
        const s = usage(scope, key)
        return `（${scope === 'user' ? '对方' : '本群'}记忆 ${s.entries}/${s.maxEntries} 条，${s.chars}/${s.maxChars} 字）`
      }
      if (args.action === 'delete') {
        if (!args.id) return { content: '缺少 id', isError: true }
        return deleteMemory(scope, key, String(args.id)) ? `已删除 ${args.id}${u()}` : { content: `没有 ${args.id}`, isError: true }
      }
      const r: WriteResult =
        args.action === 'update'
          ? args.id
            ? updateMemory(scope, key, String(args.id), String(args.text ?? ''))
            : { ok: false, reason: '缺少 id' }
          : addMemory(scope, key, String(args.text ?? ''), String(ctx.e?.user_id ?? ''))
      if (!r.ok) {
        const list = r.full ? `\n当前记忆：\n${renderMemory(scope, key).join('\n')}` : ''
        return { content: `${r.reason}${list}`, isError: true }
      }
      return `${r.merged ? '已合并到' : '已记住'} [${r.entry.id}] ${r.entry.text}${u()}`
    },
  })
}
