---
id: first-configuration
title: 首次配置与密钥设置
sidebar_label: 首次配置
---

# 首次配置与密钥设置

插件提供三种平行的配置方式，您可以根据喜好自由选择：
1. **Web 可视化管理面板**（最推荐，零门槛直观易用）
2. **私聊机器人指令**（无需切换窗口，随聊随配）
3. **命令行交互式工具 `npm run config`**（服务器终端高效配置）

---

## 方式一：Web 可视化面板（推荐）

插件启动后，在安装机器人的同一台机器上打开浏览器访问：

👉 **`http://127.0.0.1:6190`**（面板默认监听 `0.0.0.0`，其他机器可用服务器 IP 访问）

首次打开时会自动进入 **「配置 → 设置向导」**，按步骤添加提供商、填写 API Key 并选择模型即可。以下是不使用向导时的手动步骤。

### 1. 登录面板
- **管理密码**：
  首次启动时插件会自动生成一个随机密码，打印在 Yunzai 终端日志中，同时明文保存在 `Yunzai/data/Yunzai-LLM-Plugin/web-auth.json`。
  你也可以在配置文件中直接指定自定义密码 `web.password: "你的自定义密码"`。

### 2. 配置提供商与 API Key
1. 进入左侧导航栏的 **「模型与资源 → 模型」** 页面。
2. 在 **「提供商」** 列表中找到你想要使用的服务商（如 DeepSeek、OpenAI、Anthropic 或 Gemini）：
   - 在 **「配置 → 提供商」** 中填写 API Key，并检查接口地址是否正确；没有的服务商可点 **「添加提供商」**。
3. 回到 **「模型」** 页面，点击提供商右侧的 **「查询余额」**，即可测试 Key 是否有效（支持余额查询的服务商）。

### 3. 选择默认聊天模型
在下方 **「聊天模型」** 列表中，找到你想让机器人日常使用的模型，点击其右侧的 **「设为默认」**（例如 `deepseek`）。

---

## 方式二：私聊机器人指令

主人或插件管理员可以直接在 QQ / 对话适配器中私聊机器人发送如下三条指令：

```text
#llm设置密钥 deepseek sk-xxxxxxxxxxxxxxxx
#llm切换模型 deepseek
#llm测试模型
```

- 第一条：将 DeepSeek 的 API Key 保存到系统。
- 第二条：将全局默认模型切换为 `deepseek`。
- 第三条：发送单轮测试请求，验证连通性。

---

## 方式三：命令行交互配置 `npm run config`

在服务器或本机终端中，进入插件目录：

```bash
cd plugins/Yunzai-LLM-Plugin
npm run config
```

终端将弹出交互式菜单：
- 使用 **↑ / ↓ 方向键** 移动光标。
- 使用 **回车键** 确认进入下一级或保存修改。
- 修改会经过类型校验，保存后自动热重载，无需重启机器人。

也可以使用单行命令直接写入：

```bash
npm run config -- set providers.deepseek.apiKey sk-xxxx
npm run config -- set defaultModel deepseek
```

---

## 方式四：手动修改 YAML 文件

如果你更喜欢直接编辑配置文件，插件遵循 Yunzai 插件标准：
- 配置文件路径位于：`Yunzai/config/Yunzai-LLM-Plugin/config.yaml`
- 只需编写需要覆盖的字段即可，无需完整复制整个配置文件。修改后系统自动热加载。

最简配置示例：

```yaml
providers:
  deepseek:          # 默认配置已包含 DeepSeek 提供商与模型，只需填写 Key
    apiKey: sk-xxxxxxxxxxxxxx

defaultModel: deepseek
```
