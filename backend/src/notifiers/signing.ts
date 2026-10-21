import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-Gsm2http-Signature';
export const TIMESTAMP_HEADER = 'X-Gsm2http-Timestamp';
/** Receivers should reject signatures older (or newer) than this. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * `sha256=` + hex(HMAC-SHA256(secret, "<timestamp>.<raw body>")). Signing the timestamp
 * with the body means a captured request cannot be replayed later with a fresh timestamp.
 */
export function sign(secret: string, timestamp: number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `sha256=${digest}`;
}

export function signatureHeaders(
  secret: string,
  body: string,
  now: number = Date.now(),
): Record<string, string> {
  const timestamp = Math.floor(now / 1000);
  return {
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: sign(secret, timestamp, body),
  };
}

/**
 * The receiver side, as in docs/events.md: constant-time comparison plus a freshness
 * check. Exported for the tests and for anyone embedding gsm2http's receiver logic.
 */
export function verifySignature(options: {
  secret: string;
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  now?: number;
  toleranceSeconds?: number;
}): boolean {
  const { secret, body, timestamp, signature } = options;
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  const nowSeconds = (options.now ?? Date.now()) / 1000;
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - Number(timestamp)) > tolerance) return false;

  const expected = Buffer.from(sign(secret, Number(timestamp), body));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
