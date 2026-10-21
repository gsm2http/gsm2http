import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_WEBHOOK_EVENTS,
  interpolate,
  loadNotifiersConfig,
  parseNotifiersConfig,
  type MqttSinkConfig,
  type WebhookSinkConfig,
} from './config';
import { DEFAULT_RETRY_POLICY } from './retry';

describe('notifier config', () => {
  it('has no sinks and a 10 s status interval by default', () => {
    assert.deepEqual(parseNotifiersConfig(undefined, {}), {
      sinks: [],
      modemStatusMinIntervalMs: 10_000,
    });
  });

  it('turns a comma-separated WEBHOOK_URL into one signed sink per URL', () => {
    const { sinks } = parseNotifiersConfig(undefined, {
      WEBHOOK_URL: 'https://a.example/hook, http://b.example:8080/x',
      WEBHOOK_SECRET: 's3cret',
      WEBHOOK_EVENTS: 'sms.received,call.*',
      WEBHOOK_TIMEOUT_MS: '5000',
      WEBHOOK_MAX_ATTEMPTS: '3',
    });
    assert.deepEqual(
      sinks.map((s) => s.name),
      ['webhook-1', 'webhook-2'],
    );
    const first = sinks[0] as WebhookSinkConfig;
    assert.equal(first.url, 'https://a.example/hook');
    assert.equal(first.secret, 's3cret');
    assert.deepEqual(first.events, ['sms.received', 'call.*']);
    assert.equal(first.timeoutMs, 5_000);
    assert.equal(first.retry.maxAttempts, 3);
  });

  it('names a single env webhook "webhook" and leaves modem.status out by default', () => {
    const { sinks } = parseNotifiersConfig(undefined, { WEBHOOK_URL: 'https://a.example/hook' });
    const [sink] = sinks as WebhookSinkConfig[];
    assert.equal(sink?.name, 'webhook');
    assert.deepEqual(sink.events, DEFAULT_WEBHOOK_EVENTS);
    assert.ok(!sink.events.includes('modem.status'));
    assert.equal(sink.secret, undefined);
    assert.deepEqual(sink.retry, DEFAULT_RETRY_POLICY);
  });

  it('builds an MQTT sink from env vars', () => {
    const { sinks } = parseNotifiersConfig(undefined, {
      MQTT_URL: 'mqtt://broker.example:1883',
      MQTT_USERNAME: 'gsm2http',
      MQTT_PASSWORD: 'pw',
      MQTT_TOPIC_PREFIX: 'home/gsm/',
      MQTT_HA_DISCOVERY: 'true',
    });
    const [mqtt] = sinks as MqttSinkConfig[];
    assert.equal(mqtt?.topicPrefix, 'home/gsm');
    assert.deepEqual(mqtt.events, ['*']);
    assert.equal(mqtt.homeAssistant.discovery, true);
    assert.equal(mqtt.qos, 1);
  });

  it('reads sinks from a file, with ${VAR} interpolation and WEBHOOK_SECRET as the default secret', () => {
    const file = {
      events: { modemStatusMinIntervalMs: 0 },
      notifiers: [
        {
          type: 'webhook',
          name: 'n8n',
          url: 'https://n8n.example/webhook/${N8N_HOOK_ID}',
          events: ['sms.*'],
          modems: ['000000000000001'],
          headers: { 'X-Tenant': '${TENANT:-home}' },
          retry: { maxAttempts: 2, initialDelayMs: 1000 },
        },
        { type: 'webhook', url: 'https://other.example/', secret: 'own-secret', events: '*' },
        { type: 'webhook', url: 'https://unsigned.example/', secret: '' },
        {
          type: 'mqtt',
          url: 'mqtts://broker.example',
          password: '${MQTT_PASSWORD}',
          qos: 0,
          homeAssistant: { discovery: true },
        },
      ],
    };
    const config = parseNotifiersConfig(file, {
      N8N_HOOK_ID: 'abc123',
      WEBHOOK_SECRET: 'shared',
      MQTT_PASSWORD: 'pw',
    });
    assert.equal(config.modemStatusMinIntervalMs, 0);
    const [n8n, other, unsigned, mqtt] = config.sinks as [
      WebhookSinkConfig,
      WebhookSinkConfig,
      WebhookSinkConfig,
      MqttSinkConfig,
    ];
    assert.equal(n8n.url, 'https://n8n.example/webhook/abc123');
    assert.equal(n8n.secret, 'shared');
    assert.deepEqual(n8n.modems, ['000000000000001']);
    assert.deepEqual(n8n.headers, { 'X-Tenant': 'home' });
    assert.deepEqual(n8n.retry, { ...DEFAULT_RETRY_POLICY, maxAttempts: 2, initialDelayMs: 1000 });
    assert.equal(other.name, 'webhook-2');
    assert.equal(other.secret, 'own-secret');
    assert.deepEqual(other.events, ['*']);
    assert.equal(unsigned.secret, undefined, 'secret: "" turns signing off for that sink');
    assert.equal(mqtt.name, 'mqtt-4');
    assert.equal(mqtt.password, 'pw');
    assert.equal(mqtt.qos, 0);
    assert.equal(mqtt.homeAssistant.prefix, 'homeassistant');
  });

  it('combines file and env sinks', () => {
    const { sinks } = parseNotifiersConfig(
      { notifiers: [{ type: 'mqtt', name: 'ha', url: 'mqtt://broker.example' }] },
      { WEBHOOK_URL: 'https://a.example/hook' },
    );
    assert.deepEqual(
      sinks.map((s) => `${s.type}:${s.name}`),
      ['mqtt:ha', 'webhook:webhook'],
    );
  });

  it('fails loudly on mistakes', () => {
    const cases: [unknown, Record<string, string>, RegExp][] = [
      [
        { notifiers: [{ type: 'webhook', url: 'https://a.example/', evnets: ['*'] }] },
        {},
        /unknown setting "evnets"/,
      ],
      [
        { notifiers: [{ type: 'webhook', url: 'https://a.example/', events: ['sms.recieved'] }] },
        {},
        /unknown event "sms.recieved"/,
      ],
      [{ notifiers: [{ type: 'webhook', url: 'ftp://a.example/' }] }, {}, /notifiers\[0\]\.url/],
      [{ notifiers: [{ type: 'webhook' }] }, {}, /url: is required/],
      [{ notifiers: [{ type: 'smtp', url: 'x' }] }, {}, /"webhook" or "mqtt"/],
      [{ notifiers: [{ type: 'mqtt', url: 'mqtt://b', qos: 3 }] }, {}, /qos: must be 0, 1 or 2/],
      [{ notifiers: [{ type: 'mqtt', url: 'mqtt://b', topicPrefix: 'a/#' }] }, {}, /topic prefix/],
      [{ notifiers: [{ type: 'webhook', url: 'https://a/${MISSING}' }] }, {}, /MISSING is not set/],
      [
        { notifiers: [{ type: 'webhook', url: 'https://a.example/', retry: { maxAttempts: 0 } }] },
        {},
        /maxAttempts: must be a number ≥ 1/,
      ],
      [
        { notifiers: [{ type: 'webhook', name: 'webhook', url: 'https://a.example/' }] },
        { WEBHOOK_URL: 'https://b.example/' },
        /"webhook" is used twice/,
      ],
      [
        { notifiers: [{ type: 'mqtt', url: 'mqtt://b', password: 7123 }] },
        {},
        /password: must be a quoted string/,
      ],
      [
        { notifiers: [{ type: 'webhook', url: 'https://a.example/', headers: { 'X-Key': 42 } }] },
        {},
        /headers\.X-Key: must be a quoted string/,
      ],
      [{ notifier: [] }, {}, /unknown setting "notifier"/],
      [[], {}, /mapping at the top level/],
      [undefined, { WEBHOOK_URL: 'not a url' }, /WEBHOOK_URL/],
      [undefined, { MQTT_URL: 'http://broker' }, /MQTT_URL/],
      [
        undefined,
        { WEBHOOK_URL: 'https://a.example/', WEBHOOK_EVENTS: 'sms.*,bogus' },
        /WEBHOOK_EVENTS: unknown event "bogus"/,
      ],
      [undefined, { MODEM_STATUS_MIN_INTERVAL_MS: '-1' }, /MODEM_STATUS_MIN_INTERVAL_MS/],
    ];
    for (const [file, env, pattern] of cases) {
      assert.throws(() => parseNotifiersConfig(file, env), pattern, JSON.stringify(file ?? env));
    }
  });

  it('interpolates ${VAR}, ${VAR:-default} and keeps $${...} literal', () => {
    assert.equal(interpolate('a${X}b', { X: '1' }, 'w'), 'a1b');
    assert.equal(interpolate('${Y:-fallback}', {}, 'w'), 'fallback');
    assert.equal(interpolate('${Y:-}', {}, 'w'), '');
    assert.equal(interpolate('$${X}', { X: '1' }, 'w'), '${X}');
  });

  it('loads YAML from CONFIG_FILE', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm2http-config-'));
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(
      file,
      [
        'events:',
        '  modemStatusMinIntervalMs: 30000',
        'notifiers:',
        '  - type: webhook',
        '    name: n8n',
        '    url: https://n8n.example/webhook/${HOOK}',
        '    events: [sms.received, call.incoming]',
        '',
      ].join('\n'),
    );
    try {
      const config = loadNotifiersConfig({ CONFIG_FILE: file, HOOK: 'h1' });
      assert.equal(config.modemStatusMinIntervalMs, 30_000);
      assert.equal((config.sinks[0] as WebhookSinkConfig).url, 'https://n8n.example/webhook/h1');

      assert.throws(
        () => loadNotifiersConfig({ CONFIG_FILE: path.join(dir, 'nope.yaml') }),
        /cannot read/,
      );
      fs.writeFileSync(file, 'notifiers: [unclosed');
      assert.throws(
        () => loadNotifiersConfig({ CONFIG_FILE: file }),
        new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
