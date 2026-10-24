/**
 * Minimal fake NapCat: a OneBot v11 *forward* WebSocket server that Yunzai's OneBotClient adapter connects to.
 * Lets you inject group/private messages and prints everything the bot sends. Never talks to real QQ.
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import WebSocket, { WebSocketServer } from 'ws'

export const BOT_ID = 10000
export const MASTER_ID = 10001
export const USER_ID = 10002
export const GROUP_ID = 30001

// ---------- tiny PNG encoder (solid colour + stripe) for test images ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
export function makePng(r, g, b, size = 48) {
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0
    for (let x = 0; x < size; x++) {
      const o = y * (size * 3 + 1) + 1 + x * 3
      const stripe = Math.floor(y / 8) % 2 === 0
      raw[o] = stripe ? r : 255 - r
      raw[o + 1] = stripe ? g : 255 - g
      raw[o + 2] = stripe ? b : 255 - b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export const TEST_IMAGES = {
  red: makePng(220, 40, 40),
  green: makePng(40, 200, 80),
  blue: makePng(40, 90, 220),
  yellow: makePng(240, 210, 30),
  // photo-sized, to exercise sticker downscaling
  big: makePng(200, 120, 40, 800),
}

/**
 * Forward WS (Yunzai's OneBotClient adapter dials us on wsPort) unless reverseUrl is set, in which case we dial
 * Yunzai's stock OneBotv11 reverse endpoint ourselves, like a NapCat configured with a reverse WebSocket.
 * @param {{ wsPort: number, httpPort: number, outDir: string, print: (line: string) => void, reverseUrl?: string }} opts
 */
