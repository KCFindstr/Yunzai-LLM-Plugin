import { TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { locations, migrateLayout, MOVED_MARKER } from '../cli/layout.mjs'
import { imageMountScript } from '../cli/image-store.mjs'

const write = (file: string, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

it('moves an install that kept config and data in the plugin folder to the Yunzai-standard folders', t => {
  // tests point every folder at TMP through env; this one exercises the real resolution
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('YZ_LLM_')))
  for (const k of Object.keys(saved)) delete process.env[k]
  t.after(() => Object.assign(process.env, saved))

  const yz = path.join(TMP, 'layout-yunzai')
  const plugin = path.join(yz, 'plugins', 'Yunzai-LLM-Plugin-main') // a zip download keeps working
  write(path.join(plugin, 'config', 'default_config.yaml'), 'enable: true')
  write(path.join(plugin, 'config', 'PERSONA.md'), '人设')
  write(path.join(plugin, 'config', 'config.yaml'), 'persona: { active: mine }')
  write(path.join(plugin, 'config', 'config.yaml.v1.bak'), 'old')
  write(path.join(plugin, 'data', 'sessions.json'), '{}')
  write(path.join(plugin, 'data', 'images', 'g1', 'a.png'), 'png')
  write(path.join(plugin, 'data', 'agy-setup', 'agy.exe'), 'exe')
  write(path.join(plugin, 'skills', 'genshin-team', 'SKILL.md'), 'shipped')
  write(path.join(plugin, 'skills', 'my-skill', 'SKILL.md'), 'mine')
  write(path.join(plugin, 'tools', 'README.md'), 'docs')
  write(path.join(plugin, 'tools', 'dice.js'), 'export default {}')

  const loc = locations(plugin)
  assert.equal(loc.config, path.join(yz, 'config', 'Yunzai-LLM-Plugin'))
  assert.equal(loc.data, path.join(yz, 'data', 'Yunzai-LLM-Plugin'))
  assert.equal(loc.resources, path.join(yz, 'resources', 'Yunzai-LLM-Plugin'))
  assert.equal(loc.temp, path.join(yz, 'temp', 'Yunzai-LLM-Plugin'))

  const notes = migrateLayout(plugin, loc)
  assert.ok(notes.length >= 4, notes.join('\n'))
  // config: user files moved, shipped files stay; the persona example is copied so file:PERSONA.md resolves
  assert.equal(fs.readFileSync(path.join(loc.config, 'config.yaml'), 'utf8'), 'persona: { active: mine }')
  assert.ok(fs.existsSync(path.join(loc.config, 'config.yaml.v1.bak')))
  assert.ok(fs.existsSync(path.join(loc.config, 'PERSONA.md')) && fs.existsSync(path.join(plugin, 'config', 'PERSONA.md')))
  assert.deepEqual(fs.readdirSync(path.join(plugin, 'config')).sort(), ['PERSONA.md', 'default_config.yaml'])
  // own skills and tools are user config; shipped ones stay
  assert.ok(fs.existsSync(path.join(loc.config, 'skills', 'my-skill', 'SKILL.md')))
  assert.ok(fs.existsSync(path.join(plugin, 'skills', 'genshin-team', 'SKILL.md')) && !fs.existsSync(path.join(plugin, 'skills', 'my-skill')))
  assert.ok(fs.existsSync(path.join(loc.config, 'tools', 'dice.js')) && fs.existsSync(path.join(plugin, 'tools', 'README.md')))
  // data moved whole; the downloaded AGY CLI is a resource
  assert.ok(!fs.existsSync(path.join(plugin, 'data')))
  assert.equal(fs.readFileSync(path.join(loc.data, 'images', 'g1', 'a.png'), 'utf8'), 'png')
  assert.ok(fs.existsSync(path.join(loc.data, MOVED_MARKER)), 'WSL image mounts get repointed on start')
  assert.equal(fs.readFileSync(path.join(loc.resources, 'agy-setup', 'agy.exe'), 'utf8'), 'exe')
  assert.ok(!fs.existsSync(path.join(loc.data, 'agy-setup')))

  // never overwrites: a second run (or files left in the old place) changes nothing
  write(path.join(plugin, 'data', 'sessions.json'), 'stale')
  assert.deepEqual(migrateLayout(plugin, loc), [])
  assert.equal(fs.readFileSync(path.join(loc.data, 'sessions.json'), 'utf8'), '{}')
})

it('repoints the WSL image mount, unmounting an older location first', () => {
  const script = imageMountScript("D:\\Yunzai\\data\\Yunzai-LLM-Plugin\\images", true)
  assert.match(script, /umount \/var\/lib\/llm-images/)
  assert.match(script, /mount -t drvfs 'D:\\Yunzai\\data\\Yunzai-LLM-Plugin\\images' \/var\/lib\/llm-images -o ro/)
  assert.doesNotMatch(imageMountScript('/x', false), /umount/)
})
