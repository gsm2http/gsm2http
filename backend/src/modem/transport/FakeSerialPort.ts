import { EventEmitter } from 'events';
import { ModemTransport } from './ModemTransport';

/**
 * What a scripted rule answers with:
 *  - string[]: response lines, each framed as `\r\n<line>\r\n` like a real modem (ATV1).
 *    The special line '> ' is sent as the bare SMS prompt.
 *  - string: a single response line.
 *  - null: no answer at all (lets you simulate a command timeout).
 */
export type FakeResponse = string | string[] | null;

export type FakeReply =
  FakeResponse | ((match: RegExpMatchArray, port: FakeSerialPort) => FakeResponse);

export interface FakeRule {
  /** Matched against the command without its terminator, e.g. 'AT+CGMM' or '<pdu hex>\x1A'. */
  match: RegExp | string;
  reply: FakeReply;
}

export interface FakeSerialPortOptions {
  path?: string;
  rules?: FakeRule[];
  /** Reply used when no rule matches. Defaults to 'OK'. */
  fallback?: FakeResponse;
  /** Delay before each scripted reply, in ms. Defaults to 2. */
  responseDelayMs?: number;
}

/**
 * A scripted, in-memory stand-in for a serial port. Commands written to it are
 * matched against rules (first match wins) and answered asynchronously, so the
 * code under test sees exactly what it would see from hardware.
 *
 * Commands are split on '\r'. Text terminated by Ctrl-Z (0x1A), as sent after the
 * AT+CMGS prompt, is matched as `<text>\x1A`.
 */
export class FakeSerialPort extends EventEmitter implements ModemTransport {
  public readonly path: string;
  public isOpen = true;
  /** Every command received, in order (terminators stripped, Ctrl-Z kept). */
  public readonly received: string[] = [];

  private rules: FakeRule[];
  private fallback: FakeResponse;
  private responseDelayMs: number;
  private inbound = '';

  constructor(options: FakeSerialPortOptions = {}) {
    super();
    this.path = options.path || '/dev/fake0';
    this.rules = [...(options.rules || [])];
    this.fallback = options.fallback === undefined ? 'OK' : options.fallback;
    this.responseDelayMs = options.responseDelayMs ?? 2;
  }

  /** Adds a rule that takes precedence over the existing ones. */
  public onCommand(match: RegExp | string, reply: FakeReply): this {
    this.rules.unshift({ match, reply });
    return this;
  }

  /** Pushes unsolicited bytes to the reader, e.g. '+CMTI: "SM",3\r\n'. */
  public inject(data: string): void {
    if (this.isOpen) {
      this.emit('data', Buffer.from(data, 'utf8'));
    }
  }

  public write(data: string): void {
    if (!this.isOpen) {
      throw new Error(`Port ${this.path} is not open`);
    }
    if (data === '+++') {
      this.received.push(data);
      return;
    }

    this.inbound += data;
    for (;;) {
      const cr = this.inbound.indexOf('\r');
      const ctrlZ = this.inbound.indexOf('\x1A');
      if (cr === -1 && ctrlZ === -1) break;

      let command: string;
      if (ctrlZ !== -1 && (cr === -1 || ctrlZ < cr)) {
        command = this.inbound.slice(0, ctrlZ + 1);
        this.inbound = this.inbound.slice(ctrlZ + 1);
      } else {
        command = this.inbound.slice(0, cr);
        this.inbound = this.inbound.slice(cr + 1);
      }
      this.inbound = this.inbound.replace(/^\n/, '');
      command = command.replace(/^\n/, '').trim();
      if (command) {
        this.dispatch(command);
      }
    }
  }

  public close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    setImmediate(() => this.emit('close'));
  }

  private dispatch(command: string): void {
    this.received.push(command);
    let response: FakeResponse = this.fallback;

    for (const rule of this.rules) {
      const match =
        typeof rule.match === 'string'
          ? rule.match.toUpperCase() === command.toUpperCase()
            ? ([command] as RegExpMatchArray)
            : null
          : command.match(rule.match);
      if (match) {
        response = typeof rule.reply === 'function' ? rule.reply(match, this) : rule.reply;
        break;
      }
    }

    if (response === null) return;
    const lines = Array.isArray(response) ? response : [response];
    const framed = lines.map((l) => (l === '> ' ? '\r\n> ' : `\r\n${l}\r\n`)).join('');
    setTimeout(() => this.inject(framed), this.responseDelayMs);
  }
}
