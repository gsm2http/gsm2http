import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../logger';
import { HttpError, tooManyRequests } from './errors';
import type { RateLimiter } from './rateLimit';

const log = logger.child({ component: 'auth' });

/** Constant-time comparison; hashing first makes the lengths equal. */
export function tokenMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || given === '') return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b);
}

/** The token from `Authorization: Bearer <token>`. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match?.[1];
}

export interface TokenCheck {
  /** Undefined when auth is disabled. */
  token: string | undefined;
  /** Failed attempts per client address. */
  failures: RateLimiter;
}

/**
 * Checks a client's token. Undefined means let it through; otherwise the error to fail
 * with. Clients that keep guessing are locked out for the rest of the window, but a
 * correct token always passes: behind a reverse proxy every client shares one address,
 * and a guesser must not lock out the UI and automations.
 */
export function checkToken(
  { token, failures }: TokenCheck,
  given: unknown,
  address: string,
): HttpError | undefined {
  if (token === undefined) return undefined;
  if (tokenMatches(token, given)) return undefined;
  const blocked = failures.isBlocked(address);
  if (!blocked.allowed) {
    return tooManyRequests('Too many failed authentication attempts', blocked.retryAfterMs);
  }
  failures.hit(address);
  log.warn({ address, tokenSent: given !== undefined }, 'rejected request with a bad API token');
  return new HttpError(401, 'Missing or invalid API token', {}, { 'WWW-Authenticate': 'Bearer' });
}

/** Express middleware requiring `Authorization: Bearer <API_TOKEN>`. */
export function requireToken(check: TokenCheck): RequestHandler {
  return (req, _res, next) => {
    const error = checkToken(check, bearerToken(req.headers.authorization), req.ip ?? 'unknown');
    next(error);
  };
}
