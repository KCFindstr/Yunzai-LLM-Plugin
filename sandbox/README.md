# 沙盒（离线端到端测试）

在不连接任何真实 QQ / NapCat 的情况下，用**真实的 Yunzai**（复制的 `lib/`）+ 真实适配器 + 本插件构建产物运行，
由 `fake-napcat.mjs` 模拟 NapCat（OneBot v11 正向 WebSocket），可以模拟群聊、私聊、图片、表情、引用回复。

隔离措施：

- 独立运行目录 `sandbox/.runtime/`（git 忽略），独立配置：Yunzai HTTP 端口 **2599**（生产是 2536，绝不复用——端口冲突时 Yunzai 会请求旧进程 `/exit`），
  独立 redis 端口 **6390**，OneBotClient 只连 `ws://127.0.0.1:3299`；启动前会检查所有配置不含非本地地址。
- 只复制 OneBot 适配器、system、other 和本插件；不复制 ws-plugin、stdin 适配器。
- 连接方式：存在 `plugins/adapter/OneBotClient.js`（可选的正向 WS 客户端）时由它连接模拟 NapCat；没有时模拟 NapCat 以反向 WS 连接 TRSS 自带的 `ws://127.0.0.1:2599/OneBotv11`。
- Redis：Yunzai 不附带 redis。Windows 首次运行时自动从 [redis-windows](https://github.com/redis-windows/redis-windows) 下载固定版本的 Redis 8 msys2 构建（校验 SHA-256）到 `sandbox/redis/`（git 忽略）；其他系统需要 PATH 中有 `redis-server`。
- 插件配置和数据（会话、额度、表情）按 Yunzai 规范写在 `.runtime/config/Yunzai-LLM-Plugin` 和 `.runtime/data/Yunzai-LLM-Plugin`，不影响正式数据。

## 使用

```bash
pnpm build                                  # 先构建插件
node sandbox/run.mjs                        # 交互模式（输入 help 查看命令）
node sandbox/run.mjs --mock --script sandbox/scenarios/basic.txt   # 自动场景，失败时退出码 1
node sandbox/install-plugins.mjs            # 可选：把 miao/genshin/星铁/绝区零插件装进沙盒
node sandbox/run.mjs --mock --script sandbox/scenarios/games.txt
```

- 默认使用 `mock-llm.mjs` 模拟模型（按关键词决定回复/调用工具）。
- 想用真实模型：复制 `config.example.yaml` 为 `sandbox/config.yaml` 并填入 Key（该文件被 git 忽略），然后不带 `--mock` 运行。
- 机器人发出的图片/表情保存在 `.runtime/out/`；完整 Yunzai 日志在 `.runtime/yunzai.log`。
- `--fresh` 清空运行目录（会删除沙盒里安装的游戏插件）；`--verbose` 显示完整日志。

交互命令示例：

```
ga 你好                      测试用户在群里 @机器人
ga 帮我查查深渊数据          自然语言转指令
gr 继续                      引用机器人上一条消息（不@）
g 大家好                     不@，机器人不应回复
p #llm帮助                   主人私聊
pi red #llm添加表情          主人私聊发图添加表情
```
