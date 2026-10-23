import { TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { computerHistory, historyText, pruneComputerHistory, readComputerScreenshot, recordComputerEvent, saveComputerScreenshot } from '../src/computer/history.ts'
import { flushAllStores } from '../src/core/store.ts'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

describe('computer task history', () => {
  it('persists chronological visible turns and redacts secrets without storing binary or reasoning', () => {
    const id = 'a123456789'
    recordComputerEvent(id, { kind: 'request', text: 'Take a screenshot' })
    recordComputerEvent(id, { kind: 'response', text: 'Observed the result', step: 1, tools: [{ name: 'desktop', args: historyText({ operation: 'actions', password: 'private-pass', data: 'private-binary', native: { reasoning: 'private-reasoning' }, url: 'https://example.com/?token=private-token' }) }] })
    recordComputerEvent(id, { kind: 'request', text: 'Continue after the pause' })
    recordComputerEvent(id, { kind: 'response', text: 'Finished', step: 2 })
    const history = computerHistory(id)
    assert.deepEqual(history.events.map(event => event.seq), [1, 2, 3, 4])
    assert.deepEqual(history.events.filter(event => event.kind === 'response').map(event => event.step), [1, 2])
    const serialized = JSON.stringify(history)
    for (const value of ['private-pass', 'private-binary', 'private-reasoning', 'private-token']) assert.ok(!serialized.includes(value))
    assert.match(serialized, /Observed the result/)
    flushAllStores()
    assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, 'data/computer-history', id, 'history.json'), 'utf8')).events.length, 4)
  })

  it('deduplicates screenshots, rejects invalid images and prevents path traversal or corrupt reads', () => {
    const id = 'b123456789'
    const image = saveComputerScreenshot(id, png)!
    assert.equal(image.mime, 'image/png')
    assert.deepEqual(saveComputerScreenshot(id, png), image)
    assert.deepEqual(readComputerScreenshot(id, image.id)?.raw, png)
    assert.equal(saveComputerScreenshot(id, Buffer.from('<script>alert(1)</script>')), undefined)
    assert.equal(readComputerScreenshot(id, '../../config/config.yaml'), undefined)
    assert.throws(() => computerHistory('../config'), /无效/)
    fs.writeFileSync(path.join(TMP, 'data/computer-history', id, `${image.id}.image`), 'corrupt')
    assert.equal(readComputerScreenshot(id, image.id), undefined)
  })

  it('bounds retained history and reports omitted events', () => {
    const id = 'c123456789'
    for (let i = 0; i < 280; i++) recordComputerEvent(id, { kind: 'response', text: 'x'.repeat(8000), step: i + 1 })
    const history = computerHistory(id)
    assert.ok(history.dropped > 0)
    assert.equal(history.events.at(-1)?.step, 280)
    assert.ok(Buffer.byteLength(JSON.stringify(history)) < 2 * 1024 * 1024)
  })

  it('removes evicted job history and cancels writes that could recreate it', () => {
    const id = 'd123456789'
    saveComputerScreenshot(id, png)
    recordComputerEvent(id, { kind: 'reply', text: 'Sent', delivery: 'sent' })
    flushAllStores()
    recordComputerEvent(id, { kind: 'reply', text: 'Pending write' })
    pruneComputerHistory(new Set(['a123456789']))
    flushAllStores()
    assert.equal(fs.existsSync(path.join(TMP, 'data/computer-history', id)), false)
    assert.equal(fs.existsSync(path.join(TMP, 'data/computer-history/a123456789/history.json')), true)
  })
})
