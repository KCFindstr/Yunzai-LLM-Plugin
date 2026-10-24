import { PLUGIN_ROOT } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { it } from 'node:test'

// Exercise the real constructor without booting Yunzai, its plugins or gateway.
const core = path.resolve(PLUGIN_ROOT, '../../lib/bot.js')
const source = fs.existsSync(core) ? fs.readFileSync(core, 'utf8') : ''
const start = source.indexOf('  constructor() {')
const constructor = source.slice(start, source.indexOf('\n  serverAuth(', start))
const Fixture = source ? new Function('EventEmitter', 'util', `return class extends EventEmitter {
  bots = {}; uin = []; original = this;
  ${constructor}
}`)(EventEmitter, { makeLog() {} }) : undefined

it('keeps message listeners when an early connection finishes waiting for online', { skip: !Fixture }, () => {
  const bot = new Fixture()
  let received = 0
  bot.on('message', () => received++)
  bot.original.once('online', () => {})
  bot.emit('online')
  bot.emit('message', {})
  assert.equal(received, 1)
  assert.equal(bot.listenerCount('message'), 1)
  assert.equal(bot._eventsCount, 1)
  assert.deepEqual(bot.eventNames(), ['message'])
})

it('preserves bot account writes and consistent listener removal through either view', { skip: !Fixture }, () => {
  const bot = new Fixture(), account = { nickname: 'test' }
  bot['123'] = account
  assert.equal(bot['123'], account)
  const listener = () => {}
  bot.original.on('message', listener)
  bot.off('message', listener)
  assert.equal(bot.original.listenerCount('message'), 0)
  assert.equal(bot._eventsCount, 0)
  bot.on('message', listener)
  bot.original.removeAllListeners()
  assert.equal(bot.listenerCount('message'), 0)
})
