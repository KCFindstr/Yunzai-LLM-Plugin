# 自定义工具

把 `.js` / `.mjs` 文件放在 `Yunzai/config/Yunzai-LLM-Plugin/tools/`（Yunzai 的 config 目录下，不是这个插件目录），插件启动或 `#llm重载` 时自动加载。这个目录只放说明和示例。每个文件默认导出一个工具（或工具数组）：

```js
export default {
  name: 'roll_dice',                       // 只能用字母、数字、下划线、横线
  description: '掷骰子，返回 1~N 的随机数。用户要求掷骰子/随机数时使用。',
  parameters: {                            // JSON Schema
    type: 'object',
    properties: { sides: { type: 'integer', description: '骰子面数，默认 6' } },
  },
  // ctx: { e(当前消息事件), eff(当前生效配置), isAdmin, model, turn }
  async run(args, ctx) {
    const n = Math.max(2, Number(args.sides) || 6)
    return `掷出了 ${1 + Math.floor(Math.random() * n)}（${n} 面骰）`
  },
}
```

- 返回字符串，或 `{ content, isError }`。返回内容会交给模型，由模型组织语言回复。
- 可选 `available(ctx)`：返回 false 时本轮不提供该工具（例如只对管理员开放：`available: ctx => ctx.isAdmin`）。
- 不需要写代码的 HTTP 接口可以直接写在配置 `tools.http` 里（见 default_config.yaml）。
- `example-dice.js.example` 是一个示例，去掉 `.example` 后缀即可启用。
