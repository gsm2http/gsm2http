import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { logger, type Logger } from '../logger';
import { defaultDriverRegistry } from './drivers';
import type {
  ModemCapabilities,
  ModemContext,
  ModemDriver,
  ModemIdentity,
  ModemStatePatch,
  SendSmsResult,
} from './drivers/types';
import { DEFAULT_SIMULATED_PROFILE } from './mock/mockFleet';
import { SimulatedModem } from './mock/SimulatedModem';
import { DIALABLE_NUMBER, SAFE_AT_COMMAND, SAFE_PROMPT_PAYLOAD, SIM_PIN } from './atInput';
import { FakeSerialPort } from './transport/FakeSerialPort';
import { LineSplitter, type ModemTransport } from './transport/ModemTransport';
import type {
  CallEndReason,
  DialResult,
  EndedCall,
  ModemInfo,
  ModemStreamOptions,
  NetworkMode,
  SentSms,
  SimStatus,
} from './types';

export type StreamSentSms = Omit<SentSms, 'modemId' | 'modemPort'>;
export type StreamEndedCall = Omit<EndedCall, 'modemId' | 'modemPort'>;

interface QueuedCommand {
  command: string;
  timeoutMs: number;
  resolve: (response: string[]) => void;
  reject: (error: Error) => void;
  /** Sent after the `> ` prompt and terminated with Ctrl-Z (AT+CMGS). */
  promptPayload?: string;
  promptSent?: boolean;
}

/** Fallback sweep of SIM storage; new SMS normally arrive through the +CMTI URC. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
/**
 * Commands waiting behind the one in flight. A wedged modem times out one command at a
 * time, so without a cap REST calls and polls would pile up forever.
 */
export const MAX_QUEUE_LENGTH = 32;
const SIM_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * The API never spends a SIM's last PIN attempt: with this many (or fewer) left it refuses,
 * leaving the final try to someone holding the SIM and its PUK.
 */
export const MIN_PIN_ATTEMPTS_LEFT = 1;
/** When the modem cannot report remaining attempts, this many wrong PINs block further tries. */
export const MAX_UNVERIFIED_PIN_FAILURES = 1;

/** Thrown when an unlock is refused to protect the SIM from a PUK lock. */
export class PinAttemptsError extends Error {
  constructor(
    message: string,
    public readonly attemptsLeft: number | undefined,
  ) {
    super(message);
  }
}

function csqToPercent(rssi: number): number {
  return rssi === 99 ? 0 : Math.min(100, Math.round((rssi / 31) * 100));
}

export interface ModemStreamEvents {
  /** One raw-log line: modem output, a `> command` echo or a `[System …]` note. */
  line: [text: string];
  /** An unsolicited result code such as +CMTI or RING. */
  urc: [line: string];
  status: [info: ModemInfo];
  /** Time to check SIM storage for messages whose +CMTI was missed. */
  poll: [];
  close: [];
  smsSent: [sms: StreamSentSms];
  /** An outgoing call placed with `dial()` is over. */
  callEnded: [call: StreamEndedCall];
  /** `NO CARRIER`, `BUSY`, `^CEND`… while no outgoing call is up: an incoming call ended. */
  callEndLine: [line: string];
}

/**
 * Owns one modem: its transport, a FIFO AT command queue with per-command timeouts,
 * URC routing and the modem's observable state. Everything vendor-specific is delegated
 * to `driver`. In mock mode the transport is a SimulatedModem's FakeSerialPort, so the
 * whole pipeline runs unchanged.
 */
