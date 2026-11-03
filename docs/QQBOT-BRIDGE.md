# QQBot 桥接排查

## 主动发送图片失败

`QQBot message delivery failed; no successful complete send result` 是桥接层汇总的错误，实际原因要看远端 QQBot 日志。

2026-10-23 的表情发送失败来自 QQBot SDK `qq-group-bot@1.1.0`：没有 `msg_id` 的 v2 图片先上传媒体，随后错误地把上传返回对象当作 `file_data` 再调用 `/files`，QQ 返回 `40011000 请求数据异常`。PNG 和 `sub_type: 1` 不是这次错误的原因。

远端 `/data/trss/TRSS-Yunzai/lib/modules/qq-group-bot@1.1.0.patch` 已修复此路径：先以 `srv_send_msg: false` 上传一次，再发送包含 `media.file_info` 的 `msg_type: 7` 消息。补丁文件仍在，但此前由于 `pnpm-workspace.yaml` 是上游 git 跟踪文件，TRSS AllBot 的每日自动更新（`Main.sh update all`）执行 `git pull` / `git reset` 时会覆盖该文件，导致写入的 `patchedDependencies` 注册项丢失，重新安装时回退为官方未打补丁的 SDK。

根治方案：在远端 TRSS-Yunzai 根目录放置本地未跟踪的 `.pnpmfile.cjs`，利用 pnpm 的 `hooks.updateConfig(config)` 钩子在每次 `pnpm install` 时动态注入补丁依赖项，不受上游 git 更新覆盖的影响：

```javascript
// .pnpmfile.cjs
const fs = require('node:fs')
const path = require('node:path')

const LOCAL_PATCHES = {
  'qq-group-bot@1.1.0': 'lib/modules/qq-group-bot@1.1.0.patch',
}

module.exports = {
  hooks: {
    updateConfig(config) {
      const patched = { ...(config.patchedDependencies || {}) }
      for (const [pkg, file] of Object.entries(LOCAL_PATCHES)) {
        if (patched[pkg]) continue
        if (!fs.existsSync(path.join(__dirname, file))) {
          throw new Error(`[local-patches] missing ${file}; refusing to install unpatched ${pkg}`)
        }
        patched[pkg] = file
      }
      config.patchedDependencies = patched
      return config
    },
  },
}
```

同时，`pnpm-workspace.yaml` 保持与上游一致以避免拉取冲突。远端已有离线检查 `config/onebot-bridge-tools/audit-compatibility.mjs --installed`，使用模拟 SDK 请求，不会发送 QQ 消息。另验证了私聊/群聊、主动/被动、图片/视频/语音/文件共 16 种媒体发送组合，每次只调用一次 `/files`，然后一次 `/messages`。

### Windows 本地工作区 `ERR_PNPM_WORKSPACE_WALK_ERROR` 根治

在 Windows 环境下，若早期版本在 `plugins/Yunzai-LLM-Plugin/data/agy-setup/` 下生成了 Chromium / IE 缓存目录（`Content.IE5` 具有系统级 `Everyone:(DENY)(RD)` 拒绝读取权限），Yunzai 根目录执行 `pnpm install` 遍历 `plugins/**` 时会报 `ERR_PNPM_WORKSPACE_WALK_ERROR: Access is denied. (os error 5)`。
插件已在 `cli/layout.mjs` 中添加 `evictLegacyPluginData` 机制：当主数据目录已迁移生效后，启动或迁移时会自动检测并利用 `fs.renameSync`（不读取目录内部内容）将插件目录下的遗留 `agy-setup` 移入 `data/Yunzai-LLM-Plugin/legacy-plugin-data/`，确保插件目录完全脱离 pnpm 工作区扫描范围。

本地 Yunzai 会把发送异常转成 `{ error: [err] }`，因此表情发送代码必须检查返回值；失败不能增加使用次数或写入已发送的群聊记录。

## 网关在线，但收不到转发消息

如果 QQBot 仍打印收到的私聊/群聊，OneBot 连接和心跳也正常，但没有转发消息，应检查 `Bot.listenerCount('message')`，连接状态不能代替入站检查。

Yunzai 核心 `lib/bot.js` 的代理原先只有 `get`。通过代理注册事件时，`_eventsCount` 的写入落在账号对象上，而读取仍来自原实例。启动期间的 HTTP/WebSocket 连接可能在原实例上注册 `once('online')`；其清理看到错误的计数后会重置整个 `_events`，使全部入站监听器消失。修复为：已经存在于原实例上的属性写回原实例，其余账号属性仍写到代理目标。重启后重新注册监听器。此修复已同时应用到本地和远端核心，回归测试位于 `test/yunzai-event-proxy.test.ts`。

## 引用消息没有发送者 ID

QQ 的部分引用仅包含引用文本/图片和 `ref_msg_idx`，没有作者。桥接优先使用引用中明确提供的作者，再使用之前观察到的消息索引别名恢复身份。本地还会查询 `get_msg`、来源元数据和同一机器人/群内的精确消息 ID 缓存。

如果平台省略作者，而且引用索引无法映射到原消息，就不能可靠恢复发送者 ID。相同文本可能由不同人发送，不能仅凭文本或当前发言人推断身份。唯一的例外是引用图片：已保存图片按内容哈希命名，若本机器人/本群最近记录里恰好只有一个人发过字节完全相同的图片，就认定为此人；有多人发过（例如转发的表情图）则仍视为未知。无法恢复时提示词明确标记 `【引用｜发送者ID未知】`；已知身份显示为 `【引用 名字(平台ID x)】`，引用中的图片标注 `[图片N:路径]` 直接写在引用内容里。旧 rollout 及已保存历史中的旧标题不会被追溯改写。
