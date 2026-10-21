import type { AnyGatewayEvent, EventFilter } from '../events';
import { logger } from '../logger';
import { isRetryableStatus, parseRetryAfter, retryDelay, type RetryPolicy } from './retry';
import { signatureHeaders } from './signing';
import type {
  DeliveryLog,
  DeliveryRecord,
  Notifier,
  NotifierStats,
  NotifierSummary,
} from './types';

export interface WebhookNotifierOptions {
  name: string;
  url: string;
  filter: EventFilter;
  /** Signs every request when set. See docs/events.md#signatures. */
  secret?: string;
  timeoutMs: number;
  retry: RetryPolicy;
  /** Extra request headers, e.g. for an auth proxy. gsm2http's own headers win on clashes. */
  headers?: Record<string, string>;
  /** Deliveries in flight or waiting to retry, beyond which new events are dropped. */
  maxPending?: number;
  log: DeliveryLog;
  /** Injected by tests. */
  fetch?: typeof fetch;
  random?: () => number;
}

interface AttemptResult {
  ok: boolean;
  retryable: boolean;
  status?: number;
  error?: string;
  retryAfterMs?: number;
}

const DEFAULT_MAX_PENDING = 1_000;
/** On shutdown, requests already in flight get this long to finish; retries are dropped. */
const CLOSE_GRACE_MS = 2_000;
const USER_AGENT = 'gsm2http-webhook/1 (+https://github.com/gsm2http/gsm2http)';

/**
 * POSTs each event as JSON to one URL, with retries and exponential backoff. The body is
 * serialised once, so every retry sends identical bytes; each attempt is signed afresh so
 * a late retry still passes the receiver's freshness check.
 */
export class WebhookNotifier implements Notifier {
  public readonly type = 'webhook' as const;
  public readonly name: string;
  public readonly filter: EventFilter;
  private readonly options: WebhookNotifierOptions;
  private readonly fetch: typeof fetch;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly log;
  private pending = 0;
  private closed = false;
  private readonly stats: NotifierStats = { delivered: 0, failed: 0, pending: 0 };

  constructor(options: WebhookNotifierOptions) {
    this.options = options;
    this.name = options.name;
    this.filter = options.filter;
    this.fetch = options.fetch ?? fetch;
    this.log = logger.child({ component: 'webhook', notifier: options.name });
  }

  public deliver(event: AnyGatewayEvent): void {
    if (this.closed) return;
    if (this.pending >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
      this.record(event, 1, { outcome: 'dropped', error: 'too many pending deliveries' });
      this.log.error(
        { event: event.event, eventId: event.id },
        'webhook queue full, event dropped',
      );
      return;
    }
    this.pending++;
    this.track(this.attempt(event, JSON.stringify(event), 1));
  }

  private track(attempt: Promise<void>): void {
    this.inFlight.add(attempt);
    void attempt.finally(() => this.inFlight.delete(attempt));
  }

