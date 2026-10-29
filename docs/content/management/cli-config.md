---
id: cli-config
title: 命令行交互配置 (CLI)
sidebar_label: 命令行配置
---

# 命令行交互配置工具

除了 Web 面板与私聊指令外，Yunzai-LLM-Plugin 为纯终端或服务器运维用户提供了一个功能完备的命令行配置工具：`npm run config`。

该工具具备严格的模式定义（Schema Validation），确保任何修改都不会损坏配置结构。

---

## 启动交互模式

进入插件目录并运行：

```bash
cd plugins/Yunzai-LLM-Plugin
npm run config
```

### 操作指南
- **导航**：使用键盘 **↑ / ↓ 方向键** 上下移动选项。
- **选择**：
  - 单选枚举项（如 `sessionScope`）使用单选列表直接切换。
  - 多选布尔列表（如开关组）使用空格键勾选或取消勾选。
  - 数字项（如冷却时间、超时阈值）直接输入数值，超出范围会提示。
- **保存**：修改后写入 `Yunzai/config/Yunzai-LLM-Plugin/config.yaml`，机器人自动热重载。

---

## 常用 CLI 子命令

无需进入交互式菜单，也可以通过子命令在终端中快速查看或更新配置：

### 1. 浏览与查询
```bash
# 列出回复与消息相关的全部配置项（包括尚未显式设置但有默认值的项）
npm run config -- list reply

# 查看某一个配置项的当前值
npm run config -- get chat.groupContext

# 查看某一个配置项的类型、默认值与中文说明
npm run config -- describe chat.groupContext

# 检查当前 config.yaml 是否存在格式错误或未知配置项
npm run config -- check
```

### 2. 设置与更新
```bash
# 设置 DeepSeek 的 API Key
npm run config -- set providers.deepseek.apiKey sk-xxxxxxxx

# 设置默认模型为 deepseek-pro
npm run config -- set defaultModel deepseek-pro

# 开启 Markdown 渲染
npm run config -- set reply.markdown true
```

### 3. 重置为默认值
```bash
# 删除某个自定义设置项，使其恢复为系统默认行为
npm run config -- unset reply.maxBubbles
```
