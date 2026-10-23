import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clusterKeywords, clusterVectors, maxK, terms } from '../src/memory/cluster.ts'

/** Unit vectors around `centers` (one-hot in 32 dims), `per` each; loose enough that members are not near-duplicates. */
function blobs(centers: number[][], per: number) {
  let seed = 7
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5
  const out: Float32Array[] = []
  for (const c of centers) for (let i = 0; i < per; i++) {
    const v = Float32Array.from({ length: 32 }, (_, j) => (c[j] ?? 0) + rand() * 0.5)
    const n = Math.hypot(...v)
    out.push(v.map(x => x / n))
  }
  return out
}

const CENTERS = [[1, 0, 0, 0, 0, 0], [0, 1, 0, 0, 0, 0], [0, 0, 1, 0, 0, 0], [0, 0, 0, 1, 0, 0]]
const TEXTS = ['今天一起打原神抽卡', '原神抽卡又歪了', '原神新角色抽卡', '原神抽卡概率', '原神抽卡保底',
  '晚饭吃火锅', '火锅店排队', '周末火锅聚餐', '火锅底料推荐', '火锅蘸料',
  '桌面截图失败', '桌面截图成功', '再次桌面截图', '桌面截图任务', '桌面截图窗口',
  '猫咪学猫叫', '猫咪罐头', '猫咪睡觉', '猫咪打架', '猫咪洗澡']

describe('clusters', () => {
  it('finds well separated blobs with auto k, numbered by size', () => {
    const vecs = blobs(CENTERS, 5)
    const r = clusterVectors(vecs, TEXTS)
    assert.equal(r.auto, true)
    assert.equal(r.k, 4)
    assert.ok(r.scores.length >= 2)
    // every blob lands in one cluster
    for (let b = 0; b < 4; b++) assert.equal(new Set(r.assign.slice(b * 5, b * 5 + 5)).size, 1)
    assert.deepEqual(r.clusters.map(c => c.size), [5, 5, 5, 5])
    for (const c of r.clusters) {
      assert.ok(c.cohesion > 0.6, String(c.cohesion))
      assert.equal(c.exemplars.length, 3)
      assert.ok(c.exemplars.every(i => r.assign[i] === c.id))
    }
  })

  it('honours an explicit k', () => {
    const r = clusterVectors(blobs(CENTERS, 5), TEXTS, 2)
    assert.equal(r.auto, false)
    assert.equal(r.k, 2)
    assert.deepEqual(r.scores, [])
  })

  it('labels clusters with distinctive keywords, merging split words', () => {
    const r = clusterVectors(blobs(CENTERS, 5), TEXTS)
    const labels = r.clusters.map(c => c.keywords.join(' '))
    for (const word of ['原神', '火锅', '截图', '猫咪']) assert.ok(labels.some(l => l.includes(word)), `${word} in ${labels}`)
  })

  it('skips stopwords, dates and raw message headers', () => {
    const t = terms('【2026-10-22 周四 15:30｜群「1」｜发言人 4(平台ID 4)】[at:you] 我们今天讨论了抽卡')
    assert.ok(!t.has('我们') && !t.has('今天') && !t.has('发言人') && !t.has('平台'))
    assert.ok([...t].some(x => x.includes('抽卡') || x.includes('讨论')))
    assert.deepEqual(clusterKeywords(['a b'], [0], 1), [[]])
  })

  it('caps k by the point count', () => {
    assert.equal(maxK(5), 1)
    assert.equal(maxK(9), 3)
    assert.equal(maxK(1000), 12)
    assert.equal(clusterVectors(blobs(CENTERS.slice(0, 1), 4), ['a', 'b', 'c', 'd']).k, 1)
  })
})
