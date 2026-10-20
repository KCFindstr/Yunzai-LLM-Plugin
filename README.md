# Yunzai-LLM-Plugin

适用于 **Yunzai-Bot** (支持 Miao-Yunzai 与 TRSS-Yunzai) 的 **LLM (Large Language Model) 智能对话插件**。

支持接入任何兼容 **OpenAI 格式** 的大模型 API（如 **OpenAI / DeepSeek / 通义千问 / 月之暗面 Kimi / Claude / Ollama 本地模型** 等），支持多轮上下文会话记忆、人设提示词配置与群聊/私聊隔离。

---

## 🌟 功能特性

- 🚀 **极简接入**：支持标准 OpenAI 接口规范，兼容市场上绝大部分主流商业模型与本地开源模型。
- 🧠 **多轮上下文记忆**：自动维持与用户的多轮对话上下文，支持超时自动过期与群内独立记忆隔离。
- 🎭 **人设与提示词自定义**：支持设置个性化 System Prompt，随时切换 Bot 性格与角色设定。
- ⚡ **开箱即用热重载**：修改配置文件后自动热重载，无需反复重启机器人。
- 🔧 **丰富的管理命令**：支持在线切换模型、清空上下文记忆、查看当前配置状态等。

---

## 🛠️ 安装与部署

此插件已被软链接挂载至云崽根目录的 `plugins/Yunzai-LLM-Plugin` 下。

### 1. 配置文件

插件首次加载时会自动生成配置文件：
`plugins/Yunzai-LLM-Plugin/config/config.yaml`

编辑该文件填入你的 API Key 和目标服务地址：

```yaml
# API 基础地址
apiUrl: "https://api.deepseek.com/v1"

# API 密钥
apiKey: "sk-your-actual-api-key"

# 模型名称
model: "deepseek-chat"

# 系统预设人设
systemPrompt: "你是一个友好、幽默且富有智慧的 QQ 聊天助手..."

# 上下文轮数
historyLimit: 10
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

如果你是通过朋友暴露的 WebSocket 地址进行对接，有两种典型连接方式：

### 模式 A：朋友提供正向 WebSocket 地址（最常见，如 `ws://friend-ip:port/`）
1. 打开 `plugins/ws-plugin/config/config/ws-config.yaml`。
2. 在 `servers` 列表中添加一项：
   ```yaml
   servers:
     - name: "friend_bot"
       address: "ws://<朋友的IP>:<端口>"
       type: 2   # 2 代表正向 WebSocket 客户端模式
       reconnectInterval: 5
       maxReconnectAttempts: 0
       accessToken: "<朋友提供的token，若无则留空>"
   ```
3. 启动云崽，云崽将自动连接到该地址接收消息。

### 模式 B：朋友使用反向 WebSocket 连接你的机器
1. 你的 TRSS-Yunzai 本地默认监听 `ws://0.0.0.0:2536/OneBotv11`。
2. 如果你在局域网或通过内网穿透（如 frp/cpolar/tailscale），将穿透后的地址提供给朋友，朋友在其协议端（如 NapCat / Lagrange）配置反向 WS 客户端连接至该地址即可。
