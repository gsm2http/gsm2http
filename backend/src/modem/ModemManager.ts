import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { SerialPort } from 'serialport';
import { logger } from '../logger';
import { ATParser } from './ATParser';
import {
  defaultDriverRegistry,
  type DriverOverrides,
  type DriverRegistry,
  type ModemIdentity,
} from './drivers';
import { DEFAULT_MOCK_FLEET, type MockModemDefinition } from './mock/mockFleet';
import { SimulatedModem } from './mock/SimulatedModem';
import { ModemStream } from './ModemStream';
import { probeModem } from './probe';
import { openSerialPort } from './transport/ModemTransport';
import type { EndedCall, IncomingCall, ModemInfo, RawLine, ReceivedSms, SentSms } from './types';

export interface ModemEntry {
  stream: ModemStream;
  parser: ATParser;
}

export interface ModemManagerOptions {
  mockMode?: boolean;
  /**
   * Probe only these ports instead of discovering them. `*` globs are allowed, e.g.
   * `/dev/serial/by-id/usb-HUAWEI_*-if00-port0`.
   */
  ports?: string[];
  /** IMEI or model name → SIM phone number. */
  phoneNumbers?: Record<string, string>;
  /** Forced drivers per port (MODEM_DRIVER). */
  driverOverrides?: DriverOverrides;
  registry?: DriverRegistry;
  /** Simulated modems for mock mode; defaults to DEFAULT_MOCK_FLEET. */
  mockFleet?: MockModemDefinition[];
  scanIntervalMs?: number;
  /** Passed to each ModemStream; see DEFAULT_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
}

interface CandidatePort {
  path: string;
  usbVendorId?: string;
  usbProductId?: string;
}

export interface ModemManagerEvents {
  /** The full list, whenever a modem is added, removed or changes state. */
  list: [modems: ModemInfo[]];
  added: [modem: ModemInfo];
  /** The modem's last known state, with `connected: false`. */
  removed: [modem: ModemInfo];
  status: [modem: ModemInfo];
  raw: [line: RawLine];
  sms: [sms: ReceivedSms];
  smsSent: [sms: SentSms];
  /** Once per incoming call. */
  call: [call: IncomingCall];
  /** An incoming or outgoing call is over. */
  callEnded: [call: EndedCall];
}

export const DEFAULT_SCAN_INTERVAL_MS = 15_000;
/**
 * Ports that did not answer like a new modem are left alone for this long, unless the
 * device node is recreated (unplug and replug), so the hotplug scan does not keep writing
 * AT commands to data and diagnostic interfaces.
 */
const PROBE_RETRY_MS = 5 * 60 * 1_000;

interface ProbeRejection {
  nodeStamp: string;
  rejectedAt: number;
}

const log = logger.child({ component: 'modem-manager' });

/**
 * Discovers modems on serial ports, keeps one ModemStream per physical modem, and
 * re-emits their events tagged with the modem they came from.
 *
 */
export class ModemManager extends EventEmitter<ModemManagerEvents> {
  private readonly modems = new Map<string, ModemEntry>();
  /** IMEI → ID of the connected modem; used to skip a stick's secondary interfaces. */
  private readonly knownImeis = new Map<string, string>();
  /** IMEI → ID, kept after an unplug so a replugged modem gets its old ID back. */
  private readonly idByImei = new Map<string, string>();
  /** Real path → last failed probe. */
  private readonly probeRejections = new Map<string, ProbeRejection>();
  private readonly pollIntervalMs: number | undefined;
  private readonly mockMode: boolean;
  private readonly configuredPorts: string[];
  private readonly phoneNumbers: Record<string, string>;
  private readonly driverOverrides: DriverOverrides;
  private readonly registry: DriverRegistry;
  private readonly mockFleet: MockModemDefinition[];
  private isScanning = false;
  private scanTimer: NodeJS.Timeout | undefined;
  private initialScanTimer: NodeJS.Timeout | undefined;
  private rawLineCounter = 0;

