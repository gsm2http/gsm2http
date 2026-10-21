import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { io as connect } from 'socket.io-client';
import { ModemManager } from './modem/ModemManager';
import { createGateway, type Gateway, type ServerConfig } from './server';
import { TEST_TOKEN, listen, testConfig } from './testing';

interface Harness {
  modems: ModemManager;
  gateway: Gateway;
  baseUrl: string;
  close(): Promise<void>;
}

async function start(overrides: Partial<ServerConfig> = {}): Promise<Harness> {
  const modems = new ModemManager({ mockMode: true });
  const gateway = createGateway(testConfig(overrides), modems);
  const baseUrl = await listen(gateway.httpServer);
  return {
    modems,
    gateway,
    baseUrl,
    close: async () => {
      modems.close();
      await gateway.close();
    },
  };
}

function request(
  h: Harness,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
) {
  const { method = init.body === undefined ? 'GET' : 'POST', token = TEST_TOKEN } = init;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init.headers };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${h.baseUrl}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function connectSocket(h: Harness, auth: Record<string, unknown>): Promise<string> {
  const socket = connect(h.baseUrl, { transports: ['websocket'], auth, reconnection: false });
  return new Promise((resolve) => {
    socket.once('connect', () => {
      socket.disconnect();
      resolve('connected');
    });
    socket.once('connect_error', (err) => {
      socket.disconnect();
      resolve(err.message);
    });
  });
}

describe('authentication', () => {
  let h: Harness;
  before(async () => (h = await start()));
  after(() => h.close());

  it('rejects API requests without a valid bearer token', async () => {
    for (const token of [null, '', 'wrong-token-0123456789abcdef', `${TEST_TOKEN}x`]) {
      const res = await request(h, '/api/modems', { token });
      assert.equal(res.status, 401, String(token));
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      assert.equal((await json(res)).success, false);
    }
    const sms = await request(h, '/api/modems/modem-1/sms', {
      token: null,
      body: { to: '+12025550199', text: 'hi' },
    });
    assert.equal(sms.status, 401);
    assert.equal(h.modems.getModem('modem-1')?.stream.simulator?.sentPdus.length, 0);
  });

  it('accepts the token and leaves /healthz open for container health checks', async () => {
    assert.equal((await request(h, '/api/modems')).status, 200);
    assert.equal((await request(h, '/healthz', { token: null })).status, 200);
  });

  it('rejects Socket.io connections without the token', async () => {
    assert.equal(await connectSocket(h, {}), 'unauthorized');
    assert.equal(await connectSocket(h, { token: 'nope' }), 'unauthorized');
    assert.equal(await connectSocket(h, { token: TEST_TOKEN }), 'connected');
  });

  it('reports auth as enabled to the UI', async () => {
    assert.equal((await json(await request(h, '/api/config'))).authEnabled, true);
  });
});

describe('authentication brute force', () => {
  let h: Harness;
  before(async () => (h = await start()));
  after(() => h.close());

  it('locks out further guesses but still accepts the right token', async () => {
    for (let i = 0; i < 20; i++) {
      assert.equal((await request(h, '/api/modems', { token: `guess-${i}` })).status, 401);
    }
    const locked = await request(h, '/api/modems', { token: 'guess-again' });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.equal(await connectSocket(h, { token: 'guess-again' }), 'rate_limited');

    // Behind a reverse proxy every client shares one address; a guesser must not lock
    // out the UI and automations that hold the real token.
    assert.equal((await request(h, '/api/modems')).status, 200);
    assert.equal(await connectSocket(h, { token: TEST_TOKEN }), 'connected');
  });
});

describe('AUTH_DISABLED', () => {
  let h: Harness;
  before(async () => (h = await start({ apiToken: undefined })));
  after(() => h.close());

  it('serves the API and socket without a token only when explicitly disabled', async () => {
    assert.equal((await request(h, '/api/modems', { token: null })).status, 200);
    assert.equal(await connectSocket(h, {}), 'connected');
  });
});