export class ModemStream extends EventEmitter<ModemStreamEvents> {
  public readonly id: string;
  public readonly portPath: string;
  public readonly name: string;
  public model = 'Unknown';
  public manufacturer = 'Unknown';
  public revision: string | undefined;
  public imei = '';
  public phoneNumber: string | undefined;
  public simStatus: SimStatus = 'UNKNOWN';
  public operatorName = '';
  public signalStrength = 0;
  public signalPercentage = 0;
  public accessTechnology: string | undefined;
  public networkMode: NetworkMode = '3g';
  public connected = false;
  public isDialing = false;
  public capabilities: ModemCapabilities = { sms: true, voice: false, ussd: false, audio: false };
  public readonly driver: ModemDriver;
  public readonly identity: ModemIdentity;
  /** The simulated device when running against a FakeSerialPort (tests, MOCK_MODE). */
  public readonly simulator: SimulatedModem | undefined;

  public readonly logger: Logger;
  private transport: ModemTransport | undefined;
  private readonly splitter: LineSplitter;
  private readonly ctx: ModemContext;
  private readonly pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private callTimer: NodeJS.Timeout | undefined;
  private finishCall: ((reason: string) => void) | undefined;
  /** Wrong PINs since the last successful unlock; used when the modem cannot report retries. */
  private failedPinAttempts = 0;
  private unlockChain: Promise<void> = Promise.resolve();

  private readonly commandQueue: QueuedCommand[] = [];
  private currentCommand: QueuedCommand | undefined;
  private currentResponse: string[] = [];
  private commandTimer: NodeJS.Timeout | undefined;

  constructor(options: ModemStreamOptions) {
    super();
    this.id = options.id;
    this.portPath = options.portPath;
    this.name = options.name ?? `Modem (${this.portPath})`;
    this.logger = logger.child({ modemId: this.id, port: this.portPath });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    let transport = options.transport;
    let supportsVoice = options.supportsVoice;
    let simStatus = options.simStatus;
    this.simulator = options.simulator;
    if (!transport && options.mockMode) {
      const base = DEFAULT_SIMULATED_PROFILE;
      this.simulator ??= new SimulatedModem(
        {
          ...base,
          manufacturer: options.manufacturer ?? base.manufacturer,
          model: options.model ?? base.model,
          imei: options.imei ?? base.imei,
          simStatus: options.simStatus ?? base.simStatus,
          operator: options.operator,
          rssi: options.signalStrength,
          voice: options.supportsVoice ?? base.voice,
        },
        this.portPath,
      );
      transport = this.simulator.port;
      supportsVoice ??= this.simulator.profile.voice;
      simStatus ??= this.simulator.simStatus;
    }
    if (!transport) {
      throw new Error(`ModemStream ${this.id}: an open transport is required outside mock mode`);
    }

    this.identity = { ...this.simulator?.identity, ...options.identity };
    if (options.model) this.identity.model = options.model;
    if (options.manufacturer) this.identity.manufacturer = options.manufacturer;

    if (this.identity.model) this.model = this.identity.model;
    if (this.identity.manufacturer) this.manufacturer = this.identity.manufacturer;
    this.revision = this.identity.revision;
    if (options.imei) this.imei = options.imei;
    if (options.phoneNumber) this.phoneNumber = options.phoneNumber;
    if (options.operator) this.operatorName = options.operator;
    if (options.signalStrength !== undefined) this.updateSignal(options.signalStrength);
    if (supportsVoice !== undefined) this.capabilities.voice = supportsVoice;
    if (simStatus) this.simStatus = simStatus;
    if (options.networkMode) this.networkMode = options.networkMode;

    this.driver = options.driver ?? defaultDriverRegistry.select(this.identity, this.portPath);
    this.ctx = this.createContext();
    this.splitter = new LineSplitter(
      (line) => {
        this.handleLine(line);
      },
      () => {
        this.handlePrompt();
      },
    );

    this.attachTransport(transport);
  }

  public get supportsVoice(): boolean {
    return this.capabilities.voice;
  }

  private createContext(): ModemContext {
    return {
      id: this.id,
      portPath: this.portPath,
      identity: this.identity,
      send: (command, timeoutMs) => this.sendCommand(command, timeoutMs),
      sendWithPrompt: (command, payload, timeoutMs) =>
        this.enqueue(command, timeoutMs ?? 5_000, payload),
      write: (command) => {
        this.fireAndForget(command);
      },
      log: (line) => {
        this.emitNote(line);
      },
      getInfo: () => this.getInfo(),
    };
  }