  private async attempt(event: AnyGatewayEvent, body: string, attempt: number): Promise<void> {
    const started = Date.now();
    const result = await this.post(event, body, attempt);
    const durationMs = Date.now() - started;
    // After close(), a success is still recorded, but nothing is retried.
    if (this.closed && !result.ok) return;

    const fields = { event: event.event, eventId: event.id, attempt, status: result.status };
    if (result.ok) {
      this.pending--;
      this.stats.delivered++;
      this.stats.lastSuccessAt = new Date().toISOString();
      this.record(event, attempt, { outcome: 'delivered', status: result.status, durationMs });
      this.log.info({ ...fields, durationMs }, 'webhook delivered');
      return;
    }

    this.stats.lastFailureAt = new Date().toISOString();
    this.stats.lastError = result.error;
    const { retry } = this.options;
    if (result.retryable && attempt < retry.maxAttempts) {
      const delay = retryDelay(retry, attempt, result.retryAfterMs, this.options.random);
      this.record(event, attempt, {
        outcome: 'retrying',
        status: result.status,
        error: result.error,
        durationMs,
        retryAt: new Date(Date.now() + delay).toISOString(),
      });
      this.log.warn(
        { ...fields, error: result.error, retryInMs: delay },
        'webhook failed, will retry',
      );
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.track(this.attempt(event, body, attempt + 1));
      }, delay);
      // Pending retries alone should not keep the process alive (tests, CLI tools).
      timer.unref();
      this.timers.add(timer);
      return;
    }

    this.pending--;
    this.stats.failed++;
    this.record(event, attempt, {
      outcome: 'failed',
      status: result.status,
      error: result.error,
      durationMs,
    });
    this.log.error(
      { ...fields, error: result.error },
      result.retryable ? 'webhook failed, giving up' : 'webhook rejected, not retrying',
    );
  }

  private async post(
    event: AnyGatewayEvent,
    body: string,
    attempt: number,
  ): Promise<AttemptResult> {
    const own: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-Gsm2http-Event': event.event,
      'X-Gsm2http-Delivery': event.id,
      'X-Gsm2http-Attempt': String(attempt),
      ...(this.options.secret ? signatureHeaders(this.options.secret, body) : {}),
    };
    // Header names are case-insensitive; a configured `content-type` or lowercase
    // signature header must not be merged into gsm2http's own.
    const reserved = new Set(Object.keys(own).map((name) => name.toLowerCase()));
    const extra = Object.entries(this.options.headers ?? {}).filter(
      ([name]) => !reserved.has(name.toLowerCase()),
    );
    const headers: Record<string, string> = { ...Object.fromEntries(extra), ...own };

    let response: Response;
    try {
      response = await this.fetch(this.options.url, {
        method: 'POST',
        headers,
        body,
        // A redirected POST may silently turn into a GET; make the user fix the URL instead.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      return {
        ok: false,
        retryable: true,
        error: timedOut ? `timed out after ${this.options.timeoutMs} ms` : describeError(err),
      };
    }
    // Free the connection; the response body is never used.
    await response.body?.cancel().catch(() => undefined);

    const { status } = response;
    if (status >= 200 && status < 300) return { ok: true, retryable: false, status };
    if (status >= 300 && status < 400) {
      return {
        ok: false,
        retryable: false,
        status,
        error: `redirected (HTTP ${status}); set the final URL instead`,
      };
    }
    return {
      ok: false,
      retryable: isRetryableStatus(status),
      status,
      error: `HTTP ${status}`,
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
    };
  }

  private record(
    event: AnyGatewayEvent,
    attempt: number,
    fields: Pick<DeliveryRecord, 'outcome'> & Partial<DeliveryRecord>,
  ): void {
    this.options.log.add({
      notifier: this.name,
      eventId: event.id,
      event: event.event,
      attempt,
      at: new Date().toISOString(),
      ...fields,
    });
  }

  public describe(): NotifierSummary {
    return {
      name: this.name,
      type: this.type,
      target: redactUrl(this.options.url),
      events: this.filter.events,
      ...(this.filter.modems && { modems: this.filter.modems }),
      signed: Boolean(this.options.secret),
      stats: { ...this.stats, pending: this.pending },
    };
  }

  /** Drops scheduled retries and gives requests in flight a moment to complete. */
  public async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.pending -= this.timers.size;
    this.timers.clear();

    if (this.inFlight.size > 0) {
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => (grace = setTimeout(resolve, CLOSE_GRACE_MS))),
      ]);
      clearTimeout(grace);
    }
    if (this.pending > 0) {
      this.log.warn({ pending: this.pending }, 'shut down with undelivered webhooks');
    }
  }
}

/**
 * Webhook URLs usually carry their secret in the path (n8n and Home Assistant webhook
 * IDs), so only the origin is shown. Credentials and query strings are dropped too.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Non-http schemes (mqtt:) have an empty pathname rather than '/'.
    const hasMore = !['', '/'].includes(parsed.pathname) || parsed.search !== '';
    return `${parsed.protocol}//${parsed.host}${hasMore ? '/…' : ''}`;
  } catch {
    return '(invalid URL)';
  }
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // undici puts the useful part (ECONNREFUSED, ENOTFOUND…) in `cause`.
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  return cause ? `${err.message}: ${cause}` : err.message;
}
