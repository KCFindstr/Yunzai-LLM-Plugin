import YAML from 'yaml'
import { queryBalance } from '../billing/balance.ts'
import { daily, limitsFor, resetUsage, summarize, topUsers, totals, WINDOW_WEEK } from '../billing/ledger.ts'
import { priceCacheInfo, refreshPrices, resolvePrice } from '../billing/pricing.ts'
import { catalogEntries, catalogInfo, displayCmd, formatCommandCatalog, matchRule, scanCatalog, searchCommands } from '../commands/catalog.ts'
import { config, resolveKeys } from '../core/config.ts'
import type { ModelConfig, ProviderType, QuotaScope, ThinkingLevel } from '../core/configTypes.ts'
import { log } from '../core/log.ts'
import { fetchBuffer, formatDuration, formatUsd, isPlainObject, maskSecret, truncate } from '../core/util.ts'
import { botNickname, sendApi, sendForward } from '../core/yunzai.ts'
import { clearSession, clearSessionsWhere, peekSession, sessionKey, sessionStats } from '../chat/session.ts'
import { getQuoted } from '../chat/message.ts'
import { pickModel, utilityChat } from '../chat/utility.ts'
import * as help from '../help.ts'
import { PROVIDER_TYPES } from '../llm/index.ts'
import { indexSticker } from '../stickers/indexer.ts'
import { sendSticker } from '../stickers/picker.ts'
import {
  addImageSticker,
  addMfaceSticker,
  findSticker,
  listStickers,
  removeSticker,
  uniqueName,
  updateSticker,
  type Sticker,
} from '../stickers/store.ts'
import { loadCustomTools } from '../tools/custom.ts'
import { clearMemory, deleteMemory, listMemory, memoryStats, renderMemory, usage, type MemScope } from '../memory/store.ts'
import { registry } from '../tools/registry.ts'
import { deleteSkill, listSkills, loadSkills, parseSkillMarkdown, saveSkill } from '../tools/skills.ts'
import { BasePlugin } from './base.ts'

const THINKING: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const SECRET_KEYS = /(apikey|api_key|key|token|secret|password)$/i

interface Ctx {
  e: any
  args: string
  self: LLMAdmin
}

interface Cmd {
  names: string[]
  level: 'user' | 'admin' | 'master'
  run: (c: Ctx) => Promise<any>
}

// ---------- helpers ----------

async function say(e: any, text: string) {
  if (text.length <= 600) return e.reply(text)
  const chunks: string[] = []
  let cur = ''
  for (const para of text.split(/\n(?=【)|\n\n/)) {
    if ((cur + para).length > 1500 && cur) {
      chunks.push(cur)
      cur = ''
    }
    cur += (cur ? '\n\n' : '') + para
  }
  if (cur) chunks.push(cur)
  return sendForward(e, chunks, botNickname(e))
}

function parseValue(raw: string): any {
  const t = raw.trim()
  if (t === '' || t === '默认' || t === 'null') return null
  try {
    return YAML.parse(t)
  } catch {
    return t
  }
}

function mask(v: any, key = ''): any {
  if (typeof v === 'string' && SECRET_KEYS.test(key)) return maskSecret(v)
  if (Array.isArray(v)) return v.map(x => mask(x, key))
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x, k)]))
  return v
}

function isSecretPath(p: string) {
  return /apikey|api_key|token|secret|password|jinakey/i.test(p)
}

function updateModels(fn: (models: ModelConfig[]) => void) {
  const models = structuredClone(config.get().models)
  fn(models)
  config.set('models', models)
}

function modelOrThrow(id: string): ModelConfig {
  const m = config.getModel(id)
  if (!m) throw new Error(`没有模型「${id}」，可用：${config.get().models.map(x => x.id).join(', ')}`)
  return m
}

/** "本群" / group id / undefined */
function targetGroup(e: any, arg?: string): string | undefined {
  if (!arg) return undefined
  if (arg === '本群') return e.group_id ? String(e.group_id) : undefined
  return /^\d{5,}$/.test(arg) ? arg : undefined
}

function priceLine(m: ModelConfig): string {
  const p = resolvePrice(m)
  if (!p) return '价格未知'
  const cache = p.cacheRead != null ? ` 缓存读 $${+p.cacheRead.toFixed(4)}` : ''
  return `$${+p.input.toFixed(4)}/$${+p.output.toFixed(4)}${cache}（${p.source}）`
}

function limitLine(m: ModelConfig): string {
  const parts: string[] = []
  for (const s of ['user', 'group', 'global'] as QuotaScope[]) {
    const l = limitsFor(m, s)
    if (l.window5h || l.weekly)
      parts.push(`${{ user: '每人', group: '每群', global: '全局' }[s]} 5h ${l.window5h ? formatUsd(l.window5h) : '∞'} / 周 ${l.weekly ? formatUsd(l.weekly) : '∞'}`)
  }
  return parts.join('；') || '不限'
}

function usageLines(userId: string, groupId?: string): string[] {
  const lines: string[] = []
  for (const m of config.get().models) {
    const segs: string[] = []
    for (const s of ['user', 'group', 'global'] as QuotaScope[]) {
      const sum = summarize(m, s, { userId, groupId })
      if (!sum) continue
      const { limits } = sum
      if (!limits.window5h && !limits.weekly && !(s === 'user' && (sum.used5h || sum.usedWeek))) continue
      const name = { user: '个人', group: '本群', global: '全局' }[s]
      const a = `5h ${formatUsd(sum.used5h)}${limits.window5h ? `/${formatUsd(limits.window5h)}` : ''}`
      const b = `周 ${formatUsd(sum.usedWeek)}${limits.weekly ? `/${formatUsd(limits.weekly)}` : ''}`
      const reset =
        limits.window5h && sum.used5h >= limits.window5h
          ? `（${formatDuration(sum.reset5h)}后恢复）`
          : limits.weekly && sum.usedWeek >= limits.weekly
            ? `（${formatDuration(sum.resetWeek)}后恢复）`
            : ''
      segs.push(`${name} ${a} · ${b}${reset}`)
    }
    if (segs.length) lines.push(`${m.id}：${segs.join('；')}`)
  }
  return lines
}

