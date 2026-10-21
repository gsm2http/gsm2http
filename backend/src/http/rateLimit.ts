/** Above this many tracked keys, expired windows are swept on the next hit. */
const SWEEP_THRESHOLD = 1_000;
/** Hard cap; beyond it the oldest windows are dropped, so many source addresses can't grow memory. */
const MAX_KEYS = 10_000;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Fixed-window counter per key (a modem, a client address). In memory: limits reset on
 * restart, which is fine for a single self-hosted process. A limit of 0 disables it.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    public readonly limit: number,
    public readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one hit for `key` and says whether it is within the limit. */
  public hit(key: string): RateLimitResult {
    if (this.limit <= 0) return { allowed: true };
    const now = this.now();
    if (this.windows.size > SWEEP_THRESHOLD) this.sweep(now);

    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, window);
    }
    if (window.count >= this.limit) return { allowed: false, retryAfterMs: window.resetAt - now };
    window.count++;
    return { allowed: true };
  }

  /** Whether `key` has used up its window, without counting a hit. */
  public isBlocked(key: string): RateLimitResult {
    if (this.limit <= 0) return { allowed: true };
    const now = this.now();
    const window = this.windows.get(key);
    if (!window || window.resetAt <= now || window.count < this.limit) return { allowed: true };
    return { allowed: false, retryAfterMs: window.resetAt - now };
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    // Maps iterate in insertion order, so this drops the oldest windows first.
    for (const key of this.windows.keys()) {
      if (this.windows.size <= MAX_KEYS) break;
      this.windows.delete(key);
    }
  }
}
