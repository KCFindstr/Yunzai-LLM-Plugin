import { TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { it } from 'node:test'
import { readRolloutImage, recentRollouts, recordRolloutEvent, recordRolloutImages, rolloutHistory, ROLLOUT_RETENTION_MS, startRollout, updateRollout } from '../src/chat/rollouts.ts'

export const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='
it('persists tool raster images and removes completed rollouts and files only after 30 days', () => {
  const original = Date.now, now = original()
  try {
    Date.now = () => now
    const id = startRollout({ conv: 'images', input: 'image', source: 'chat', inputImageCount: 0 })
    const images = recordRolloutImages(id, [{ type: 'image', data: PNG, mime: 'text/html' }, { type: 'image', data: Buffer.from('<svg/>').toString('base64') }])
    assert.equal(images.length, 1); assert.equal(images[0].mime, 'image/png')
    recordRolloutEvent(id, { kind: 'tool', text: 'image result', images })
    updateRollout(id, { status: 'completed' })
    assert.deepEqual(readRolloutImage(id, images[0].id)?.raw, Buffer.from(PNG, 'base64'))
    assert.equal(readRolloutImage('../config', images[0].id), undefined)
    assert.equal(readRolloutImage(id, '../config'), undefined)
    assert.equal(readRolloutImage(startRollout({ conv: 'other', input: '', source: 'chat', inputImageCount: 0 }), images[0].id), undefined)
    Date.now = () => now + ROLLOUT_RETENTION_MS - 1
    assert.ok(rolloutHistory(id))
    const directory = path.join(TMP, 'data/rollout-images', id)
    assert.ok(fs.existsSync(directory))
    Date.now = () => now + ROLLOUT_RETENTION_MS + 1
    assert.equal(rolloutHistory(id), undefined)
    assert.equal(fs.existsSync(directory), false)
    assert.equal(readRolloutImage(id, images[0].id), undefined)
    assert.ok(recentRollouts().some(r => r.status === 'queued'))
  } finally { Date.now = original }
})
