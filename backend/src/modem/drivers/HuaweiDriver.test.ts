import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ModemStream } from '../ModemStream';
import { GenericDriver } from './GenericDriver';
import { HUAWEI_PROFILE, startModem, waitFor } from './testUtils';

describe('HuaweiDriver (on a simulated Huawei stick)', () => {
  let stream: ModemStream | null = null;

  afterEach(() => {
    stream?.removeAllListeners();
    stream?.close();
    stream = null;
  });

  it('adds ^CURC=0 to the init sequence right after CFUN', async () => {
    const m = await startModem({ ...HUAWEI_PROFILE, simStatus: 'SIM PIN' });
    stream = m.stream;
    assert.equal(stream.driver.name, 'huawei');

    await stream.unlock('1234');
    const init = m.port.received.filter((c) => /^AT(\+CFUN|\^CURC|\+CPMS|\+CMGF|\+CNMI)/.test(c));
    assert.deepEqual(init, [
      'AT+CFUN=1',
      'AT^CURC=0',
      'AT+CPMS="SM","SM","SM"',
      'AT+CMGF=0',
      'AT+CNMI=2,1,0,0,0',
    ]);
  });

  it('reports voice + audio for an E173 and SMS-only for an E3372', async () => {
    const e173 = await startModem(HUAWEI_PROFILE);
    stream = e173.stream;
    assert.deepEqual(stream.getInfo().capabilities, {
      sms: true,
      voice: true,
      ussd: true,
      audio: true,
    });
    stream.removeAllListeners();
    stream.close();

    // Known SMS-only model: the quirk table wins even if ^CVOICE answers
    const e3372 = await startModem({ ...HUAWEI_PROFILE, model: 'E3372', voice: true, lte: true });
    stream = e3372.stream;
    assert.equal(stream.getInfo().supportsVoice, false);
  });

  it('probes ^CVOICE for models it does not know', async () => {
    const withVoice = await startModem({ ...HUAWEI_PROFILE, model: 'E1550', voice: true });
    stream = withVoice.stream;
    assert.equal(stream.supportsVoice, true);
    stream.removeAllListeners();
    stream.close();

    const withoutVoice = await startModem({ ...HUAWEI_PROFILE, model: 'E1550', voice: false });
    stream = withoutVoice.stream;
    assert.equal(stream.supportsVoice, false);
  });

  it('treats ^RSSI / ^MODE as URCs and tracks signal and access technology from them', async () => {
    const m = await startModem(HUAWEI_PROFILE);
    stream = m.stream;
    const urcs: string[] = [];
    stream.on('urc', (l) => urcs.push(l));

    // Arrives in the middle of a command response and must not be mixed into it
    m.port.onCommand('AT+CREG?', null);
    const pending = stream.sendCommand('AT+CREG?', 1000);
    await waitFor(() => m.port.received.includes('AT+CREG?'), 500, 'CREG sent');
    m.port.inject('\r\n^RSSI: 12\r\n\r\n^MODE: 5,4\r\n\r\n+CREG: 0,1\r\n\r\nOK\r\n');

    assert.deepEqual(await pending, ['+CREG: 0,1', 'OK']);
    assert.deepEqual(urcs, ['^RSSI: 12', '^MODE: 5,4']);
    assert.equal(stream.signalStrength, 12);
    assert.equal(stream.getInfo().accessTechnology, 'WCDMA');
  });

  it('accepts COMMAND NOT SUPPORT as a final response', async () => {
    const m = await startModem(HUAWEI_PROFILE);
    stream = m.stream;
    assert.deepEqual(await stream.sendCommand('AT^FOO', 500), ['COMMAND NOT SUPPORT']);
  });

  it('ends an outgoing call on ^CEND', async () => {
    const m = await startModem(HUAWEI_PROFILE);
    stream = m.stream;

    const result = stream.dial('+15555550100', 5000);
    assert.equal(result.success, true);
    await waitFor(() => m.port.received.includes('ATD+15555550100;'), 500, 'ATD');

    m.port.inject('\r\n^CEND:1,0,104,16\r\n');
    const done = await result.completion!;
    assert.match(done.message, /\^CEND/);
    assert.equal(stream.isDialing, false);
  });

  it('uses ^SYSCFG for 3G sticks, ^SYSCFGEX for LTE sticks, and falls back for unknown models', async () => {
    const e173 = await startModem(HUAWEI_PROFILE);
    stream = e173.stream;
    await stream.setNetworkMode('2g');
    assert.deepEqual(
      e173.port.received.filter((c) => c.startsWith('AT^SYSCFG')),
      ['AT^SYSCFG=13,1,3FFFFFFF,2,4'],
    );
    stream.removeAllListeners();
    stream.close();

    const e3372 = await startModem({ ...HUAWEI_PROFILE, model: 'E3372', lte: true, voice: false });
    stream = e3372.stream;
    await stream.setNetworkMode('auto');
    assert.deepEqual(
      e3372.port.received.filter((c) => c.startsWith('AT^SYSCFG')),
      ['AT^SYSCFGEX="00",3FFFFFFF,1,2,7FFFFFFFFFFFFFFF,,'],
    );
    stream.removeAllListeners();
    stream.close();

    const unknown = await startModem({ ...HUAWEI_PROFILE, model: 'E1550', lte: false });
    stream = unknown.stream;
    await stream.setNetworkMode('3g');
    assert.deepEqual(
      unknown.port.received.filter((c) => c.startsWith('AT^SYSCFG')),
      ['AT^SYSCFGEX="02",3FFFFFFF,1,2,7FFFFFFFFFFFFFFF,,', 'AT^SYSCFG=14,2,3FFFFFFF,2,4'],
    );
  });

  it('can be overridden with the generic driver for the same hardware', async () => {
    const m = await startModem(HUAWEI_PROFILE, new GenericDriver());
    stream = m.stream;
    assert.equal(stream.getInfo().driver, 'generic');
    assert.equal(stream.supportsVoice, false);

    await stream.setNetworkMode('3g');
    assert.ok(!m.port.received.some((c) => c.startsWith('AT^')));
  });
});
