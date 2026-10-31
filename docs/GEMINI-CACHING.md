# Gemini 会话与缓存

普通对话建议保留默认的 `providers.<名称>.serverState: true`；单个 Gemini 模型可以通过 `models[].serverState` 覆盖。设置为 `false` 或关闭 `store` 后，插件会发送完整的本地历史，不发送 `previous_interaction_id`。摘要、分类等一次性请求始终使用 `store: false`。

每个新 rollout 都建立新的服务端会话，发送该次执行组装的完整上下文（配置允许的历史、摘要、记忆和最近群聊）。`serverState` 只控制同一 rollout 内的工具轮次续接；属于原 rollout 的后台结果可在上下文未改变时续接原链，不属于原 rollout 的回调重新开始。新 rollout 不继承上一次执行的临时提示、工具结果或原始请求。此边界同样适用于启用服务端状态的 OpenAI Responses。

同一 rollout 内，后续工具轮次使用最后成功返回的 interaction ID，只发送新增的 `function_result` 等步骤。每次请求仍发送当前的 `system_instruction`、完整 `tools` 和 `generation_config`。服务端 ID 失效时会用本次执行的完整上下文重试。关闭 `serverState` 或 `store` 后，同一次执行的工具轮次也重发完整上下文。提示缓存仅复用相同输入的计算，不增加隐藏历史。

Gemini Interactions 的有状态与无状态模式都支持隐式缓存，Gemini 3.8 Flash 的文档最小输入长度为 4,096 token。无需添加 `cache_control`，Interactions 也不支持显式缓存对象。相同请求的重试命中率不能代表持续增长的真实对话。

## 用量报告的限制

Google 已确认某些有状态续接的 `usage.total_input_tokens` / `usage.total_cached_tokens` 会遗漏历史上下文。2026-10-22 的 Gemini 3.8 Flash 合成测试也复现了此现象：首轮 8,508 token，续接能准确回忆首轮标记，但仅报告 97 输入 token、0 缓存 token。因此 0 缓存不能证明没有命中，少报输入也不能证明历史免费。

插件保留接口报告的原始数值，不补造历史输入或缓存 token。有状态 Gemini 续接会标记 `inputIncomplete`，累计统计保存 `incompleteCalls`，面板、对话记录、日志和统计命令提示数据可能不完整；受影响的累计缓存命中率显示「待确认」。已记录的不完整统计在关闭有状态模式后仍保留标记，直到清零对应累计统计。花费及额度仍按已报告值计算，可能偏低，不能作为实际消费的可靠上限；请用服务商账单核对。

## 来源

- [上下文缓存](https://ai.google.dev/gemini-api/docs/caching?hl=zh-cn)
- [Interactions：会话状态与本次请求参数](https://ai.google.dev/gemini-api/docs/interactions-overview)
- [Google 对历史用量漏报的确认](https://discuss.ai.google.dev/t/interactions-api-is-the-stored-history-of-previous-interaction-id-billed-and-why-is-it-missing-from-usage/187450)