  private attachTransport(transport: ModemTransport): void {
    this.transport = transport;
    this.connected = true;
    transport.on('data', (chunk: Buffer | string) => {
      this.splitter.push(chunk);
    });

    transport.on('error', (err: Error) => {
      this.logger.error({ err }, 'serial port error');
      this.emitNote(`[System Error] Serial port error: ${err.message}`);
      this.emitStatus();
    });

    transport.on('close', () => {
      this.connected = false;
      this.transport = undefined;
      this.logger.info('modem disconnected');
      this.emitNote(`[System Event] Modem ${this.id} disconnected (${this.portPath})`);
      this.finishCall?.('port_disconnected');
      this.stopTimersAndFlushQueue(`Modem ${this.id} disconnected`);
      this.emit('close');
      this.emitStatus();
    });

    void this.runStartupSequence();
  }

  private async runStartupSequence(): Promise<void> {
    this.emitNote(`[System Event] Checking SIM status on ${this.id} (driver: ${this.driver.name})`);
    const simStatus = await this.attempt('SIM status query', () =>
      this.driver.querySimStatus(this.ctx),
    );
    if (simStatus) this.setSimStatus(simStatus);
    if (this.simStatus === 'SIM PIN') {
      this.emitNote(`[System Warning] SIM PIN required on ${this.id} (${this.portPath})`);
    }

    // IMEI and model, unless the port probe already read them.
    if (!this.imei) {
      const imei = (await this.trySend('AT+CGSN', 2_000)).find((l) => /^\d{14,16}$/.test(l));
      if (imei) this.imei = imei;
    }
    if (!this.identity.model) {
      const model = (await this.trySend('AT+CGMM', 2_000)).find(
        (l) => l !== 'OK' && !l.includes('ERROR'),
      );
      if (model) this.model = this.identity.model = model;
    }

    // Storage and notification setup fails with +CME ERROR: 11 while the SIM is locked;
    // it runs again after a successful unlock.
    if (this.simStatus === 'READY') {
      this.emitNote(`[System Event] Configuring PDU-mode SMS on ${this.id}`);
      await this.initDriver();
    }

    const capabilities = await this.attempt('capability probe', () =>
      this.driver.probeCapabilities(this.ctx),
    );
    if (capabilities) this.capabilities = capabilities;
    this.applyState(await this.attempt('signal query', () => this.driver.querySignal(this.ctx)));
    this.applyState(await this.attempt('network query', () => this.driver.queryNetwork(this.ctx)));

    this.emitStatus();
    this.startPolling();

    // Belt and braces for the SIM's small storage (often 10–50 slots): messages are
    // deleted as they are read, but anything that slipped through (a crash between read
    // and delete, a message that failed to parse) would eventually block new SMS.
    // AT+CMGD=1,3 deletes all read, sent and unsent messages and keeps unread ones.
    this.cleanupTimer = setInterval(() => {
      if (this.transport?.isOpen && this.simStatus === 'READY') void this.trySend('AT+CMGD=1,3');
    }, SIM_CLEANUP_INTERVAL_MS);
  }

  private async initDriver(): Promise<void> {
    try {
      await this.driver.init(this.ctx);
    } catch (err) {
      this.logger.warn({ err }, 'modem init failed');
      this.emitNote(`[System Error] Init failed on ${this.id}: ${errorMessage(err)}`);
    }
  }

  /** Runs a driver step, logging failures and resolving with undefined instead of rejecting. */
  private async attempt<T>(what: string, step: () => Promise<T>): Promise<T | undefined> {
    try {
      return await step();
    } catch (err) {
      this.logger.warn({ err }, `${what} failed`);
      return undefined;
    }
  }