async function collectImages(e: any): Promise<{ images: { buf: Buffer }[]; mfaces: any[] }> {
  const segs: any[] = [...(e.message ?? [])]
  if (e.reply_id && typeof e.getReply === 'function') {
    try {
      const r = await e.getReply()
      segs.push(...(r?.message ?? []))
    } catch {}
  }
  const images: { buf: Buffer }[] = []
  const mfaces: any[] = []
  for (const s of segs) {
    if (s?.type === 'mface' && s.emoji_id) mfaces.push(s)
    else if (s?.type === 'image' && s.url) {
      const buf = await fetchBuffer(s.url, { maxBytes: 10 * 1024 * 1024 })
      if (buf) images.push({ buf })
    }
  }
  return { images, mfaces }
}

/** Add + index stickers from the current message; reports in a single reply. */
async function addStickersFrom(e: any, hint?: { name?: string; desc?: string }): Promise<number> {
  const { images, mfaces } = await collectImages(e)
  const added: Sticker[] = []
  const dup: Sticker[] = []
  for (const img of images) {
    const [s, isNew] = addImageSticker(img.buf, { addedBy: String(e.user_id), name: hint?.name, desc: hint?.desc })
    ;(isNew ? added : dup).push(s)
  }
  for (const m of mfaces) {
    const preview = m.url ? await fetchBuffer(m.url, { maxBytes: 5 * 1024 * 1024 }) : undefined
    const [s, isNew] = addMfaceSticker(
      { emoji_id: m.emoji_id, emoji_package_id: m.emoji_package_id, key: m.key, summary: m.summary },
      preview,
      String(e.user_id),
    )
    ;(isNew ? added : dup).push(s)
  }
  if (!added.length && !dup.length) return 0
  const lines: string[] = []
  for (const s of added) {
    if (hint?.name && hint?.desc) {
      lines.push(`✅ ${s.id}「${s.name}」`)
      continue
    }
    try {
      const r = await indexSticker(s, { hint: hint?.name, userId: String(e.user_id) })
      lines.push(`✅ ${r.id}「${r.name}」${r.desc}`)
    } catch (err: any) {
      lines.push(`⚠️ ${s.id} 已保存但识别失败：${truncate(err.message, 60)}（可用 #llm重命名表情 手动命名）`)
    }
  }
  for (const s of dup) lines.push(`↩️ ${s.id}「${s.name}」已存在`)
  await e.reply(lines.join('\n'))
  return added.length + dup.length
}

// ---------- commands ----------