describe('CORS', () => {
  it('sends no CORS headers by default (same origin only)', async () => {
    const h = await start();
    try {
      const res = await request(h, '/api/modems', { headers: { Origin: 'http://evil.example' } });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      const preflight = await request(h, '/api/modems', {
        method: 'OPTIONS',
        token: null,
        headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    } finally {
      await h.close();
    }
  });

  it('allows only the listed origins', async () => {
    const h = await start({ corsOrigins: ['http://ui.example.lan:8080'] });
    try {
      const allowed = await request(h, '/api/modems', {
        method: 'OPTIONS',
        token: null,
        headers: {
          Origin: 'http://ui.example.lan:8080',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      });
      assert.equal(allowed.status, 204);
      assert.equal(
        allowed.headers.get('access-control-allow-origin'),
        'http://ui.example.lan:8080',
      );
      assert.match(allowed.headers.get('access-control-allow-headers') ?? '', /Authorization/);

      const other = await request(h, '/api/modems', { headers: { Origin: 'http://evil.example' } });
      assert.equal(other.headers.get('access-control-allow-origin'), null);
    } finally {
      await h.close();
    }
  });
});

describe('HTTP hardening', () => {
  let h: Harness;
  before(async () => (h = await start()));
  after(() => h.close());

  it('sets security headers', async () => {
    const res = await request(h, '/healthz', { token: null });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('x-powered-by'), null);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  });

  it('rejects oversized bodies with a plain JSON error', async () => {
    const res = await request(h, '/api/modems/modem-1/sms', {
      body: { to: '+12025550199', text: 'x'.repeat(64 * 1024) },
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await json(res), { success: false, error: 'Request body is too large' });
  });

  it('never leaks stack traces or parser internals', async () => {
    const res = await fetch(`${h.baseUrl}/api/modems/modem-1/sms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: '{"to": "+1202',
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.doesNotMatch(text, /\bat \w|node_modules|SyntaxError|stack/);
    assert.deepEqual(JSON.parse(text), { success: false, error: 'Request body is not valid JSON' });
  });
});

describe('/api/mock', () => {
  it('does not exist unless MOCK_MODE is on', async () => {
    const h = await start({ mockMode: false });
    try {
      const res = await request(h, '/api/mock/sms', { body: { text: 'hi' } });
      assert.equal(res.status, 404);
    } finally {
      await h.close();
    }
  });
});

describe('AT command injection over the API', () => {
  let h: Harness;
  before(async () => (h = await start()));
  after(() => h.close());

  const NUMBERS = [
    '+12025550199;+CFUN=0',
    '+12025550199\r\nAT+CFUN=0',
    '+12025550199\nATZ',
    '+1202555\t0199',
    '+12025550199\x1A',
    '12025550199,',
    '+1-202-555-0199;',
    '*#06#',
    'ATD112',
  ];

  it('rejects injected phone numbers on dial and SMS before they reach the modem', async () => {
    const simulator = h.modems.getModem('modem-1')?.stream.simulator;
    assert.ok(simulator);
    simulator.port.received.length = 0;

    for (const to of NUMBERS) {
      const dial = await request(h, '/api/modems/modem-1/dial', { body: { to } });
      assert.equal(dial.status, 400, `dial ${JSON.stringify(to)}`);
      const sms = await request(h, '/api/modems/modem-1/sms', { body: { to, text: 'hi' } });
      assert.equal(sms.status, 400, `sms ${JSON.stringify(to)}`);
    }
    // Startup commands (AT+CFUN=1 ...) may still be arriving; none of ours may.
    assert.deepEqual(
      simulator.port.received.filter((c) => /^ATD|^AT\+CMGS|CFUN=0|ATZ/.test(c)),
      [],
    );
  });

  it('rejects injected SIM PINs', async () => {
    const simulator = h.modems.getModem('modem-2')?.stream.simulator;
    for (const pin of ['1234"\r\nAT+CFUN=0', '1234;+CFUN=0', '1234\x1A', '12 34', '123', 1234]) {
      const res = await request(h, '/api/modems/modem-2/unlock', { body: { pin } });
      assert.equal(res.status, 400, JSON.stringify(pin));
    }
    assert.deepEqual(simulator?.pinAttempts, []);
  });

  it('rejects control characters in SMS text but keeps line breaks', async () => {
    for (const text of ['hi\x1AAT+CFUN=0', 'hi\x1B', 'nul\x00', 'bell\x07']) {
      const res = await request(h, '/api/modems/modem-1/sms', {
        body: { to: '+12025550199', text },
      });
      assert.equal(res.status, 400, JSON.stringify(text));
    }
    const ok = await request(h, '/api/modems/modem-1/sms', {
      body: { to: '+12025550199', text: 'line one\nline two\r\nline three' },
    });
    assert.equal(ok.status, 200);
  });

  it('rejects malformed modem ids and mock PDUs', async () => {
    for (const id of ['modem-1;ATZ', 'modem-1\r\nATZ', 'modem 1', 'x'.repeat(129)]) {
      const res = await request(h, `/api/modems/${encodeURIComponent(id)}/hangup`, { body: {} });
      assert.equal(res.status, 400, JSON.stringify(id));
    }
    const mockId = await request(h, '/api/mock/call', { body: { modemId: 'modem-1\nATZ' } });
    assert.equal(mockId.status, 400);
    for (const pdu of ['00\x1A', '0G', '001', 'AB'.repeat(200)]) {
      const res = await request(h, '/api/mock/sms', { body: { modemId: 'modem-1', pdu } });
      assert.equal(res.status, 400, pdu.slice(0, 10));
    }
  });
});

describe('rate limits', () => {
  let h: Harness;
  before(
    async () =>
      (h = await start({
        rateLimits: {
          smsMinIntervalMs: 0,
          smsDailyLimit: 2,
          callsHourlyLimit: 1,
          unlocksHourlyLimit: 1,
        },
      })),
  );
  after(() => h.close());

  it('enforces a minimum gap between SMS', async () => {
    const g = await start({
      rateLimits: {
        smsMinIntervalMs: 60_000,
        smsDailyLimit: 0,
        callsHourlyLimit: 0,
        unlocksHourlyLimit: 0,
      },
    });
    try {
      const send = () =>
        request(g, '/api/modems/modem-1/sms', { body: { to: '+12025550199', text: 'hi' } });
      assert.equal((await send()).status, 200);
      assert.equal((await send()).status, 429);
    } finally {
      await g.close();
    }
  });

  it('limits SMS per modem per day', async () => {
    const send = () =>
      request(h, '/api/modems/modem-1/sms', { body: { to: '+12025550199', text: 'hi' } });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const limited = await send();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal((await json(limited)).success, false);
  });

  it('limits dials and unlocks', async () => {
    const dial = () =>
      request(h, '/api/modems/modem-1/dial', { body: { to: '+12025550199', durationMs: 500 } });
    assert.equal((await dial()).status, 200);
    await request(h, '/api/modems/modem-1/hangup', { body: {} });
    assert.equal((await dial()).status, 429);

    const unlock = () => request(h, '/api/modems/modem-2/unlock', { body: { pin: '1234' } });
    assert.equal((await unlock()).status, 200);
    assert.equal((await unlock()).status, 429);
  });

  it('does not count requests that fail validation', async () => {
    const res = await request(h, '/api/modems/modem-2/sms', { body: { to: 'bad', text: 'hi' } });
    assert.equal(res.status, 400);
  });
});

describe('webhook configuration over the API', () => {
  it('does not exist: sinks are configuration only, even with a valid token', async () => {
    const h = await start();
    try {
      const res = await request(h, '/api/config/webhook', {
        body: { url: 'https://attacker.example/collect' },
      });
      assert.equal(res.status, 404);
    } finally {
      await h.close();
    }
  });
});
