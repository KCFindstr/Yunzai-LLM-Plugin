/**
 * Must be imported FIRST in every test file: points config/data dirs at a fresh temp dir before any
 * src module (which read them at import time) is evaluated.
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const PLUGIN_ROOT = path.resolve(here, '..')
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yzllm-test-'))

fs.mkdirSync(path.join(TMP, 'config'), { recursive: true })
fs.copyFileSync(path.join(PLUGIN_ROOT, 'config', 'default_config.yaml'), path.join(TMP, 'config', 'default_config.yaml'))
process.env.YZ_LLM_PLUGIN_DIR = TMP
process.env.YZ_LLM_CONFIG_DIR = path.join(TMP, 'config')
process.env.YZ_LLM_DATA_DIR = path.join(TMP, 'data')
process.env.YZ_LLM_SKILLS_DIR = path.join(TMP, 'skills')
process.env.YZ_LLM_TOOLS_DIR = path.join(TMP, 'tools')
process.env.YZ_LLM_QUIET = '1'

// Run after test hooks and browser/child-process shutdown, before leaving test data behind.
process.once('beforeExit', async () => {
  const { flushAllStores } = await import('../src/core/store.ts')
  const { closeUsageHistory } = await import('../src/billing/history.ts')
  flushAllStores()
  closeUsageHistory()
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

export function writeUserConfig(yaml: string) {
  fs.writeFileSync(path.join(TMP, 'config', 'config.yaml'), yaml, 'utf8')
}

export interface TestEmbedding {
  enable?: boolean
  type?: 'voyage' | 'openai'
  baseUrl?: string
  apiKey?: string
  model?: string
  dimensions?: number
  minScore?: number
}

/**
 * Point recall at a test embedding endpoint in memory (a provider plus an embeddingModels entry, as the config now
 * stores them). Fields left out keep their current values.
 */
export function setEmbedding(config: { get(): any }, e: TestEmbedding) {
  const c = config.get()
  const cur = c.embeddingModels.find((m: any) => m.id === c.memory.embedding.model)
  const prov = cur ? c.providers[cur.provider] : undefined
  const type = e.type ?? (prov ? (prov.type === 'voyage' ? 'voyage' : 'openai') : 'voyage')
  c.providers.__test_embedding = { type, baseUrl: e.baseUrl ?? prov?.baseUrl, apiKey: 'apiKey' in e ? e.apiKey : prov?.apiKey, timeout: 10, maxRetries: 1 }
  c.embeddingModels = [...c.embeddingModels.filter((m: any) => m.id !== '__test_embedding'),
    { id: '__test_embedding', provider: '__test_embedding', model: e.model ?? cur?.model ?? 'voyage-4-lite', dimensions: e.dimensions ?? cur?.dimensions ?? 512 }]
  c.memory.embedding = { enable: e.enable ?? c.memory.embedding.enable, model: '__test_embedding', minScore: e.minScore ?? c.memory.embedding.minScore }
}

export interface Captured {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: any
}

/** Tiny programmable HTTP server. `handler` returns [status, json] for each request. */
export async function mockServer(handler: (req: Captured, n: number) => [number, any] | Promise<[number, any]>) {
  const requests: Captured[] = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const c of req) raw += c
    const cap: Captured = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined }
    requests.push(cap)
    const [status, json] = await handler(cap, requests.length)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(json))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as any).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(r => server.close(() => r())),
  }
}

/** Minimal fake Yunzai event. Replies are collected in `sent`. */
export function fakeEvent(over: Record<string, any> = {}) {
  const sent: { msg: any; quote?: boolean; data?: any }[] = []
  const e: any = {
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    self_id: 10000,
    user_id: 20001,
    group_id: 30001,
    group_name: '测试群',
    message_id: 'm1',
    sender: { user_id: 20001, nickname: '岛风', card: '岛风' },
    message: [{ type: 'at', qq: 10000 }, { type: 'text', text: ' 你好' }],
    msg: '你好',
    atBot: true,
    isGroup: true,
    reply: async (msg: any, quote?: boolean, data?: any) => {
      sent.push({ msg, quote, data })
      return { message_id: `r${sent.length}` }
    },
    ...over,
  }
  return { e, sent }
}
