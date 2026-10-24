# QQBot 桥接排查

## 主动发送图片失败

`QQBot message delivery failed; no successful complete send result` 是桥接层汇总的错误，实际原因要看远端 QQBot 日志。

2026-10-23 的表情发送失败来自 QQBot SDK `qq-group-bot@1.1.0`：没有 `msg_id` 的 v2 图片先上传媒体，随后错误地把上传返回对象当作 `file_data` 再调用 `/files`，QQ 返回 `40011000 请求数据异常`。PNG 和 `sub_type: 1` 不是这次错误的原因。

远端 `/data/trss/TRSS-Yunzai/lib/modules/qq-group-bot@1.1.0.patch` 已修复此路径：先以 `srv_send_msg: false` 上传一次，再发送包含 `media.file_info` 的 `msg_type: 7` 消息。补丁文件仍在，但此前 `pnpm-workspace.yaml` 丢失了注册项，安装后实际加载了未修复的 SDK。修复时恢复以下注册并重新安装、重载远端桥接机器人：

```yaml
patchedDependencies:
  qq-group-bot@1.1.0: lib/modules/qq-group-bot@1.1.0.patch
```

升级桥接根项目或重新安装依赖时，应保留此注册项及对应锁文件。远端已有离线检查 `config/onebot-bridge-tools/verify-quotes.mjs --installed` 和 `audit-compatibility.mjs --installed`，使用模拟 SDK 请求，不会发送 QQ 消息。另验证了私聊/群聊、主动/被动、图片/视频/语音/文件共 16 种媒体发送组合，每次只调用一次 `/files`，然后一次 `/messages`。

本地 Yunzai 会把发送异常转成 `{ error: [err] }`，因此表情发送代码必须检查返回值；失败不能增加使用次数或写入已发送的群聊记录。

## 网关在线，但收不到转发消息

如果 QQBot 仍打印收到的私聊/群聊，OneBot 连接和心跳也正常，但没有转发消息，应检查 `Bot.listenerCount('message')`，连接状态不能代替入站检查。

Yunzai 核心 `lib/bot.js` 的代理原先只有 `get`。通过代理注册事件时，`_eventsCount` 的写入落在账号对象上，而读取仍来自原实例。启动期间的 HTTP/WebSocket 连接可能在原实例上注册 `once('online')`；其清理看到错误的计数后会重置整个 `_events`，使全部入站监听器消失。修复为：已经存在于原实例上的属性写回原实例，其余账号属性仍写到代理目标。重启后重新注册监听器。此修复已同时应用到本地和远端核心，回归测试位于 `test/yunzai-event-proxy.test.ts`。

## 引用消息没有发送者 ID

QQ 的部分引用仅包含引用文本/图片和 `ref_msg_idx`，没有作者。桥接优先使用引用中明确提供的作者，再使用之前观察到的消息索引别名恢复身份。本地还会查询 `get_msg`、来源元数据和同一机器人/群内的精确消息 ID 缓存。

如果平台省略作者，而且引用索引无法映射到原消息，就不能可靠恢复发送者 ID。相同文本可能由不同人发送，不能仅凭文本或当前发言人推断身份。此时提示词明确标记 `【引用消息｜发送者ID未知】`；已知身份仍显示姓名和 `平台ID`。旧 rollout 及已保存历史中的旧标题不会被追溯改写。
