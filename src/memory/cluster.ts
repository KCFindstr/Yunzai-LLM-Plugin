/**
 * Topic clusters over the recall archive, without an LLM: spherical k-means on the full (L2-normalized) vectors, k
 * picked by silhouette when not given, and each cluster described by c-TF-IDF keywords plus the entries nearest its
 * centroid. Sizes are a few thousand vectors at most, so everything is plain loops.
 */

export interface Cluster {
  id: number
  size: number
  /** Mean cosine of members to the centroid (1 = identical). */
  cohesion: number
  keywords: string[]
  /** Member indices nearest the centroid, best first. */
  exemplars: number[]
}

export interface Clustering {
  k: number
  auto: boolean
  /** Silhouette per candidate k (only when k was picked automatically). */
  scores: { k: number; silhouette: number }[]
  assign: number[]
  clusters: Cluster[]
}

export const MAX_K = 12
// k selection runs k-means once per candidate k: do it on a sample, then fit the chosen k on everything
const SELECT_SAMPLE = 300

function rng(seed: number) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
}

// everything is Float32Array so the hot loops stay monomorphic
function dot(a: Float32Array, b: Float32Array) {
  let s = 0
  for (let j = 0; j < a.length; j++) s += a[j] * b[j]
  return s
}

function normalize(v: Float32Array) {
  const n = Math.sqrt(dot(v, v)) || 1
  for (let j = 0; j < v.length; j++) v[j] /= n
  return v
}

/** Largest k worth trying for n points. */
export function maxK(n: number) {
  return Math.max(1, Math.min(MAX_K, Math.floor(n / 3)))
}

/** Spherical k-means with k-means++ seeding; best of a few seeded restarts by total cosine distance. */
export function kmeans(vecs: Float32Array[], k: number, seed = 42): { assign: number[]; centroids: Float32Array[] } {
  const n = vecs.length
  const d = vecs[0].length
  k = Math.max(1, Math.min(k, n))
  let best: { assign: number[]; centroids: Float32Array[]; cost: number } | undefined
  // restarts guard against a bad seeding on small inputs; large ones are stable enough and costly
  const restarts = n * d > 500_000 ? 1 : 3
  for (let restart = 0; restart < restarts; restart++) {
    const rand = rng(seed + restart * 7919)
    // k-means++: each next seed is drawn with probability ∝ squared cosine distance to the nearest seed so far
    const centroids: Float32Array[] = [Float32Array.from(vecs[Math.floor(rand() * n)])]
    const dist = vecs.map(v => Math.max(0, 1 - dot(v, centroids[0])))
    while (centroids.length < k) {
      const total = dist.reduce((a, x) => a + x * x, 0)
      let r = rand() * total
      let pick = 0
      if (total > 0) while (pick < n - 1 && (r -= dist[pick] ** 2) > 0) pick++
      else pick = Math.floor(rand() * n)
      const c = Float32Array.from(vecs[pick])
      centroids.push(c)
      vecs.forEach((v, i) => { dist[i] = Math.min(dist[i], Math.max(0, 1 - dot(v, c))) })
    }
    const assign = new Array<number>(n).fill(-1)
    let cost = 0
    for (let it = 0; it < 50; it++) {
      let changed = false
      cost = 0
      vecs.forEach((v, i) => {
        let bi = 0, bs = -Infinity
        centroids.forEach((c, ci) => { const s = dot(v, c); if (s > bs) { bs = s; bi = ci } })
        cost += 1 - bs
        if (assign[i] !== bi) { assign[i] = bi; changed = true }
      })
      if (!changed && it) break
      const sums = centroids.map(() => new Float32Array(d))
      const counts = new Array<number>(k).fill(0)
      vecs.forEach((v, i) => { const s = sums[assign[i]]; counts[assign[i]]++; for (let j = 0; j < d; j++) s[j] += v[j] })
      sums.forEach((s, ci) => {
        if (counts[ci]) { centroids[ci] = normalize(s); return }
        // an emptied cluster restarts at the point worst served by its centroid
        let far = 0, fs = Infinity
        vecs.forEach((v, i) => { const x = dot(v, centroids[assign[i]]); if (x < fs) { fs = x; far = i } })
        centroids[ci] = Float32Array.from(vecs[far])
      })
    }
    if (!best || cost < best.cost) best = { assign, centroids, cost }
  }
  return { assign: best!.assign, centroids: best!.centroids }
}

