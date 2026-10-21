import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MULTIPART_UCS2_SEGMENTS, MULTIPART_UCS2_TEXT } from '../mock/fixtures';
import {
  ATParser,
  type ParsedCallEndedEvent,
  type ParsedCallEvent,
  type ParsedSmsEvent,
} from './ATParser';
import { ModemStream } from './ModemStream';
import { PDUParser } from './PDUParser';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function mockModem(): { modem: ModemStream; parser: ATParser; close: () => void } {
  const modem = new ModemStream({ id: 'modem-1', portPath: '/dev/ttyUSB0', mockMode: true });
  const parser = new ATParser(modem);
  return {
    modem,
    parser,
    close: () => {
      parser.close();
      modem.close();
    },
  };
}

describe('ModemStream and ATParser', () => {
  it('serializes concurrent AT commands through the queue', async () => {
    const { modem, close } = mockModem();
    const [cpin, csq, creg] = await Promise.all([
      modem.sendCommand('AT+CPIN?'),
      modem.sendCommand('AT+CSQ'),
      modem.sendCommand('AT+CREG?'),
    ]);
    assert.deepEqual(cpin, ['+CPIN: READY', 'OK']);
    assert.deepEqual(csq.slice(-1), ['OK']);
    assert.ok(csq[0]?.startsWith('+CSQ:'));
    assert.deepEqual(creg, ['+CREG: 0,1', 'OK']);
    close();
  });

  it('reads an SMS announced by +CMTI and frees its SIM slot', async () => {
    const { modem, parser, close } = mockModem();
    const received: ParsedSmsEvent[] = [];
    parser.on('sms', (sms) => received.push(sms));
    const sent: string[] = [];
    modem.on('line', (line) => sent.push(line));

    modem.setMockPdu(
      '42',
      PDUParser.encodeDeliverPdu({ sender: '+12025550199', text: 'Integration test SMS' }),
    );
    modem.injectMockData('+CMTI: "SM",42\r\n');
    await tick(150);

    assert.equal(received.length, 1);
    assert.equal(received[0]?.sender, '+12025550199');
    assert.equal(received[0].text, 'Integration test SMS');
    assert.equal(received[0].modemId, 'modem-1');
    assert.ok(sent.includes('> AT+CMGD=42'), 'expected the SIM slot to be deleted');
    close();
  });

  it('emits one complete SMS for rapid +CMTI notifications of a 4-part message', async () => {
    const { modem, parser, close } = mockModem();
    const received: ParsedSmsEvent[] = [];
    parser.on('sms', (sms) => received.push(sms));

    MULTIPART_UCS2_SEGMENTS.forEach((text, i) => {
      const pdu = PDUParser.encodeDeliverPdu({
        sender: '123',
        text,
        encoding: 'ucs2',
        concat: { refNumber: 123, totalParts: 4, partIndex: i + 1 },
      });
      modem.setMockPdu(String(101 + i), pdu);
    });
    // Networks often deliver all parts within a few tens of milliseconds.
    for (let i = 0; i < 4; i++) {
      setTimeout(() => {
        modem.injectMockData(`+CMTI: "SM",${101 + i}\r\n`);
      }, i * 20);
    }
    await tick(500);

    assert.equal(received.length, 1);
    assert.equal(received[0]?.sender, '123');
    assert.equal(received[0].text, MULTIPART_UCS2_TEXT);
    close();
  });

  it('emits one call event per incoming call, however many times it rings', async () => {
    const { modem, parser, close } = mockModem();
    const calls: ParsedCallEvent[] = [];
    parser.on('call', (call) => calls.push(call));

    modem.injectMockData('RING\r\n+CLIP: "+12025550188",145,"",0,"",0\r\n');
    modem.injectMockData('RING\r\n+CLIP: "+12025550188",145,"",0,"",0\r\n');
    await tick(50);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.number, '+12025550188');
    assert.match(calls[0].callId, /^call_[0-9a-f]{32}$/);
    close();
  });

  it('ends an incoming call when the rings stop, or at once on NO CARRIER', async () => {
    const modem = new ModemStream({ id: 'modem-1', portPath: '/dev/ttyUSB0', mockMode: true });
    const parser = new ATParser(modem, undefined, { ringGapMs: 60 });
    const ended: ParsedCallEndedEvent[] = [];
    parser.on('callEnded', (call) => ended.push(call));

    modem.injectMockData('RING\r\n+CLIP: "+12025550188",145,"",0,"",0\r\n');
    await tick(30);
    modem.injectMockData('RING\r\n+CLIP: "+12025550188",145,"",0,"",0\r\n');
    await tick(30);
    assert.equal(ended.length, 0, 'the second ring kept the call alive');
    await tick(60);
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.reason, 'missed');
    assert.equal(ended[0].rings, 2);
    assert.equal(ended[0].detail, undefined, 'inferred from silence');
    assert.ok(ended[0].durationMs >= 25 && ended[0].durationMs < 60, 'measured to the last ring');

    // A withheld number, ended by the network.
    modem.injectMockData('RING\r\n+CLIP: "",128,"",0,"",0\r\n');
    await tick(10);
    modem.injectMockData('NO CARRIER\r\n');
    await tick(10);
    assert.equal(ended.length, 2);
    assert.equal(ended[1]?.number, '');
    assert.equal(ended[1].detail, 'NO CARRIER');
    parser.close();
    modem.close();
  });

  it('treats a ring from a different number as a new call', async () => {
    const { modem, parser, close } = mockModem();
    const events: string[] = [];
    parser.on('call', (c) => events.push(`call ${c.number}`));
    parser.on('callEnded', (c) => events.push(`ended ${c.number}`));
    modem.injectMockData('+CLIP: "+12025550101",145\r\n+CLIP: "+12025550102",145\r\n');
    await tick(30);
    close();
    assert.deepEqual(events, [
      'call +12025550101',
      'ended +12025550101',
      'call +12025550102',
      'ended +12025550102',
    ]);
  });

  it('processes every message returned by AT+CMGL', async () => {
    const { modem, parser, close } = mockModem();
    const received: ParsedSmsEvent[] = [];
    parser.on('sms', (sms) => received.push(sms));

    modem.setMockPdu('5', PDUParser.encodeDeliverPdu({ sender: '+12025550111', text: 'Batch 1' }));
    modem.setMockPdu('6', PDUParser.encodeDeliverPdu({ sender: '+12025550122', text: 'Batch 2' }));
    await parser.pollMessages();

    assert.deepEqual(
      received.map((s) => [s.sender, s.text]),
      [
        ['+12025550111', 'Batch 1'],
        ['+12025550122', 'Batch 2'],
      ],
    );
    close();
  });
});