const COMMANDS: Cmd[] = [
  // ----- user -----
  {
    names: ['帮助', 'help', '菜单', ''],
    level: 'user',
    async run({ e }) {
      const nodes = [help.USER_HELP]
      if (config.isAdmin(e))
        nodes.push(
          help.ADMIN_HELP_BASIC,
          help.ADMIN_HELP_MODEL,
          help.ADMIN_HELP_BILLING,
          help.ADMIN_HELP_PERSONA,
          help.ADMIN_HELP_STICKER,
          help.ADMIN_HELP_TOOLS,
        )
      return sendForward(e, nodes, botNickname(e))
    },
  },
  {
    names: ['状态', 'status'],
    level: 'user',
    async run({ e }) {
      const eff = config.effective(e.group_id)
      const m = config.getModel(eff.model)
      const sess = peekSession(sessionKey(e, eff.chat.sessionScope))
      const lines = [
        `插件：${config.get().enable ? '已启用' : '已停用'}${e.group_id ? `，本群：${eff.enable ? '启用' : '停用'}` : ''}`,
        `模型：${m ? `${m.id}（${m.model}）` : '未配置'}，思考：${m?.thinking ?? eff.chat.thinking}`,
        `我们的对话：${sess?.messages.length ?? 0} 条记忆${sess?.summary ? '（含摘要）' : ''}`,
      ]
      if (config.isAdmin(e)) {
        const ci = catalogInfo()
        const st = sessionStats()
        const pc = priceCacheInfo()
        lines.push(
          `会话总数：${st.count}（${st.messages} 条消息）`,
          `指令目录：${ci.verified}/${ci.entries} 条已验证，${ci.rules} 条规则`,
          `表情：${listStickers().length} 个（已识别 ${listStickers().filter(s => s.indexed).length}）`,
          `技能：${listSkills().length} 个，工具：${registry.all().length} 个`,
          `长期记忆：${memoryStats().entries} 条（${memoryStats().users} 人，${memoryStats().groups} 群）`,
          `价格表：${pc.count} 个模型，${pc.fetchedAt ? `${formatDuration(Date.now() - pc.fetchedAt)}前更新` : '未更新'}`,
        )
      }
      return e.reply(lines.join('\n'))
    },
  },
  {
    names: ['额度', '用量', 'usage'],
    level: 'user',
    async run({ e, args }) {
      const target = args && config.isAdmin(e) ? args.replace(/\D/g, '') : String(e.user_id)
      const lines = usageLines(target, e.group_id ? String(e.group_id) : undefined)
      return e.reply(lines.length ? `${target === String(e.user_id) ? '你' : target}的用量：\n${lines.join('\n')}` : '暂无用量记录')
    },
  },
  {
    names: ['清除记忆', '清空记忆', '重置', 'reset'],
    level: 'user',
    async run({ e }) {
      const eff = config.effective(e.group_id)
      const ok = clearSession(sessionKey(e, eff.chat.sessionScope))
      return e.reply(ok ? '好，之前聊的我都忘掉啦~' : '我们还没聊过呢')
    },
  },

  // ----- long-term memory -----
  {
    names: ['记忆', '我的记忆', 'memory'],
    level: 'user',
    async run({ e, args }) {
      const admin = config.isAdmin(e)
      const m = /^(群|group)\s*(\d+)?$/.exec(args)
      if (args && !admin) return e.reply('只有管理员可以查看别人的记忆')
      const out: string[] = []
      const section = (scope: MemScope, key: string, title: string) => {
        const lines = renderMemory(scope, key)
        const u = usage(scope, key)
        out.push(`【${title}】${lines.length ? `（${u.entries}/${u.maxEntries} 条，${u.chars}/${u.maxChars} 字）` : ''}`, ...(lines.length ? lines : ['（空）']))
      }
      if (m) {
        const gid = m[2] ?? (e.group_id ? String(e.group_id) : '')
        if (!gid) return e.reply('请指定群号：#llm记忆 群 123456')
        section('group', gid, `群 ${gid} 的长期记忆`)
      } else {
        const uid = args ? args.replace(/\D/g, '') : String(e.user_id)
        section('user', uid, uid === String(e.user_id) ? '关于你的长期记忆' : `关于 ${uid} 的长期记忆`)
        if (!args && e.group_id) section('group', String(e.group_id), '本群的长期记忆')
      }
      out.push('', '#llm删除记忆 <编号> 删除一条；#llm忘记我 清空关于你的全部记忆')
      return say(e, out.join('\n'))
    },
  },
  {
    names: ['删除记忆'],
    level: 'user',
    async run({ e, args }) {
      const toks = args.split(/\s+/).filter(Boolean)
      const id = toks.find(t => /^m[0-9a-z]+$/i.test(t))
      if (!id) return e.reply('格式：#llm删除记忆 <编号>（编号见 #llm记忆，如 m3）')
      const admin = config.isAdmin(e)
      const other = toks.find(t => /^\d{5,}$/.test(t))
      if (other && !admin) return e.reply('只有管理员可以删除别人的记忆')
      if (deleteMemory('user', other ?? String(e.user_id), id)) return e.reply(`✅ 已删除记忆 ${id}`)
      // group memory: members may delete only when anyone's chat may write it; otherwise admins only
      const canGroup = admin || config.get().memory.groupWrite === 'all'
      if (e.group_id && listMemory('group', String(e.group_id)).some(x => x.id === id)) {
        if (!canGroup) return e.reply('只有管理员可以删除群记忆')
        deleteMemory('group', String(e.group_id), id)
        return e.reply(`✅ 已删除本群记忆 ${id}`)
      }
      return e.reply(`没有找到记忆 ${id}`)
    },
  },
  {
    names: ['忘记我'],
    level: 'user',
    async run({ e }) {
      const n = clearMemory('user', String(e.user_id))
      return e.reply(n ? `好，关于你的 ${n} 条长期记忆都已删除` : '我没有记着关于你的事')
    },
  },
  {
    names: ['清空长期记忆'],
    level: 'admin',
    async run({ e, args }) {
      const m = /^(群|group)\s*(\d+)?$/.exec(args)
      if (m) {
        const gid = m[2] ?? (e.group_id ? String(e.group_id) : '')
        if (!gid) return e.reply('格式：#llm清空长期记忆 群 <群号>')
        return e.reply(`✅ 已清空群 ${gid} 的 ${clearMemory('group', gid)} 条记忆`)
      }
      const qq = args.replace(/\D/g, '')
      if (!qq) return e.reply('格式：#llm清空长期记忆 <QQ> 或 #llm清空长期记忆 群 [群号]')
      return e.reply(`✅ 已清空 ${qq} 的 ${clearMemory('user', qq)} 条记忆`)
    },
  },

  // ----- basic admin -----
  {
    names: ['开启', '关闭'],
    level: 'admin',
    async run({ e, args, self }) {
      const on = self.matched === '开启'
      const gid = targetGroup(e, args || '本群')
      if (!gid) return e.reply('请在群里使用，或指定群号：#llm开启 123456')
      config.set(`groups.${gid}.enable`, on)
      return e.reply(`✅ 群 ${gid} 已${on ? '开启' : '关闭'} LLM 对话`)
    },
  },
  {
    names: ['全局开启', '全局关闭'],
    level: 'admin',
    async run({ e, self }) {
      const on = self.matched === '全局开启'
      config.set('enable', on)
      return e.reply(`✅ LLM 插件已${on ? '全局开启' : '全局关闭'}`)
    },
  },
  {
    names: ['重载', 'reload'],
    level: 'admin',
    async run({ e }) {
      config.load()
      loadSkills()
      const tools = await loadCustomTools()
      const r = await scanCatalog()
      return e.reply(`✅ 已重载：技能 ${listSkills().length} 个，自定义工具 ${tools.length} 个，指令 ${r.verified}/${r.entries}`)
    },
  },
  {
    names: ['配置', 'config'],
    level: 'admin',
    async run({ e, args }) {
      const v = args ? config.read(args) : config.get()
      if (v === undefined) return e.reply(`配置项 ${args} 不存在`)
      const text = typeof v === 'object' && v !== null ? YAML.stringify(mask(v, args.split('.').pop()), { lineWidth: 0 }) : String(mask(v, args.split('.').pop()))
      return say(e, `${args || '全部配置'}：\n${truncate(text, 6000)}`)
    },
  },
  {
    names: ['设置', 'set'],
    level: 'admin',
    async run({ e, args }) {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(args)
      if (!m) return e.reply('格式：#llm设置 <路径> <值>，例如 #llm设置 chat.groupContext 8')
      const [, path, rawValue] = m
      if (isSecretPath(path) && e.group_id) {
        await e.recall?.().catch?.(() => {})
        return e.reply('⚠️ 密钥类配置只能私聊设置')
      }
      const value = parseValue(rawValue)
      const old = config.read(path)
      if (old !== undefined && old !== null && value !== null) {
        const ot = Array.isArray(old) ? 'array' : typeof old
        const nt = Array.isArray(value) ? 'array' : typeof value
        if (ot !== nt && !(ot === 'array' && nt === 'string') && ot !== 'object')
          return e.reply(`类型不匹配：${path} 原来是 ${ot}，你给的是 ${nt}`)
      }
      config.set(path, Array.isArray(old) && typeof value === 'string' ? value.split(/[,，]\s*/) : value)
      const shown = isSecretPath(path) ? maskSecret(String(value)) : JSON.stringify(config.read(path))
      return e.reply(`✅ ${path} = ${truncate(shown, 300)}${old === undefined ? '\n（注意：这是新的配置项，请确认拼写）' : ''}`)
    },
  },
  {
    names: ['删除配置', 'unset'],
    level: 'admin',
    async run({ e, args }) {
      if (!args) return e.reply('格式：#llm删除配置 <路径>')
      config.delete(args)
      return e.reply(`✅ 已删除 ${args}（恢复默认值：${truncate(JSON.stringify(mask(config.read(args), args)) ?? '无', 200)}）`)
    },
  },
  {
    names: ['管理员列表'],
    level: 'admin',
    async run({ e }) {
      const list = config.get().admins
      return e.reply(list.length ? `插件管理员：${list.join(', ')}\n（Yunzai 主人默认拥有全部权限）` : '没有额外的插件管理员（Yunzai 主人默认拥有全部权限）')
    },
  },
  {
    names: ['添加管理员', '删除管理员'],
    level: 'master',
    async run({ e, args, self }) {
      const qq = (args.match(/\d{5,}/) ?? [])[0] ?? (e.at ? String(e.at) : '')
      if (!qq) return e.reply('请提供 QQ 号')
      const list = config.get().admins.map(String)
      const next = self.matched === '添加管理员' ? [...new Set([...list, qq])] : list.filter(x => x !== qq)
      config.set('admins', next)
      return e.reply(`✅ 插件管理员：${next.join(', ') || '无'}`)
    },
  },
  {
    names: ['清除全部记忆'],
    level: 'admin',
    async run({ e, args }) {
      const gid = targetGroup(e, args)
      const n = clearSessionsWhere(k => !gid || k.includes(`:g${gid}`))
      return e.reply(`✅ 已清除 ${n} 个会话的记忆`)
    },
  },

  // ----- models & providers -----
  {
    names: ['模型列表', 'models'],
    level: 'admin',
    async run({ e }) {
      const c = config.get()
      const def = config.defaultModelId()
      const lines = c.models.map(m => {
        const p = config.getProvider(m.provider)
        const flags = [
          m.id === def ? '【默认】' : '',
          c.fallbackModels.includes(m.id) ? '【备用】' : '',
          !p ? '❌提供商不存在' : config.hasKey(p) ? '' : '❌无Key',
        ].join('')
        return `${m.id}${flags}\n  ${m.provider}(${p?.type ?? '?'}) / ${m.model}\n  思考 ${m.thinking ?? c.chat.thinking}${m.vision === false ? '' : ' · 视觉'}\n  价格 ${priceLine(m)}\n  额度 ${limitLine(m)}`
      })
      return say(e, lines.join('\n\n') || '还没有配置模型')
    },
  },
  {
    names: ['切换模型'],
    level: 'admin',
    async run({ e, args }) {
      const [id, g] = args.split(/\s+/)
      const m = modelOrThrow(id)
      const gid = targetGroup(e, g)
      if (gid) config.set(`groups.${gid}.model`, m.id)
      else config.set('defaultModel', m.id)
      return e.reply(`✅ ${gid ? `群 ${gid}` : '默认'}模型已切换为 ${m.id}（${m.model}）`)
    },
  },
  {
    names: ['添加模型'],
    level: 'admin',
    async run({ e, args }) {
      const [id, provider, model] = args.split(/\s+/)
      if (!id || !provider || !model) return e.reply('格式：#llm添加模型 <id> <提供商> <模型名>')
      if (!config.getProvider(provider)) return e.reply(`提供商「${provider}」不存在，先 #llm添加提供商`)
      if (config.getModel(id)?.id === id) return e.reply(`模型 id「${id}」已存在`)
      updateModels(ms => ms.push({ id, provider, model, pricing: 'auto' } as ModelConfig))
      const m = config.getModel(id)!
      return e.reply(`✅ 已添加模型 ${id}\n价格：${priceLine(m)}\n可用 #llm模型设置 ${id} thinking low 等调整参数`)
    },
  },
  {
    names: ['删除模型'],
    level: 'admin',
    async run({ e, args }) {
      const m = modelOrThrow(args.trim())
      updateModels(ms => ms.splice(ms.findIndex(x => x.id === m.id), 1))
      return e.reply(`✅ 已删除模型 ${m.id}`)
    },
  },
  {
    names: ['模型设置'],
    level: 'admin',
    async run({ e, args }) {
      const mm = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(args)
      if (!mm) return e.reply('格式：#llm模型设置 <id> <字段> <值>')
      const m = modelOrThrow(mm[1])
      const field = mm[2]
      const allowed = ['thinking', 'vision', 'maxTokens', 'temperature', 'topP', 'nativeSearch', 'pricingId', 'extraBody', 'model', 'provider', 'pricing', 'quota']
      if (!allowed.includes(field)) return e.reply(`可设置字段：${allowed.join(', ')}`)
      const value = parseValue(mm[3])
      if (field === 'thinking' && !THINKING.includes(value)) return e.reply(`thinking 可选：${THINKING.join(' / ')}`)
      updateModels(ms => {
        const t = ms.find(x => x.id === m.id)!
        if (value === null) delete (t as any)[field]
        else (t as any)[field] = value
      })
      return e.reply(`✅ ${m.id}.${field} = ${JSON.stringify(value)}`)
    },
  },
  {
    names: ['备用模型'],
    level: 'admin',
    async run({ e, args }) {
      const ids = args.split(/[,，\s]+/).filter(Boolean)
      for (const id of ids) modelOrThrow(id)
      config.set('fallbackModels', ids)
      return e.reply(`✅ 备用模型：${ids.join(' → ') || '无'}`)
    },
  },
  {
    names: ['思考'],
    level: 'admin',
    async run({ e, args }) {
      const [level, id] = args.split(/\s+/) as [ThinkingLevel, string?]
      if (!THINKING.includes(level)) return e.reply(`可选：${THINKING.join(' / ')}`)
      if (id) {
        const m = modelOrThrow(id)
        updateModels(ms => (ms.find(x => x.id === m.id)!.thinking = level))
      } else config.set('chat.thinking', level)
      return e.reply(`✅ ${id ?? '默认'}思考强度：${level}`)
    },
  },
  {
    names: ['温度'],
    level: 'admin',
    async run({ e, args }) {
      const [v, id] = args.split(/\s+/)
      const value = v === '默认' || !v ? null : Number(v)
      if (value !== null && !(value >= 0 && value <= 2)) return e.reply('温度范围 0~2，或「默认」（不发送该参数）')
      if (id) {
        const m = modelOrThrow(id)
        updateModels(ms => {
          const t = ms.find(x => x.id === m.id)!
          if (value === null) delete t.temperature
          else t.temperature = value
        })
      } else config.set('chat.temperature', value)
      return e.reply(`✅ ${id ?? '默认'}温度：${value ?? '不设置（使用模型默认）'}`)
    },
  },
  {
    names: ['提供商列表', 'providers'],
    level: 'admin',
    async run({ e }) {
      const lines = Object.entries(config.get().providers).map(([name, p]) => {
        const keys = resolveKeys(p.apiKey)
        return `${name}：${p.type}  ${p.baseUrl ?? '(默认地址)'}\n  Key：${keys.length ? keys.map(maskSecret).join(', ') : '未配置'}`
      })
      return say(e, lines.join('\n') || '没有提供商')
    },
  },
  {
    names: ['添加提供商'],
    level: 'admin',
    async run({ e, args }) {
      const [name, type, baseUrl, key] = args.split(/\s+/)
      if (!name || !PROVIDER_TYPES.includes(type as ProviderType))
        return e.reply(`格式：#llm添加提供商 <名称> <类型> [地址]\n类型：${PROVIDER_TYPES.join(' / ')}`)
      if (key && e.group_id) {
        await e.recall?.().catch?.(() => {})
        return e.reply('⚠️ 请私聊设置 Key（#llm设置密钥）')
      }
      const p: any = { ...(config.getProvider(name) ?? {}), type }
      if (baseUrl) p.baseUrl = baseUrl
      if (key) p.apiKey = key.includes(',') ? key.split(',') : key
      config.set(`providers.${name}`, p)
      return e.reply(`✅ 提供商 ${name}（${type}）已保存${key ? '' : '\n私聊发送 #llm设置密钥 ' + name + ' <Key> 设置密钥'}`)
    },
  },
  {
    names: ['设置密钥', '设置key'],
    level: 'admin',
    async run({ e, args }) {
      if (e.group_id) {
        await e.recall?.().catch?.(() => {})
        return e.reply('⚠️ 为了安全，请私聊我设置密钥')
      }
      const [name, key] = args.split(/\s+/)
      if (!name || !key) return e.reply('格式：#llm设置密钥 <提供商> <Key>（多个 Key 用英文逗号分隔）')
      if (!config.getProvider(name)) return e.reply(`提供商「${name}」不存在`)
      config.set(`providers.${name}.apiKey`, key.includes(',') ? key.split(',') : key)
      return e.reply(`✅ ${name} 的密钥已设置：${maskSecret(key)}`)
    },
  },
  {
    names: ['删除提供商'],
    level: 'admin',
    async run({ e, args }) {
      const name = args.trim()
      if (!config.getProvider(name)) return e.reply(`提供商「${name}」不存在`)
      config.delete(`providers.${name}`)
      return e.reply(config.getProvider(name) ? `已删除自定义设置，${name} 恢复为默认配置` : `✅ 已删除提供商 ${name}`)
    },
  },
  {
    names: ['测试模型'],
    level: 'admin',
    async run({ e, args }) {
      const id = args.trim() || config.defaultModelId()
      const m = modelOrThrow(id)
      const start = Date.now()
      try {
        const { text } = await utilityChat({
          candidates: [m.id],
          system: '你是一个测试助手。',
          user: [{ type: 'text', text: '请只回复：OK' }],
          maxTokens: 50,
          quotaCtx: { userId: e.user_id, isAdmin: true },
        })
        return e.reply(`✅ ${m.id} 正常（${Date.now() - start}ms）：${truncate(text, 100)}`)
      } catch (err: any) {
        return e.reply(`❌ ${m.id} 失败：${truncate(err.message, 300)}`)
      }
    },
  },

  // ----- billing -----
  {
    names: ['额度设置'],
    level: 'admin',
    async run({ e, args }) {
      const toks = args.split(/\s+/).filter(Boolean)
      const id = toks.shift()
      if (!id) return e.reply('格式：#llm额度设置 <模型id> [user|group|global] 5h=1 week=2')
      const m = modelOrThrow(id)
      let scope: QuotaScope | undefined
      if (['user', 'group', 'global'].includes(toks[0])) scope = toks.shift() as QuotaScope
      const lim: any = {}
      for (const t of toks) {
        const kv = /^(5h|week|weekly|周)=([\d.]+)$/i.exec(t)
        if (!kv) return e.reply(`无法识别：${t}`)
        const v = Number(kv[2]) || null
        if (kv[1].toLowerCase() === '5h') lim.window5h = v
        else lim.weekly = v
      }
      updateModels(ms => {
        const t = ms.find(x => x.id === m.id)!
        t.quota ??= {}
        if (scope) t.quota[scope] = { ...(t.quota[scope] ?? {}), ...lim }
        else Object.assign(t.quota, lim)
      })
      return e.reply(`✅ ${m.id} 额度：${limitLine(config.getModel(m.id)!)}`)
    },
  },
  {
    names: ['价格'],
    level: 'admin',
    async run({ e, args }) {
      const m = modelOrThrow(args.trim() || config.defaultModelId())
      const p = resolvePrice(m)
      if (!p) return e.reply(`${m.id}（${m.model}）价格未知。可 #llm设置价格 或 #llm模型设置 ${m.id} pricingId <价格表中的模型名>`)
      return e.reply(
        `${m.id}（${m.model}）每百万 token：\n输入 $${p.input}  输出 $${p.output}\n缓存读 $${p.cacheRead ?? '≈输入×0.5'}  缓存写 $${p.cacheWrite ?? '≈输入×1.25'}${p.perSearch ? `\n联网搜索 $${p.perSearch}/次` : ''}\n来源：${p.source}`,
      )
    },
  },
  {
    names: ['设置价格'],
    level: 'admin',
    async run({ e, args }) {
      const toks = args.split(/\s+/).filter(Boolean)
      const m = modelOrThrow(toks.shift() ?? '')
      const map: Record<string, string> = { in: 'input', input: 'input', out: 'output', output: 'output', cacheread: 'cacheRead', cachewrite: 'cacheWrite', cachewrite1h: 'cacheWrite1h', search: 'perSearch', persearch: 'perSearch' }
      const pricing: any = {}
      for (const t of toks) {
        const kv = /^(\w+)=([\d.]+)$/.exec(t)
        const k = kv && map[kv[1].toLowerCase()]
        if (!k) return e.reply(`无法识别：${t}（可用 in= out= cacheRead= cacheWrite= search=）`)
        pricing[k] = Number(kv![2])
      }
      if (pricing.input == null || pricing.output == null) return e.reply('至少需要 in= 和 out=（美元/百万token）')
      updateModels(ms => (ms.find(x => x.id === m.id)!.pricing = pricing))
      return e.reply(`✅ ${m.id} 价格：${priceLine(config.getModel(m.id)!)}`)
    },
  },
  {
    names: ['刷新价格'],
    level: 'admin',
    async run({ e }) {
      await refreshPrices(true)
      const lines = config.get().models.map(m => `${m.id}：${priceLine(m)}`)
      return e.reply(`价格表：${priceCacheInfo().count} 个模型\n${lines.join('\n')}`)
    },
  },
  {
    names: ['余额'],
    level: 'admin',
    async run({ e }) {
      const lines: string[] = []
      for (const [name, p] of Object.entries(config.get().providers)) {
        if (!config.hasKey(p)) continue
        try {
          const r = await queryBalance(p)
          lines.push(`${name}：${r ?? '该提供商不支持余额查询'}`)
        } catch (err: any) {
          lines.push(`${name}：查询失败 ${truncate(err.message, 60)}`)
        }
      }
      return e.reply(lines.join('\n') || '没有配置 Key 的提供商')
    },
  },
  {
    names: ['统计'],
    level: 'admin',
    async run({ e }) {
      const t = totals()
      const lines = ['【累计】']
      for (const [id, v] of Object.entries(t))
        lines.push(`${id}：${formatUsd(v.cost)}，${v.calls} 次，入 ${v.input} 缓存 ${v.cacheRead} 出 ${v.output}${v.input + v.cacheRead ? `（缓存命中 ${Math.round((v.cacheRead / (v.input + v.cacheRead)) * 100)}%）` : ''}`)
      lines.push('', '【近7天】')
      for (const [day, by] of daily(7)) {
        const sum = Object.values(by).reduce((a, b) => a + b, 0)
        lines.push(`${day}：${formatUsd(sum)}`)
      }
      const top = topUsers(WINDOW_WEEK, 10)
      if (top.length) {
        lines.push('', '【本周用量排行】')
        top.forEach(([uid, v], i) => lines.push(`${i + 1}. ${uid}：${formatUsd(v)}`))
      }
      return say(e, lines.join('\n'))
    },
  },
  {
    names: ['重置额度'],
    level: 'admin',
    async run({ e, args }) {
      if (args === '全部') {
        resetUsage({ all: true })
        return e.reply('✅ 已重置所有人的额度窗口（累计统计保留）')
      }
      const qq = args.replace(/\D/g, '')
      if (!qq) return e.reply('格式：#llm重置额度 <QQ|全部>')
      resetUsage({ userId: qq })
      return e.reply(`✅ 已重置 ${qq} 的额度窗口`)
    },
  },

  // ----- persona -----
  {
    names: ['人设列表'],
    level: 'admin',
    async run({ e }) {
      const p = config.get().persona
      const lines = Object.entries(p.presets).map(([k, v]) => `${k === p.active ? '★' : '·'} ${k}：${truncate(v.replace(/\s+/g, ' '), 40)}`)
      return say(e, lines.join('\n') || '没有人设')
    },
  },
  {
    names: ['人设'],
    level: 'admin',
    async run({ e }) {
      const eff = config.effective(e.group_id)
      return say(e, `当前人设（${config.get().groups[String(e.group_id)]?.persona ?? config.get().persona.active}）：\n${eff.personaPrompt}`)
    },
  },
  {
    names: ['设置人设'],
    level: 'admin',
    async run({ e, args }) {
      const m = /^(\S+)\s*[\r\n]+([\s\S]+)$/.exec(args) ?? /^(\S+)\s+([\s\S]+)$/.exec(args)
      if (!m) return e.reply('格式：#llm设置人设 <名称>（换行）<人设内容>')
      config.set(`persona.presets.${m[1]}`, m[2].trim())
      return e.reply(`✅ 人设「${m[1]}」已保存（${m[2].trim().length} 字）。#llm切换人设 ${m[1]} 启用`)
    },
  },
  {
    names: ['切换人设'],
    level: 'admin',
    async run({ e, args }) {
      const [name, g] = args.split(/\s+/)
      if (!config.get().persona.presets[name]) return e.reply(`没有人设「${name}」`)
      const gid = targetGroup(e, g)
      if (gid) config.set(`groups.${gid}.persona`, name)
      else config.set('persona.active', name)
      return e.reply(`✅ ${gid ? `群 ${gid}` : '默认'}人设已切换为「${name}」`)
    },
  },
  {
    names: ['删除人设'],
    level: 'admin',
    async run({ e, args }) {
      const name = args.trim()
      if (name === config.get().persona.active) return e.reply('不能删除正在使用的默认人设')
      config.delete(`persona.presets.${name}`)
      return e.reply(`✅ 已删除人设「${name}」`)
    },
  },

  // ----- stickers -----
  {
    names: ['添加表情'],
    level: 'admin',
    // Only images inside this very message, or in the message it replies to, are added — never later messages.
    async run({ e, args }) {
      const [name, ...rest] = args.split(/\s+/).filter(Boolean)
      const hint = name ? { name, desc: rest.join(' ') || undefined } : undefined
      const n = await addStickersFrom(e, hint)
      if (n) return true
      return e.reply('没有找到图片。请在这条指令里附带图片/表情，或者引用（回复）一条图片消息再发送 #llm添加表情')
    },
  },
  {
    names: ['导入收藏表情'],
    level: 'admin',
    async run({ e, args }) {
      const count = Math.min(Number(args) || 20, 100)
      let res: any
      try {
        res = await sendApi(e, 'fetch_custom_face', { count })
      } catch (err: any) {
        return e.reply(`获取收藏表情失败（需要 NapCat 等支持 fetch_custom_face 的协议端）：${truncate(err.message, 80)}`)
      }
      const urls: string[] = (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []).filter((u: any) => typeof u === 'string')
      if (!urls.length) return e.reply('没有获取到收藏表情')
      await e.reply(`获取到 ${urls.length} 个收藏表情，正在下载并识别，请稍候…`)
      let added = 0
      let failed = 0
      for (const url of urls) {
        const buf = await fetchBuffer(url, { maxBytes: 10 * 1024 * 1024 })
        if (!buf) {
          failed++
          continue
        }
        const [s, isNew] = addImageSticker(buf, { addedBy: String(e.user_id) })
        if (!isNew) continue
        added++
        try {
          await indexSticker(s, { userId: String(e.user_id) })
        } catch {
          failed++
        }
      }
      return e.reply(`✅ 新增 ${added} 个表情${failed ? `，${failed} 个下载或识别失败` : ''}。#llm表情列表 查看`)
    },
  },
  {
    names: ['表情列表'],
    level: 'admin',
    async run({ e }) {
      const items = listStickers()
      if (!items.length) return e.reply('还没有表情，#llm添加表情 来添加')
      const lines = items.map(s => `${s.id}「${s.name}」${s.kind === 'mface' ? '[商城]' : ''}${s.indexed ? '' : '[未识别]'} ${s.use || s.desc} ·用${s.uses}次`)
      return say(e, `共 ${items.length} 个表情：\n${lines.join('\n')}`)
    },
  },
  {
    names: ['查看表情'],
    level: 'admin',
    async run({ e, args }) {
      const s = findSticker(args)
      if (!s) return e.reply('没有这个表情')
      await e.reply(`${s.id}「${s.name}」\n描述：${s.desc}\n场景：${s.use}\n标签：${s.tags.join('、')}${s.text ? `\n文字：${s.text}` : ''}`)
      return sendSticker(e, s, config.get().sticker.sendAs)
    },
  },
  {
    names: ['重命名表情'],
    level: 'admin',
    async run({ e, args }) {
      const [id, ...rest] = args.split(/\s+/)
      const s = findSticker(id ?? '')
      if (!s || !rest.length) return e.reply('格式：#llm重命名表情 <编号> <新名称> [使用场景]')
      const name = uniqueName(rest[0], s.id)
      updateSticker(s.id, { name, use: rest.slice(1).join(' ') || s.use, indexed: true })
      return e.reply(`✅ ${s.id} 已命名为「${name}」`)
    },
  },
  {
    names: ['删除表情'],
    level: 'admin',
    async run({ e, args }) {
      const s = removeSticker(args)
      return e.reply(s ? `✅ 已删除 ${s.id}「${s.name}」` : '没有这个表情')
    },
  },
  {
    names: ['识别表情'],
    level: 'admin',
    async run({ e, args }) {
      const targets = args === '全部' ? listStickers() : args ? [findSticker(args)].filter(Boolean) : listStickers().filter(s => !s.indexed)
      if (!targets.length) return e.reply('没有需要识别的表情')
      await e.reply(`正在识别 ${targets.length} 个表情…`)
      let ok = 0
      for (const s of targets as Sticker[]) {
        try {
          await indexSticker(s, { userId: String(e.user_id) })
          ok++
        } catch (err: any) {
          log.warn(`识别表情 ${s.id} 失败: ${err.message}`)
        }
      }
      return e.reply(`✅ 识别完成 ${ok}/${targets.length}`)
    },
  },

  // ----- tools / skills / commands -----
  {
    names: ['工具列表', 'tools'],
    level: 'admin',
    async run({ e }) {
      const disabled = new Set(config.get().tools.disabled)
      const ws = config.get().tools.webSearch
      const lines = registry.all().map(t => `${disabled.has(t.name) ? '⛔' : '✅'} ${t.name}（${t.source ?? 'builtin'}）${truncate(t.description, 40)}`)
      lines.push('', `联网搜索：${ws.enable ? ws.provider : '关闭'}${ws.provider === 'native' ? '（使用模型自带搜索，仅 anthropic/openai-responses/gemini 类型支持）' : ''}`)
      return say(e, lines.join('\n'))
    },
  },
  {
    names: ['启用工具', '禁用工具'],
    level: 'admin',
    async run({ e, args, self }) {
      const name = args.trim()
      if (!registry.get(name)) return e.reply(`没有工具「${name}」`)
      const set = new Set(config.get().tools.disabled)
      if (self.matched === '禁用工具') set.add(name)
      else set.delete(name)
      config.set('tools.disabled', [...set])
      return e.reply(`✅ 工具 ${name} 已${self.matched === '禁用工具' ? '禁用' : '启用'}`)
    },
  },
  {
    names: ['搜索设置'],
    level: 'admin',
    async run({ e, args }) {
      const [provider, extra] = args.split(/\s+/)
      const ok = ['native', 'tavily', 'brave', 'searxng', 'jina', 'none']
      if (!ok.includes(provider)) return e.reply(`可选：${ok.join(' / ')}`)
      if (extra && provider !== 'searxng' && e.group_id) {
        await e.recall?.().catch?.(() => {})
        return e.reply('⚠️ 请私聊设置搜索 Key')
      }
      config.set('tools.webSearch.provider', provider)
      config.set('tools.webSearch.enable', provider !== 'none')
      if (extra) config.set(provider === 'searxng' ? 'tools.webSearch.baseUrl' : 'tools.webSearch.apiKey', extra)
      return e.reply(`✅ 联网搜索：${provider}`)
    },
  },
  {
    names: ['技能列表', 'skills'],
    level: 'admin',
    async run({ e }) {
      const s = listSkills()
      return say(e, s.length ? s.map(x => `· ${x.name}：${x.description}`).join('\n') : '没有技能。#llm添加技能 来添加')
    },
  },
  {
    names: ['查看技能'],
    level: 'admin',
    async run({ e, args }) {
      const s = listSkills().find(x => x.name === args.trim())
      return s ? say(e, `${s.name}：${s.description}\n\n${s.body}`) : e.reply('没有这个技能')
    },
  },
  {
    names: ['添加技能'],
    level: 'admin',
    async run({ e, args }) {
      const m = /^(\S+)\s*[\r\n]+([\s\S]+)$/.exec(args)
      if (!m) return e.reply('格式：#llm添加技能 <名称>（换行）<内容>\n内容第一行写技能简介，或使用 --- frontmatter（name/description）')
      let md = m[2].trim()
      if (!md.startsWith('---')) {
        const parsed = parseSkillMarkdown(md, m[1])
        md = `---\nname: ${m[1]}\ndescription: ${JSON.stringify(parsed.description)}\n---\n${md}\n`
      }
      const s = saveSkill(m[1], md)
      return e.reply(`✅ 技能「${s.name}」已保存：${s.description}`)
    },
  },
  {
    names: ['删除技能'],
    level: 'admin',
    async run({ e, args }) {
      return e.reply(deleteSkill(args.trim()) ? '✅ 已删除' : '没有这个技能')
    },
  },
  {
    names: ['指令列表'],
    level: 'admin',
    async run({ e, args }) {
      if (args) return say(e, searchCommands(args, 15).join('\n') || '没有找到')
      return say(e, formatCommandCatalog())
    },
  },
  {
    names: ['扫描指令'],
    level: 'admin',
    async run({ e }) {
      const r = await scanCatalog()
      return e.reply(`✅ 扫描完成：${r.rules} 条规则，${r.entries} 条指令说明，其中 ${r.verified} 条已验证可用`)
    },
  },
  {
    names: ['测试指令'],
    level: 'admin',
    async run({ e, args }) {
      if (!args) return e.reply('格式：#llm测试指令 #深渊')
      const r = await matchRule(args, e)
      return e.reply(r ? `「${args}」→ 插件「${r.plugin}」的 ${r.fnc}（/${truncate(r.reg.source, 80)}/）${r.permission ? ` 权限:${r.permission}` : ''}` : `没有插件会处理「${args}」`)
    },
  },
  {
    names: ['添加指令说明'],
    level: 'admin',
    async run({ e, args }) {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(args)
      if (!m) return e.reply('格式：#llm添加指令说明 <指令> <说明>')
      const hints = [...config.get().tools.botCommand.hints.filter(h => h.cmd !== m[1]), { cmd: m[1], desc: m[2].trim() }]
      config.set('tools.botCommand.hints', hints)
      await scanCatalog()
      const ok = await matchRule(m[1])
      return e.reply(`✅ 已添加：${m[1]} — ${m[2].trim()}${ok ? '' : '\n⚠️ 当前没有插件能匹配这条指令'}`)
    },
  },
]

