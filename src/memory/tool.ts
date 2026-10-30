import { config } from '../core/config.ts'
import { registry } from '../tools/registry.ts'
import { addMemory, deleteMemory, renderMemory, updateMemory, usage, type MemScope, type WriteResult } from './store.ts'
import { archiveOriginal, groupSessionsFor, recallSession, sessionKey } from '../chat/session.ts'
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

/** Characters of an original chat returned per recall call; the rest is read on with offset. */
const ORIGINAL_PAGE = 3000

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
    // a getter: the registry reads it every turn, so it follows memory.recallLimit
    get description() {
      return `检索当前会话更早的历史聊天记录（包含各阶段摘要与每日概要，语义与关键词综合匹配，可按日期筛选）。仅当前会话，最多返回${config.get().memory.recallLimit}条。摘要会省略细节；结果带「原文 id=…」时，可用 id 读取当时的聊天原文（含原话和图片路径），需要确切说法、细节或旧图片时使用，较长时用 offset 续读。`
    },
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的事、话题或旧对话的简短描述，尽量带上可能出现的人名、游戏名等关键词，如「岛风 周六 看猫的约定」；只按日期查时可留空' },
        date: { type: 'string', description: '只看某一天：YYYY-MM-DD，或「昨天」「上周六」「10月20日」这类说法' },
        from: { type: 'string', description: '日期范围起点 YYYY-MM-DD（含）' },
        to: { type: 'string', description: '日期范围终点 YYYY-MM-DD（含）' },
        count: { type: 'integer', description: '返回条数，默认3（不超过上面说的上限）' },
        id: { type: 'string', description: '读取某条结果的聊天原文：填结果里「原文 id=」后的值；填写时忽略其他检索参数' },
        offset: { type: 'integer', description: '读取原文时从第几个字开始，默认0' },
      },
    },
    async run(args, ctx) {
      if (typeof args.id === 'string' && args.id.trim()) {
        const keys = [sessionKey(ctx.e, ctx.eff.chat.sessionScope), ...recallSources(ctx.e, ctx.eff.chat.sessionScope).map(s => s.key)]
        const original = archiveOriginal(keys, args.id.trim())
        if (!original) return { content: `没有 id 为「${args.id}」的聊天原文（可能已过期，或该条只有摘要），请先检索再用结果里的 id`, isError: true }
        const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
        const page = original.text.slice(offset, offset + ORIGINAL_PAGE)
        const end = offset + page.length
        const more = end < original.text.length ? `\n……（共 ${original.text.length} 字，已读到第 ${end} 字，继续读用 offset=${end}）` : ''
        return `【${original.day} 聊天原文${offset ? `，从第 ${offset} 字起` : ''}】\n${page || '（已读完）'}${more}`
      }
      const range = rangeOf(args)
      const hits = await recallSession(sessionKey(ctx.e, ctx.eff.chat.sessionScope), String(args.query ?? ''), Number(args.count) || 3, { range, extra: recallSources(ctx.e, ctx.eff.chat.sessionScope) })
      return hits.join('\n\n') || (range ? `${range.from === range.to ? range.from : `${range.from} 至 ${range.to}`} 没有找到旧聊天记录` : '没有匹配的旧聊天片段')
    },
  })
  registry.register({
    name: 'memory',
    source: 'builtin',
    description:
      '管理长期记忆（跨会话保留）。scope=user 记录关于当前用户的事实与偏好；scope=group 记录关于本群的约定、梗或公共常识。' +
      '操作包括 read 查看全部条目、add 添加一条（写明主语）、update 改写已有条目、delete 删除指定编号。敏感信息（密码、证件号等）不得记录。',
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
    remaining: ctx => `剩余修改 ${Math.max(0, config.get().memory.maxWritesPerTurn - (ctx.turn.memoryWrites ?? 0))} 次；读取无单独次数上限`,
    async run(args, ctx) {
      const scope: MemScope = args.scope === 'group' ? 'group' : 'user'
      const key = memoryKey(scope, ctx.e)
      if (!key) return { content: scope === 'group' ? '当前不在群聊中，无法操作群记忆' : '无法获取当前用户标识，无法操作用户记忆', isError: true }
      if (args.action === 'read') return renderMemory(scope, key).join('\n') || '暂无记忆'
      if (scope === 'group' && !groupWritable(ctx)) {
        const mode = config.get().memory.groupWrite
        if (!ctx.e?.group_id) return { content: '当前不在群聊中，无法修改群记忆', isError: true }
        if (mode === 'off') return { content: '群记忆修改功能已被禁用', isError: true }
        if (mode === 'admin' && !ctx.isAdmin) {
          return { content: '权限不足：当前群记忆仅允许机器人管理员修改，普通用户不能修改群记忆。请告知用户需要管理员权限。', isError: true }
        }
        return { content: '当前无法修改群记忆', isError: true }
      }
      if (!['add', 'update', 'delete'].includes(args.action)) return { content: `未知记忆操作「${args.action}」（支持：read, add, update, delete）`, isError: true }
      const max = config.get().memory.maxWritesPerTurn
      if ((ctx.turn.memoryWrites ?? 0) >= max) return { content: `本轮最多修改 ${max} 次记忆，本次修改已达上限`, isError: true }
      ctx.turn.memoryWrites = (ctx.turn.memoryWrites ?? 0) + 1
      ctx.turn.memoryChanged = true
      const u = () => {
        const s = usage(scope, key)
        return `（${scope === 'user' ? '对方' : '本群'}记忆 ${s.entries}/${s.maxEntries} 条，${s.chars}/${s.maxChars} 字）`
      }
      if (args.action === 'delete') {
        if (!args.id) return { content: '缺少 id 参数，请提供要删除的记忆编号（如 m1）', isError: true }
        return deleteMemory(scope, key, String(args.id)) ? `已删除 ${args.id}${u()}` : { content: `未找到编号为 ${args.id} 的记忆条目`, isError: true }
      }
      const r: WriteResult =
        args.action === 'update'
          ? args.id
            ? updateMemory(scope, key, String(args.id), String(args.text ?? ''))
            : { ok: false, reason: '缺少 id 参数，请提供要修改的记忆编号（如 m1）' }
          : addMemory(scope, key, String(args.text ?? ''), String(ctx.e?.user_id ?? ''))
      if (!r.ok) {
        const list = r.full ? `\n当前记忆：\n${renderMemory(scope, key).join('\n')}` : ''
        return { content: `${r.reason}${list}`, isError: true }
      }
      return `${r.merged ? '已合并到' : '已记住'} [${r.entry.id}] ${r.entry.text}${u()}`
    },
  })
}
