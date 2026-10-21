import { registry } from '../tools/registry.ts'
import { formatCommandCatalog, matchRule, searchCommands } from './catalog.ts'
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
      '执行机器人已安装插件的指令（如 #深渊、*体力、*火花面板、%面板），结果由插件直接发送给用户。当用户想查询游戏数据或使用机器人已有功能时优先用它，不要自己编造数据。' +
      '每轮只能执行一条；执行后不要再复述结果。指令格式优先使用系统提示列出的格式，若不确定或需要查看所有可用指令，使用 search_bot_commands 或 list_bot_commands。' +
      '注意：角色相关指令（如 *{角色}面板 等），直接代入用户原词执行（如 *火花面板、*狼尊面板），不要擅自更改角色名！',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '完整指令文本，如 "#深渊"、"#刻晴面板"、"*火花面板"、"*忘却之庭"' } },
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
          content: `没有插件能处理「${cmd}」。请检查格式，或用 search_bot_commands 搜索、list_bot_commands 获取完整列表；如果确实没有对应功能就直接告诉用户。`,
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
    description:
      '按关键词搜索机器人已安装插件的指令（支持角色名、功能词、指令片段，如 "火花"、"抽卡记录"、"星铁 面板"）。' +
      '在常用指令列表里找不到合适指令，或想确认某个角色/功能是否有对应指令时使用。若要查看全部完整列表，请用 list_bot_commands。',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '功能或角色关键词，如 "火花"、"抽卡记录"、"星铁 深渊"' } },
      required: ['query'],
    },
    available: ctx => ctx.eff.tools.botCommand.enable,
    async run(args) {
      const hits = searchCommands(String(args.query ?? ''), 12)
      return hits.length ? hits.join('\n') : '没有找到相关指令。可调用 list_bot_commands 查看完整指令列表。'
    },
  })

  registry.register({
    name: 'list_bot_commands',
    source: 'builtin',
    description:
      '获取机器人当前已安装所有插件支持的完整指令列表（可按游戏/分类过滤）。' +
      '当系统提示中的常用指令不够全面、需要查找全部支持的功能或确认指令全貌时调用。',
    parameters: {
      type: 'object',
      properties: {
        game: {
          type: 'string',
          description: '可选过滤：all (全部), sr (星穹铁道), gs (原神), zzz (绝区零), common (通用/系统)',
          enum: ['all', 'sr', 'gs', 'zzz', 'common'],
        },
        plugin: {
          type: 'string',
          description: '可选：按插件名称过滤（如 miao-plugin, StarRail-plugin, genshin, xiaoyao-cvs-plugin 等）',
        },
      },
    },
    available: ctx => ctx.eff.tools.botCommand.enable,
    async run(args) {
      return formatCommandCatalog({ game: args.game, plugin: args.plugin })
    },
  })
}
