import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { createEvent } from '../events';
import type { ModemInfo } from '../modem/types';
import {
  homeAssistantDiscovery,
  MqttNotifier,
  type MqttClientLike,
  type MqttNotifierOptions,
  type MqttQos,
} from './mqtt';
import { DeliveryLog } from './types';

interface Published {
  topic: string;
  payload: string;
  qos: MqttQos;
  retain: boolean;
}

class FakeClient extends EventEmitter implements MqttClientLike {
  public connected = false;
  public readonly published: Published[] = [];
  public connectOptions: unknown;
  public failNext = false;
  public ended = false;

  publish(
    topic: string,
    payload: string,
    opts: { qos: MqttQos; retain: boolean },
    cb: (err?: Error) => void,
  ) {
    this.published.push({ topic, payload, ...opts });
    const fail = this.failNext;
    this.failNext = false;
    queueMicrotask(() => cb(fail ? new Error('broker said no') : undefined));
  }

  connectNow() {
    this.connected = true;
    this.emit('connect');
  }

  endAsync() {
    this.ended = true;
    this.connected = false;
    return Promise.resolve();
  }
}

const MODEM: ModemInfo = {
  id: 'modem-1',
  port: '/dev/ttyUSB0',
  name: 'Huawei E173 (/dev/ttyUSB0)',
  model: 'E173',
  manufacturer: 'Huawei',
  imei: '000000000000001',
  driver: 'huawei',
  capabilities: { sms: true, voice: true, ussd: false, audio: false },
  simStatus: 'READY',
  operator: 'Example Mobile',
  signalPercentage: 61,
  supportsVoice: true,
  connected: true,
  networkMode: 'auto',
};
const REF = { id: 'modem-1', port: '/dev/ttyUSB0', imei: '000000000000001' };

