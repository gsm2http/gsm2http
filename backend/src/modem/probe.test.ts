import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { probeModem } from './probe';
import { ModemManager } from './ModemManager';
import { SimulatedModem } from './mock/SimulatedModem';
import { FakeSerialPort } from './transport/FakeSerialPort';
import { GENERIC_PROFILE, HUAWEI_PROFILE, waitFor } from './drivers/testUtils';

describe('Port probe', () => {
  it('reads the vendor-neutral identity of an AT modem', async () => {
    const sim = new SimulatedModem({
      ...HUAWEI_PROFILE,
      revision: '21.158.00.00.143',
      simStatus: 'SIM PIN',
    });
    const result = await probeModem(sim.port, { settleMs: 0 });

    assert.deepEqual(result, {
      identity: { manufacturer: 'huawei', model: 'E173', revision: '21.158.00.00.143' },
      imei: '860000000000101',
      simStatus: 'SIM PIN',
    });
    assert.deepEqual(sim.port.received, [
      'ATE0',
      'AT',
      'AT+CGMI',
      'AT+CGMM',
      'AT+CGMR',
      'AT+CGSN',
      'AT+CPIN?',
    ]);
  });

  it('strips "+CGMM:" style prefixes some firmware adds', async () => {
    const port = new FakeSerialPort({
      rules: [
        { match: 'AT+CGMI', reply: ['+CGMI: "Quectel"', 'OK'] },
        { match: 'AT+CGMM', reply: ['+CGMM: "EC25"', 'OK'] },
        { match: 'AT+CGSN', reply: ['+CGSN: "867000000000001"', 'OK'] },
        { match: 'AT+CPIN?', reply: ['+CPIN: READY', 'OK'] },
      ],
    });
    const result = await probeModem(port, { settleMs: 0 });
    assert.ok(result);
    assert.equal(result.identity.manufacturer, 'Quectel');
    assert.equal(result.identity.model, 'EC25');
    assert.equal(result.imei, '867000000000001');
  });

  it('rejects ports that do not speak AT', async () => {
    const silent = new FakeSerialPort({ fallback: null });
    assert.equal(await probeModem(silent, { settleMs: 0, commandTimeoutMs: 30 }), null);
  });
});

describe('ModemManager driver selection', () => {
  let manager: ModemManager | null = null;

  afterEach(() => {
    manager?.close();
    manager = null;
  });

  it('runs the default mock fleet through the Huawei driver', async () => {
    manager = new ModemManager({ mockMode: true });
    const list = manager.getModemList();
    assert.deepEqual(
      list.map((m) => m.driver),
      ['huawei', 'huawei'],
    );

    const m1 = manager.getModem('modem-1')!;
    await waitFor(() => m1.stream.getInfo().capabilities.audio, 2000, 'modem-1 startup');
    assert.ok(m1.stream.simulator!.port.received.includes('AT^CURC=0'));
  });

  it('mixes vendors in one fleet and applies MODEM_DRIVER-style overrides per port', async () => {
    manager = new ModemManager({
      mockMode: true,
      driverOverrides: { ttyUSB9: 'generic' },
      mockFleet: [
        { id: 'modem-1', name: 'ACME', portPath: '/dev/ttyUSB7', profile: GENERIC_PROFILE },
        { id: 'modem-2', name: 'Huawei', portPath: '/dev/ttyUSB8', profile: HUAWEI_PROFILE },
        {
          id: 'modem-3',
          name: 'Huawei forced generic',
          portPath: '/dev/ttyUSB9',
          profile: HUAWEI_PROFILE,
        },
      ],
    });
    assert.deepEqual(
      manager.getModemList().map((m) => m.driver),
      ['generic', 'huawei', 'generic'],
    );

    const acme = manager.getModem('modem-1')!;
    await waitFor(() => acme.stream.operatorName === 'Test Net', 2000, 'startup');
    const result = await acme.stream.sendSms('+15555550100', 'hello from the mock fleet');
    assert.equal(result.parts, 1);
    assert.equal(acme.stream.simulator!.sentPdus.length, 1);
  });
});
