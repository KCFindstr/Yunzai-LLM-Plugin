import { config } from '../core/config.ts'
import { registry } from '../tools/registry.ts'
import { addMemory, deleteMemory, renderMemory, updateMemory, usage, type MemScope, type WriteResult } from './store.ts'

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
    name: 'memory',
    source: 'builtin',
    description:
      '管理长期记忆（跨会话保留）。scope=user 记关于当前对方的事：对方明确告诉你的称呼、喜好、常玩的游戏/角色、生日、重要约定；scope=group 记本群的约定、梗、常识。' +
      '不要记一次性的事情、闲聊内容本身、你自己的推测，绝不记录密码/证件号/手机号等敏感信息。每条一句话；已有相近条目时用 update 改写（填 id），过时或错误的用 delete。只在确实值得长期记住时使用。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'delete'] },
        scope: { type: 'string', enum: ['user', 'group'] },
        id: { type: 'string', description: 'update/delete 时填写记忆编号，如 m3' },
        text: { type: 'string', description: 'add/update 时的内容，一句话' },
      },
      required: ['action', 'scope'],
    },
    available: ctx => config.get().memory.enable,
    async run(args, ctx) {
      const scope: MemScope = args.scope === 'group' ? 'group' : 'user'
      if (scope === 'group' && !groupWritable(ctx)) return { content: '当前不能修改群记忆', isError: true }
      const key = memoryKey(scope, ctx.e)
      if (!key) return { content: '缺少对象', isError: true }
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
