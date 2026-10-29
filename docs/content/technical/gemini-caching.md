---
id: gemini-caching
title: Gemini 会话与服务端缓存
sidebar_label: Gemini 缓存机制
---

# Google Gemini 会话与服务端缓存剖析

Google Gemini 提供了强大的 Interactions API 与原生上下文缓存能力，但在实际对接与计费统计中具有特殊性。

---

## 会话保持机制

- **服务端会话 (`serverState`)**：
  默认开启（`providers.<名称>.serverState: true`，可按模型覆盖）。首轮发送完整输入，后续用上次返回的 interaction ID 续接，只发送新增的消息或工具结果；系统提示、工具定义和生成参数每次照常发送。关闭后每次发送完整的本地历史。
- **重建会话**：
  修改人设或可用工具不需要重建。替换前缀记忆、压缩 / 截断历史、切换提供商 / 地址 / 模型、会话过期或服务端 ID 失效时，会重新建立会话。
- **缓存**：
  有状态与无状态模式都使用 Gemini 的隐式缓存，无需 `cache_control`。

---

## 计费与用量报告注意事项

:::note 上游报告不完整标记
Google Gemini Interactions 接口在目前某些服务端会话场景下，返回的用量元数据（Usage Metadata）可能会省略部分已缓存在服务端的历史 Token 数量。
:::

- **面板警示标记**：
  有状态续接会被标记，Web 面板、对话记录、日志和统计命令会提示「用量报告不完整」，受影响的缓存命中率显示「待确认」。
- **账单核对**：
  插件不会补算缺失的 token，因此记录的 Gemini 花费与额度可能偏低，请以 Google AI Studio / Cloud 控制台的账单为准。
