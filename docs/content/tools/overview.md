---
id: overview
title: 工具与技能体系概览
sidebar_label: 工具概览
---

# 工具与技能体系概览

Yunzai-LLM-Plugin 拥有一套严密、安全且支持渐进式调用的工具与技能扩展架构。大模型在对话过程中可以根据需要自主调用工具收集信息、执行计算并组织多模态回复。

---

## 内置基础工具

| 工具标识 | 功能描述 | 适用环境 |
| :--- | :--- | :--- |
| **`web_search`** | 联网搜索。支持模型自带搜索，以及 DeepSeek、AnySearch、Tavily、Brave Search、SearXNG、Jina 等搜索服务。 | 全平台 (Win/Linux) |
| **`web_fetch`** | 读取网页正文（直接抓取、Jina Reader 或 DeepSeek Fetch）。默认禁止访问局域网与内网地址。 | 全平台 (Win/Linux) |
| **`render_html`** | 将 HTML 交给机器人自带的 Chromium 渲染为图片，页面脚本被禁用。 | 全平台 (Win/Linux) |
| **`read_file`** | 按路径读取本对话的附件（图片、视频、音频、文件）加入上下文；不支持直接看图的模型由辅助模型代看。 | 全平台 (Win/Linux) |
| **`send_image`** | 发送附件或工具生成的图片。 | 全平台 (Win/Linux) |
| **`add_sticker`** / **`list_stickers`** | 检索表情包与新增表情包。 | 全平台 (Win/Linux) |
| **`recall`** | 主动检索旧聊天档案与每日概要。 | 全平台 (Win/Linux) |
| **`memory`** | 记录、修改关于群友和本群的长期记忆。 | 全平台 (Win/Linux) |
| **`search_bot_commands`** / **`run_bot_command`** | 搜索并以提问者身份执行其他插件的指令。 | 全平台 (Win/Linux) |

此外可以在 `tools.http` 中声明调用 HTTP 接口的自定义工具。各工具可在 Web 面板「配置 → 工具」中单独开关，或用 `#llm启用工具` / `#llm禁用工具` 切换。

---

## 高级外部系统工具（重点支持差异）

为了赋予大模型更强大的生产力，插件研发了多款系统级工具：
- **`run_code`**：安全隔离的代码执行沙盒。
- **`computer_task`**：在持久桌面上全自主操作电脑（可通过 RustDesk 远程观看与接管）。
- **`google_lens`**：Google 视觉反向搜图。
- **`agy`**：宿主机高权限 Antigravity 异步代理。

:::warning 平台兼容性注意
由于上述高级系统工具深度依赖 Windows PowerShell 自动化脚本、WSL2 子系统隔离容器以及本地系统接口，**目前这些高级环境仅支持在 Windows 宿主机上部署与运行**。Linux 纯服务器环境暂不支持此类工具的自动化创建。详细说明请务必查阅 [平台支持说明](/tools/platform-support)。
:::

---

## 动态技能体系 (`skills/*/SKILL.md`)

插件遵循按需加载规范：
- 插件自带技能位于插件目录的 `skills/<技能名>/SKILL.md`；自建技能放在 `Yunzai/config/Yunzai-LLM-Plugin/skills/<技能名>/SKILL.md`（同名时优先）。
- 启动时大模型仅了解技能的名称与一句话摘要（极省 Token）。
- 当遇到特定复杂任务时，大模型主动调用 `load_skill` 载入完整的技能规范指导下一步行动。