  constructor(options: ModemManagerOptions = {}) {
    super();
    this.mockMode = options.mockMode ?? false;
    this.configuredPorts = options.ports ?? [];
    this.phoneNumbers = options.phoneNumbers ?? {};
    this.driverOverrides = options.driverOverrides ?? {};
    this.registry = options.registry ?? defaultDriverRegistry;
    this.mockFleet = options.mockFleet ?? DEFAULT_MOCK_FLEET;
    this.pollIntervalMs = options.pollIntervalMs;

    if (this.mockMode) {
      this.createMockModems();
    } else {
      this.initialScanTimer = setTimeout(() => void this.scan(), 500);
      const scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
      this.scanTimer = setInterval(() => void this.scan(), scanIntervalMs);
    }
  }

  public lookupPhoneNumber(model: string, imei: string): string | undefined {
    const byImei = imei ? this.phoneNumbers[imei] : undefined;
    if (byImei) return byImei;

    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const cleanModel = normalize(model);
    for (const [key, number] of Object.entries(this.phoneNumbers)) {
      if (cleanModel.includes(normalize(key))) return number;
    }
    return undefined;
  }

  /**
   * Mock modems are SimulatedModems behind FakeSerialPorts. They take the same path as
   * real hardware: the driver is chosen from the identity a probe would read.
   */
  private createMockModems(): void {
    log.info({ count: this.mockFleet.length }, 'starting simulated modems');

    for (const def of this.mockFleet) {
      const simulator = new SimulatedModem(def.profile, def.portPath);
      const identity = simulator.identity;
      this.register(
        new ModemStream({
          id: def.id,
          name: def.name,
          portPath: def.portPath,
          transport: simulator.port,
          simulator,
          driver: this.registry.select(identity, def.portPath, this.driverOverrides),
          identity,
          imei: def.profile.imei,
          phoneNumber: def.phoneNumber,
          // Known up front so the fleet is usable synchronously; startup re-reads both.
          simStatus: simulator.simStatus,
          supportsVoice: def.profile.voice ?? false,
          operator: def.profile.operator,
          signalStrength: def.profile.rssi,
          networkMode: def.networkMode,
          pollIntervalMs: this.pollIntervalMs,
        }),
      );
    }
  }

  private register(stream: ModemStream): void {
    const id = stream.id;
    const parser = new ATParser(stream);
    const entry: ModemEntry = { stream, parser };
    this.modems.set(id, entry);
    if (stream.imei) {
      this.knownImeis.set(stream.imei, id);
      this.idByImei.set(stream.imei, id);
    }

    stream.on('line', (text) => {
      const raw: RawLine = {
        id: (++this.rawLineCounter).toString(36),
        modemId: id,
        modemPort: stream.portPath,
        modemName: stream.name,
        event: text,
        timestamp: new Date().toISOString(),
      };
      this.emit('raw', raw);
    });

    const tag = { modemId: id, modemPort: stream.portPath };

    stream.on('status', (info) => {
      // A removed modem's final "disconnected" update would otherwise re-add it downstream.
      if (this.modems.get(id) !== entry) return;
      this.emit('status', info);
      this.emitList();
    });

    stream.on('smsSent', (sms) => this.emit('smsSent', { ...sms, ...tag }));
    stream.on('callEnded', (call) => this.emit('callEnded', { ...call, ...tag }));

    parser.on('sms', (sms) => {
      const event: ReceivedSms = { ...sms, recipientNumber: stream.phoneNumber };
      this.emit('sms', event);
    });

    parser.on('call', (call) => {
      const event: IncomingCall = { ...call, recipientNumber: stream.phoneNumber };
      this.emit('call', event);
    });

    parser.on('callEnded', (call) => this.emit('callEnded', call));

    stream.on('close', () => {
      if (this.modems.get(id) !== entry) return;
      log.info({ modemId: id, port: stream.portPath }, 'modem removed');
      if (stream.imei && this.knownImeis.get(stream.imei) === id) {
        this.knownImeis.delete(stream.imei);
      }
      parser.close();
      this.modems.delete(id);
      // Probe again right away: the replugged stick may come back on another port.
      this.probeRejections.clear();
      this.emit('removed', { ...stream.getInfo(), connected: false });
      this.emitList();
    });

    this.emit('added', stream.getInfo());
    this.emitList();
  }

