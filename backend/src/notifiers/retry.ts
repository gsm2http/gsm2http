export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retries. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Each delay is this many times the previous one. */
  factor: number;
}

/** About 10 s, 30 s, 90 s, 4.5 min and 13.5 min between six attempts: ~19 min in all. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 6,
  initialDelayMs: 10_000,
  maxDelayMs: 30 * 60_000,
  factor: 3,
};

/** ±20 %, so sinks that failed together don't all retry in the same instant. */
const JITTER = 0.2;

/**
 * Delay before attempt `failedAttempt + 1`. A server's `Retry-After` is honoured when it
 * asks for longer than the backoff would, up to `maxDelayMs`.
 */
export function retryDelay(
  policy: RetryPolicy,
  failedAttempt: number,
  retryAfterMs?: number,
  random: () => number = Math.random,
): number {
  const base = policy.initialDelayMs * policy.factor ** (failedAttempt - 1);
  const jittered = base * (1 - JITTER + 2 * JITTER * random());
  return Math.round(Math.min(policy.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0)));
}

/**
 * Timeouts, 408, 425, 429 and 5xx are worth retrying. Other 4xx mean the request itself
 * was rejected (bad URL, auth, signature) and would fail again.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** `Retry-After` as seconds or an HTTP date. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