export function startFakeNapCat(opts) {
  const { wsPort, httpPort, outDir, print, reverseUrl } = opts
  fs.mkdirSync(outDir, { recursive: true })
  const messages = new Map() // message_id -> stored message
  let nextId = 1000
  const listeners = new Set() // (out) => void, for expect()
  let socket

  const imgUrl = name => `http://127.0.0.1:${httpPort}/img/${name}.png`
  const httpServer = http
    .createServer((req, res) => {
      const m = /^\/img\/(\w+)\.png/.exec(req.url ?? '')
      const buf = m && TEST_IMAGES[m[1]]
      if (!buf) return res.writeHead(404).end()
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': buf.length }).end(buf)
    })
    .listen(httpPort, '127.0.0.1')

  const members = [
    { user_id: BOT_ID, nickname: '沙盒机器人', card: '', role: 'admin' },
    { user_id: MASTER_ID, nickname: '主人', card: '主人', role: 'owner' },
    { user_id: USER_ID, nickname: '测试用户', card: '小测', role: 'member' },
    { user_id: 10003, nickname: '路人甲', card: '', role: 'member' },
  ]
  const nameOf = id => members.find(m => m.user_id === id)?.card || members.find(m => m.user_id === id)?.nickname || String(id)

  function describeSeg(s) {
    const d = s.data ?? {}
    switch (s.type) {
      case 'text':
        return d.text
      case 'at':
        return `@${d.qq}`
      case 'reply':
        return `[回复#${d.id}]`
      case 'image': {
        let saved = ''
        const f = String(d.file ?? '')
        if (f.startsWith('base64://')) {
          const buf = Buffer.from(f.slice(9), 'base64')
          const name = `out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${buf[0] === 0x89 ? 'png' : buf[0] === 0xff ? 'jpg' : buf[0] === 0x47 ? 'gif' : 'img'}`
          fs.writeFileSync(path.join(outDir, name), buf)
          saved = ` ${Math.round(buf.length / 1024)}KB -> out/${name}`
        } else saved = ` ${f.slice(0, 60)}`
        return d.sub_type == 1 ? `[表情包${saved}]` : `[图片${saved}]`
      }
      case 'mface':
        return `[商城表情 ${d.summary ?? d.emoji_id}]`
      case 'face':
        return `[QQ表情${d.id}]`
      case 'node':
        return `\n    ├ ${(d.content ?? []).map(describeSeg).join('')}`
      default:
        return `[${s.type}]`
    }
  }

  function emitOut(target, segs) {
    const text = segs.map(describeSeg).join('')
    print(`\x1b[36m[Bot → ${target}]\x1b[0m ${text}`)
    for (const l of listeners) l(text)
  }

  function storeMessage(msg) {
    messages.set(msg.message_id, msg)
    return msg.message_id
  }

  function api(action, params) {
    switch (action) {
      case 'get_login_info':
        return { user_id: BOT_ID, nickname: '沙盒机器人' }
      case 'get_version_info':
        return { app_name: 'FakeNapCat', app_version: '0.1.0', protocol_version: 'v11' }
      case 'get_online_clients':
        return { clients: [] }
      case 'get_cookies':
        return { cookies: '' }
      case 'get_csrf_token':
        return { token: 0 }
      case 'get_friend_list':
        return members.filter(m => m.user_id !== BOT_ID).map(m => ({ user_id: m.user_id, nickname: m.nickname, remark: '' }))
      case 'get_stranger_info':
        return { user_id: params.user_id, nickname: nameOf(Number(params.user_id)) }
      case 'get_group_list':
        return [{ group_id: GROUP_ID, group_name: '沙盒测试群', member_count: members.length, max_member_count: 200 }]
      case 'get_group_info':
        return { group_id: GROUP_ID, group_name: '沙盒测试群', member_count: members.length, max_member_count: 200 }
      case 'get_group_member_list':
        return members.map(m => ({ group_id: GROUP_ID, ...m }))
      case 'get_group_member_info':
        return { group_id: GROUP_ID, ...(members.find(m => m.user_id === Number(params.user_id)) ?? { user_id: params.user_id, nickname: String(params.user_id) }) }
      case 'send_msg':
      case 'send_group_msg':
      case 'send_private_msg': {
        const target = params.group_id ? `群${params.group_id}` : `私聊${params.user_id}`
        const message = Array.isArray(params.message) ? params.message : [{ type: 'text', data: { text: String(params.message) } }]
        emitOut(target, message)
        const id = nextId++
        storeMessage({ message_id: id, user_id: BOT_ID, sender: { user_id: BOT_ID, nickname: '沙盒机器人' }, message, group_id: params.group_id })
        return { message_id: id }
      }
      case 'send_group_forward_msg':
      case 'send_private_forward_msg': {
        const target = params.group_id ? `群${params.group_id}` : `私聊${params.user_id}`
        emitOut(target, [{ type: 'text', data: { text: '[合并转发]' } }, ...(params.messages ?? [])])
        const id = nextId++
        return { message_id: id, forward_id: `f${id}` }
      }
      case 'get_msg': {
        const m = messages.get(Number(params.message_id))
        if (!m) throw new Error('消息不存在')
        return m
      }
      case 'delete_msg':
        print(`\x1b[90m[撤回 #${params.message_id}]\x1b[0m`)
        return null
      case 'fetch_custom_face':
        return Object.keys(TEST_IMAGES).map(imgUrl).slice(0, Number(params.count) || 48)
      case 'set_input_status':
        print('\x1b[90m[对方正在输入…]\x1b[0m')
        return null
      case 'set_msg_emoji_like':
      case '_set_model_show':
        return null
      default:
        throw new Error(`unsupported action ${action}`)
    }
  }

  const attach = ws => {
    socket = ws
    print('\x1b[32m[FakeNapCat] Yunzai 已连接\x1b[0m')
    ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: BOT_ID, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }))
    ws.on('message', raw => {
      let req
      try {
        req = JSON.parse(String(raw))
      } catch {
        return
      }
      if (!req.action) return
      let resp
      try {
        resp = { status: 'ok', retcode: 0, data: api(req.action, req.params ?? {}), echo: req.echo }
      } catch (err) {
        resp = { status: 'failed', retcode: 1404, msg: err.message, wording: err.message, data: null, echo: req.echo }
      }
      ws.send(JSON.stringify(resp))
    })
    ws.on('close', () => print('\x1b[33m[FakeNapCat] 连接断开\x1b[0m'))
  }

  let wss
  let closed = false
  if (reverseUrl) {
    // Yunzai is still starting when we begin, so keep retrying (and reconnect after a drop) until closed
    const dial = () => {
      if (closed) return
      const ws = new WebSocket(reverseUrl, { headers: { 'X-Self-ID': String(BOT_ID), 'X-Client-Role': 'Universal' } })
      ws.on('open', () => attach(ws))
      ws.on('error', () => {})
      ws.on('close', () => {
        if (socket === ws) socket = undefined
        setTimeout(dial, 1000)
      })
    }
    dial()
  } else {
    wss = new WebSocketServer({ port: wsPort, host: '127.0.0.1' })
    wss.on('connection', attach)
  }

  /**
   * Inject a message.
   * @param {{ private?: boolean, user?: number, text?: string, at?: boolean, image?: string, sticker?: boolean, mface?: boolean, replyTo?: number }} m
   */
  function inject(m) {
    if (!socket) return print('\x1b[31m尚未连接\x1b[0m')
    const user = m.user ?? USER_ID
    const segs = []
    if (m.replyTo) segs.push({ type: 'reply', data: { id: String(m.replyTo) } })
    if (m.at && !m.private) segs.push({ type: 'at', data: { qq: String(BOT_ID) } }, { type: 'text', data: { text: ' ' } })
    if (m.text) segs.push({ type: 'text', data: { text: m.text } })
    if (m.image) segs.push({ type: 'image', data: { file: `${m.image}.png`, url: imgUrl(m.image), sub_type: m.sticker ? 1 : 0, summary: m.sticker ? '[动画表情]' : '' } })
    if (m.mface)
      segs.push({ type: 'mface', data: { emoji_id: 'e123', emoji_package_id: 1001, key: 'k', summary: '[开心]', url: imgUrl('yellow') } })
    const id = nextId++
    // like real NapCat, include identifying data (Yunzai drops identical raw_message within 1s)
    const raw = segs.map(s => (s.type === 'text' ? s.data.text : `[CQ:${s.type}${s.data.file ? `,file=${s.data.file}` : ''}${s.data.id ? `,id=${s.data.id}` : ''}]`)).join('')
    const sender = { user_id: user, nickname: nameOf(user), card: nameOf(user), role: members.find(x => x.user_id === user)?.role ?? 'member' }
    const event = {
      time: Math.floor(Date.now() / 1000),
      self_id: BOT_ID,
      post_type: 'message',
      message_type: m.private ? 'private' : 'group',
      sub_type: m.private ? 'friend' : 'normal',
      message_id: id,
      user_id: user,
      message: segs,
      raw_message: raw,
      font: 0,
      sender,
      ...(m.private ? {} : { group_id: GROUP_ID }),
    }
    storeMessage({ ...event })
    print(`\x1b[33m[${m.private ? '私聊' : '群'} ${nameOf(user)} #${id}]\x1b[0m ${raw}`)
    socket.send(JSON.stringify(event))
    return id
  }

  /** Resolve when a bot output matching `re` arrives (or reject after timeout). */
  function expect(re, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        listeners.delete(fn)
        reject(new Error(`等待 /${re.source}/ 超时`))
      }, timeoutMs)
      const fn = text => {
        if (!re.test(text)) return
        clearTimeout(t)
        listeners.delete(fn)
        resolve(text)
      }
      listeners.add(fn)
    })
  }

  const lastBotMessageId = () => [...messages.values()].filter(m => m.user_id === BOT_ID).at(-1)?.message_id
  const lastUserMessageId = () => [...messages.values()].filter(m => m.user_id !== BOT_ID).at(-1)?.message_id

  return {
    inject,
    expect,
    lastBotMessageId,
    lastUserMessageId,
    connected: () => Boolean(socket),
    close: () => {
      closed = true
      wss?.close()
      socket?.close()
      httpServer.close()
    },
  }
}
