import { PDUParser } from '../modem/PDUParser';
import type { ModemStream } from '../modem/ModemStream';
import { MULTIPART_UCS2_SEGMENTS, MULTIPART_UCS2_SENDER } from './fixtures';

/** Stagger between parts, like a network delivering a long message. */
const PART_INTERVAL_MS = 40;

export type MockSmsRequest =
  | { kind: 'testCase'; testCase: 'multipart-ucs2' }
  | { kind: 'pdus'; pdus: string[] }
  | { kind: 'text'; sender: string; text: string; multipart: boolean };

export interface MockSmsResult {
  parts: number;
  indices: string[];
}

/**
 * Stores SMS in a mock modem's SIM and announces each with +CMTI, so they travel the same
 * read → decode → reassemble → delete path as on real hardware.
 */
export function injectMockSms(stream: ModemStream, request: MockSmsRequest): MockSmsResult {
  const pdus = buildPdus(request);
  const indices = pdus.map((pdu, i) => {
    const index = nextSimIndex();
    stream.setMockPdu(index, pdu);
    setTimeout(() => {
      stream.injectMockData(`+CMTI: "SM",${index}\r\n`);
    }, i * PART_INTERVAL_MS);
    return index;
  });
  return { parts: pdus.length, indices };
}

export function injectMockCall(stream: ModemStream, caller: string): void {
  stream.injectMockData(`RING\r\n+CLIP: "${caller}",145,"",0,"",0\r\n`);
}

function buildPdus(request: MockSmsRequest): string[] {
  switch (request.kind) {
    case 'testCase':
      return encodeConcatenated(MULTIPART_UCS2_SENDER, [...MULTIPART_UCS2_SEGMENTS], 'ucs2');
    case 'pdus':
      return request.pdus;
    case 'text': {
      const { sender, text, multipart } = request;
      // Single-part limits are 160 GSM 7-bit or 70 UCS-2 characters; with a concatenation
      // header each part holds 153 or 67.
      const ucs2 = /[^\x20-\x7E]/.test(text);
      const segmentLength = ucs2 ? 67 : 153;
      const needsSplit = multipart || text.length > (ucs2 ? 70 : 160);
      if (!needsSplit || text.length <= segmentLength) {
        return [PDUParser.encodeDeliverPdu({ sender, text })];
      }
      const segments: string[] = [];
      for (let i = 0; i < text.length; i += segmentLength) {
        segments.push(text.slice(i, i + segmentLength));
      }
      return encodeConcatenated(sender, segments);
    }
  }
}

function encodeConcatenated(sender: string, segments: string[], encoding?: 'ucs2'): string[] {
  const refNumber = Math.floor(Math.random() * 255) + 1;
  return segments.map((text, i) =>
    PDUParser.encodeDeliverPdu({
      sender,
      text,
      encoding,
      concat: { refNumber, totalParts: segments.length, partIndex: i + 1 },
    }),
  );
}

let simIndex = 1000;

/** Mock SIM slots. Unique per process, so parts injected together never overwrite each other. */
function nextSimIndex(): string {
  return String(simIndex++);
}
