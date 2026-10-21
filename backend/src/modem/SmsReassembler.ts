import { EventEmitter } from 'node:events';
import { logger } from '../logger';
import type { ParsedPdu } from './PDUParser';

const log = logger.child({ component: 'sms-reassembler' });

export interface CompleteSms {
  sender: string;
  text: string;
  timestamp: string;
}

interface MultipartSession {
  sender: string;
  refNumber: number;
  totalParts: number;
  parts: Map<number, string>;
  timestamp: string;
  timer: NodeJS.Timeout;
}

export class SmsReassembler extends EventEmitter<{ sms: [sms: CompleteSms] }> {
  private readonly sessions = new Map<string, MultipartSession>();

  constructor(private readonly timeoutMs = 30_000) {
    super();
  }

  /**
   * Emits `sms` straight away for a single-part message. Parts of a concatenated message
   * are held until all have arrived, or until `timeoutMs` passes without a new part.
   */
  public addPart(pdu: ParsedPdu): void {
    const timestamp = pdu.timestamp || new Date().toISOString();

    if (!pdu.isMultipart || !pdu.totalParts || pdu.totalParts <= 1 || pdu.partIndex === undefined) {
      this.emitSms({ sender: pdu.sender, text: pdu.text, timestamp });
      return;
    }

    // The reference number is only unique per sender, and senders reuse it quickly.
    const key = `${pdu.sender}_${pdu.refNumber ?? 'unknown'}`;
    let session = this.sessions.get(key);

    if (!session) {
      session = {
        sender: pdu.sender,
        refNumber: pdu.refNumber ?? 0,
        totalParts: pdu.totalParts,
        parts: new Map<number, string>(),
        timestamp,
        timer: this.createTimer(key),
      };
      this.sessions.set(key, session);
    } else {
      clearTimeout(session.timer);
      session.timer = this.createTimer(key);
    }

    session.parts.set(pdu.partIndex, pdu.text);

    if (session.parts.size >= session.totalParts) {
      clearTimeout(session.timer);
      this.sessions.delete(key);

      let fullText = '';
      for (let i = 1; i <= session.totalParts; i++) {
        fullText += session.parts.get(i) ?? '';
      }

      log.debug({ parts: session.totalParts }, 'reassembled multipart SMS');
      this.emitSms({ sender: session.sender, text: fullText, timestamp: session.timestamp });
    }
  }

  private createTimer(key: string): NodeJS.Timeout {
    return setTimeout(() => {
      const session = this.sessions.get(key);
      if (!session) return;

      this.sessions.delete(key);
      log.warn(
        { refNumber: session.refNumber, received: session.parts.size, total: session.totalParts },
        'multipart SMS timed out; delivering the parts received',
      );

      let partialText = '';
      for (let i = 1; i <= session.totalParts; i++) {
        const part = session.parts.get(i);
        if (part !== undefined) {
          partialText += part;
        } else {
          partialText += ` [PARTIAL: missing part ${i}/${session.totalParts}] `;
        }
      }

      this.emitSms({
        sender: session.sender,
        text: `[PARTIAL] ${partialText.trim()}`,
        timestamp: session.timestamp,
      });
    }, this.timeoutMs);
  }

  private emitSms(sms: CompleteSms): void {
    this.emit('sms', sms);
  }

  public clear(): void {
    for (const session of this.sessions.values()) {
      clearTimeout(session.timer);
    }
    this.sessions.clear();
  }
}
