---
id: gemini-caching
title: Gemini 会话与服务端缓存
sidebar_label: Gemini 缓存机制
---

# Google Gemini 会话与服务端缓存剖析

Google Gemini 提供 Interactions API 与上下文缓存，但在对接和计费统计上有一些特殊之处。

---

## 会话保持机制

- **服务端会话 (`serverState`)**：
  默认开启（`providers.<名称>.serverState: true`，可按模型覆盖）。每个新 rollout 首轮发送组装的完整上下文并建立新会话；仅同一 rollout 内的工具轮次及原 rollout 的后台结果可续接 interaction ID。系统提示、工具定义和生成参数每次照常发送。关闭后每个工具轮次也发送完整上下文。
- **重建会话**：
  每个新 rollout 必须重建，不继承旧执行的临时提示或工具结果。原 rollout 的后台结果仅在上下文、提供商和模型仍匹配时续接；服务端 ID 失效时重发完整上下文。OpenAI Responses 也遵守这一边界。
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
