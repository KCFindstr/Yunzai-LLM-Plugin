import { TMP } from './helpers.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, it } from 'node:test'
import { imageSize } from 'image-size'

const { downscaleImage, closeOwnBrowser } = await import('../src/render/browser.ts')
const { sendableImage } = await import('../src/stickers/picker.ts')
after(() => closeOwnBrowser())

it('resizes stickers to their aspect ratio without viewport padding or cropping', async () => {
  for (const [width, height, expectedWidth, expectedHeight] of [
    [964, 404, 240, 101],
    [404, 964, 101, 240],
    [964, 120, 240, 30],
    [120, 964, 30, 240],
    [480, 480, 240, 240],
    [80, 40, 80, 40],
  ]) {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="red"/></svg>`)
    const original = await downscaleImage(svg, 'image/svg+xml', 1000)
    const file = path.join(TMP, `${width}x${height}.png`)
    fs.writeFileSync(file, original)
    // Old viewport-sized copies must not be reused after the fix.
    fs.writeFileSync(path.join(TMP, `${width}x${height}.s240.png`), Buffer.from('old cache'))
    const output = await sendableImage(file, 240)
    const actual = imageSize(output)
    assert.deepEqual([actual.width, actual.height], [expectedWidth, expectedHeight], `${width}x${height}`)
    assert.deepEqual(await sendableImage(file, 240), output, 'cached delivery is unchanged')
    if (width <= 240 && height <= 240) assert.deepEqual(output, original, 'small originals are preserved')
  }
})