  private startPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => {
      if (!this.isDialing) this.emit('poll');
    }, this.pollIntervalMs);
  }

  /** Clears every timer and rejects in-flight and queued commands, so nothing outlives the port. */
  private stopTimersAndFlushQueue(reason: string): void {
    clearTimeout(this.callTimer);
    clearTimeout(this.commandTimer);
    clearInterval(this.pollTimer);
    clearInterval(this.cleanupTimer);
    this.commandTimer = undefined;

    const pending = this.currentCommand
      ? [this.currentCommand, ...this.commandQueue]
      : [...this.commandQueue];
    this.currentCommand = undefined;
    this.currentResponse = [];
    this.commandQueue.length = 0;
    for (const command of pending) command.reject(new Error(reason));
  }

  /** Commands queued or in flight. */
  public getQueueLength(): number {
    return this.commandQueue.length + (this.currentCommand ? 1 : 0);
  }

  public getSimStatus(): SimStatus {
    return this.simStatus;
  }

  public setSimStatus(status: SimStatus): void {
    if (this.simStatus !== status) {
      this.simStatus = status;
      this.emitStatus();
    }
  }

  /** Merges driver-reported state and emits a status update if anything changed. */
  private applyState(patch: ModemStatePatch | undefined): void {
    if (!patch) return;
    let changed = false;

    if (patch.simStatus && patch.simStatus !== this.simStatus) {
      this.simStatus = patch.simStatus;
      changed = true;
    }
    if (patch.signalStrength !== undefined && patch.signalStrength !== this.signalStrength) {
      this.updateSignal(patch.signalStrength);
      changed = true;
    }
    if (patch.operator !== undefined && patch.operator !== this.operatorName) {
      this.operatorName = patch.operator;
      changed = true;
    }
    if (patch.accessTechnology !== undefined && patch.accessTechnology !== this.accessTechnology) {
      this.accessTechnology = patch.accessTechnology;
      changed = true;
    }

    if (changed) this.emitStatus();
  }

  public getInfo(): ModemInfo {
    return {
      id: this.id,
      port: this.portPath,
      name: this.name,
      model: this.model,
      manufacturer: this.manufacturer,
      revision: this.revision,
      imei: this.imei,
      driver: this.driver.name,
      capabilities: { ...this.capabilities },
      simStatus: this.simStatus,
      phoneNumber: this.phoneNumber,
      operator: this.operatorName,
      signalStrength: this.signalStrength,
      signalPercentage: this.signalPercentage,
      accessTechnology: this.accessTechnology,
      supportsVoice: this.supportsVoice,
      connected: this.connected,
      networkMode: this.networkMode,
      isDialing: this.isDialing,
    };
  }

  /**
   * Queues an AT command and resolves with every response line up to and including the
   * final result code. `ERROR` and `+CME/+CMS ERROR` resolve too, so callers must check
   * the lines; only timeouts and a closed port reject.
   */
  public sendCommand(command: string, timeoutMs = 5_000): Promise<string[]> {
    return this.enqueue(command, timeoutMs);
  }

  private enqueue(command: string, timeoutMs: number, promptPayload?: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      // The last line of defence against AT injection: drivers validate their inputs too,
      // but nothing reaches the serial port unless it is a single, inert command line.
      if (!SAFE_AT_COMMAND.test(command)) {
        reject(new Error('Refusing to send an AT command containing control characters'));
        return;
      }
      if (promptPayload !== undefined && !SAFE_PROMPT_PAYLOAD.test(promptPayload)) {
        reject(new Error('Refusing to send a prompt payload that is not hex'));
        return;
      }
      if (this.commandQueue.length >= MAX_QUEUE_LENGTH) {
        reject(new Error(`Modem ${this.id} command queue full (${MAX_QUEUE_LENGTH} pending)`));
        return;
      }
      this.commandQueue.push({
        command: command.trim(),
        timeoutMs,
        resolve,
        reject,
        promptPayload,
      });
      this.processQueue();
    });
  }

  /** Like sendCommand, but logs failures and resolves with no lines instead of rejecting. */
  private async trySend(command: string, timeoutMs?: number): Promise<string[]> {
    try {
      return await this.sendCommand(command, timeoutMs);
    } catch (err) {
      this.logger.warn({ err, command }, 'command failed');
      return [];
    }
  }

  private processQueue(): void {
    if (this.currentCommand) return;
    const next = this.commandQueue.shift();
    if (!next) return;

    this.currentCommand = next;
    this.currentResponse = [];

    this.commandTimer = setTimeout(() => {
      this.logger.warn({ command: next.command, timeoutMs: next.timeoutMs }, 'command timed out');
      this.currentCommand = undefined;
      this.currentResponse = [];
      this.commandTimer = undefined;
      next.reject(new Error(`Command timed out after ${next.timeoutMs} ms: ${next.command}`));
      // ESC abandons a pending SMS prompt; a bare CR/LF aborts a half-received command line.
      const abort = next.promptPayload !== undefined && !next.promptSent ? '\x1B' : '\r\n';
      if (this.transport?.isOpen) this.transport.write(abort);
      this.processQueue();
    }, next.timeoutMs);

    if (this.transport?.isOpen) {
      this.logger.debug({ command: next.command }, 'tx');
      this.emitNote(`> ${next.command}`);
      // Commands that expect a prompt end with CR only, per TS 27.005 §3.5.1.
      this.transport.write(
        next.promptPayload !== undefined ? `${next.command}\r` : `${next.command}\r\n`,
      );
    } else {
      clearTimeout(this.commandTimer);
      this.commandTimer = undefined;
      this.currentCommand = undefined;
      next.reject(new Error(`Modem ${this.id} is not connected`));
      this.processQueue();
    }
  }

  private handlePrompt(): void {
    const command = this.currentCommand;
    if (command?.promptPayload === undefined || command.promptSent || !this.transport?.isOpen) {
      return;
    }
    command.promptSent = true;
    this.emitNote(`> [${command.promptPayload.length / 2} byte PDU]`);
    this.transport.write(`${command.promptPayload}\x1A`);
  }

  /** Pushes raw bytes from the simulated device as if the modem had sent them. */
  public injectMockData(data: string): void {
    if (this.transport instanceof FakeSerialPort) this.transport.inject(data);
  }

  public setMockSms(index: string, sender: string, text: string): void {
    this.simulator?.storeSms(index, sender, text);
  }

  public setMockPdu(index: string, pduHex: string): void {
    this.simulator?.storePdu(index, pduHex);
  }

  /**
   * Sends the SIM PIN. Resolves false if the modem rejects it. Never retried: three wrong
   * PINs lock the SIM until the PUK is entered. Throws PinAttemptsError instead of trying
   * when the attempt could be the one that PUK-locks the SIM.
   */
  public unlock(pin: string): Promise<boolean> {
    if (!SIM_PIN.test(pin)) return Promise.reject(new Error('PIN must be 4 to 8 digits'));
    // One unlock at a time: concurrent requests would all pass the attempts-left check
    // before any AT+CPIN was sent, and together could PUK-lock the SIM.
    const run = this.unlockChain.then(() => this.unlockNow(pin));
    this.unlockChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async unlockNow(pin: string): Promise<boolean> {
    await this.assertPinAttemptIsSafe();

    if (!(await this.driver.unlock(this.ctx, pin))) {
      this.failedPinAttempts++;
      this.logger.warn({ failedPinAttempts: this.failedPinAttempts }, 'SIM rejected the PIN');
      return false;
    }

    this.failedPinAttempts = 0;
    this.setSimStatus('READY');
    this.emitNote(`[System Event] SIM unlocked on ${this.id}`);
    await this.initDriver();
    this.emitStatus();
    return true;
  }

  private async assertPinAttemptIsSafe(): Promise<void> {
    if (this.simStatus === 'SIM PUK') {
      throw new PinAttemptsError(`Modem ${this.id} SIM is PUK-locked; enter the PUK in a phone`, 0);
    }
    const left = await this.driver.queryPinAttemptsLeft?.(this.ctx).catch(() => undefined);
    if (left !== undefined) {
      if (left <= MIN_PIN_ATTEMPTS_LEFT) {
        throw new PinAttemptsError(
          `Modem ${this.id} SIM has ${left} PIN attempt${left === 1 ? '' : 's'} left; ` +
            'refusing to risk a PUK lock. Unlock it in a phone.',
          left,
        );
      }
      return;
    }
    if (this.failedPinAttempts >= MAX_UNVERIFIED_PIN_FAILURES) {
      throw new PinAttemptsError(
        `Modem ${this.id} already rejected a PIN and cannot report how many attempts are ` +
          'left; refusing to risk a PUK lock. Check the PIN, then restart gsm2http or ' +
          'unlock the SIM in a phone.',
        undefined,
      );
    }
  }

  public async queryDiagnostics(): Promise<void> {
    const simStatus = await this.attempt('SIM status query', () =>
      this.driver.querySimStatus(this.ctx),
    );
    if (simStatus) this.setSimStatus(simStatus);
    this.applyState(await this.attempt('signal query', () => this.driver.querySignal(this.ctx)));
    this.applyState(await this.attempt('network query', () => this.driver.queryNetwork(this.ctx)));
    if (this.simStatus === 'READY') await this.initDriver();
    this.emitStatus();
  }

  public async setNetworkMode(mode: NetworkMode): Promise<void> {
    this.networkMode = mode;
    try {
      await this.driver.setNetworkMode(this.ctx, mode);
      this.emitNote(`[System Event] Switched network mode to ${mode} on ${this.id}`);
    } catch (err) {
      this.logger.warn({ err, mode }, 'modem rejected network mode change');
      this.emitNote(
        `[System Error] Network mode change on ${this.id} failed: ${errorMessage(err)}`,
      );
    }
    this.emitStatus();
  }

  /** Sends an SMS, split into concatenated parts when it does not fit in one. */
  public async sendSms(to: string, text: string): Promise<SendSmsResult> {
    if (!DIALABLE_NUMBER.test(to)) throw new Error('Recipient must be "+" and digits');
    if (!this.connected) throw new Error(`Modem ${this.id} is not connected`);
    if (!this.capabilities.sms) throw new Error(`Modem ${this.id} does not support SMS`);
    if (this.simStatus !== 'READY') {
      throw new Error(`Modem ${this.id} SIM is not ready (${this.simStatus})`);
    }

    const result = await this.driver.sendSms(this.ctx, to, text);
    const parts = `${result.parts} part${result.parts === 1 ? '' : 's'}`;
    this.emitNote(`[System Event] SMS sent from ${this.id} (${parts})`);
    this.emit('smsSent', {
      to,
      text,
      parts: result.parts,
      messageReferences: result.messageReferences,
      timestamp: new Date().toISOString(),
    });
    return result;
  }

  /**
   * Places a call and hangs up after `durationMs`, or earlier if the network ends it.
   * Returns immediately; `completion` resolves when the call is over.
   */
  public dial(number: string, durationMs: number, options: { force?: boolean } = {}): DialResult {
    if (!DIALABLE_NUMBER.test(number)) {
      return { success: false, message: `Not a dialable number: ${number}` };
    }
    if (!this.supportsVoice) {
      return { success: false, message: `Modem ${this.id} does not support voice calls` };
    }
    if (this.isDialing) {
      if (!options.force) {
        return {
          success: false,
          busy: true,
          message: `Modem ${this.id} is currently busy with an active call`,
        };
      }
      this.finishCall?.('aborted_for_new_call');
    }

    this.isDialing = true;
    this.emitStatus();
    const callId = `call_${randomUUID().replaceAll('-', '')}`;
    const startedAt = Date.now();

    let resolveCompletion!: (result: DialResult) => void;
    const completion = new Promise<DialResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const finish = (reason: string) => {
      clearTimeout(this.callTimer);
      this.callTimer = undefined;
      this.isDialing = false;
      this.finishCall = undefined;
      const endedAt = Date.now();

      void this.hangUpLine().then(() => {
        this.emitNote(`[System Event] Call from ${this.id} ended (${reason})`);
        this.emitStatus();
        const ended: StreamEndedCall = {
          callId,
          direction: 'outbound',
          number,
          reason: callEndReason(reason),
          startedAt: new Date(startedAt).toISOString(),
          durationMs: endedAt - startedAt,
          timestamp: new Date(endedAt).toISOString(),
        };
        if (ended.reason === 'remote_hangup') ended.detail = reason;
        this.emit('callEnded', ended);
        resolveCompletion({
          success: true,
          message: `Call to ${number} finished (${reason})`,
          durationMs,
        });
      });
    };
    this.finishCall = finish;

    this.logger.info({ durationMs }, 'dialing');
    this.driver.dial(this.ctx, number).catch((err: unknown) => {
      this.emitNote(`[System Error] Dial on ${this.id} failed: ${errorMessage(err)}`);
      if (this.finishCall === finish) finish('dial_failed');
    });

    this.callTimer = setTimeout(() => {
      this.finishCall?.('duration_elapsed');
    }, durationMs);

    return {
      success: true,
      message: `Dialing ${number} on ${this.id}`,
      callId,
      durationMs,
      completion,
    };
  }

  public hangup(): void {
    if (this.finishCall) {
      this.finishCall('manual_hangup');
    } else if (this.transport?.isOpen) {
      void this.hangUpLine();
    }
  }

  private async hangUpLine(): Promise<void> {
    try {
      await this.driver.hangup(this.ctx);
    } catch (err) {
      this.logger.warn({ err }, 'hangup failed');
    }
  }

  private fireAndForget(command: string): void {
    this.sendCommand(command).catch((err: unknown) => {
      this.logger.warn({ err, command }, 'command failed');
    });
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;

    this.logger.debug({ line }, 'rx');
    this.emitNote(line);

    // The driver extracts state (SIM, signal, operator…) from any line, solicited or not.
    this.applyState(this.driver.handleLine(line, this.ctx) ?? undefined);

    if (this.driver.isCallEnded(line)) {
      if (this.isDialing) this.finishCall?.(line);
      else this.emit('callEndLine', line);
    }

    if (this.driver.isUrc(line)) {
      this.emit('urc', line);
      return;
    }

    const command = this.currentCommand;
    if (!command) return;

    this.currentResponse.push(line);
    if (this.driver.isFinalResponse(line)) {
      clearTimeout(this.commandTimer);
      this.commandTimer = undefined;
      const response = this.currentResponse;
      this.currentCommand = undefined;
      this.currentResponse = [];
      command.resolve(response);
      this.processQueue();
    }
  }

  private updateSignal(rssi: number): void {
    this.signalStrength = rssi;
    this.signalPercentage = csqToPercent(rssi);
  }

  private emitStatus(): void {
    this.emit('status', this.getInfo());
  }

  /** Emits one line for the raw AT log: modem output, `> command` echoes or `[System …]` notes. */
  private emitNote(text: string): void {
    this.emit('line', text);
  }

  public close(): void {
    this.finishCall?.('closed');
    this.stopTimersAndFlushQueue(`Modem ${this.id} closed`);
    if (this.transport?.isOpen) this.transport.close();
    this.connected = false;
  }
}

/** Maps the internal reasons passed to `finish()` and modem result lines to the public enum. */
function callEndReason(reason: string): CallEndReason {
  switch (reason) {
    case 'duration_elapsed':
      return 'completed';
    case 'manual_hangup':
      return 'hangup';
    case 'aborted_for_new_call':
      return 'replaced';
    case 'dial_failed':
      return 'failed';
    case 'closed':
    case 'port_disconnected':
      return 'modem_closed';
    case 'BUSY':
      return 'busy';
    case 'NO ANSWER':
      return 'no_answer';
    default:
      return 'remote_hangup';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
