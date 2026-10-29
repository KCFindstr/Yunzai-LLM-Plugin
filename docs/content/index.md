---
id: index
title: 项目概览
slug: /
---

# Yunzai-LLM-Plugin

欢迎查阅 **Yunzai-LLM-Plugin** 官方文档。

**Yunzai-LLM-Plugin** 是专为 **TRSS-Yunzai** 与 **Miao-Yunzai** 设计的高性能大模型（LLM）对话插件。它具备原生大模型会话管理、多协议接口兼容、精细额度控制、自然语言转指令、智能表情包收发、多层记忆与向量检索、以及开箱即用的 Web 可视化管理工作区。

:::tip 特别提醒：平台兼容性与高级环境
本插件的基础对话、Web 管理面板、多模型路由、额度计费、表情包、多层记忆等核心能力在 **Windows / Linux** 环境下均可无缝使用。

**请特别注意：**
插件的诸多高级扩展工具（包括**代码沙盒执行 `run_code`**、**持久桌面电脑使用 `computer_task`**、**Google Lens 视觉搜索**、**RustDesk 远程控制**以及 **AGY 宿主机全能代理**）目前依赖 Windows 宿主机（除 AGY 外还需要 WSL2），**当前阶段仅支持 Windows 系统**。详细支持矩阵请参见 [平台支持说明](/tools/platform-support)。
:::

---

## 🌟 核心特性一览

<div className="screenshot-card">
  <img src="/img/webui-overview.png" alt="Web 管理面板概览" />
</div>

### 1. 多协议与全主流大模型支持
- **OpenAI 兼容接口**：全面支持 DeepSeek、通义千问 (DashScope)、Kimi (Moonshot)、智谱 GLM、SiliconFlow (硅基流动)、OpenRouter、Ollama 等几乎所有兼容协议的服务商。
- **OpenAI Responses API**：OpenAI 与 DeepSeek 的 Responses 接口，支持推理摘要与自带联网搜索。
- **Anthropic Messages API**：支持 Claude 系列，自带**显式提示词缓存断点**（Prompt Caching），大幅降低 API 成本。
- **Google Gemini Interactions API**：原生接入 Gemini 系列，支持多模态（图像、音频、视频、PDF）直传。

### 2. 精准的额度控制与智能备用路由
- 支持为每个模型独立配置「5 小时滚动额度」与「每周额度」（美元计价）。
- 细分**每人 (user)**、**每群 (group)**、**全局 (global)** 三维立体限制。
- 价格自动同步 LiteLLM / OpenRouter 权威实时价格表，真实统计缓存命中与推理消耗。
- 主模型额度耗尽或不可用时，系统**自动平滑切换到备用模型列表 (fallbackModels)**。

### 3. 多层记忆与 3D 向量空间检索
- **分层记忆架构**：短轮次上下文缓存、自动滚动片段摘要（Rolling Summaries）、每日概要归档（保留365天）、旧聊天档案（保留30天）。
- **向量 + 关键词混合检索**：支持 Voyage AI (`voyage-context-4`) 等 Embedding 向量模型，遇到长远回忆或关联事件时智能唤起。
- **3D 向量可视化**：Web 面板内置 PCA 3D 投影降维视图，可自由旋转、缩放浏览记忆点，直观观察语义聚类。

### 4. 强大的工具生态与高级运行环境
- **内置工具**：联网搜索（模型自带搜索、DeepSeek、AnySearch、Tavily、Brave、SearXNG、Jina）、安全网页读取、HTML 紧凑长图渲染。
- **高级系统级工具（仅 Windows + WSL2 支持）**：
  - **`run_code`**：专用 WSL 容器沙盒隔离运行 Python / Node / Bash 代码。
  - **`computer_task`**：独立的持久桌面，模型自主操作键盘鼠标完成网页与软件任务。
  - **`google_lens`**：在持久桌面的浏览器中用 Google Lens 以图搜图。
  - **`agy`**：宿主机高权限 Antigravity 异步代理。

### 5. 直观优雅的 Web 管理面板
插件启动即开放管理工作区（默认监听 `0.0.0.0:6190`）：
- 实时仪表盘与机器人连接状态
- 提供商管理、连通性测试与余额查询
- 会话上下文与历史记忆审查（支持手动编辑与模型重生成）
- 表情包批量拖拽上传与视觉智能命名
- 动态配置校验与可视化表单编辑

### 6. 自动思考强度与主动发言
- 判断模型按消息类别自动选择思考强度，闲聊不浪费推理 token。
- 可按群开启主动发言：没有被 @ 时也能在合适的时机自然接话。

---

## 快速导航

- 想要快速上手安装并接入模型？请阅读 [快速安装](/getting-started/quickstart)。
- 了解有哪些聊天与控制指令？请阅读 [常用指令大全](/getting-started/commands)。
- 探索 Web 管理面板的全部功能？请阅读 [Web 管理面板指南](/management/webui)。
- 查看各工具对 Windows / Linux 的系统支持？请阅读 [平台支持说明](/tools/platform-support)。