/** Mean silhouette under cosine distance, from a precomputed similarity matrix. */
export function silhouette(sims: Float32Array[], assign: number[], k: number) {
  const n = assign.length
  const sizes = new Array<number>(k).fill(0)
  for (const a of assign) sizes[a]++
  let total = 0
  for (let i = 0; i < n; i++) {
    if (sizes[assign[i]] < 2) continue // singleton: silhouette 0 by convention
    const sum = new Array<number>(k).fill(0)
    for (let j = 0; j < n; j++) if (j !== i) sum[assign[j]] += 1 - sims[i][j]
    const a = sum[assign[i]] / (sizes[assign[i]] - 1)
    let b = Infinity
    for (let c = 0; c < k; c++) if (c !== assign[i] && sizes[c]) b = Math.min(b, sum[c] / sizes[c])
    if (b === Infinity) continue
    total += (b - a) / (Math.max(a, b) || 1)
  }
  return total / n
}

/** Silhouette for every candidate k on (a sample of) the data; the best one wins. */
export function chooseK(vecs: Float32Array[], seed = 42): { k: number; scores: { k: number; silhouette: number }[] } {
  const top = maxK(vecs.length)
  if (top < 2) return { k: 1, scores: [] }
  let sample = vecs
  if (vecs.length > SELECT_SAMPLE) {
    const rand = rng(seed)
    const idx = vecs.map((_, i) => i)
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
    sample = idx.slice(0, SELECT_SAMPLE).map(i => vecs[i])
  }
  const sims = sample.map(a => Float32Array.from(sample, b => dot(a, b)))
  const scores: { k: number; silhouette: number }[] = []
  for (let k = 2; k <= top; k++) scores.push({ k, silhouette: silhouette(sims, kmeans(sample, k, seed).assign, k) })
  const best = scores.reduce((a, b) => (b.silhouette > a.silhouette ? b : a), scores[0])
  return { k: best.k, scores }
}

// ---------- keywords ----------

const STOPWORDS = new Set((
  '的 了 和 与 及 或 是 在 有 也 都 就 还 而 但 并 被 把 让 给 对 向 从 到 为 以 于 之 其 这 那 这个 那个 这些 那些 一个 一些 ' +
  '我 你 他 她 它 我们 你们 他们 她们 自己 对方 大家 什么 怎么 为什么 如何 哪 哪里 没有 不是 就是 还是 可以 需要 已经 因为 所以 ' +
  '如果 然后 之后 之前 随后 后来 先 再 又 再次 首次 继续 表示 称 说 问 回答 回应 询问 提到 谈及 要求 告诉 认为 觉得 希望 ' +
  '今天 昨天 明天 上午 下午 晚上 凌晨 中午 当日 概要 事实 结论 约定 暂无 私聊 群聊 用户 成员 消息 内容 时候 一下 一起 ' +
  'the a an and or of to in on for with is are was were be been it this that at by from as but not you we they he she i'
).split(/\s+/))

const LONG_STOPWORDS = [...STOPWORDS].filter(w => w.length >= 2 && /^\p{Script=Han}+$/u.test(w))
// a gram starting or ending on one of these is a fragment of a phrase, not a name or topic
const EDGE_CHARS = new Set('的了着过和与及或是在有也都就还而但并被把让给对向从到为以于之其这那我你他她它们么吗呢吧啊呀哦嘛又再很说问称')
const segmenter = new Intl.Segmenter('en', { granularity: 'word' })

/**
 * Terms of a text, dictionary-free: every 2-4 character gram of each Han run (the word segmenter has no idea about
 * names and slang like 哈基米), plus Latin words and adjacent word pairs. clusterKeywords then lets a longer gram
 * absorb the shorter ones it contains.
 */
export function terms(text: string): Set<string> {
  // raw archived messages carry headers like 【2026-10-22 周四 15:30｜群「1」｜发言人 4(平台ID 4)】 and [at:you] markers
  const clean = text.toLowerCase().replace(/【[^】]*[｜|][^】]*】/g, ' ').replace(/\[[a-z_]+:[^\]]*\]/gi, ' ')
  const out = new Set<string>()
  for (const run of clean.match(/\p{Script=Han}+/gu) ?? []) {
    // stopEnd[i]: end of the earliest stopword starting at i, so a gram covering it can be skipped
    const stopEnd = new Array<number>(run.length).fill(Infinity)
    for (const w of LONG_STOPWORDS) for (let p = run.indexOf(w); p >= 0; p = run.indexOf(w, p + 1)) stopEnd[p] = Math.min(stopEnd[p], p + w.length)
    for (let n = 2; n <= 4; n++)
      for (let i = 0; i + n <= run.length; i++) {
        if (EDGE_CHARS.has(run[i]) || EDGE_CHARS.has(run[i + n - 1])) continue
        let stop = false
        for (let p = i; p < i + n - 1 && !stop; p++) stop = stopEnd[p] <= i + n
        if (!stop) out.add(run.slice(i, i + n))
      }
  }
  const words = [...segmenter.segment(clean.replace(/\p{Script=Han}+/gu, ' | '))]
    .filter(s => s.isWordLike && /^[a-z][a-z0-9_'-]*$/.test(s.segment))
    .map(s => s.segment)
  words.forEach((w, i) => {
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w)
    const next = words[i + 1]
    if (next && w.length >= 2 && next.length >= 2 && !STOPWORDS.has(w) && !STOPWORDS.has(next)) out.add(`${w} ${next}`)
  })
  return out
}

