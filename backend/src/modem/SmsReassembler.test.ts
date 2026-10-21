import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedPdu } from './PDUParser';
import { SmsReassembler, type CompleteSms } from './SmsReassembler';
import { MULTIPART_UCS2_SEGMENTS, MULTIPART_UCS2_TEXT } from '../mock/fixtures';

describe('SmsReassembler', () => {
  it('should emit single-part messages immediately', () => {
    const reassembler = new SmsReassembler();
    const received: CompleteSms[] = [];

    reassembler.on('sms', (sms) => received.push(sms));

    const singlePdu: ParsedPdu = {
      sender: '+12025550123',
      text: 'Single part test message',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: false,
    };

    reassembler.addPart(singlePdu);

    assert.equal(received.length, 1);
    assert.equal(received[0]!.sender, '+12025550123');
    assert.equal(received[0]!.text, 'Single part test message');
  });

  it('should reassemble 2-part message delivered in order (1 then 2)', () => {
    const reassembler = new SmsReassembler();
    const received: CompleteSms[] = [];
    reassembler.on('sms', (sms) => received.push(sms));

    reassembler.addPart({
      sender: '+12025550123',
      text: 'Hello ',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 50,
      totalParts: 2,
      partIndex: 1,
    });

    assert.equal(received.length, 0); // Not completed yet

    reassembler.addPart({
      sender: '+12025550123',
      text: 'world!',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 50,
      totalParts: 2,
      partIndex: 2,
    });

    assert.equal(received.length, 1);
    assert.equal(received[0]!.sender, '+12025550123');
    assert.equal(received[0]!.text, 'Hello world!');
  });

  it('should reassemble 2-part message delivered out of order (2 then 1)', () => {
    const reassembler = new SmsReassembler();
    const received: CompleteSms[] = [];
    reassembler.on('sms', (sms) => received.push(sms));

    // Deliver part 2 first
    reassembler.addPart({
      sender: '+12025550123',
      text: 'world!',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 51,
      totalParts: 2,
      partIndex: 2,
    });

    assert.equal(received.length, 0);

    // Deliver part 1 second
    reassembler.addPart({
      sender: '+12025550123',
      text: 'Hello ',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 51,
      totalParts: 2,
      partIndex: 1,
    });

    assert.equal(received.length, 1);
    assert.equal(received[0]!.text, 'Hello world!');
  });

  it('should reassemble the full 4-segment UCS-2 SMS into a single message', () => {
    const reassembler = new SmsReassembler();
    const received: CompleteSms[] = [];
    reassembler.on('sms', (sms) => received.push(sms));

    const segments = [...MULTIPART_UCS2_SEGMENTS];

    // Ingest all 4 parts
    segments.forEach((seg, i) => {
      reassembler.addPart({
        sender: '123',
        text: seg,
        timestamp: '2026-09-04T12:00:00Z',
        isMultipart: true,
        refNumber: 88,
        totalParts: 4,
        partIndex: i + 1,
      });
    });

    assert.equal(received.length, 1);
    assert.equal(received[0]!.sender, '123');
    assert.equal(received[0]!.text, MULTIPART_UCS2_TEXT);
  });

  it('should trigger fallback timeout and emit partial text when a segment is lost', async () => {
    // Set 50ms short timeout for test
    const reassembler = new SmsReassembler(50);
    const received: CompleteSms[] = [];
    reassembler.on('sms', (sms) => received.push(sms));

    // Send part 1 and 3 of 3 (part 2 is dropped by carrier)
    reassembler.addPart({
      sender: '+12025550110',
      text: 'Part one.',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 99,
      totalParts: 3,
      partIndex: 1,
    });

    reassembler.addPart({
      sender: '+12025550110',
      text: 'Part three.',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 99,
      totalParts: 3,
      partIndex: 3,
    });

    assert.equal(received.length, 0);

    // Wait for timeout to fire
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(received.length, 1);
    assert.equal(received[0]!.sender, '+12025550110');
    assert.ok(received[0]!.text.startsWith('[PARTIAL]'));
    assert.ok(received[0]!.text.includes('Part one.'));
    assert.ok(received[0]!.text.includes('missing part 2/3'));
    assert.ok(received[0]!.text.includes('Part three.'));
  });

  it('should handle interleaved concurrent multipart messages from different senders', () => {
    const reassembler = new SmsReassembler();
    const received: CompleteSms[] = [];
    reassembler.on('sms', (sms) => received.push(sms));

    // Sender A Part 1
    reassembler.addPart({
      sender: 'Alice',
      text: 'Alice 1; ',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 1,
      totalParts: 2,
      partIndex: 1,
    });

    // Sender B Part 1
    reassembler.addPart({
      sender: 'Bob',
      text: 'Bob 1; ',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 2,
      totalParts: 2,
      partIndex: 1,
    });

    // Sender A Part 2
    reassembler.addPart({
      sender: 'Alice',
      text: 'Alice 2',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 1,
      totalParts: 2,
      partIndex: 2,
    });

    // Sender A should be emitted now
    assert.equal(received.length, 1);
    assert.equal(received[0]!.sender, 'Alice');
    assert.equal(received[0]!.text, 'Alice 1; Alice 2');

    // Sender B Part 2
    reassembler.addPart({
      sender: 'Bob',
      text: 'Bob 2',
      timestamp: '2026-09-04T12:00:00Z',
      isMultipart: true,
      refNumber: 2,
      totalParts: 2,
      partIndex: 2,
    });

    assert.equal(received.length, 2);
    assert.equal(received[1]!.sender, 'Bob');
    assert.equal(received[1]!.text, 'Bob 1; Bob 2');
  });
});
