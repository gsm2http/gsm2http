import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig, parseCorsOrigins, parseModemNumbers } from './config';

const TOKEN = 'a'.repeat(32);

describe('config', () => {
  it('uses documented defaults', () => {
    const config = loadConfig({ API_TOKEN: TOKEN });
    assert.equal(config.port, 9333);
    assert.equal(config.mockMode, false);
    assert.deepEqual(config.modemPorts, []);
    assert.deepEqual(config.notifiers.sinks, []);
    assert.equal(config.defaultCallDurationMs, 10_000);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.scanIntervalMs, 15_000);
    assert.equal(config.pollIntervalMs, 30_000);
    assert.equal(config.maxModems, 2);
    assert.equal(config.apiToken, TOKEN);
    assert.deepEqual(config.corsOrigins, []);
    assert.deepEqual(config.rateLimits, {
      smsMinIntervalMs: 10_000,
      smsDailyLimit: 50,
      callsHourlyLimit: 5,
      unlocksHourlyLimit: 3,
    });
  });

  it('refuses to start without API_TOKEN unless AUTH_DISABLED=true', () => {
    assert.throws(() => loadConfig({}), /API_TOKEN is required/);
    assert.throws(() => loadConfig({ API_TOKEN: '   ' }), /API_TOKEN is required/);
    assert.throws(() => loadConfig({ API_TOKEN: 'short' }), /at least 32 characters/);
    assert.throws(() => loadConfig({ AUTH_DISABLED: 'yes' }), /API_TOKEN is required/);
    assert.equal(loadConfig({ AUTH_DISABLED: 'true' }).apiToken, undefined);
  });

  it('accepts CORS origins and rejects anything that is not one', () => {
    assert.deepEqual(parseCorsOrigins('https://ha.example.lan:8123, http://localhost:5173/'), [
      'https://ha.example.lan:8123',
      'http://localhost:5173',
    ]);
    assert.deepEqual(parseCorsOrigins('*'), ['*']);
    assert.throws(() => parseCorsOrigins('ha.example.lan'), /CORS_ORIGINS/);
    assert.throws(() => parseCorsOrigins('https://ha.example.lan/path'), /CORS_ORIGINS/);
    assert.throws(() => parseCorsOrigins('file:///etc'), /CORS_ORIGINS/);
  });

  it('accepts only http(s) webhook URLs', () => {
    const env = { API_TOKEN: TOKEN };
    const [sink] = loadConfig({ ...env, WEBHOOK_URL: ' https://hooks.example/x ' }).notifiers.sinks;
    assert.equal(sink?.type === 'webhook' && sink.url, 'https://hooks.example/x');
    assert.throws(() => loadConfig({ ...env, WEBHOOK_URL: 'file:///etc/passwd' }), /WEBHOOK_URL/);
    assert.throws(() => loadConfig({ ...env, WEBHOOK_URL: 'hooks.example' }), /WEBHOOK_URL/);
  });

  it('parses rate limits, with 0 disabling one', () => {
    const limits = loadConfig({
      API_TOKEN: TOKEN,
      SMS_MIN_INTERVAL_MS: '0',
      CALLS_HOURLY_LIMIT: '2',
    }).rateLimits;
    assert.equal(limits.smsMinIntervalMs, 0);
    assert.equal(limits.callsHourlyLimit, 2);
    assert.throws(
      () => loadConfig({ API_TOKEN: TOKEN, UNLOCK_HOURLY_LIMIT: '-1' }),
      /UNLOCK_HOURLY_LIMIT/,
    );
  });

  it('parses MAX_MODEMS and rejects anything but a positive whole number', () => {
    assert.equal(loadConfig({ API_TOKEN: TOKEN, MAX_MODEMS: '4' }).maxModems, 4);
    for (const MAX_MODEMS of ['0', '-1', '1.5', 'many']) {
      assert.throws(() => loadConfig({ API_TOKEN: TOKEN, MAX_MODEMS }), /MAX_MODEMS/);
    }
  });

  it('rejects scan and poll intervals below 5 s', () => {
    assert.equal(
      loadConfig({ API_TOKEN: TOKEN, POLL_INTERVAL_MS: '60000' }).pollIntervalMs,
      60_000,
    );
    assert.throws(
      () => loadConfig({ API_TOKEN: TOKEN, POLL_INTERVAL_MS: '1000' }),
      /at least 5000 ms/,
    );
    assert.throws(
      () => loadConfig({ API_TOKEN: TOKEN, SCAN_INTERVAL_MS: 'soon' }),
      /positive integer/,
    );
  });

  it('parses explicit ports and rejects invalid numbers', () => {
    assert.deepEqual(
      loadConfig({ API_TOKEN: TOKEN, MODEM_PORTS: '/dev/ttyUSB0, /dev/ttyUSB3' }).modemPorts,
      ['/dev/ttyUSB0', '/dev/ttyUSB3'],
    );
    assert.throws(
      () => loadConfig({ API_TOKEN: TOKEN, PORT: 'abc' }),
      /PORT must be a positive integer/,
    );
  });

  it('parses MODEM_NUMBERS as JSON or key=value pairs', () => {
    assert.deepEqual(parseModemNumbers('{"000000000000001":"+12025550100"}'), {
      '000000000000001': '+12025550100',
    });
    assert.deepEqual(parseModemNumbers('E173=+12025550100, 000000000000002=+12025550101'), {
      e173: '+12025550100',
      '000000000000002': '+12025550101',
    });
  });
});
