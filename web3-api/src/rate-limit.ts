import {tooManyRequests} from './errors.ts'

/**
 * In-memory sliding-window limiter. State is per process, so with several
 * instances the effective limit is multiplied; anything that must hold
 * globally (challenge and intent creation) is ALSO enforced from the database.
 *
 * Callers key by DID after authentication. IP-based keys are only a coarse
 * outer guard: behind a PDS proxy every user of that PDS shares one source IP.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly max: number
  private readonly windowMs: number
  private lastSweep = 0

  constructor(max: number, windowMs: number) {
    this.max = max
    this.windowMs = windowMs
  }

  /** Throws a 429 AppError when the key is over its limit. */
  consume(key: string, now: number = Date.now()): void {
    this.sweep(now)
    const windowStart = now - this.windowMs
    const recent = (this.hits.get(key) ?? []).filter(t => t > windowStart)
    if (recent.length >= this.max) {
      this.hits.set(key, recent)
      const oldest = recent[0] ?? now
      throw tooManyRequests((oldest + this.windowMs - now) / 1000)
    }
    recent.push(now)
    this.hits.set(key, recent)
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.windowMs) return
    this.lastSweep = now
    const windowStart = now - this.windowMs
    for (const [k, v] of this.hits) {
      if (!v.some(t => t > windowStart)) this.hits.delete(k)
    }
  }
}

export type RouteLimits = {
  createChallenge: SlidingWindowLimiter
  verifyChallenge: SlidingWindowLimiter
  unlink: SlidingWindowLimiter
  read: SlidingWindowLimiter
  tipIntent: SlidingWindowLimiter
  tipSubmit: SlidingWindowLimiter
  global: SlidingWindowLimiter
}

const MINUTE = 60_000

export function defaultRouteLimits(perIpPerMinute: number): RouteLimits {
  return {
    createChallenge: new SlidingWindowLimiter(10, MINUTE),
    verifyChallenge: new SlidingWindowLimiter(20, MINUTE),
    unlink: new SlidingWindowLimiter(10, MINUTE),
    read: new SlidingWindowLimiter(120, MINUTE),
    tipIntent: new SlidingWindowLimiter(20, MINUTE),
    tipSubmit: new SlidingWindowLimiter(30, MINUTE),
    global: new SlidingWindowLimiter(perIpPerMinute, MINUTE),
  }
}
