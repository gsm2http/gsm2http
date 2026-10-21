import { SerialPort } from 'serialport';

const BAUD_RATE = 115_200;

/**
 * The byte pipe a modem talks over. A real `SerialPort` satisfies this
 * interface as-is; tests and mock mode use `FakeSerialPort` instead.
 *
 * Events: 'data' (Buffer | string), 'error' (Error), 'close' ().
 */
export interface ModemTransport {
  readonly path: string;
  readonly isOpen: boolean;
  write(data: string): void;
  close(): void;
  // Matches the Node stream signature so a SerialPort is assignable as-is.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Opens a serial port and resolves once it is ready, or with null if it cannot be opened.
 */
export function openSerialPort(path: string, baudRate = BAUD_RATE): Promise<SerialPort | null> {
  return new Promise((resolve) => {
    try {
      const port: SerialPort = new SerialPort({ path, baudRate }, (err) => {
        resolve(err ? null : port);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Splits a raw byte stream into AT response lines. Also reports the bare
 * `> ` prompt that modems send (without a line terminator) after AT+CMGS.
 */
export class LineSplitter {
  private buffer = '';
  /** Bytes discarded because a line grew past the limit without a terminator. */
  public droppedBytes = 0;

  /**
   * @param maxLineLength A port that streams binary or delimiter-less data (diagnostic
   *   interfaces, line noise after a USB glitch) would otherwise grow the buffer without
   *   bound, so a partial line longer than this is dropped.
   */
  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onPrompt: () => void = () => undefined,
    private readonly maxLineLength = 16 * 1024,
  ) {}

  public push(chunk: Buffer | string): void {
    this.buffer += chunk.toString();

    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
    }

    if (this.buffer.replace(/\r/g, '').trim() === '>') {
      this.buffer = '';
      this.onPrompt();
    }

    if (this.buffer.length > this.maxLineLength) {
      this.droppedBytes += this.buffer.length;
      this.buffer = '';
    }
  }
}
