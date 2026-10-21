import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { io as connect } from 'socket.io-client';
import { SCHEMA_VERSION, type AnyGatewayEvent, type EventType, type GatewayEvent } from './events';
import { MULTIPART_UCS2_TEXT } from './mock/fixtures';
import { ModemManager } from './modem/ModemManager';
import { DEFAULT_RETRY_POLICY } from './notifiers';
import { verifySignature } from './notifiers/signing';
import { createGateway, type Gateway } from './server';
import { TEST_TOKEN, close, listen, testConfig, tick } from './testing';

/** Polls until `check` returns a value, so tests don't depend on exact delivery timing. */
async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await tick(20);
  }
}
const SECRET = 'test-secret-0123456789abcdef';

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

interface ReceivedWebhook {
  event: AnyGatewayEvent;
  headers: http.IncomingHttpHeaders;
  validSignature: boolean;
}

describe('gateway (mock mode)', () => {
  let modems: ModemManager;
  let gateway: Gateway;
  let baseUrl: string;
  let webhookServer: http.Server;
  let webhooks: ReceivedWebhook[] = [];
  let startup: AnyGatewayEvent[] = [];

  const received = <T extends EventType>(name: T) =>
    webhooks
      .map((w) => w.event)
      .filter((e): e is GatewayEvent<T> & AnyGatewayEvent => e.event === name);

  const post = async (path: string, payload: unknown = {}): Promise<ApiResponse> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  before(async () => {
    webhookServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        webhooks.push({
          event: JSON.parse(raw) as AnyGatewayEvent,
          headers: req.headers,
          validSignature: verifySignature({
            secret: SECRET,
            body: raw,
            timestamp: req.headers['x-gsm2http-timestamp'] as string | undefined,
            signature: req.headers['x-gsm2http-signature'] as string | undefined,
          }),
        });
        res.writeHead(204).end();
      });
    });
    const url = `${await listen(webhookServer)}/hook`;

    modems = new ModemManager({ mockMode: true });
    gateway = createGateway(
      testConfig({
        notifiers: {
          modemStatusMinIntervalMs: 0,
          sinks: [
            {
              type: 'webhook',
              name: 'test',
              url,
              events: ['*'],
              secret: SECRET,
              timeoutMs: 2_000,
              retry: DEFAULT_RETRY_POLICY,
              headers: {},
            },
          ],
        },
      }),
      modems,
    );
    baseUrl = await listen(gateway.httpServer);
    await tick(100);
    startup = webhooks.map((w) => w.event);
  });

  beforeEach(() => {
    webhooks = [];
  });

  after(async () => {
    modems.close();
    await gateway.close();
    webhookServer.closeAllConnections();
    await close(webhookServer);
  });

  it('announces the mock fleet as modem.added on startup, and modem.removed on unplug', async () => {
    const added = startup.filter((e) => e.event === 'modem.added');
    assert.deepEqual(
      added.map((e) => e.modem.id),
      ['modem-1', 'modem-2'],
    );

    // A separate fleet, so unplugging does not disturb the other tests.
    const fleet = new ModemManager({ mockMode: true });
    const second = createGateway(testConfig(), fleet);
    const seen: AnyGatewayEvent[] = [];
    second.bus.subscribe((e) => seen.push(e));
    fleet.getModem('modem-1')!.stream.close();
    await tick(20);

    const removedAt = seen.findIndex((e) => e.event === 'modem.removed');
    const removed = seen[removedAt];
    assert.equal(removed?.modem.id, 'modem-1');
    assert.equal(removed.event === 'modem.removed' && removed.data.connected, false);
    assert.ok(
      !seen.slice(removedAt).some((e) => e.event === 'modem.status' && e.modem.id === 'modem-1'),
      'no status update after removal',
    );
    fleet.close();
    await second.close();
  });

  it('delivers one signed, versioned sms.received for a reassembled 4-part SMS', async () => {
    const res = await post('/api/mock/sms', { modemId: 'modem-1', testCase: 'multipart-ucs2' });
    assert.equal(res.status, 200);
    assert.equal(res.body.parts, 4);

    await waitFor(() => received('sms.received').length > 0);
    await tick(100);
    const events = received('sms.received');
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event?.schemaVersion, SCHEMA_VERSION);
    assert.match(event.id, /^evt_[0-9a-f]{32}$/);
    assert.equal(event.modem.id, 'modem-1');
    assert.equal(event.modem.imei, '000000000000001');
    assert.equal(event.modem.phoneNumber, '+12025550100');
    assert.equal(event.data.sender, '123');
    assert.equal(event.data.text, MULTIPART_UCS2_TEXT);
    assert.equal(event.data.recipientNumber, '+12025550100');
    assert.match(event.data.sentAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

    const hook = webhooks.find((w) => w.event.id === event.id)!;
    assert.equal(hook.validSignature, true);
    assert.equal(hook.headers['x-gsm2http-event'], 'sms.received');
    assert.equal(hook.headers['x-gsm2http-delivery'], event.id);
    assert.equal(hook.headers['x-gsm2http-attempt'], '1');
  });

  it('sends call.incoming once per call and call.ended when it stops ringing', async () => {
    await post('/api/mock/call', { modemId: 'modem-1', number: '+12025550188' });
    // Two more rings from the same caller, then the network reports the end.
    const stream = modems.getModem('modem-1')!.stream;
    stream.injectMockData('RING\r\n+CLIP: "+12025550188",145,"",0,"",0\r\n');
    stream.injectMockData('RING\r\n+CLIP: "+12025550188",145,"",0,"",0\r\n');
    stream.injectMockData('NO CARRIER\r\n');
    await waitFor(() => received('call.ended').length > 0);

    const incoming = received('call.incoming');
    assert.equal(incoming.length, 1);
    assert.equal(incoming[0]?.data.number, '+12025550188');
    assert.equal(incoming[0].data.direction, 'inbound');

    const ended = received('call.ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.data.callId, incoming[0].data.callId);
    assert.equal(ended[0].data.reason, 'missed');
    assert.equal(ended[0].data.rings, 3);
    assert.equal(ended[0].data.detail, 'NO CARRIER');
  });

  it('dials asynchronously, synchronously, and reports a busy modem', async () => {
    // Durations below 500 ms are raised to 500 ms.
    const async = await post('/api/modems/modem-1/dial', { to: '+12025550199', durationMs: 50 });
    assert.equal(async.status, 200);
    assert.equal(async.body.completed, false);
    assert.equal(async.body.durationMs, 500);
    assert.match(String(async.body.callId), /^call_/);
    const ended = await waitFor(() =>
      received('call.ended').find((e) => e.data.callId === async.body.callId),
    );
    assert.equal(ended.data.direction, 'outbound');
    assert.equal(ended.data.reason, 'completed');
    assert.equal(ended.data.number, '+12025550199');

    const started = Date.now();
    const sync = await post('/api/modems/modem-1/dial', {
      to: '+1 (202) 555-0199',
      durationMs: 600,
      sync: true,
    });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.completed, true);
    assert.equal(sync.body.to, '+12025550199');
    assert.ok(Date.now() - started >= 550);

    const seconds = await post('/api/modems/modem-1/dial', {
      to: '+12025550199',
      durationSeconds: 0.6,
      sync: true,
    });
    assert.equal(seconds.body.durationMs, 600);

    await post('/api/modems/modem-1/dial', { to: '+12025550199', durationMs: 1_000 });
    const busy = await post('/api/modems/modem-1/dial', { to: '+12025550198' });
    assert.equal(busy.status, 409);
    assert.equal(busy.body.busy, true);
    assert.equal(busy.body.success, false);
    const hangup = await post('/api/modems/modem-1/hangup');
    assert.equal(hangup.status, 200);
    await waitFor(() => received('call.ended').some((e) => e.data.reason === 'hangup'));
  });

  it('sends an SMS, splitting long text, emits sms.sent, and refuses a locked SIM', async () => {
    const short = await post('/api/modems/modem-1/sms', { to: '+12025550199', text: 'Hello' });
    assert.equal(short.status, 200);
    assert.equal(short.body.parts, 1);
    assert.equal(short.body.from, '+12025550100');

    const long = await post('/api/modems/modem-1/sms', {
      to: '+12025550199',
      text: 'x'.repeat(200),
    });
    assert.equal(long.status, 200);
    assert.equal(long.body.parts, 2);
    assert.equal(modems.getModem('modem-1')?.stream.simulator?.sentPdus.length, 3);

    const locked = await post('/api/modems/modem-2/sms', { to: '+12025550199', text: 'Hello' });
    assert.equal(locked.status, 409);

    const missing = await post('/api/modems/modem-1/sms', { to: '+12025550199' });
    assert.equal(missing.status, 400);

    await waitFor(() => received('sms.sent').length >= 2);
    const sent = received('sms.sent');
    assert.deepEqual(
      sent.map((e) => [e.data.to, e.data.from, e.data.parts, e.data.text.length]),
      [
        ['+12025550199', '+12025550100', 1, 5],
        ['+12025550199', '+12025550100', 2, 200],
      ],
    );
  });

  it('rejects malformed input with 400 before it reaches the modem', async () => {
    const cases: [string, unknown][] = [
      ['/api/modems/modem-1/dial', { to: '+1202;ATH' }],
      ['/api/modems/modem-1/dial', { to: '+12025550199', durationMs: -5 }],
      ['/api/modems/modem-1/dial', { to: '+12025550199', sync: 'yes' }],
      ['/api/modems/modem-2/dial', { to: '+12025550199' }],
      ['/api/modems/modem-2/unlock', { pin: '12"\r\nAT' }],
      ['/api/modems/modem-2/network', { type: '5g' }],
    ];
    for (const [path, payload] of cases) {
      const res = await post(path, payload);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(payload)}`);
      assert.equal(res.body.success, false);
      assert.equal(typeof res.body.error, 'string');
    }
  });

  it('returns 404 for unknown modems and removed routes', async () => {
    assert.equal((await post('/api/modems/modem-9/hangup')).status, 404);
    assert.equal((await post('/api/modem/dial', { to: '+12025550199' })).status, 404);
    // Sinks are configuration only; the runtime webhook setter is gone.
    assert.equal((await post('/api/config/webhook', { url: 'https://example.com/' })).status, 404);
  });

  it('lists notifiers with redacted targets and recent deliveries', async () => {
    await post('/api/mock/sms', { modemId: 'modem-1', text: 'for the delivery log' });
    await waitFor(() => received('sms.received').length > 0);
    const res = await fetch(`${baseUrl}/api/notifiers`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    const body = (await res.json()) as {
      notifiers: { name: string; target: string; signed: boolean; stats: { delivered: number } }[];
      deliveries: { notifier: string; outcome: string; event: string }[];
    };
    assert.equal(body.notifiers.length, 1);
    assert.equal(body.notifiers[0]?.name, 'test');
    assert.match(body.notifiers[0].target, /^http:\/\/127\.0\.0\.1:\d+\/…$/);
    assert.equal(body.notifiers[0].signed, true);
    assert.ok(body.notifiers[0].stats.delivered > 0);
    assert.ok(body.deliveries.some((d) => d.event === 'sms.received' && d.outcome === 'delivered'));
    assert.ok(!JSON.stringify(body).includes('for the delivery log'), 'no payloads in the log');
  });

  it('streams the modem list and the same event envelopes over Socket.io', async () => {
    const socket = connect(baseUrl, { transports: ['websocket'], auth: { token: TEST_TOKEN } });
    try {
      const list = await new Promise<unknown[]>((resolve) => socket.once('modems.list', resolve));
      assert.equal(list.length, 2);

      const sms = new Promise<AnyGatewayEvent>((resolve) => socket.once('sms.received', resolve));
      await post('/api/mock/sms', { modemId: 'modem-1', text: 'over the socket' });
      const event = await sms;
      assert.equal(event.event, 'sms.received');
      assert.equal(event.data.text, 'over the socket');

      // Webhook and socket carry the same event, with the same ID.
      await waitFor(() => received('sms.received').find((e) => e.id === event.id));
    } finally {
      socket.disconnect();
    }
  });

  it('unlocks a SIM with a valid PIN and reports the new status', async () => {
    const res = await post('/api/modems/modem-2/unlock', { pin: '1234' });
    assert.equal(res.status, 200);
    assert.equal(modems.getModem('modem-2')?.stream.getSimStatus(), 'READY');
    await waitFor(() =>
      received('modem.status').some(
        (e) => e.modem.id === 'modem-2' && e.data.simStatus === 'READY',
      ),
    );
  });
});
