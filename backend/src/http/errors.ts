import type { ErrorRequestHandler, RequestHandler } from 'express';
import { logger } from '../logger';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message);

export const tooManyRequests = (message: string, retryAfterMs: number) => {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new HttpError(
    429,
    message,
    { retryAfterSeconds },
    { 'Retry-After': `${retryAfterSeconds}` },
  );
};

/** Errors raised by body-parser and friends carry a status and say whether to expose it. */
function clientError(err: unknown): { status: number; message: string } | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, expose, type } = err as { status?: unknown; expose?: unknown; type?: unknown };
  if (typeof status !== 'number' || status < 400 || status >= 500 || expose !== true) {
    return undefined;
  }
  if (type === 'entity.too.large') return { status, message: 'Request body is too large' };
  if (type === 'entity.parse.failed') return { status, message: 'Request body is not valid JSON' };
  return { status, message: 'Malformed request' };
}

export const notFound: RequestHandler = (req) => {
  throw new HttpError(404, `No route for ${req.method} ${req.path}`);
};

/**
 * Every error response is `{ success: false, error }`, plus any details. Stack traces and
 * internal messages stay in the server log.
 */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  if (err instanceof HttpError) {
    res.set(err.headers);
    res.status(err.status).json({ success: false, error: err.message, ...err.details });
    return;
  }
  const client = clientError(err);
  if (client) {
    res.status(client.status).json({ success: false, error: client.message });
    return;
  }
  logger.error({ err, method: req.method, path: req.path }, 'unhandled error');
  res.status(500).json({ success: false, error: 'Internal server error' });
};
