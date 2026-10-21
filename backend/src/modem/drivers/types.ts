import type { ModemInfo, NetworkMode, SimStatus } from '../types';

/**
 * What we know about a device before choosing a driver for it.
 * Gathered by the port probe from AT+CGMI / AT+CGMM / AT+CGMR and the USB descriptor.
 */
export interface ModemIdentity {
  manufacturer?: string;
  model?: string;
  revision?: string;
  /** USB vendor id, lowercase hex without 0x (e.g. '12d1'). */
  usbVendorId?: string;
  /** USB product id, lowercase hex without 0x. */
  usbProductId?: string;
}

export interface ModemCapabilities {
  sms: boolean;
  /** Can place and receive circuit-switched voice calls (ATD / RING). */
  voice: boolean;
  ussd: boolean;
  /** Exposes call audio to the host (e.g. PCM over a USB serial interface). */
  audio: boolean;
}

/** Parsed device state a driver reports back; the stream merges it into ModemInfo. */
export interface ModemStatePatch {
  simStatus?: SimStatus;
  /** Raw RSSI on the 0-31 scale, 99 = unknown. */
  signalStrength?: number;
  operator?: string;
  /** Radio access technology currently in use, e.g. 'GSM', 'WCDMA', 'LTE'. */
  accessTechnology?: string;
}

export interface SendSmsResult {
  /** Number of PDUs sent (> 1 for concatenated messages). */
  parts: number;
  /** TP-Message-Reference values returned by +CMGS, one per part. */
  messageReferences: number[];
}

/**
 * The handle a driver uses to talk to its modem. All commands go through the
 * per-modem FIFO queue, so drivers never need their own locking.
 */
export interface ModemContext {
  readonly id: string;
  readonly portPath: string;
  readonly identity: ModemIdentity;
  /**
   * Queues a command and resolves with every response line up to and including
   * the final result code (OK / ERROR / +CME ERROR ...). An ERROR still resolves;
   * only a timeout or a closed port rejects.
   */
  send(command: string, timeoutMs?: number): Promise<string[]>;
  /** Like send(), but waits for the '> ' prompt, then writes `payload` + Ctrl-Z (AT+CMGS style). */
  sendWithPrompt(command: string, payload: string, timeoutMs?: number): Promise<string[]>;
  /** Fire-and-forget send; errors are logged, not thrown. */
  write(command: string): void;
  /** Emits a line on the modem's raw event stream (visible in the UI console). */
  log(line: string): void;
  getInfo(): ModemInfo;
}

/**
 * Everything vendor- or model-specific about driving a modem.
 *
 * Drivers are shared by every modem they match, so keep per-modem state out of
 * instance fields; derive it from `ctx` instead. Extend `GenericDriver` and
 * override only what your hardware does differently.
 */
export interface ModemDriver {
  /** Stable id used in logs, ModemInfo.driver and the MODEM_DRIVER override (e.g. 'huawei'). */
  readonly name: string;
  /** Human readable description. */
  readonly label: string;

  /**
   * How well this driver fits a device: 0 = not at all, higher = better.
   * The registry picks the highest score; GenericDriver returns 1 for everything.
   */
  matches(identity: ModemIdentity): number;

  /** Final result codes that end a command's response (OK, ERROR, ...). */
  isFinalResponse(line: string): boolean;
  /** Lines the modem sends on its own (+CMTI, RING, ...). They bypass the command queue. */
  isUrc(line: string): boolean;
  /** Lines that mean an outgoing call has ended (NO CARRIER, BUSY, ...). */
  isCallEnded(line: string): boolean;
  /**
   * Called for every line received, solicited or not. Return the state it implies
   * (signal, SIM status, operator...), or nothing if the line is not interesting.
   */
  handleLine(line: string, ctx: ModemContext): ModemStatePatch | undefined;

  /** Asks the SIM for its PIN state (AT+CPIN?). */
  querySimStatus(ctx: ModemContext): Promise<SimStatus>;
  /** Runs once the SIM is READY (at startup, after unlock, on diagnostics): radio on, SMS storage, PDU mode, new-message indications. */
  init(ctx: ModemContext): Promise<void>;
  /** Detects what this particular device can do. Runs at startup. */
  probeCapabilities(ctx: ModemContext): Promise<ModemCapabilities>;

  unlock(ctx: ModemContext, pin: string): Promise<boolean>;
  /**
   * PIN attempts the SIM has left before it locks to PUK, or undefined if the modem cannot
   * tell. The stream refuses to unlock when this reaches 1, so report it whenever possible.
   */
  queryPinAttemptsLeft?(ctx: ModemContext): Promise<number | undefined>;
  sendSms(ctx: ModemContext, to: string, text: string): Promise<SendSmsResult>;
  /** Starts an outgoing voice call. Throw if the modem refuses it. */
  dial(ctx: ModemContext, number: string): Promise<void>;
  hangup(ctx: ModemContext): Promise<void>;

  querySignal(ctx: ModemContext): Promise<ModemStatePatch>;
  queryNetwork(ctx: ModemContext): Promise<ModemStatePatch>;
  setNetworkMode(ctx: ModemContext, mode: NetworkMode): Promise<void>;
}