/**
 * c-TF-IDF over documents: a term scores by the share of the cluster's documents containing it, weighted by how rare
 * it is across all documents. `skip` marks near-duplicate documents (a day digest restating its only episode), which
 * would otherwise make every phrase of theirs look common. Terms seen in a single document are skipped for clusters
 * of 3+; a term found mostly
 * inside a longer one (哈基 inside 哈基米) gives way to it, and a term overlapping an already chosen one is dropped.
 */
export function clusterKeywords(texts: string[], assign: number[], k: number, top = 5, skip = new Set<number>()): string[][] {
  const docTerms = texts.map((t, i) => (skip.has(i) ? new Set<string>() : terms(t)))
  const df = new Map<string, number>()
  for (const ts of docTerms) for (const t of ts) df.set(t, (df.get(t) ?? 0) + 1)
  const n = texts.length
  return Array.from({ length: k }, (_, c) => {
    const members = docTerms.filter((_, i) => assign[i] === c && !skip.has(i))
    const counts = new Map<string, number>()
    for (const ts of members) for (const t of ts) counts.set(t, (counts.get(t) ?? 0) + 1)
    const minCount = members.length >= 3 ? 2 : 1
    // the longest containing gram of each term, by count: a term whose count it nearly matches is just its fragment
    const absorbed = new Set<string>()
    for (const [t, cnt] of counts) {
      if (cnt < minCount || t.length < 3 || t.includes(' ')) continue
      for (const sub of [t.slice(1), t.slice(0, -1)]) if ((counts.get(sub) ?? 0) <= cnt / 0.8) absorbed.add(sub)
    }
    const ranked = [...counts]
      .filter(([t, cnt]) => cnt >= minCount && !absorbed.has(t))
      .map(([t, cnt]) => [t, (cnt / members.length) * Math.log(1 + n / df.get(t)!)] as const)
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    const picked: string[] = []
    for (const [t] of ranked) {
      if (picked.length >= top) break
      if (picked.some(p => p.includes(t) || t.includes(p) || overlaps(p, t))) continue
      picked.push(t)
    }
    return picked
  })
}

/** Two grams that share a 2+ character edge (岛风风 / 风风说) name the same thing twice. */
function overlaps(a: string, b: string) {
  for (let len = Math.min(a.length, b.length) - 1; len >= 2; len--)
    if (a.endsWith(b.slice(0, len)) || b.endsWith(a.slice(0, len))) return true
  return false
}

// ---------- all together ----------

const DUPLICATE = 0.9

/** Members nearly identical to an earlier member of their cluster (checked against the last few kept, to stay linear). */
function nearDuplicates(vecs: Float32Array[], assign: number[]): Set<number> {
  const kept = new Map<number, number[]>()
  const out = new Set<number>()
  vecs.forEach((v, i) => {
    const list = kept.get(assign[i]) ?? []
    if (list.slice(-64).some(j => dot(v, vecs[j]) >= DUPLICATE)) out.add(i)
    else kept.set(assign[i], [...list, i].slice(-64))
  })
  return out
}

/** Cluster normalized vectors; `k` undefined (or out of range) picks it by silhouette. */
export function clusterVectors(vecs: Float32Array[], texts: string[], k?: number): Clustering {
  if (!vecs.length) return { k: 0, auto: !k, scores: [], assign: [], clusters: [] }
  const auto = !k || k < 1
  const chosen = auto ? chooseK(vecs) : { k: Math.min(k!, vecs.length), scores: [] }
  const { assign, centroids } = kmeans(vecs, chosen.k)
  // number clusters biggest first so ids (and colours) follow size
  const sizes = centroids.map((_, c) => assign.filter(a => a === c).length)
  const order = sizes.map((s, c) => [s, c]).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]).map(([, c]) => c)
  const remap = new Map(order.map((c, i) => [c, i]))
  const finalAssign = assign.map(a => remap.get(a)!)
  const keywords = clusterKeywords(texts, finalAssign, order.length, 5, nearDuplicates(vecs, finalAssign))
  const clusters = order.map((c, id) => {
    const members = finalAssign.map((a, i) => [a, i]).filter(([a]) => a === id).map(([, i]) => i)
    const sims = members.map(i => [dot(vecs[i], centroids[c]), i] as const).sort((a, b) => b[0] - a[0])
    return {
      id,
      size: members.length,
      cohesion: sims.reduce((a, [s]) => a + s, 0) / members.length,
      keywords: keywords[id],
      exemplars: sims.slice(0, 3).map(([, i]) => i),
    }
  })
  return { k: clusters.length, auto, scores: chosen.scores, assign: finalAssign, clusters }
}
