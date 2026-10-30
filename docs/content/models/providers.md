---
id: providers
title: 多协议模型支持
sidebar_label: 多协议支持
---

# 多协议大模型支持

Yunzai-LLM-Plugin 用统一的接口对接各家模型，处理各厂商在数据格式、工具调用（Function Calling）、多模态文件输入、推理思考过程（Thinking/Reasoning）以及缓存机制上的差异。

---

## 支持的协议与提供商一览

| 协议类型 | 典型代表厂商 | 核心特性支持 |
| :--- | :--- | :--- |
| **`openai`** (Chat Completions) | DeepSeek、阿里云百炼 (通义千问)、月之暗面 (Kimi)、智谱 GLM、SiliconFlow、OpenRouter、Ollama 等 | 流式传输、标准工具调用、`<think>` / `reasoning_content` 推理链提取、OpenRouter 原生计费直通。 |
| **`openai-responses`** | OpenAI 官方、DeepSeek | `reasoning.summary` 推理摘要提取、模型自带联网搜索。 |
| **`anthropic`** | Anthropic 官方 Claude 及兼容接口 | **显式提示词缓存 (Prompt Caching)**、细粒度思考控制 (`thinking.display: summarized`)、PDF 原生解析。 |
| **`gemini`** | Google AI Studio (Gemini 系列) | **多模态输入**（直接读取图片、视频、音频、PDF）、服务端长会话状态保持 (Interactions API)。 |
| **`voyage`** | Voyage AI (`voyage-context-4`) | 只用于向量模型，支持上下文感知嵌入 (Contextualized Embeddings)。 |
| **`systemone`** | TypeSafe Jev / 自建 Kev | 分类接口，可作为自动思考强度与主动发言的判断模型。 |

---

## 典型配置示例

### 1. 接入 DeepSeek (深度求索)
DeepSeek 价格较低且支持推理思考，默认配置已包含，只需填写 `apiKey`：

```yaml
providers:
  deepseek:
    type: openai-responses
    baseUrl: https://api.deepseek.com
    apiKey: sk-xxxxxxxxxxxxxxxx
```

### 2. 接入 Anthropic Claude (带缓存断点)
插件支持 Anthropic 的提示词缓存，可降低重复输入的费用：

```yaml
providers:
  anthropic:
    type: anthropic
    baseUrl: https://api.anthropic.com
    apiKey: sk-ant-xxxxxxxxxxxxxxx
    cacheTtl: 5m       # 提示词缓存周期：5m（默认）或 1h
```

### 3. 接入 Google Gemini (多模态与超长上下文)
Gemini 支持视频、音频原生理解：

```yaml
providers:
  gemini:
    type: gemini
    baseUrl: https://generativelanguage.googleapis.com
    apiKey: AIzaSyxxxxxxxxxxxxxxxx
```

### 4. 接入 OpenRouter (聚合全网模型)
OpenRouter 聚合了大量模型，并在响应中返回实际花费，插件直接用于计费：

```yaml
providers:
  openrouter:
    type: openai
    baseUrl: https://openrouter.ai/api/v1
    apiKey: sk-or-v1-xxxxxxxxxxxx
```

---

## 模型定义与备用容灾机制 (`fallbackModels`)

在插件配置中，每一个模型都有唯一的 `id`，绑定到对应的 `provider`。聊天模型（`models`）、向量模型（`embeddingModels`）和 System One 模型（`systemoneModels`）分开配置，在 Web 面板「模型」页面中分别列出，每个都可单独测试。你可以配置备用模型列表，当主力模型因限额耗尽、网络抖动或上游服务异常时，系统会自动切换到备用模型：

```yaml
defaultModel: deepseek         # 默认主力模型（留空 = 第一个配置了 Key 的模型）

fallbackModels:               # 当 defaultModel 不可用时依次尝试
  - deepseek-pro
```