function setup(overrides: Partial<MqttNotifierOptions> = {}) {
  const client = new FakeClient();
  const log = new DeliveryLog();
  const notifier = new MqttNotifier({
    name: 'mqtt',
    url: 'mqtt://user:pass@broker.example:1883',
    filter: { events: ['*'] },
    topicPrefix: 'gsm2http',
    qos: 1,
    retainStatus: true,
    homeAssistant: { discovery: false, prefix: 'homeassistant' },
    log,
    connect: (_url, options) => {
      client.connectOptions = options;
      return client;
    },
    ...overrides,
  });
  return { client, notifier, log };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('MQTT notifier', () => {
  it('publishes the envelope to <prefix>/<modemId>/<family>/<action>', async () => {
    const { client, notifier, log } = setup();
    client.connectNow();
    const sms = createEvent('sms.received', REF, {
      sender: '+12025550199',
      text: 'hi',
      sentAt: '2026-10-14T19:04:12Z',
    });
    notifier.deliver(sms);
    notifier.deliver(
      createEvent('call.ended', REF, {
        callId: 'c',
        direction: 'inbound',
        number: '+1',
        reason: 'missed',
        startedAt: sms.timestamp,
        durationMs: 1,
        rings: 1,
      }),
    );
    await flush();

    const events = client.published.filter((p) => p.topic !== 'gsm2http/status');
    assert.deepEqual(
      events.map((p) => [p.topic, p.qos, p.retain]),
      [
        ['gsm2http/modem-1/sms/received', 1, false],
        ['gsm2http/modem-1/call/ended', 1, false],
      ],
    );
    assert.deepEqual(JSON.parse(events[0]!.payload), sms);
    assert.equal(notifier.describe().stats.delivered, 2);
    assert.equal(log.list()[0]?.outcome, 'delivered');
  });

  it('retains modem/status, and overwrites it with the final state on removal', async () => {
    const { client, notifier } = setup();
    client.connectNow();
    notifier.deliver(createEvent('modem.status', REF, MODEM));
    notifier.deliver(createEvent('modem.removed', REF, { ...MODEM, connected: false }));
    await flush();

    const status = client.published.filter((p) => p.topic === 'gsm2http/modem-1/modem/status');
    assert.equal(status.length, 2);
    assert.ok(status.every((p) => p.retain));
    const last = JSON.parse(status[1]!.payload) as { event: string; data: ModemInfo };
    assert.equal(last.event, 'modem.status');
    assert.equal(last.data.connected, false);
    assert.ok(
      client.published.some((p) => p.topic === 'gsm2http/modem-1/modem/removed' && !p.retain),
    );
  });

  it('announces availability with a retained online message and an offline last will', async () => {
    const { client, notifier } = setup();
    assert.deepEqual(
      (client.connectOptions as { will: { topic: string; retain: boolean } }).will.topic,
      'gsm2http/status',
    );
    client.connectNow();
    assert.deepEqual(client.published[0], {
      topic: 'gsm2http/status',
      payload: 'online',
      qos: 1,
      retain: true,
    });

    await notifier.close();
    assert.deepEqual(client.published.at(-1), {
      topic: 'gsm2http/status',
      payload: 'offline',
      qos: 1,
      retain: true,
    });
    assert.ok(client.ended);
  });

  it('counts failed publishes', async () => {
    const { client, notifier, log } = setup();
    client.connectNow();
    client.failNext = true;
    notifier.deliver(
      createEvent('sms.sent', REF, { to: '+1', text: 'x', parts: 1, messageReferences: [1] }),
    );
    await flush();
    assert.equal(notifier.describe().stats.failed, 1);
    assert.equal(log.list()[0]?.error, 'broker said no');
  });

  it('publishes Home Assistant discovery once per modem per connection, keyed on IMEI', async () => {
    const { client, notifier } = setup({
      homeAssistant: { discovery: true, prefix: 'homeassistant' },
    });
    client.connectNow();
    notifier.deliver(createEvent('modem.added', REF, MODEM));
    notifier.deliver(createEvent('modem.status', REF, { ...MODEM, signalPercentage: 70 }));
    await flush();

    const discovery = client.published.filter((p) => p.topic.startsWith('homeassistant/'));
    assert.deepEqual(
      discovery.map((p) => p.topic),
      [
        'homeassistant/sensor/gsm2http_000000000000001/signal/config',
        'homeassistant/sensor/gsm2http_000000000000001/operator/config',
        'homeassistant/sensor/gsm2http_000000000000001/sim/config',
        'homeassistant/binary_sensor/gsm2http_000000000000001/connected/config',
        'homeassistant/event/gsm2http_000000000000001/sms/config',
        'homeassistant/event/gsm2http_000000000000001/call/config',
      ],
    );
    assert.ok(discovery.every((p) => p.retain));

    // After a reconnect the broker may have lost them, so they are sent again.
    client.connectNow();
    assert.equal(client.published.filter((p) => p.topic.startsWith('homeassistant/')).length, 12);
  });

  it('builds discovery configs that read the retained status topic', () => {
    const [signal, , , connected, sms] = homeAssistantDiscovery(MODEM, { topicPrefix: 'gsm2http' });
    assert.equal(signal?.config.unique_id, 'gsm2http_000000000000001_signal');
    assert.equal(signal.config.state_topic, 'gsm2http/modem-1/modem/status');
    assert.equal(signal.config.value_template, '{{ value_json.data.signalPercentage }}');
    assert.equal(signal.config.availability_topic, 'gsm2http/status');
    assert.deepEqual(signal.config.device, {
      identifiers: ['gsm2http_000000000000001'],
      name: 'Huawei E173',
      manufacturer: 'Huawei',
      model: 'E173',
    });
    assert.equal(connected?.config.device_class, 'connectivity');
    assert.equal(sms?.config.state_topic, 'gsm2http/modem-1/sms/received');
    assert.deepEqual(sms.config.event_types, ['sms.received']);
  });

  it('hides broker credentials in its summary', () => {
    const { notifier } = setup();
    assert.equal(notifier.describe().target, 'mqtt://broker.example:1883');
    assert.equal(notifier.describe().connected, false);
  });
});