const NAMES = COMMANDS.flatMap(c => c.names.map(n => [n.toLowerCase(), c] as const)).sort((a, b) => b[0].length - a[0].length)

export class LLMAdmin extends BasePlugin {
  matched = ''

  constructor() {
    super({
      name: 'LLM管理',
      dsc: 'LLM 插件帮助与管理（#llm帮助）',
      event: 'message',
      priority: 100,
      rule: [{ reg: '^#\\s*(?:llm|LLM|Llm)([\\s\\S]*)$', fnc: 'dispatch' }],
    })
  }

  async dispatch(): Promise<boolean> {
    const e = this.e
    const text = String(e.msg ?? '').replace(/^#\s*llm/i, '').trim()
    const lower = text.toLowerCase()
    const hit = NAMES.find(([n]) => (n === '' ? lower === '' : lower.startsWith(n)))
    if (!hit) {
      await e.reply('没有这个指令，发送 #llm帮助 查看全部指令')
      return true
    }
    const [name, cmd] = hit
    if (cmd.level === 'master' && !e.isMaster) {
      await e.reply('只有主人可以操作')
      return true
    }
    if (cmd.level === 'admin' && !config.isAdmin(e)) {
      await e.reply('只有管理员可以操作')
      return true
    }
    this.matched = cmd.names.find(n => n.toLowerCase() === name) ?? name
    const rawArgs = this.rawText(e).replace(/^#\s*llm/i, '').trim().slice(name.length).trim()
    try {
      await cmd.run({ e, args: rawArgs, self: this })
    } catch (err: any) {
      log.warn(`#llm${name} 出错`, err)
      await e.reply(`出错了：${truncate(err?.message ?? String(err), 200)}`)
    }
    return true
  }

  /** e.msg joins text segments without newlines in some adapters; rebuild from segments to keep line breaks. */
  rawText(e: any): string {
    const t = (e.message ?? [])
      .filter((s: any) => s?.type === 'text')
      .map((s: any) => s.text ?? '')
      .join('')
      .trim()
    return t.startsWith('#') || t.startsWith('＃') ? t.replace(/^＃/, '#') : (e.msg ?? t)
  }
}

export { getQuoted }
