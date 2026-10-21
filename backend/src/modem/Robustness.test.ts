import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GenericDriver } from './drivers';
import { expandGlob, ModemManager } from './ModemManager';
import { MAX_QUEUE_LENGTH, ModemStream } from './ModemStream';
import { FakeSerialPort } from './transport/FakeSerialPort';
import { LineSplitter } from './transport/ModemTransport';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A modem that never answers, so the first startup command stays in flight. */
function silentModem(): ModemStream {
  return new ModemStream({
    id: 'silent',
    portPath: '/dev/ttyFAKE9',
    transport: new FakeSerialPort({ fallback: null }),
    driver: new GenericDriver(),
  });
}

describe('Runtime robustness', () => {
  it('splits CRLF lines across chunk boundaries', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push('+CSQ: 2');
    splitter.push('1,99\r\nOK\r');
    splitter.push('\n');
    assert.deepEqual(lines, ['+CSQ: 21,99', 'OK']);
  });

  it('drops an oversized partial line instead of buffering it forever', () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line), undefined, 64);
    for (let i = 0; i < 100; i++) splitter.push('U'.repeat(32));
    assert.ok(splitter.droppedBytes > 0);
    splitter.push('\r\nOK\r\n');
    assert.equal(lines.at(-1), 'OK');
  });

  it('rejects commands once the per-port queue is full', async () => {
    const stream = silentModem();
    assert.equal(stream.getQueueLength(), 1, 'the startup AT+CPIN? is in flight');

    const queued = Array.from({ length: MAX_QUEUE_LENGTH }, () =>
      stream.sendCommand('AT+CSQ').catch(() => []),
    );
    await assert.rejects(stream.sendCommand('AT+CSQ'), /queue full/);

    stream.close();
    await Promise.all(queued);
    assert.equal(stream.getQueueLength(), 0);
  });

  it('rejects queued commands when the modem is closed', async () => {
    const stream = silentModem();
    const queued = stream.sendCommand('AT+COPS?');
    stream.close();
    await assert.rejects(queued, /closed/);
  });

  it('keeps modem IDs stable across an unplug and never gives one to another stick', async () => {
    const manager = new ModemManager({ mockMode: true });
    try {
      const modem1 = manager.getModem('modem-1');
      assert.ok(modem1);
      const imei = modem1.stream.imei;
      modem1.stream.close();
      for (let i = 0; i < 50 && manager.getModem('modem-1'); i++) await tick(10);
      assert.equal(manager.getModem('modem-1'), undefined);

      // modem-2 is connected and modem-1 is remembered for its IMEI.
      assert.equal(manager.allocateModemId('999999999999999'), 'modem-3');
      assert.equal(manager.allocateModemId(imei), 'modem-1');
    } finally {
      manager.close();
    }
  });

  it('expands * in explicit port paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsm2http-ports-'));
    try {
      for (const name of ['usb-HUAWEI_E173-if00-port0', 'usb-HUAWEI_E173-if02-port0', 'other']) {
        fs.writeFileSync(path.join(dir, name), '');
      }
      assert.deepEqual(expandGlob(path.join(dir, 'usb-HUAWEI_*-if0?-port0')), []);
      assert.deepEqual(
        expandGlob(path.join(dir, 'usb-HUAWEI_*-port0')).map((p) => path.basename(p)),
        ['usb-HUAWEI_E173-if00-port0', 'usb-HUAWEI_E173-if02-port0'],
      );
      assert.deepEqual(expandGlob(path.join(dir, 'missing')), []);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
