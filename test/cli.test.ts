import { PLUGIN_ROOT, TMP, writeUserConfig } from './helpers.ts'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import YAML from 'yaml'

const CLI = path.join(PLUGIN_ROOT, 'cli', 'config.mjs')
const env = { ...process.env, YZ_LLM_CONFIG_DIR: path.join(TMP, 'config'), NO_COLOR: '1' }
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const run = (args: string[]) => strip(execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' }))
const runFail = (args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
  return { code: r.status, out: strip(`${r.stdout}${r.stderr}`) }
}
const userYaml = () => fs.readFileSync(path.join(TMP, 'config', 'config.yaml'), 'utf8')

describe('config schema', () => {
  it('covers every key in default_config.yaml (schema and defaults cannot drift apart)', async () => {
    const { SCHEMA, validate } = await import('../cli/schema.mjs')
    const defaults = YAML.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'config', 'default_config.yaml'), 'utf8'))
    assert.equal(validate(SCHEMA, defaults, defaults, undefined), undefined)
  })
})

describe('config CLI subcommands', () => {
  it('set/get/unset keep comments, use map keys for group ids, mask secrets', () => {
    writeUserConfig('# 保留我\nreply:\n  maxBubbles: 1 # 行内\n')
    run(['set', 'groups.123456.enable', 'false'])
    run(['set', 'providers.deepseek.apiKey', 'sk-abcdefghijk123'])
    run(['set', 'models.0.thinking', 'high'])
    const text = userYaml()
    assert.match(text, /# 保留我/)
    assert.match(text, /# 行内/)
    const doc = YAML.parse(text)
    assert.equal(doc.groups['123456'].enable, false)
    assert.equal(doc.models[0].thinking, 'high')
    assert.equal(doc.models.length, 7, 'default models array materialized before index write')
    assert.match(run(['get', 'providers.deepseek.apiKey']), /sk-ab\*\*\*\*k123/)
    assert.match(run(['get', 'providers.deepseek.apiKey', '--show-secrets']), /sk-abcdefghijk123/)
    run(['unset', 'reply.maxBubbles'])
    assert.equal(YAML.parse(userYaml()).reply, undefined, 'empty parent removed')
    assert.match(run(['get', 'reply.maxBubbles']), /^2/)
  })

  it('rejects unknown keys (with a suggestion), bad enum values, out-of-range numbers and unknown model ids', () => {
    writeUserConfig('# 空\n')
    const typo = runFail(['set', 'chat.groupContxt', '3'])
    assert.equal(typo.code, 1)
    assert.match(typo.out, /未知配置项.*chat\.groupContext/)
    assert.match(runFail(['set', 'reply.quote', 'sometimes']).out, /可选值：auto \/ always \/ never/)
    assert.match(runFail(['set', 'chat.groupContext', '99']).out, /不能大于 30/)
    assert.match(runFail(['set', 'defaultModel', 'nope']).out, /可选值：sonnet/)
    assert.match(runFail(['set', 'groups.abc.enable', 'true']).out, /键名格式不正确|格式/)
    assert.equal(userYaml(), '# 空\n', 'nothing written on rejected input')
  })

  it('model ids may be Chinese but not contain spaces', () => {
    writeUserConfig('')
    run(['set', 'models.0.id', '小克'])
    run(['set', 'defaultModel', '小克'])
    assert.equal(YAML.parse(userYaml()).defaultModel, '小克')
    assert.notEqual(runFail(['set', 'models.1.id', '小 克']).code, 0)
  })

  it('list shows valid keys that are not set yet, filtered by provider type', () => {
    writeUserConfig('reply:\n  maxBubbles: 3\n')
    const p = run(['list', 'providers.anthropic'])
    assert.match(p, /providers\.anthropic\.timeout\s+\(未设置\)/)
    assert.match(p, /providers\.anthropic\.cacheTtl/)
    assert.doesNotMatch(p, /maxTokensField/, 'OpenAI-only field hidden for anthropic')
    assert.match(run(['list', 'reply']), /reply\.maxBubbles\s+3 \[已修改\]/)
    assert.match(run(['describe', 'models.2.thinking']), /可选：off \/ minimal/)
    assert.match(runFail(['check']).out + '', /没有任何可用模型|未配置 Key/)
  })

  it('check reports invalid keys hand-written into config.yaml', () => {
    writeUserConfig('chat:\n  groupContxt: 3\n')
    assert.match(runFail(['check']).out, /无效配置：chat: 未知配置项：groupContxt/)
  })
})

describe('config CLI interactive (arrow keys / radio / checkbox)', () => {
  // Root order follows the schema: … groups(9) trigger(10) chat(11) quota(12). D99 = last item (返回);
  // in the main menu, D99 U = 保存并退出.
  it('number field: browse -> quota.notifyCooldown -> 900 -> save', async () => {
    writeUserConfig('# 空\n')
    await drive(['E', 'D12', 'E', 'D2', 'E', '900', 'E', 'D99', 'E', 'D99', 'E', 'D99', 'U', 'E'])
    assert.deepEqual(YAML.parse(userYaml()), { quota: { notifyCooldown: 900 } })
  })

  it('enum field is a radio list: chat.sessionScope -> group', async () => {
    writeUserConfig('# 空\n')
    await drive(['E', 'D11', 'E', 'E', 'D1', 'E', 'D99', 'E', 'D99', 'E', 'D99', 'U', 'E'])
    assert.deepEqual(YAML.parse(userYaml()), { chat: { sessionScope: 'group' } })
  })

  it('checkbox: batch-toggle the switches of a section', async () => {
    writeUserConfig('# 空\n')
    // trigger has 11 fields; ☑ 批量开关 follows them; 3rd box = alias
    await drive(['E', 'D10', 'E', 'D11', 'E', 'D2', 'S', 'E', 'D99', 'E', 'D99', 'E', 'D99', 'U', 'E'])
    assert.deepEqual(YAML.parse(userYaml()), { trigger: { alias: true } })
  })

  it('new map entry: groups -> + 新增群号 -> enable = 关', async () => {
    writeUserConfig('# 空\n')
    await drive(['E', 'D9', 'E', 'E', '123456', 'E', 'E', 'D1', 'E', 'D99', 'E', 'D99', 'E', 'D99', 'E', 'D99', 'U', 'E'])
    assert.deepEqual(YAML.parse(userYaml()), { groups: { '123456': { enable: false } } })
  })
})

/** Drive @inquirer prompts through a pipe with raw key codes; each key is sent once the screen has redrawn. */
async function drive(seq: string[]) {
  const KEYS: Record<string, string> = { D: '\x1b[B', U: '\x1b[A', E: '\r', S: ' ' }
  const child = spawn(process.execPath, [CLI], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let lastData = 0
  let chunks = 0
  const onData = (d: Buffer) => {
    out += d
    lastData = Date.now()
    chunks++
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const done = new Promise<number | null>(r => child.on('exit', r))
  const settled = async (since: number) => {
    const start = Date.now()
    while (Date.now() - start < 2000) {
      if (chunks > since && Date.now() - lastData > 40) return
      await new Promise(r => setTimeout(r, 10))
    }
  }
  await settled(0)
  for (const s of seq) {
    const before = chunks
    const m = /^([DUES])(\d*)$/.exec(s)
    child.stdin.write(m ? KEYS[m[1]].repeat(Number(m[2]) || 1) : s)
    await settled(before)
  }
  const timer = setTimeout(() => child.kill(), 8000)
  const code = await done
  clearTimeout(timer)
  assert.equal(code, 0, strip(out).slice(-800))
}
