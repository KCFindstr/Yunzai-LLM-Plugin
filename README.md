# Yunzai-LLM-Plugin

TRSS-Yunzai / Miao-Yunzai 的大模型对话插件。只在被 **@** 时说话，不抢占任何已有指令。

## 功能

- **多协议**：OpenAI Chat Completions 兼容接口（DeepSeek、通义、Kimi、智谱、OpenRouter、Ollama…）、OpenAI Responses API、Anthropic Messages API（及兼容接口）、Gemini Interactions API。
- **按接口报告用量的额度控制**：每个模型可设置「5 小时滚动额度」和「每周额度」（美元），按人 / 按群 / 全局三种范围；用量按接口返回的 token（含缓存命中、缓存写入、思考、联网搜索）× 价格计算。价格自动从 LiteLLM / OpenRouter 价格表获取（Claude 内置官方价），也可手动设置；OpenRouter 直接使用返回的实际费用。额度用完自动切换备用模型。Gemini 服务端会话目前可能漏报历史输入和缓存 token，面板与统计会标记报告不完整；相应花费与额度可能偏低，不能保证实际消费上限，实际费用以服务商账单为准。详见 [Gemini 会话与缓存](docs/GEMINI-CACHING.md)。
- **自然语言转指令**：运行时扫描已启用插件的规则、帮助菜单和配置中的指令说明，只向模型提供验证通过的指令。插件加载规则变化时自动刷新；模型可用工具搜索和列出当前指令。指令以原用户身份重新分发，权限、群开关全部照旧。
- **表情包**：管理员发图片即可添加，视觉模型自动识别命名；聊天时模型偶尔（有概率和冷却控制）发一个合适的表情，以 QQ 表情形式发送。支持商城表情（mface）和导入机器人收藏表情（NapCat）。
- **工具 / 技能**：联网搜索（模型自带搜索或 AnySearch / Tavily / Brave / SearXNG / Jina）、网页读取（防内网访问）、HTML 渲染成图片（表格、多维对比等图片更好读的内容，由模型决定；复用机器人自带的 Chromium，禁用脚本）、自定义 JS 工具、HTTP 工具、`skills/*/SKILL.md` 技能（按需加载，省 token）。
- **运行代码（可选，Windows + WSL2）**：`run_code` 工具在专用 WSL 发行版里用 bubblewrap 隔离运行 Python / Node / Bash（精确计算、数据处理、画图表），可访问公网但看不到 Windows 磁盘、本机和局域网，有时间/内存/磁盘上限。同一次回复里 run_code 和 render_html 共用一个工作目录（HTML 可以直接引用代码下载/生成的图片，渲染也在沙盒里进行），回复结束后清空。`npm run exec-setup -- --install` 一键创建，然后设置 `tools.exec.enable: true`（默认仅管理员可触发，`tools.exec.access: all` 开放给所有人）。
- **思考强度自动选择**：`thinking: auto` 每条消息先用一个便宜的小模型判断是闲聊 / 提问 / 复杂问题（关闭思考，约 200 token、0.6~1 秒，超时自动退回本地关键词规则），再选对应的思考强度；也支持 TypeSafe Jev 或自建 Kev（`chat.thinkingJudge`）。
- **Markdown 输出**：`reply.markdown` 默认关闭；支持 Markdown 的群聊可设为 `true`，QQBot 可用 `auto`。私聊始终使用普通文本；Markdown 模式下帮助和长回复合并为一条消息。
- **群内艾特 / 身份**：模型可在正文使用 `[at:ID]`，插件转换为真实 `at` 消息段。ID可来自当前消息、历史或记忆；最近群友资料仅辅助识人，不是艾特白名单。资料来自消息名片、昵称、带名艾特和适配器已有缓存，缺失时不把数字冒充名字；拿不到昵称时（如 QQBot 只给用户ID）可在配置 `names`（全局）或 `groups.<群号>.names`（单个群）里写「平台ID: 称呼」，或在网页面板「群友称呼」页逐个填写，配置的称呼优先于适配器提供的名字。`chat.rosterSize` 默认12，可设0关闭。每次最多5个，不支持全体成员，私聊和代码中的标记不会触发艾特。`reply.atUser` 只控制自动艾特提问者。
- **人设文件**：人设可以写成 `file:PERSONA.md`，直接编辑文件即可生效（示例见 `config/PERSONA.md`）。完整的请求示例见 [docs/EXAMPLE_ROLLOUT.md](docs/EXAMPLE_ROLLOUT.md)。

