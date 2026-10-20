import type { RateConfig } from '../core/configTypes.ts'
import { sleep } from '../core/util.ts'

interface Bucket {
  tokens: number
  updated: number
}

/** Token buckets keyed by string; capacity/refill come from the RateConfig at call time (hot-reload friendly). */
export class RateLimiter {
  private buckets = new Map<string, Bucket>()

  private refill(key: string, rate: RateConfig): Bucket {
    const now = Date.now()
    const cap = Math.max(1, rate.count)
    const perMs = cap / Math.max(1, rate.perSeconds * 1000)
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: cap, updated: now }
      this.buckets.set(key, b)
    }
    b.tokens = Math.min(cap, b.tokens + (now - b.updated) * perMs)
    b.updated = now
    return b
  }

  available(key: string, rate: RateConfig): number {
    return Math.floor(this.refill(key, rate).tokens)
  }

  tryTake(key: string, rate: RateConfig): boolean {
    const b = this.refill(key, rate)
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }

  /** Wait up to maxWaitMs for a token. */
  async take(key: string, rate: RateConfig, maxWaitMs: number): Promise<boolean> {
    const deadline = Date.now() + maxWaitMs
    while (true) {
      if (this.tryTake(key, rate)) return true
      const b = this.refill(key, rate)
      const need = ((1 - b.tokens) * rate.perSeconds * 1000) / Math.max(1, rate.count)
      if (Date.now() + need > deadline) return false
      await sleep(Math.min(need + 20, 2000))
    }
  }
}

export const limiter = new RateLimiter()

/** Simple per-key cooldown tracker. */
export class Cooldown {
  private last = new Map<string, number>()
  ready(key: string, seconds: number): boolean {
    const t = this.last.get(key)
    return !t || Date.now() - t >= seconds * 1000
  }
  hit(key: string) {
    this.last.set(key, Date.now())
    if (this.last.size > 5000) for (const [k, v] of this.last) if (Date.now() - v > 86400_000) this.last.delete(k)
  }
  /** ready + hit in one go */
  pass(key: string, seconds: number): boolean {
    if (!this.ready(key, seconds)) return false
    this.hit(key)
    return true
  }
}
