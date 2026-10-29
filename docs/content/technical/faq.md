---
id: faq
title: 常见问题解答与排障
sidebar_label: 常见问题 (FAQ)
---

# 常见问题解答 (FAQ)

### Q1: 启动 Yunzai 时报错找不到 `node:sqlite` 模块或语法错误？
**A**: 请检查您的 Node.js 版本。Yunzai-LLM-Plugin 使用了 Node 内置的 SQLite 模块，要求运行环境的 **Node.js 版本必须 ≥ 22.13**。请升级 Node.js 后重试。

---

### Q2: 在群里 @ 机器人没有任何回复？
1. **检查控制台日志**：确认机器人是否收到了消息。如果控制台输出了关于 API Key 或连接超时，请检查提供商设置。
2. **检查当前默认模型**：发送 `#llm模型列表`，确认默认模型已设置且该模型的提供商绑定了有效的 API Key。
3. **检查额度是否超限**：发送 `#llm额度` 查看当前用户或当前群的消费额度是否已被用满。
4. **检查群黑白名单**：发送 `#llm状态` 查看本群是否启用；检查「配置 → 触发方式」中的 `groupWhitelist` / `groupBlacklist`，以及「配置 → 分群设置」中该群的 `enable`。

---

### Q3: 为什么我在 Linux 服务器上运行 `exec-setup` 或 `computer-setup` 报错？
**A**: 如 [平台支持说明](/tools/platform-support) 中所述，代码沙盒 `run_code`、持久桌面 `computer_task`、Google Lens 和 AGY 等高级工具目前深度依赖 Windows 宿主机与 WSL2 子系统协同，当前阶段**仅支持在 Windows 10/11 操作系统上部署**。在 Linux VPS 上，建议使用基础对话、Web 管理面板、表情包与联网搜索等全功能模块。

---

### Q4: 如何重置忘记的 Web 管理密码？
**A**: 自动生成的密码保存在 Yunzai 目录下的 `data/Yunzai-LLM-Plugin/web-auth.json`。也可以在 `config/Yunzai-LLM-Plugin/config.yaml` 中显式设置：
```yaml
web:
  password: "YourNewStrongPassword"
```
保存后系统自动重置登录密码。

---

### Q5: 提示词缓存（Prompt Caching）真的能省钱吗？
**A**: 是的。对于 Anthropic Claude 接口，插件会自动标注缓存断点。系统提示词、工具定义和前序历史在缓存有效期内（`cacheTtl`）被复用时，缓存命中部分的输入费用约为原价的 10%。Gemini 与 OpenAI 等接口使用服务商的自动缓存。
