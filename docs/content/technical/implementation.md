---
id: implementation
title: 架构演进与核心实现
sidebar_label: 架构与实现
---

# 架构演进与核心实现说明

本文档面向对 Yunzai-LLM-Plugin 源码架构、生命周期及扩展点感兴趣的开发者和深度使用者。

---

## 插件核心模块划分

插件源码位于 `src/` 目录下，按职责高度解耦：

- **`src/core/`**：配置加载、旧配置迁移与校验（`config.ts`，配置结构定义在 `cli/schema.mjs`，Web 面板与命令行共用），目录规范与迁移（`paths.ts`、`layout.ts`）。
- **`src/apps/`**：Yunzai 插件入口，`#llm` 管理指令（`admin.ts`）与聊天触发（`chat.ts`）。
- **`src/chat/`**：对话主循环与工具调用（`agent.ts`）、提示词组装（`prompt.ts`）、会话与历史（`session.ts`）、自动思考判断（`thinking.ts`、`judge.ts`）、主动发言（`proactive.ts`）与执行记录（`rollouts.ts`）。
- **`src/llm/`**：各协议适配器（`openaiChat.ts`、`openaiResponses.ts`、`anthropic.ts`、`gemini.ts`、`systemone.ts`），抹平 OpenAI、Anthropic、Gemini 的差异。
- **`src/billing/`**：价格表（`pricing.ts`）、用量与额度账本（`ledger.ts`）、余额查询（`balance.ts`）。
- **`src/memory/`**：基于 Node 内置 `node:sqlite` 的记忆存储、摘要整理与向量检索。
- **`src/commands/`**：其他插件指令的发现与以原身份重新分发。
- **`src/tools/`**：工具注册中心（`registry.ts`）与各工具实现（搜索、网页读取、HTML 渲染、代码执行、电脑任务、Google Lens、AGY、技能）。
- **`src/web/`**：内置 HTTP 服务与 REST API，服务 Web 管理面板（前端位于 `web/`）。

---

## 自动化测试与质量守护

代码库使用 Node.js 内置的 `node:test` 测试运行器（`npm test`）：
- **460+ 项单元与集成测试**
- 覆盖各提供商协议、配置校验与迁移、额度、工具限制、记忆检索以及 Web 管理接口。
- 所有网络请求在测试中均使用本地 Mock 拦截，测试过程零 Token 消费。
