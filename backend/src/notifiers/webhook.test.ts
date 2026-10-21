import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEvent, type AnyGatewayEvent } from '../events';
import { isRetryableStatus, parseRetryAfter, retryDelay, type RetryPolicy } from './retry';
import { verifySignature } from './signing';
import { DeliveryLog } from './types';
import { redactUrl, WebhookNotifier, type WebhookNotifierOptions } from './webhook';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const FAST_RETRY: RetryPolicy = { maxAttempts: 4, initialDelayMs: 5, maxDelayMs: 1_000, factor: 2 };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

/** A fetch that answers from a script: a status, a thrown error, or 'hang' (until aborted). */
function scriptedFetch(script: (number | Error | 'hang' | Response)[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      headers: init?.headers as Record<string, string>,
      body: init?.body as string,
      at: Date.now(),
    });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    if (step instanceof Error) throw step;
    if (step instanceof Response) return step;
    if (step === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    }
    return new Response(null, { status: step });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function smsEvent(): AnyGatewayEvent {
  return createEvent(
    'sms.received',
    { id: 'modem-1', port: '/dev/ttyUSB0', imei: '000000000000001' },
    { sender: '+12025550199', text: 'hello', sentAt: '2026-10-14T19:04:12.000Z' },
  );
}

function notifier(
  overrides: Partial<WebhookNotifierOptions> & Pick<WebhookNotifierOptions, 'fetch'>,
) {
  const log = new DeliveryLog();
  const n = new WebhookNotifier({
    name: 'test',
    url: 'https://hooks.example/webhook/secret-path?token=abc',
    filter: { events: ['*'] },
    timeoutMs: 1_000,
    retry: FAST_RETRY,
    log,
    random: () => 0.5,
    ...overrides,
  });
  return { notifier: n, log };
}

async function settle(n: WebhookNotifier): Promise<void> {
  for (let i = 0; i < 200 && n.describe().stats.pending > 0; i++) await tick(5);
}

