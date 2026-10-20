/** Help menu sections. Each string is sent as one node of a forward message. */

export const USER_HELP = `【LLM 对话 · 使用说明】
• 在群里 @我 + 内容 就能和我聊天；回复（引用）我的消息也可以继续聊
• 可以直接让我帮你查游戏数据，比如：
  @我 帮我查查深渊数据 → 等同于 #深渊
  @我 看看我星铁体力 → 等同于 *体力
• 发图片并@我，我可以看图（取决于当前模型）
• 原有指令照常使用，不受影响

【常用指令】
#llm帮助 — 显示本帮助
#llm状态 — 当前模型、会话信息
#llm额度 — 查看你的用量与剩余额度
#llm清除记忆 — 清空最近的对话上下文（短期记忆）
#llm记忆 — 查看我长期记住的关于你（和本群）的事
#llm删除记忆 <编号> — 删除一条长期记忆
#llm忘记我 — 删除关于你的全部长期记忆`

export const ADMIN_HELP_BASIC = `【管理 · 基础】（主人/插件管理员，可私聊使用）
#llm开启 / #llm关闭 [群号] — 本群（或指定群）启用/停用
#llm全局开启 / #llm全局关闭 — 总开关
#llm重载 — 重新加载配置、技能、工具、指令目录
#llm配置 [路径] — 查看配置（如 #llm配置 chat）
#llm设置 <路径> <值> — 修改任意配置，值按 YAML 解析
  例：#llm设置 chat.groupContext 8
  例：#llm设置 reply.maxBubbles 1
  例：#llm设置 groups.123456.persona 猫娘
#llm删除配置 <路径> — 恢复该项为默认值
#llm管理员列表 / #llm添加管理员 <QQ> / #llm删除管理员 <QQ>（仅主人）
#llm清除全部记忆 [群号] — 清空对话上下文（短期）
#llm记忆 <QQ> / #llm记忆 群 [群号] — 查看某人/某群的长期记忆
#llm删除记忆 <QQ> <编号> — 删除某人的一条长期记忆
#llm清空长期记忆 <QQ> / #llm清空长期记忆 群 [群号]
长期记忆上限与写入权限见配置 memory.*（写满后需合并/删除，接近上限自动整理）`

export const ADMIN_HELP_MODEL = `【管理 · 模型与提供商】
#llm模型列表 — 模型、Key 状态、价格、额度
#llm切换模型 <模型id> [群号] — 设默认模型（或某群模型）
#llm添加模型 <id> <提供商> <模型名> — 例：#llm添加模型 pro gemini gemini-3.1-pro-preview
#llm删除模型 <id>
#llm模型设置 <id> <字段> <值> — 字段：thinking / vision / maxTokens / temperature / nativeSearch / pricingId / extraBody
#llm备用模型 <id1,id2,...> — 额度用完时依次尝试
#llm思考 <off|minimal|low|medium|high|xhigh|max> [模型id] — 思考强度
#llm温度 <0~2|默认> [模型id]
#llm提供商列表
#llm添加提供商 <名称> <类型> <地址> — 类型：openai / openai-responses / anthropic / gemini
  例：#llm添加提供商 ds openai https://api.deepseek.com
#llm设置密钥 <提供商> <Key> — 仅限私聊；多个 Key 用英文逗号分隔（自动轮换）
#llm删除提供商 <名称>
#llm测试模型 [模型id] — 发一条测试请求`

export const ADMIN_HELP_BILLING = `【管理 · 计费与额度】（单位：美元，滚动窗口）
#llm额度设置 <模型id> [user|group|global] 5h=<金额> week=<金额>
  例：#llm额度设置 sonnet user 5h=1 week=2 （每人每5小时$1、每周$2）
  金额写 0 表示不限
#llm价格 <模型id> — 当前使用的价格及来源
#llm设置价格 <模型id> in=<输入> out=<输出> [cacheRead=..] [cacheWrite=..]（每百万token）
#llm刷新价格 — 从 LiteLLM/OpenRouter 价格表更新
#llm余额 — 查询各提供商账户余额（DeepSeek/OpenRouter/Moonshot/SiliconFlow）
#llm统计 — 总花费、近7天、用量排行
#llm额度 <QQ> — 查看某人的用量
#llm重置额度 <QQ|全部>`

export const ADMIN_HELP_PERSONA = `【管理 · 人设】
#llm人设 — 查看当前人设
#llm人设列表
#llm设置人设 <名称>（换行）<人设内容> — 新建/修改，{botName} 会替换为机器人昵称
#llm切换人设 <名称> [群号]
#llm删除人设 <名称>`

export const ADMIN_HELP_STICKER = `【管理 · 表情包】
#llm添加表情 [名称] [描述] — 必须在同一条消息里附带图片/表情，或引用（回复）一条图片消息发送；只添加这条消息/被引用消息里的图片
#llm导入收藏表情 [数量] — 导入机器人QQ号的收藏表情（NapCat）
#llm表情列表 — 查看全部表情
#llm查看表情 <编号|名称>
#llm重命名表情 <编号> <新名称>
#llm删除表情 <编号|名称>
#llm识别表情 [编号|全部] — 用视觉模型重新识别
表情包会被自动识别并按情境偶尔发送；频率：sticker.probability（采纳概率）、sticker.cooldown（同一会话冷却秒数）`

export const ADMIN_HELP_TOOLS = `【管理 · 工具 / 技能 / 指令】
#llm工具列表 — 内置/自定义工具及状态
#llm启用工具 <名称> / #llm禁用工具 <名称>
#llm搜索设置 <native|tavily|brave|searxng|jina|none> [Key或地址]
#llm技能列表 / #llm查看技能 <名称> / #llm删除技能 <名称>
#llm添加技能 <名称>（换行）<SKILL.md 内容，第一行或 frontmatter 写简介>
#llm指令列表 [关键词] — 可被自然语言调用的指令
#llm扫描指令 — 重新扫描已安装插件的指令
#llm测试指令 <文本> — 查看某条指令会被哪个插件处理
#llm添加指令说明 <指令> <说明> — 补充指令目录（提示给 AI）
自定义 JS 工具放在 plugins/Yunzai-LLM-Plugin/tools/*.js，HTTP 工具写在配置 tools.http`
