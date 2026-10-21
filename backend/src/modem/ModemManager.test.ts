import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { ModemManager, type ModemEntry } from './ModemManager';
import type { ModemInfo, RawLine } from './types';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ModemManager (mock mode)', () => {
  let manager: ModemManager;

  const modem = (id: string): ModemEntry => {
    const entry = manager.getModem(id);
    assert.ok(entry, `expected modem ${id}`);
    return entry;
  };

  afterEach(() => {
    manager.close();
  });

  it('starts two mock modems with distinct profiles', () => {
    manager = new ModemManager({ mockMode: true });
    const list = manager.getModemList();
    assert.equal(list.length, 2);

    const m1 = list.find((m) => m.id === 'modem-1');
    assert.ok(m1);
    assert.equal(m1.model, 'E173');
    assert.equal(m1.port, '/dev/ttyUSB0');
    assert.equal(m1.supportsVoice, true);
    assert.equal(m1.simStatus, 'READY');

    const m2 = list.find((m) => m.id === 'modem-2');
    assert.ok(m2);
    assert.equal(m2.model, 'E3531');
    assert.equal(m2.port, '/dev/ttyUSB3');
    assert.equal(m2.supportsVoice, false);
    assert.equal(m2.simStatus, 'SIM PIN');
  });

  it('tags raw lines with the modem they came from', async () => {
    manager = new ModemManager({ mockMode: true });
    const lines: RawLine[] = [];
    manager.on('raw', (line) => lines.push(line));

    modem('modem-2').stream.injectMockData('+CSQ: 21,99\r\n');
    await tick(50);

    const found = lines.find((l) => l.modemId === 'modem-2' && l.event.includes('+CSQ: 21,99'));
    assert.ok(found, 'expected a raw line tagged with modem-2');
    assert.equal(found.modemPort, '/dev/ttyUSB3');
  });

  it('does not poll SIM storage while the SIM is locked', async () => {
    manager = new ModemManager({ mockMode: true });
    const { stream } = modem('modem-2');
    assert.equal(stream.getSimStatus(), 'SIM PIN');

    let polled = false;
    stream.on('line', (line) => {
      if (line.includes('AT+CMGL')) polled = true;
    });
    stream.emit('poll');
    await tick(50);

    assert.equal(polled, false);
  });

  it('unlocks a SIM and reports the new status', async () => {
    manager = new ModemManager({ mockMode: true });
    const updates: ModemInfo[] = [];
    manager.on('status', (info) => updates.push(info));

    const { stream } = modem('modem-2');
    assert.equal(await stream.unlock('1234'), true);
    assert.equal(stream.getSimStatus(), 'READY');
    assert.ok(updates.some((s) => s.id === 'modem-2' && s.simStatus === 'READY'));
  });

  it('refuses PINs that are not 4 to 8 digits before sending anything', async () => {
    manager = new ModemManager({ mockMode: true });
    await assert.rejects(modem('modem-2').stream.unlock('12"\r\nATD1;'), /4 to 8 digits/);
  });

  it('rejects calls on modems without voice support', () => {
    manager = new ModemManager({ mockMode: true });
    const result = modem('modem-2').stream.dial('+12025550199', 100);
    assert.equal(result.success, false);
    assert.match(result.message, /does not support voice calls/);
    assert.equal(modem('modem-1').stream.dial('+12025550199', 100).success, true);
  });

  it('refuses to dial anything but digits', () => {
    manager = new ModemManager({ mockMode: true });
    const result = modem('modem-1').stream.dial('+1202;ATH', 100);
    assert.equal(result.success, false);
    assert.match(result.message, /Not a dialable number/);
  });

  it('switches network mode per modem', async () => {
    manager = new ModemManager({ mockMode: true });
    await modem('modem-2').stream.setNetworkMode('2g');
    assert.equal(modem('modem-2').stream.getInfo().networkMode, '2g');
    assert.equal(modem('modem-1').stream.getInfo().networkMode, '3g');
  });

  it('finds modems by port suffix, IMEI, model and phone number', () => {
    manager = new ModemManager({ mockMode: true });
    assert.equal(modem('ttyUSB3').stream.id, 'modem-2');
    assert.equal(modem('000000000000001').stream.id, 'modem-1');
    assert.equal(modem('e3531').stream.id, 'modem-2');
    assert.equal(modem('+1 202 555 0100').stream.id, 'modem-1');
    assert.equal(manager.getModem('nonexistent'), undefined);
  });

  it('reports a busy modem and accepts a new call once the first has finished', async () => {
    manager = new ModemManager({ mockMode: true });
    const { stream } = modem('modem-1');

    const first = stream.dial('+12025550101', 80);
    assert.equal(first.success, true);
    assert.equal(first.durationMs, 80);
    assert.equal(stream.isDialing, true);

    const second = stream.dial('+12025550102', 80);
    assert.equal(second.success, false);
    assert.equal(second.busy, true);

    const completion = await first.completion;
    assert.equal(completion?.success, true);
    assert.equal(stream.isDialing, false);

    const third = await stream.dial('+12025550103', 50).completion;
    assert.equal(third?.success, true);
  });

  it('ends a call on hangup, and replaces it when forced', async () => {
    manager = new ModemManager({ mockMode: true });
    const { stream } = modem('modem-1');

    assert.equal(stream.dial('+12025550101', 5_000).success, true);
    stream.hangup();
    assert.equal(stream.isDialing, false);

    stream.dial('+12025550101', 5_000);
    const forced = stream.dial('+12025550104', 50, { force: true });
    assert.equal(forced.success, true);
    await forced.completion;
    assert.equal(stream.isDialing, false);
  });
});
