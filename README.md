# Yunzai-LLM-Plugin

TRSS-Yunzai / Miao-Yunzai 的大模型对话插件。只在被 **@** 时说话，不抢占任何已有指令。

## 功能

- **多协议**：OpenAI Chat Completions 兼容接口（DeepSeek、通义、Kimi、智谱、OpenRouter、Ollama…）、OpenAI Responses API、Anthropic Messages API（及兼容接口）、Gemini Interactions API。
- **按实际花费的额度控制**：每个模型可设置「5 小时滚动额度」和「每周额度」（美元），按人 / 按群 / 全局三种范围；用量按接口返回的真实 token（含缓存命中、缓存写入、思考、联网搜索）× 价格计算。价格自动从 LiteLLM / OpenRouter 价格表获取（Claude 内置官方价），也可手动设置；OpenRouter 直接使用返回的实际费用。额度用完自动切换备用模型。
- **自然语言转指令**：`@机器人 帮我查查深渊数据` 等同于发送 `#深渊`。插件在运行时扫描已安装插件的指令规则和帮助菜单，并用内置的原神 / 星铁 / 绝区零常用指令表交叉验证，只把真实存在的指令提供给模型。指令以原用户身份重新分发，权限、群开关全部照旧。
- **表情包**：管理员发图片即可添加，视觉模型自动识别命名；聊天时模型偶尔（有概率和冷却控制）发一个合适的表情，以 QQ 表情形式发送。支持商城表情（mface）和导入机器人收藏表情（NapCat）。
- **工具 / 技能**：联网搜索（模型自带搜索或 AnySearch / Tavily / Brave / SearXNG / Jina）、网页读取（防内网访问）、HTML 渲染成图片（长回答/表格/攻略，复用机器人自带的 Chromium，禁用脚本）、自定义 JS 工具、HTTP 工具、`skills/*/SKILL.md` 技能（按需加载，省 token）。
- **运行代码（可选，Windows + WSL2）**：`run_code` 工具在专用 WSL 发行版里用 bubblewrap 隔离运行 Python / Node / Bash（精确计算、数据处理、画图表），可访问公网但看不到 Windows 磁盘、本机和局域网，有时间/内存/磁盘上限。`npm run exec-setup -- --install` 一键创建，然后设置 `tools.exec.enable: true`（默认仅管理员可触发，`tools.exec.access: all` 开放给所有人）。
- **思考强度自动选择**：`thinking: auto` 每条消息先用一个便宜的小模型判断是闲聊 / 提问 / 复杂问题（关闭思考，约 200 token、0.6~1 秒，超时自动退回本地关键词规则），再选对应的思考强度；也支持 TypeSafe Jev 或自建 Kev（`chat.thinkingJudge`）。
- **Markdown 输出**：`reply.markdown` 默认关闭（OneBot 不支持）；接入 QQ 官方机器人（QQBot）时可设为 `true` 或 `auto`。
- **人设文件**：人设可以写成 `file:PERSONA.md`，直接编辑文件即可生效（示例见 `config/PERSONA.md`）。完整的请求示例见 [docs/EXAMPLE_ROLLOUT.md](docs/EXAMPLE_ROLLOUT.md)。
- **降低风控**：只在被呼叫时回复；模拟打字延迟；一次最多 N 条消息；群/全局发送频率上限；有人插话才引用；长文合并转发；去除 Markdown；错误和额度提示有冷却。
- **省 token**：稳定的系统提示（时间等动态信息放在用户消息里）以命中缓存；Anthropic 显式缓存断点、OpenAI `prompt_cache_key`、Gemini 服务端会话；历史按块截断（而不是每轮滑动）以保持缓存前缀；旧历史压缩成摘要；工具调用过程不写入长期记忆；执行指令后不再额外调用模型。
- **私聊管理**：主人/插件管理员私聊发送 `#llm帮助` 查看全部管理指令，模型、Key、额度、人设、表情、工具都能用指令配置。

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
