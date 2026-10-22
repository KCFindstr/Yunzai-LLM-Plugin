import { TMP, PLUGIN_ROOT, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

const secret = 'never-export-this-provider-secret'
writeUserConfig(`providers:\n  mock: { type: openai, baseUrl: 'http://127.0.0.1:9', apiKey: '${secret}' }\nmodels:\n  - { id: example, provider: mock, model: example-model }\ndefaultModel: example\npersona:\n  active: example\n  presets:\n    example: '完整人设：你是{botName}，保持简短自然。'\nchat: { maxToolRounds: 20, sessionScope: group }\ntools:\n  computer: { enable: true, access: admin }\n  http:\n    - name: example_http\n      description: 文档示例HTTP工具\n      url: 'https://example.invalid/private-endpoint'\n      headers: { Authorization: 'Bearer ${secret}' }\n`)
fs.mkdirSync(path.join(TMP, 'skills', 'computer-use'), { recursive: true })
fs.copyFileSync(path.join(PLUGIN_ROOT, 'skills/computer-use/SKILL.md'), path.join(TMP, 'skills/computer-use/SKILL.md'))
const marker = path.join(TMP, 'custom-module-executed')
fs.mkdirSync(path.join(TMP, 'tools'), { recursive: true })
fs.writeFileSync(path.join(TMP, 'tools', 'side-effect.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed');`)

function generate(admin: boolean) {
  const before = fs.readFileSync(path.join(TMP, 'config/config.yaml'), 'utf8')
  const result = spawnSync(process.execPath, [path.join(PLUGIN_ROOT, 'docs/generate-initial-request.mjs'), ...(admin ? ['--admin'] : [])], {
    cwd: PLUGIN_ROOT, env: process.env, encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(fs.readFileSync(path.join(TMP, 'config/config.yaml'), 'utf8'), before)
  assert.equal(fs.existsSync(marker), false)
  assert.ok(!result.stdout.includes(secret))
  assert.ok(!result.stdout.includes('private-endpoint'))
  return JSON.parse(result.stdout)
}

describe('complete initial prompt examples', () => {
  it('uses real builders, includes all model-visible sections and excludes transport credentials', () => {
    const snapshot = generate(true)
    assert.equal(snapshot.context.isAdmin, true)
    assert.match(snapshot.initial.system, /完整人设：你是天津风/)
    assert.match(snapshot.initial.system, /工具最多 20 轮/)
    assert.match(snapshot.initial.system, /computer-use：/)
    assert.equal(snapshot.initial.messages.length, 5)
    const input = snapshot.initial.messages.at(-1).content[0].text
    assert.match(input, /阿明\(平台ID 1001\)［管理员］/)
    assert.match(input, /最近群友·仅身份参考/)
    assert.match(input, /小红/)
    assert.match(input, /喜欢被叫阿明/)
    assert.match(input, /\[at:you\] 截一下你的桌面给我看看/)
    assert.ok(snapshot.initial.tools.every((tool: any) => tool.description && tool.parameters?.type === 'object'))
    assert.ok(snapshot.initial.tools.some((tool: any) => tool.name === 'example_http'))
    assert.ok(!snapshot.initial.tools.some((tool: any) => tool.name === 'computer_result'))
    if (process.platform === 'win32') {
      const computer = snapshot.initial.tools.find((tool: any) => tool.name === 'computer_task')
      assert.deepEqual(computer.parameters.properties.action.enum, ['start', 'status', 'cancel', 'respond'])
    }
  })

  it('applies non-admin availability filters rather than advertising every registered tool', () => {
    const snapshot = generate(false)
    assert.equal(snapshot.context.isAdmin, false)
    assert.ok(!snapshot.initial.tools.some((tool: any) => tool.name === 'computer_task'))
    assert.ok(!snapshot.initial.messages.at(-1).content[0].text.includes('［管理员］'))
  })

  it('embeds a parseable complete snapshot and readable system text in the rollout document', () => {
    const document = fs.readFileSync(path.join(PLUGIN_ROOT, 'docs/EXAMPLE_ROLLOUT.md'), 'utf8').replace(/\r\n/g, '\n')
    const block = (name: string) => {
      const body = document.split(`<!-- initial-request-${name}:start -->`)[1].split(`<!-- initial-request-${name}:end -->`)[0].trim().split('\n')
      return body.slice(1, -1).join('\n')
    }
    const snapshot = JSON.parse(block('json'))
    assert.equal(block('system'), snapshot.initial.system.replace(/\r\n/g, '\n'))
    assert.equal(snapshot.initial.messages.length, 5)
    assert.ok(snapshot.initial.tools.length >= 10)
    assert.ok(snapshot.initial.tools.some((tool: any) => tool.name === 'computer_task'))
    assert.match(document, /不是.*正在运行的机器人请求/)
  })
})