describe('webhook notifier', () => {
  it('posts the event as JSON with event and delivery headers', async () => {
    const { calls, fetch } = scriptedFetch([204]);
    const { notifier: n } = notifier({ fetch });
    const event = smsEvent();
    n.deliver(event);
    await settle(n);

    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0]!.body), event);
    assert.equal(calls[0]!.headers['Content-Type'], 'application/json');
    assert.equal(calls[0]!.headers['X-Gsm2http-Event'], 'sms.received');
    assert.equal(calls[0]!.headers['X-Gsm2http-Delivery'], event.id);
    assert.equal(calls[0]!.headers['X-Gsm2http-Attempt'], '1');
    assert.equal(calls[0]!.headers['X-Gsm2http-Signature'], undefined, 'unsigned without a secret');
    assert.equal(n.describe().stats.delivered, 1);
  });

  it('retries 5xx with exponential backoff, keeping the body and delivery ID', async () => {
    const { calls, fetch } = scriptedFetch([500, 503, 204]);
    const { notifier: n, log } = notifier({ fetch });
    const event = smsEvent();
    n.deliver(event);
    await settle(n);

    assert.equal(calls.length, 3);
    assert.deepEqual(
      calls.map((c) => c.headers['X-Gsm2http-Attempt']),
      ['1', '2', '3'],
    );
    assert.ok(
      calls.every((c) => c.body === calls[0]!.body),
      'identical body on every attempt',
    );
    assert.ok(calls.every((c) => c.headers['X-Gsm2http-Delivery'] === event.id));
    // 5 ms, then 10 ms (factor 2, no jitter with random = 0.5).
    assert.ok(calls[1]!.at - calls[0]!.at >= 5);
    assert.ok(calls[2]!.at - calls[1]!.at >= 10);

    assert.deepEqual(
      log.list().map((r) => [r.attempt, r.outcome, r.status]),
      [
        [3, 'delivered', 204],
        [2, 'retrying', 503],
        [1, 'retrying', 500],
      ],
    );
    assert.deepEqual(
      { ...n.describe().stats, lastSuccessAt: undefined, lastFailureAt: undefined },
      {
        delivered: 1,
        failed: 0,
        pending: 0,
        lastError: 'HTTP 503',
        lastSuccessAt: undefined,
        lastFailureAt: undefined,
      },
    );
  });

  it('retries network errors and timeouts, then gives up after maxAttempts', async () => {
    const { calls, fetch } = scriptedFetch([new TypeError('fetch failed'), 'hang']);
    const { notifier: n, log } = notifier({ fetch, timeoutMs: 20 });
    n.deliver(smsEvent());
    await settle(n);

    assert.equal(calls.length, FAST_RETRY.maxAttempts);
    const [last] = log.list();
    assert.equal(last?.outcome, 'failed');
    assert.equal(last.error, 'timed out after 20 ms');
    assert.equal(log.list().at(-1)?.error, 'fetch failed');
    assert.equal(n.describe().stats.failed, 1);
  });

  it('does not retry other 4xx responses or redirects', async () => {
    for (const status of [400, 401, 404, 410, 302]) {
      const { calls, fetch } = scriptedFetch([status, 204]);
      const { notifier: n, log } = notifier({ fetch });
      n.deliver(smsEvent());
      await settle(n);
      assert.equal(calls.length, 1, `HTTP ${status} is not retried`);
      assert.equal(log.list()[0]?.outcome, 'failed');
    }
  });

  it('retries 408 and 429, honouring Retry-After', async () => {
    const limited = new Response(null, { status: 429, headers: { 'Retry-After': '0' } });
    const { calls, fetch } = scriptedFetch([408, limited, 200]);
    const { notifier: n } = notifier({ fetch });
    n.deliver(smsEvent());
    await settle(n);
    assert.equal(calls.length, 3);
  });

  it('signs each attempt with a fresh timestamp over the raw body', async () => {
    const secret = 'whsec_test_0123456789';
    const { calls, fetch } = scriptedFetch([500, 204]);
    const { notifier: n } = notifier({ fetch, secret });
    n.deliver(smsEvent());
    await settle(n);

    for (const call of calls) {
      const timestamp = call.headers['X-Gsm2http-Timestamp'];
      const signature = call.headers['X-Gsm2http-Signature'];
      assert.match(signature ?? '', /^sha256=[0-9a-f]{64}$/);
      assert.ok(verifySignature({ secret, body: call.body, timestamp, signature }));
      assert.ok(!verifySignature({ secret: 'wrong', body: call.body, timestamp, signature }));
      assert.ok(!verifySignature({ secret, body: `${call.body} `, timestamp, signature }));
    }
  });

  it('lets custom headers through but never lets them override its own', async () => {
    const { calls, fetch } = scriptedFetch([204]);
    const { notifier: n } = notifier({
      fetch,
      headers: {
        Authorization: 'Bearer proxy-token',
        'X-Gsm2http-Event': 'spoofed',
        'content-type': 'text/plain',
        'x-gsm2http-event': 'spoofed',
      },
    });
    const event = smsEvent();
    n.deliver(event);
    await settle(n);
    assert.equal(calls[0]!.headers.Authorization, 'Bearer proxy-token');
    assert.equal(calls[0]!.headers['X-Gsm2http-Event'], event.event);
    // Header names are case-insensitive: differently cased duplicates must not be sent.
    assert.equal(new Headers(calls[0]!.headers).get('content-type'), 'application/json');
    assert.equal(new Headers(calls[0]!.headers).get('x-gsm2http-event'), event.event);
  });

  it('drops new events once maxPending deliveries are outstanding', async () => {
    const { calls, fetch } = scriptedFetch(['hang']);
    const { notifier: n, log } = notifier({ fetch, maxPending: 2, timeoutMs: 50 });
    n.deliver(smsEvent());
    n.deliver(smsEvent());
    n.deliver(smsEvent());
    assert.equal(log.list()[0]?.outcome, 'dropped');
    assert.equal(n.describe().stats.pending, 2);
    await n.close();
    assert.equal(calls.length, 2);
  });

  it('lets an in-flight request finish on close(), within the grace period', async () => {
    let release!: () => void;
    const slow = (async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const { notifier: n } = notifier({ fetch: slow });
    n.deliver(smsEvent());
    const closing = n.close();
    setTimeout(() => release(), 20);
    await closing;
    assert.equal(n.describe().stats.delivered, 1);
    assert.equal(n.describe().stats.pending, 0);
  });

  it('stops retrying after close()', async () => {
    const { calls, fetch } = scriptedFetch([500]);
    const { notifier: n } = notifier({
      fetch,
      retry: { ...FAST_RETRY, initialDelayMs: 50 },
    });
    n.deliver(smsEvent());
    await tick(10);
    await n.close();
    await tick(100);
    assert.equal(calls.length, 1);
  });

  it('describes itself without leaking the URL path, query or credentials', () => {
    const { fetch } = scriptedFetch([204]);
    const { notifier: n } = notifier({ fetch, secret: 'x' });
    assert.deepEqual(
      { ...n.describe(), stats: undefined },
      {
        name: 'test',
        type: 'webhook',
        target: 'https://hooks.example/…',
        events: ['*'],
        signed: true,
        stats: undefined,
      },
    );
    assert.equal(redactUrl('https://user:pass@n8n.example:5678/'), 'https://n8n.example:5678');
  });
});

describe('retry policy', () => {
  const policy: RetryPolicy = {
    maxAttempts: 6,
    initialDelayMs: 10_000,
    maxDelayMs: 1_800_000,
    factor: 3,
  };

  it('backs off exponentially with ±20 % jitter, capped at maxDelayMs', () => {
    const mid = () => 0.5;
    assert.deepEqual(
      [1, 2, 3, 4, 5].map((n) => retryDelay(policy, n, undefined, mid)),
      [10_000, 30_000, 90_000, 270_000, 810_000],
    );
    assert.equal(
      retryDelay(policy, 1, undefined, () => 0),
      8_000,
    );
    assert.equal(
      retryDelay(policy, 1, undefined, () => 1),
      12_000,
    );
    assert.equal(retryDelay(policy, 10, undefined, mid), 1_800_000);
  });

  it('waits for Retry-After when it is longer than the backoff, within the cap', () => {
    assert.equal(
      retryDelay(policy, 1, 60_000, () => 0.5),
      60_000,
    );
    assert.equal(
      retryDelay(policy, 1, 5_000, () => 0.5),
      10_000,
    );
    assert.equal(
      retryDelay(policy, 1, 10 * 3_600_000, () => 0.5),
      1_800_000,
    );
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-10-14T19:00:00Z');
    assert.equal(parseRetryAfter('120', now), 120_000);
    assert.equal(parseRetryAfter('Wed, 14 Oct 2026 19:01:00 GMT', now), 60_000);
    assert.equal(parseRetryAfter('soon', now), undefined);
    assert.equal(parseRetryAfter(null, now), undefined);
  });

  it('classifies statuses', () => {
    assert.deepEqual(
      [408, 425, 429, 500, 502, 503, 400, 401, 403, 404, 422].map(isRetryableStatus),
      [true, true, true, true, true, true, false, false, false, false, false],
    );
  });
});