人设按原文发送，不做 Markdown 转义或反转义。CLI 的外部编辑器使用 `.md` 临时文件；请用原始 Markdown/纯文本模式编辑。新版 Windows 记事本支持格式化 Markdown，若使用其格式化视图粘贴/编辑，请检查“Markdown 语法”视图中的源文本，或关闭格式化支持，避免把编辑器生成的字面反斜杠保存到人设里。不要靠全局去除反斜杠修复，以免损坏路径、正则或有意保留的转义。

- **回复与调度**：模型自行决定长回复发文字还是用 render_html 排成图片（要复制的代码、命令、链接等保持文字），文字按 Markdown/纯文字模式发送。每次 `#llm` 命令的文字/图片预览合并为一张紧凑图片，帮助使用双栏排版，不拆多条；特别长时自动缩放而不裁切。原生非图片附件保留原协议，在同一次发送中附带。会话内串行保持历史顺序，不同会话按 `reply.concurrency` 并发；`chat.maxPending` 默认20，满时提示而不静默丢弃。用户冷却改为延后处理，不丢掉后续呼叫。仍保留模拟打字、发送频率上限、引用和提示冷却。
- **上下文 / 省 token**：精简且稳定的系统提示，动态群友资料放本轮上下文；Anthropic 显式缓存断点、OpenAI `prompt_cache_key`、Gemini 服务端会话。近期历史、滚动摘要、旧聊天档案和长期事实分层使用：被截掉的聊天在同一次摘要调用中整理成可检索的片段摘要，每轮自动附上最多两段相关片段，模型遇到对方提及过去（“上次说的”、“之前那个”、续接旧话题）或早先决定/约定时也会积极调用 `recall`；每天的档案再整理成一条「当日概要」（默认保留365天），问到昨天、上周六、10月20日等日期时按日期检索；群里没有@机器人的普通聊天也会分段整理进档案和当日概要（`memory.groupChatArchive`，后台每5分钟处理）；私聊检索对方所在群的档案为可选项（`memory.crossChatRecall`，默认关）；配置 `memory.embedding`（默认 Voyage `voyage-4-lite`）后改为关键词 + 向量混合检索，无 Key 或出错时自动退回关键词。档案每会话最多120段、保留30天，过滤敏感信息；清除会话同时清除档案。空闲过期保留摘要，模型压缩失败也保留回退摘要；提示词要求模型每轮自查并主动保存称呼、喜好、约定等长期有用的事实，不等用户要求。
- **私聊管理**：主人/插件管理员私聊发送 `#llm帮助` 查看全部管理指令，模型、Key、额度、人设、表情、工具都能用指令配置。
- **网页管理面板**：插件加载时自动在 `http://127.0.0.1:6190` 启动（`web` 配置节），可在浏览器里完成全部管理：概览与机器人状态、用量与额度、会话（滚动摘要 / 旧聊天档案 / 当前上下文 / 最近对话含工具调用与花费）、长期记忆增删改、群友称呼、人设编辑、模型测试与余额、按配置结构生成的表单（与 `npm run config` 同一套校验）及 config.yaml 原文编辑、表情包（拖放批量上传并自动识别命名、重新识别、编辑名称/描述/标签、筛选与批量删除）、工具/技能/指令目录、电脑任务和实时日志。「向量空间」页把旧聊天档案的向量用 PCA 投影到可旋转缩放的 3D 空间，可逐点浏览，也可输入一句话查看它落在哪里、最相近的档案是哪些。

## 安装

```bash
cd plugins
git clone <本仓库地址> Yunzai-LLM-Plugin
cd ..
pnpm install
```

