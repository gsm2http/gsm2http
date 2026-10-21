import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Logger } from '../logger';
import type { ModemStream } from './ModemStream';
import { PDUParser } from './PDUParser';
import { SmsReassembler, type CompleteSms } from './SmsReassembler';

export interface ParsedSmsEvent extends CompleteSms {
  modemId: string;
  modemPort: string;
}

export interface ParsedCallEvent {
  callId: string;
  number: string;
  modemId: string;
  modemPort: string;
  timestamp: string;
}

export interface ParsedCallEndedEvent {
  callId: string;
  direction: 'inbound';
  number: string;
  modemId: string;
  modemPort: string;
  reason: 'missed' | 'modem_closed';
  startedAt: string;
  durationMs: number;
  rings: number;
  detail?: string;
  timestamp: string;
}

export interface ATParserEvents {
  /** Once per incoming call, on its first ring with caller ID. */
  call: [call: ParsedCallEvent];
  callEnded: [call: ParsedCallEndedEvent];
  sms: [sms: ParsedSmsEvent];
}

export interface ATParserOptions {
  /**
   * An incoming call is considered over when no RING arrives for this long. Networks ring
   * about every 5 s; modems that report the end (`NO CARRIER`, `^CEND`) end it sooner.
   */
  ringGapMs?: number;
}

export const DEFAULT_RING_GAP_MS = 10_000;

interface RingingCall {
  callId: string;
  number: string;
  startedAt: number;
  lastRingAt: number;
  rings: number;
  timer: NodeJS.Timeout;
}

const SIM_LOCKED = '+CME ERROR: 11';

/**
 * Turns a modem's unsolicited result codes into `sms` and `call` events. Every message is
 * deleted from the SIM once read, so SIM storage never fills up.
 */
export class ATParser extends EventEmitter<ATParserEvents> {
  private readonly reassembler: SmsReassembler;
  private readonly log: Logger;
  private readonly ringGapMs: number;
  private isPolling = false;
  private ringing: RingingCall | undefined;

  constructor(
    private readonly modem: ModemStream,
    reassembler: SmsReassembler = new SmsReassembler(),
    options: ATParserOptions = {},
  ) {
    super();
    this.reassembler = reassembler;
    this.log = modem.logger;
    this.ringGapMs = options.ringGapMs ?? DEFAULT_RING_GAP_MS;

    this.reassembler.on('sms', (sms) => {
      const event: ParsedSmsEvent = {
        ...sms,
        modemId: this.modem.id,
        modemPort: this.modem.portPath,
      };
      this.emit('sms', event);
    });

    this.modem.on('urc', (line) => {
      this.handleUrc(line);
    });
    this.modem.on('callEndLine', (line) => {
      if (this.ringing) this.endIncomingCall('missed', line);
    });
    this.modem.on('poll', () => {
      // Reading storage on a locked SIM only produces +CME ERROR: 11 every poll.
      if (this.modem.getSimStatus() !== 'READY' || this.modem.isDialing) return;
      void this.pollMessages();
    });
  }

  private handleUrc(line: string): void {
    // +CMTI: "SM",<index>
    const cmti = /^\+CMTI:\s*"[^"]+",(\d+)/.exec(line);
    if (cmti?.[1]) {
      void this.readAndProcessSms(cmti[1]);
      return;
    }

