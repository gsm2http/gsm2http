import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PDUParser } from './PDUParser';
import { MULTIPART_UCS2_SEGMENTS, MULTIPART_UCS2_TEXT } from '../mock/fixtures';

describe('PDUParser', () => {
  it('should decode a standard 7-bit GSM SMS-DELIVER PDU', () => {
    // Standard GSM test vector: +44782839372, "hellohello", 2011-01-11 13:25:41 GMT+0
    const vector = '0791448720003023040B914487829373F20000111011315214000AE8329BFD4697D9EC37';
    const parsed = PDUParser.parse(vector);

    assert.equal(parsed.sender, '+44782839372');
    assert.equal(parsed.text, 'hellohello');
    assert.equal(parsed.isMultipart, false);
    assert.equal(parsed.timestamp, '2011-01-11T13:25:41+00:00');
  });

  it('should encode and decode single-part 7-bit GSM text with extended characters', () => {
    const text = 'Hello world! {test} [~] ^ | €';
    const pduHex = PDUParser.encodeDeliverPdu({
      sender: '+12025550123',
      text,
      encoding: '7bit',
    });

    const parsed = PDUParser.parse(pduHex);
    assert.equal(parsed.sender, '+12025550123');
    assert.equal(parsed.text, text);
    assert.equal(parsed.isMultipart, false);
  });

  it('should encode and decode UCS-2 single-part text with special characters', () => {
    const estonianText = 'kõneaega, tasuta jälgida oma saldot. ÕÄÖÜõäöü';
    const pduHex = PDUParser.encodeDeliverPdu({
      sender: '+12025550176',
      text: estonianText,
    });

    const parsed = PDUParser.parse(pduHex);
    assert.equal(parsed.sender, '+12025550176');
    assert.equal(parsed.text, estonianText);
    assert.equal(parsed.isMultipart, false);
  });

  it('should decode alphanumeric senders correctly', () => {
    const pduHex = PDUParser.encodeDeliverPdu({
      sender: 'SUPER',
      text: 'Tere tulemast!',
      encoding: '7bit',
    });

    const parsed = PDUParser.parse(pduHex);
    assert.equal(parsed.sender, 'SUPER');
    assert.equal(parsed.text, 'Tere tulemast!');
  });

  it('should decode real-world Telegram alphanumeric sender with 14 semi-octets', () => {
    const pduHex = PDUParser.encodeDeliverPdu({
      sender: 'Telegram',
      text: 'Telegram code: 54321',
      encoding: '7bit',
    });

    const parsed = PDUParser.parse(pduHex);
    assert.equal(parsed.sender, 'Telegram');
    assert.equal(parsed.text, 'Telegram code: 54321');
    assert.ok(!parsed.timestamp.includes('NaN'));
    assert.ok(!isNaN(Date.parse(parsed.timestamp)));
  });

  it('should decode shortcode alphanumeric or numeric sender like 123', () => {
    const pduHex = PDUParser.encodeDeliverPdu({
      sender: '123',
      text: 'Teie saldo on 10 EUR',
    });

    const parsed = PDUParser.parse(pduHex);
    assert.equal(parsed.sender, '123');
    assert.equal(parsed.text, 'Teie saldo on 10 EUR');
  });

  it('should decode 2-part concatenated UCS-2 message (IEI 0x00 8-bit ref)', () => {
    const part1Text = 'Esimese osa tekst kõneaega ';
    const part2Text = 'ja teise osa tekst saldot.';

    const pdu1 = PDUParser.encodeDeliverPdu({
      sender: '+12025550123',
      text: part1Text,
      concat: { refNumber: 77, totalParts: 2, partIndex: 1 },
    });

    const pdu2 = PDUParser.encodeDeliverPdu({
      sender: '+12025550123',
      text: part2Text,
      concat: { refNumber: 77, totalParts: 2, partIndex: 2 },
    });

    const parsed1 = PDUParser.parse(pdu1);
    const parsed2 = PDUParser.parse(pdu2);

    assert.equal(parsed1.isMultipart, true);
    assert.equal(parsed1.refNumber, 77);
    assert.equal(parsed1.totalParts, 2);
    assert.equal(parsed1.partIndex, 1);
    assert.equal(parsed1.text, part1Text);

    assert.equal(parsed2.isMultipart, true);
    assert.equal(parsed2.refNumber, 77);
    assert.equal(parsed2.totalParts, 2);
    assert.equal(parsed2.partIndex, 2);
    assert.equal(parsed2.text, part2Text);
  });

  it('should decode 16-bit concatenated message (IEI 0x08)', () => {
    const text = 'Part with 16-bit concatenation reference';
    const pdu = PDUParser.encodeDeliverPdu({
      sender: '+12025550123',
      text,
      concat: { refNumber: 54321, totalParts: 3, partIndex: 2, is16Bit: true },
    });

    const parsed = PDUParser.parse(pdu);
    assert.equal(parsed.isMultipart, true);
    assert.equal(parsed.refNumber, 54321);
    assert.equal(parsed.totalParts, 3);
    assert.equal(parsed.partIndex, 2);
    assert.equal(parsed.text, text);
  });

  it('should accurately decode the 4-segment UCS-2 SMS fragments with 67-character UCS-2 boundary', () => {
    const segments = [...MULTIPART_UCS2_SEGMENTS];

    // Verify fragment 2 length is exactly 67 characters (3GPP TS 23.040 134 octets / 2)
    assert.equal(segments[1]!.length, 67);

    const ref = 202;
    const parsedSegments = segments.map((seg, i) => {
      const pdu = PDUParser.encodeDeliverPdu({
        sender: '123',
        text: seg,
        encoding: 'ucs2',
        concat: { refNumber: ref, totalParts: 4, partIndex: i + 1 },
      });
      return PDUParser.parse(pdu);
    });

    assert.equal(parsedSegments.length, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(parsedSegments[i]!.sender, '123');
      assert.equal(parsedSegments[i]!.isMultipart, true);
      assert.equal(parsedSegments[i]!.refNumber, ref);
      assert.equal(parsedSegments[i]!.totalParts, 4);
      assert.equal(parsedSegments[i]!.partIndex, i + 1);
      assert.equal(parsedSegments[i]!.text, segments[i]);
    }

    // When combined, the split words are whole
    const fullText = parsedSegments.map((s) => s.text).join('');
    assert.equal(fullText, MULTIPART_UCS2_TEXT);
  });

  it('should throw descriptive error on invalid or truncated PDU hex', () => {
    assert.throws(() => {
      PDUParser.parse('');
    }, /PDU too short/);

    assert.throws(() => {
      PDUParser.parse('00');
    }, /PDU too short/);
  });
});