仓库内已包含构建好的 `dist/`，无需额外构建。重启 Yunzai 后私聊机器人：

```
#llm设置密钥 anthropic sk-ant-xxxx
#llm切换模型 sonnet     （默认提供的模型：sonnet / haiku / gpt / luna / flash / flash-lite / deepseek）
#llm测试模型
```

也可以在服务器上用命令行配置工具（进入 `plugins/Yunzai-LLM-Plugin` 目录直接运行 `npm run config`）：方向键选择，枚举项单选、多值项勾选；只能填写有效的配置项（包括文件里还没有的），每次修改都会校验；修改后机器人自动热重载：

```bash
cd plugins/Yunzai-LLM-Plugin

npm run config                                            # 交互式：浏览全部配置项、搜索、添加提供商/模型
npm run config -- list reply                              # 列出某一节
npm run config -- describe chat.groupContext
npm run config -- set providers.deepseek.apiKey sk-xxxx
npm run config -- unset reply.maxBubbles                  # 恢复默认
npm run config -- check
```

也可以用浏览器打开网页管理面板 `http://127.0.0.1:6190`（与 Yunzai 在同一台机器上）。登录密码在 `web.password` 设置；留空时首次启动会随机生成一个，打印在 Yunzai 日志里并保存在 `data/web-auth.json`。默认只监听本机；需要远程访问时把 `web.host` 改为 `0.0.0.0` 并设置强密码，最好再放在 HTTPS 反向代理后面（面板可以查看和修改包括 API Key 在内的全部配置）。

或者直接编辑 `config/config.yaml`（只写要覆盖的项，完整选项见 `config/default_config.yaml`，修改后自动热重载）：

```yaml
providers:
  deepseek:
    type: openai
    baseUrl: https://api.deepseek.com
    apiKey: sk-xxxx
defaultModel: deepseek
```

## 常用指令

持久像素电脑、独立后台代理、技能与预算设置见 [电脑使用说明](docs/COMPUTER-USE.md)。启用后可以说“截一张你的桌面”或“去哔哩哔哩找一个关于你的视频”；先回复，再执行，完成后主动回报。

| 指令 | 说明 | 权限 |
| --- | --- | --- |
| `@机器人 内容` / 引用机器人消息 | 对话 | 所有人 |
| `#llm帮助` | 帮助菜单（管理员可见全部管理指令） | 所有人 |
| `#llm状态` / `#llm额度` / `#llm清除记忆` | 状态、个人用量、清空记忆 | 所有人 |
| `#llm模型列表` / `#llm切换模型 <id>` | 模型管理 | 管理员 |
| `#llm额度设置 sonnet user 5h=1 week=2` | 每人每 5 小时 $1、每周 $2 | 管理员 |
| `#llm设置 <路径> <值>` | 修改任意配置 | 管理员 |
| `#llm添加表情`（附图，或引用一条图片消息） | 添加表情包；只添加这条/被引用消息里的图片 | 管理员 |
| `#llm指令列表` / `#llm测试指令 #深渊` | 查看可被自然语言调用的指令 | 管理员 |

## 开发

```bash
pnpm build        # tsup -> dist/index.js（提交前务必构建）
pnpm type-check
pnpm test         # node:test，全部使用本地模拟服务器，不会调用真实 API
pnpm sandbox      # 本地沙盒：真实 Yunzai + 模拟 NapCat，见 sandbox/README.md
```

日志：每轮会输出思考强度及判断来源、每次工具调用（含参数、耗时）和用量汇总。启动前设置环境变量 `YZ_LLM_DEBUG=1`（如写进 `start.bat`）还会输出工具结果和回复全文，且不需要把整个 Yunzai 调成 debug 级别。

实现细节与交接说明见 [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md)。

主聊天模型的逐轮响应、工具参数与结果可在 **执行记录（Rollouts）** 中查看，布局与 AGY 相同，支持实时更新。记录范围、保留上限及接口见 [执行记录说明](docs/ROLLOUTS.md)。