    // +CLIP: "<number>",<type>,... follows each RING when caller ID is enabled. A withheld
    // number comes through as "".
    const clip = /^\+CLIP:\s*"([^"]*)"/.exec(line);
    if (clip) {
      this.handleRing(clip[1] ?? '');
      return;
    }

    // A bare RING keeps a known call alive; the call itself starts at the +CLIP after it.
    if ((line === 'RING' || line.startsWith('+CRING:')) && this.ringing) {
      this.refreshRingTimer(this.ringing);
    }
  }

  private handleRing(number: string): void {
    const now = Date.now();
    if (this.ringing?.number === number) {
      this.ringing.rings++;
      this.ringing.lastRingAt = now;
      this.refreshRingTimer(this.ringing);
      return;
    }
    if (this.ringing) this.endIncomingCall('missed');

    const callId = `call_${randomUUID().replaceAll('-', '')}`;
    this.ringing = {
      callId,
      number,
      startedAt: now,
      lastRingAt: now,
      rings: 1,
      timer: setTimeout(() => this.endIncomingCall('missed'), this.ringGapMs),
    };
    const event: ParsedCallEvent = {
      callId,
      number,
      modemId: this.modem.id,
      modemPort: this.modem.portPath,
      timestamp: new Date(now).toISOString(),
    };
    this.emit('call', event);
  }

  private refreshRingTimer(call: RingingCall): void {
    clearTimeout(call.timer);
    call.timer = setTimeout(() => this.endIncomingCall('missed'), this.ringGapMs);
  }

  /**
   * With `detail` the modem reported the end, so it happened now. Without it the end was
   * inferred from silence, and the last ring is the best estimate of when it happened.
   */
  private endIncomingCall(reason: ParsedCallEndedEvent['reason'], detail?: string): void {
    const call = this.ringing;
    if (!call) return;
    clearTimeout(call.timer);
    this.ringing = undefined;

    const endedAt = detail || reason === 'modem_closed' ? Date.now() : call.lastRingAt;
    const event: ParsedCallEndedEvent = {
      callId: call.callId,
      direction: 'inbound',
      number: call.number,
      modemId: this.modem.id,
      modemPort: this.modem.portPath,
      reason,
      startedAt: new Date(call.startedAt).toISOString(),
      durationMs: endedAt - call.startedAt,
      rings: call.rings,
      timestamp: new Date().toISOString(),
    };
    if (detail) event.detail = detail;
    this.emit('callEnded', event);
  }

  /** Reads one stored SMS (AT+CMGR), hands it to the reassembler and frees the slot. */
  public async readAndProcessSms(index: string): Promise<void> {
    if (this.modem.getSimStatus() !== 'READY') return;

    try {
      const lines = await this.modem.sendCommand(`AT+CMGR=${index}`);
      if (lines.some((l) => l.includes(SIM_LOCKED))) {
        this.modem.setSimStatus('SIM PIN');
        return;
      }

      // In PDU mode the PDU is the line after the +CMGR header.
      const header = lines.findIndex((l) => l.startsWith('+CMGR:'));
      const pduHex = header >= 0 ? findPduLine(lines, header + 1) : undefined;
      if (pduHex) {
        this.ingestPdu(pduHex, index);
      } else {
        this.log.warn({ index, lines }, 'no PDU in AT+CMGR response');
      }
    } catch (err) {
      this.log.error({ err, index }, 'failed to read SMS');
    } finally {
      await this.deleteFromSim(index);
    }
  }

  /** Reads every stored message (AT+CMGL=4: all, in PDU mode) and frees each slot. */
  public async pollMessages(): Promise<void> {
    if (this.isPolling || this.modem.getSimStatus() !== 'READY') return;
    this.isPolling = true;

    try {
      const lines = await this.modem.sendCommand('AT+CMGL=4');
      if (lines.some((l) => l.includes(SIM_LOCKED))) {
        this.modem.setSimStatus('SIM PIN');
        return;
      }

      for (let i = 0; i < lines.length; i++) {
        const index = /^\+CMGL:\s*(\d+)/.exec(lines[i] ?? '')?.[1];
        if (!index) continue;
        const pduHex = findPduLine(lines, i + 1);
        if (pduHex) this.ingestPdu(pduHex, index);
        await this.deleteFromSim(index);
      }
    } catch (err) {
      this.log.error({ err }, 'failed to poll SIM storage');
    } finally {
      this.isPolling = false;
    }
  }

  private ingestPdu(pduHex: string, index: string): void {
    try {
      this.reassembler.addPart(PDUParser.parse(pduHex));
    } catch (err) {
      // The PDU is logged only at debug: it contains the sender and message text.
      this.log.error({ err, index }, 'failed to parse PDU');
      this.log.debug({ index, pduHex }, 'unparseable PDU');
    }
  }

  private async deleteFromSim(index: string): Promise<void> {
    if (this.modem.getSimStatus() !== 'READY') return;
    try {
      await this.modem.sendCommand(`AT+CMGD=${index}`);
      this.log.debug({ index }, 'freed SIM slot');
    } catch (err) {
      this.log.error({ err, index }, 'failed to delete SMS from SIM');
    }
  }

  public close(): void {
    this.endIncomingCall('modem_closed');
    this.reassembler.clear();
  }
}

function findPduLine(lines: string[], from: number): string | undefined {
  for (const line of lines.slice(from)) {
    if (line.startsWith('+CMGL:')) return undefined;
    if (line && line !== 'OK' && !line.includes('ERROR')) return line;
  }
  return undefined;
}
