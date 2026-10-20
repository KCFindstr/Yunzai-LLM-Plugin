# Yunzai-LLM-Plugin (TypeScript)

适用于 **Yunzai-Bot** (支持 Miao-Yunzai 与 TRSS-Yunzai) 的 **LLM (Large Language Model) 智能对话插件**，采用 **TypeScript + tsup** 构建。

支持接入任何兼容 **OpenAI 格式** 的大模型 API（如 **OpenAI / DeepSeek / 通义千问 / 月之暗面 Kimi / Claude / Ollama 本地模型** 等），支持多轮上下文会话记忆、人设提示词配置与群聊/私聊隔离。

---

## 🌟 功能特性

- 🔷 **TypeScript 全栈开发**：具备完整的静态类型声明与 IDE 智能补全，开箱即用。
- ⚡ **极致构建体验**：基于 `tsup` (esbuild) 构建，秒级增量编译，配合 `pnpm dev` 监听热更。
- 🚀 **极简大模型接入**：支持标准 OpenAI 接口规范，兼容市场上绝大部分主流商业模型与本地开源模型。
- 🧠 **多轮上下文记忆**：自动维持与用户的多轮对话上下文，支持超时自动过期与群内独立记忆隔离。
- 🎭 **人设与提示词自定义**：支持设置个性化 System Prompt，随时切换 Bot 性格与角色设定。
- 🔧 **丰富的管理命令**：支持在线切换模型、清空上下文记忆、查看当前配置状态等。

---

## 📁 源码目录结构

```text
Yunzai-LLM-Plugin/
├── src/                      # TypeScript 源代码
│   ├── apps/
│   │   ├── chat.ts           # 核心对话逻辑 (#chat, #ai, @机器人)
│   │   └── manage.ts         # 插件管理指令 (#llm状态, #llm切换模型, #清除记忆)
│   ├── lib/
│   │   ├── config.ts         # 配置加载与热重载
│   │   ├── memory.ts         # 会话上下文记忆池
│   │   └── llm.ts            # 大模型 API 请求客户端
│   ├── types/
│   │   ├── index.ts          # 插件与 Yunzai 事件类型定义
│   │   └── plugin.ts         # 插件基类辅助声明
│   └── index.ts              # 插件入口导出
├── dist/                     # 编译生成产物 (由 tsup 构建)
├── config/
│   ├── default_config.yaml   # 默认配置模板
│   └── config.yaml           # 本地生效配置 (git 忽略)
├── index.js                  # Yunzai 框架加载入口 (指向 dist/index.js)
├── tsconfig.json             # TypeScript 配置
├── tsup.config.ts            # 构建配置
└── package.json
```

---

## 💻 开发者命令

在 `D:\Software\Yunzai-LLM-Plugin` 目录下执行：

```bash
# 启动实时监听构建 (代码保存后瞬间自动编译，Yunzai 自动热载入)
pnpm dev

# 执行生产打包
pnpm build

# 执行严格 TypeScript 类型检查
pnpm type-check
```

---

## ⚙️ 配置文件说明

编辑 `plugins/Yunzai-LLM-Plugin/config/config.yaml`：

```yaml
# API 基础地址 (支持 OpenAI、DeepSeek、Ollama 等)
apiUrl: "https://api.deepseek.com/v1"

# API 密钥 (Bearer Token)
apiKey: "sk-your-actual-api-key"

# 默认模型名称
model: "deepseek-chat"

# 系统提示词 (人设)
systemPrompt: "你是一个友好、幽默且富有智慧的 QQ 聊天助手..."

# 上下文记忆保留轮数
historyLimit: 10

# 上下文记忆有效时间 (单位：分钟)
historyTimeout: 30

# 是否在群聊中单独隔离每位群员的记忆
isolateUserInGroup: true
```

---

## 📖 常用指令

| 指令 | 说明 | 权限 |
| :--- | :--- | :--- |
| `#chat <问题>` 或 `#ai <问题>` | 与 AI 进行对话 | 全部用户 |
| `@机器人 <问题>` | 在群聊中艾特机器人直接提问 | 全部用户 |
| `#清除记忆` 或 `#chat reset` | 清除当前会话的上下文记忆 | 全部用户 |
| `#llm状态` 或 `#llm help` | 查看插件状态与帮助指南 | 全部用户 |
| `#llm切换模型 <模型名>` | 在线切换模型 (如 `deepseek-chat`) | 主人权限 |
| `#llm设置提示词 <人设内容>` | 在线更新系统提示词 | 主人权限 |

---

## 🔌 WebSocket 连接方式（对接朋友的云崽或 OneBot 协议端）

### 模式 A：正向 WebSocket 连接（主动连接朋友暴露的 WS 服务）
编辑 `plugins/ws-plugin/config/config/ws-config.yaml`：
```yaml
servers:
  - name: frenqy_bot
    address: ws://frenqy.rabimimi.com:8082
    type: 2
    reconnectInterval: 5
    maxReconnectAttempts: 0
    accessToken: "iIj7<GK%_4}Nspkt"
```

### 模式 B：反向 WebSocket 连接（朋友的协议端主动连接你的机器）
- 本地监听地址：`ws://localhost:2536/OneBotv11`
- 将此端口通过内网穿透（FRP / Tailscale / cpolar 等）暴露给朋友配置为反向客户端。
