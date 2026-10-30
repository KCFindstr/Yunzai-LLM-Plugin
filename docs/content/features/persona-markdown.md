---
id: persona-markdown
title: 人设系统与 Markdown 输出
sidebar_label: 人设与排版
---

# 人设系统与 Markdown 排版

## 独立的外部人设文件 (`file:PERSONA.md`)

在传统配置中，长篇人设往往挤在 YAML 文件的多行字符串中，容易因缩进错误或特殊符号引发解析错误。

Yunzai-LLM-Plugin 支持人设预设引用独立的 Markdown 文件（路径相对于 `Yunzai/config/Yunzai-LLM-Plugin/`）：

```yaml
persona:
  active: default
  presets:
    default: "file:PERSONA.md"
```

### 特点
1. **原文发送**：人设文件按原文发送给大模型，不做任何转义或反转义。人设中的 `{botName}` 会替换为机器人昵称。
2. **随改随生效**：直接编辑 `Yunzai/config/Yunzai-LLM-Plugin/PERSONA.md`，保存即热加载。
3. **分群独立人设**：在 `groups.<群号>.persona` 中填写人设预设名称，为不同群聊使用不同人设。也可在 Web 面板「人设」页面或用 `#llm切换人设` 管理。

:::tip 编辑人设注意事项
如果您使用 Windows 11 自带的新版记事本，建议在普通纯文本视图下编辑，避免开启自动格式化视图，以免编辑器自动向文件中注入多余的字面反斜杠。
:::

---

## 长短回复排版与图片转换

在大模型日常输出中，不同类型的内容有截然不同的展示需求：

### 1. Markdown 模式 (`reply.markdown`)
- 默认设置为 `false`。
- 若适配器支持原生 Markdown（例如官方 QQBot 适配器），可将其设为 `true`；设为 `auto` 时只有消息来自 QQBot 适配器才使用 Markdown。
- 开启后不再拆分多条消息、不去除 Markdown 符号；关闭时（OneBot / NapCat 等）按 `reply.stripMarkdown` 去除符号，超过 `reply.maxChars` 的长文按 `reply.longText` 合并转发或截断。

### 2. 文本 vs HTML 长图自动抉择
当大模型生成长篇大论时，大模型拥有自主权（通过内置规则引导）：
- **可复制内容（代码、命令、链接、文本摘要）**：始终保持文字形式直接输出，方便用户选中复制。
- **排版复杂内容（多维对比表格、数据清单、排版卡片）**：模型可调用 `render_html`，由机器人自带的 Chromium（Yunzai 渲染器）渲染为图片发送，避免在群里刷屏长文本。