  private emitList(): void {
    this.emit('list', this.getModemList());
  }

  public getModemList(): ModemInfo[] {
    return [...this.modems.values()].map((m) => m.stream.getInfo());
  }

  public getAllModems(): ModemEntry[] {
    return [...this.modems.values()];
  }

  public getDefaultModem(): ModemEntry | undefined {
    return this.modems.values().next().value;
  }

  /**
   * Finds a modem by, in order: its ID, its port path (or the end of it, e.g. `ttyUSB0`),
   * its IMEI, part of its model name, or its phone number (digits only are compared).
   */
  public getModem(query: string): ModemEntry | undefined {
    const exact = this.modems.get(query);
    if (exact) return exact;

    const needle = query.trim().toLowerCase();
    const needleDigits = needle.replace(/\D/g, '');
    if (!needle) return undefined;

    const entries = [...this.modems.values()];
    const matchers: ((s: ModemStream) => boolean)[] = [
      (s) => s.id.toLowerCase() === needle,
      (s) => s.portPath.toLowerCase() === needle || s.portPath.toLowerCase().endsWith(needle),
      (s) => s.imei === needle,
      (s) => s.model.toLowerCase().includes(needle),
      (s) => !!needleDigits && s.phoneNumber?.replace(/\D/g, '') === needleDigits,
    ];
    for (const matches of matchers) {
      const found = entries.find((e) => matches(e.stream));
      if (found) return found;
    }
    return undefined;
  }

  public async scan(): Promise<ModemInfo[]> {
    if (this.mockMode || this.isScanning) return this.getModemList();

    this.isScanning = true;
    try {
      const activePorts = new Set(this.getAllModems().map((m) => resolvePath(m.stream.portPath)));
      for (const candidate of await this.discoverCandidatePorts()) {
        // /dev/serial/by-id symlinks and their targets are the same device.
        const realPath = resolvePath(candidate.path);
        if (activePorts.has(realPath)) continue;
        activePorts.add(realPath);

        const stamp = nodeStamp(realPath);
        const rejection = this.probeRejections.get(realPath);
        if (rejection?.nodeStamp === stamp && Date.now() - rejection.rejectedAt < PROBE_RETRY_MS) {
          continue;
        }

        try {
          if (await this.adoptPort(candidate)) {
            this.probeRejections.delete(realPath);
          } else {
            this.probeRejections.set(realPath, { nodeStamp: stamp, rejectedAt: Date.now() });
          }
        } catch (err) {
          log.warn({ err, port: candidate.path }, 'error probing port');
        }
      }
    } catch (err) {
      log.error({ err }, 'modem scan failed');
    } finally {
      this.isScanning = false;
    }
    return this.getModemList();
  }

  private async adoptPort(candidate: CandidatePort): Promise<boolean> {
    const portPath = candidate.path;
    const serialPort = await openSerialPort(portPath);
    if (!serialPort) return false;

    const probe = await probeModem(serialPort);
    if (!probe) {
      if (serialPort.isOpen) serialPort.close();
      return false;
    }

    // Huawei sticks expose two or three AT-capable interfaces. The first one found wins;
    // the others report the same IMEI and are released.
    const owner = probe.imei ? this.knownImeis.get(probe.imei) : undefined;
    if (owner) {
      log.debug({ port: portPath, owner }, 'skipping secondary interface of a known modem');
      serialPort.close();
      return false;
    }

    const identity: ModemIdentity = {
      ...probe.identity,
      usbVendorId: candidate.usbVendorId,
      usbProductId: candidate.usbProductId,
    };
    const model = identity.model ?? '';
    const driver = this.registry.select(identity, portPath, this.driverOverrides);
    const id = this.allocateModemId(probe.imei);
    const label = [identity.manufacturer, model].filter(Boolean).join(' ') || 'Modem';
    const phoneNumber = this.lookupPhoneNumber(model, probe.imei);
    log.info(
      {
        modemId: id,
        port: portPath,
        model: model || undefined,
        simStatus: probe.simStatus,
        driver: driver.name,
      },
      'modem detected',
    );

    this.register(
      new ModemStream({
        id,
        name: `${label} (${portPath})`,
        portPath,
        transport: serialPort,
        driver,
        identity,
        imei: probe.imei,
        phoneNumber,
        simStatus: probe.simStatus,
        pollIntervalMs: this.pollIntervalMs,
      }),
    );
    return true;
  }

