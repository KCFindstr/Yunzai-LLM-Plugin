import { registry } from '../tools/registry.ts'
import { matchRule, searchCommands } from './catalog.ts'
import { dispatchCommand } from './dispatch.ts'

const ALWAYS_BLOCKED = [/^#?llm/i]

function blocked(cmd: string, patterns: string[]): boolean {
  if (ALWAYS_BLOCKED.some(r => r.test(cmd))) return true
  return patterns.some(p => {
    try {
      return new RegExp(p, 'i').test(cmd)
    } catch {
      return false
    }
  })
}

export function registerCommandTools() {
  registry.register({
    name: 'run_bot_command',
    source: 'builtin',
    description:
      '执行机器人已安装插件的指令（如 #深渊、*体力、%面板），结果由插件直接发送给用户。当用户想查询游戏数据或使用机器人已有功能时优先用它，不要自己编造数据。' +
      '每轮只能执行一条；执行后不要再复述结果。指令必须是系统提示「机器人指令」里列出的格式，不确定时先用 search_bot_commands 搜索。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '完整指令文本，如 "#深渊"、"#刻晴面板"、"*忘却之庭"' } },
      required: ['command'],
    },
    available: ctx => ctx.eff.tools.botCommand.enable,
    async run(args, ctx) {
      const cmd = String(args.command ?? '')
        .replace(/[\r\n]+/g, ' ')
        .trim()
      if (!cmd) return { content: '缺少 command', isError: true }
      if (ctx.turn.commands >= 1) return { content: '每轮只能执行一条指令', isError: true }
      const bc = ctx.eff.tools.botCommand
      if (blocked(cmd, bc.blacklist)) return { content: `指令「${cmd}」不允许通过对话执行`, isError: true }
      const rule = await matchRule(cmd, ctx.e)
      if (!rule)
        return {
          content: `没有插件能处理「${cmd}」。请检查格式，或用 search_bot_commands 搜索正确指令；如果确实没有对应功能就直接告诉用户。`,
          isError: true,
        }
      if (rule.permission === 'master' && !bc.allowMasterCommands)
        return { content: `「${cmd}」是主人指令，不能通过对话执行，请让用户直接发送该指令`, isError: true }
      ctx.turn.commands++
      ctx.turn.dispatched = cmd
      const { replied } = await dispatchCommand(ctx.e, cmd)
      return {
        content: replied ? `已执行「${cmd}」，插件已把结果发给用户。` : `已执行「${cmd}」（插件暂未返回内容）。`,
        terminal: true,
      }
    },
  })

  registry.register({
    name: 'search_bot_commands',
    source: 'builtin',
    description: '按关键词搜索机器人已安装插件的指令（返回指令格式和说明，或插件的匹配正则）。在系统提示列出的常用指令里找不到合适的时使用。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '功能关键词，如 "抽卡记录"、"星铁 深渊"' } },
      required: ['query'],
    },
    available: ctx => ctx.eff.tools.botCommand.enable,
    async run(args) {
      const hits = searchCommands(String(args.query ?? ''), 8)
      return hits.length ? hits.join('\n') : '没有找到相关指令'
    },
  })
}