  /**
   * The ID this modem had before it was unplugged, else the lowest `modem-N` that is
   * neither connected nor remembered for another IMEI. IDs therefore stay stable across
   * replugs and never move to a different stick.
   */
  public allocateModemId(imei: string): string {
    const previous = imei ? this.idByImei.get(imei) : undefined;
    if (previous && !this.modems.has(previous)) return previous;

    const reserved = new Set([...this.modems.keys(), ...this.idByImei.values()]);
    for (let n = 1; ; n++) {
      const id = `modem-${n}`;
      if (!reserved.has(id)) return id;
    }
  }

  /**
   * Explicit ports are used exclusively. Otherwise only USB serial and CDC-ACM nodes are
   * considered: on-board UARTs (ttyS*, ttyAMA*) are the console or Bluetooth on a
   * Raspberry Pi and must never receive AT commands.
   */
  private async discoverCandidatePorts(): Promise<CandidatePort[]> {
    let paths: string[];
    if (this.configuredPorts.length > 0) {
      paths = this.configuredPorts.flatMap(expandGlob);
    } else if (process.platform === 'linux') {
      paths = listDir('/dev', /^tty(USB|ACM)\d+$/);
    } else if (process.platform === 'darwin') {
      paths = listDir('/dev', /^cu\.(usbmodem|usbserial|wchusbserial|HUAWEI)/i);
    } else {
      paths = [];
    }

    // SerialPort.list() reports USB VID:PID, which drivers match on. It relies on udev
    // and misses devices inside some containers, so it only adds detail on Linux and macOS.
    const usbIds = new Map<string, { usbVendorId?: string; usbProductId?: string }>();
    try {
      for (const port of await SerialPort.list()) {
        if (!port.path) continue;
        usbIds.set(resolvePath(port.path), {
          usbVendorId: port.vendorId?.toLowerCase(),
          usbProductId: port.productId?.toLowerCase(),
        });
        if (this.configuredPorts.length === 0 && paths.length === 0) paths.push(port.path);
      }
    } catch (err) {
      log.debug({ err }, 'SerialPort.list() failed');
    }

    return paths.map((p) => ({ path: p, ...usbIds.get(resolvePath(p)) }));
  }

  public close(): void {
    clearTimeout(this.initialScanTimer);
    clearInterval(this.scanTimer);
    for (const { parser, stream } of this.modems.values()) {
      parser.close();
      stream.close();
    }
    this.modems.clear();
    this.knownImeis.clear();
    this.probeRejections.clear();
  }
}

function listDir(dir: string, pattern: RegExp): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/** Expands a `*` in the last path segment; plain paths are kept if they exist. */
export function expandGlob(pattern: string): string[] {
  if (!pattern.includes('*')) return fs.existsSync(pattern) ? [pattern] : [];
  const base = path
    .basename(pattern)
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return listDir(path.dirname(pattern), new RegExp(`^${base}$`));
}

/** Resolves /dev/serial/by-id symlinks so one device is never probed twice. */
function resolvePath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Changes when the device node is recreated, i.e. after an unplug and replug. */
function nodeStamp(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${st.rdev}:${st.ino}:${st.ctimeMs}`;
  } catch {
    return 'missing';
  }
}
