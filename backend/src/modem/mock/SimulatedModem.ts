import { PDUParser } from '../PDUParser';
import { SimStatus } from '../types';
import type { ModemIdentity } from '../drivers/types';
import { FakeResponse, FakeSerialPort } from '../transport/FakeSerialPort';

export interface SimulatedModemProfile {
  manufacturer: string;
  model: string;
  revision?: string;
  imei: string;
  usbVendorId?: string;
  usbProductId?: string;
  /**
   * Which vendor command set the device answers. 'generic' devices reply ERROR
   * to every ^-prefixed command; 'huawei' devices implement ^CVOICE, ^SYSCFG etc.
   */
  dialect?: 'generic' | 'huawei';
  /** SIM state at power-on. Defaults to READY. */
  simStatus?: SimStatus;
  /** If set, only this PIN unlocks the SIM; otherwise any PIN does. */
  pin?: string;
  /** PIN attempts left at power-on (default 3); the SIM locks to PUK when they run out. */
  pinAttempts?: number;
  /** Firmware answers AT+CPINR / AT^CPIN? with the attempts left (default true). */
  reportsPinAttempts?: boolean;
  operator?: string;
  /** Raw RSSI 0-31. */
  rssi?: number;
  voice?: boolean;
  /** Firmware understands ^SYSCFGEX (LTE-era Huawei). */
  lte?: boolean;
}

export interface StoredSms {
  sender: string;
  text: string;
  pduHex: string;
}

/**
 * A scripted AT-command device living behind a FakeSerialPort. It keeps just
 * enough state (SIM lock, SMS storage, sent messages) to behave like real
 * hardware for the full ModemStream + driver + ATParser path.
 */
export class SimulatedModem {
  public readonly port: FakeSerialPort;
  public readonly profile: SimulatedModemProfile;
  public simStatus: SimStatus;
  /** SMS storage, keyed by index (what AT+CMGR / AT+CMGL / AT+CMGD operate on). */
  public readonly storage = new Map<string, StoredSms>();
  /** PDUs submitted with AT+CMGS, in order. */
  public readonly sentPdus: string[] = [];

  /** PIN attempts left before the SIM locks to PUK. */
  public pinAttemptsLeft: number;
  /** Every PIN tried with AT+CPIN, right or wrong. */
  public readonly pinAttempts: string[] = [];

  private nextMessageRef = 1;
  private pendingSubmitLength?: number;

  constructor(
    profile: SimulatedModemProfile,
    port: FakeSerialPort | string = new FakeSerialPort(),
  ) {
    this.profile = profile;
    this.simStatus = profile.simStatus || 'READY';
    this.pinAttemptsLeft = profile.pinAttempts ?? 3;
    this.port = typeof port === 'string' ? new FakeSerialPort({ path: port }) : port;
    this.installRules();
  }

  /** What a port probe would learn about this device. */
  public get identity(): ModemIdentity {
    return {
      manufacturer: this.profile.manufacturer,
      model: this.profile.model,
      revision: this.profile.revision,
      usbVendorId: this.profile.usbVendorId,
      usbProductId: this.profile.usbProductId,
    };
  }

  public storeSms(index: string, sender: string, text: string, pduHex?: string): void {
    const hex = pduHex || PDUParser.encodeDeliverPdu({ sender, text });
    this.storage.set(index, { sender, text, pduHex: hex });
  }

  public storePdu(index: string, pduHex: string): void {
    try {
      const parsed = PDUParser.parse(pduHex);
      this.storage.set(index, { sender: parsed.sender, text: parsed.text, pduHex });
    } catch {
      this.storage.set(index, { sender: 'Unknown', text: '', pduHex });
    }
  }

  /** Stores an SMS and announces it with +CMTI, as the network would. */
  public receiveSms(index: string, sender: string, text: string): void {
    this.storeSms(index, sender, text);
    this.port.inject(`\r\n+CMTI: "SM",${index}\r\n`);
  }

  /** Simulates an incoming call with caller ID. */
  public ring(caller: string): void {
    this.port.inject(`\r\nRING\r\n\r\n+CLIP: "${caller}",145,"",0,"",0\r\n`);
  }

  private simLocked(): FakeResponse | undefined {
    if (this.simStatus === 'READY') return undefined;
    return this.simStatus === 'NO SIM' ? '+CME ERROR: 10' : '+CME ERROR: 11';
  }

  private installRules(): void {
    const p = this.profile;
    const huawei = p.dialect === 'huawei';
    const port = this.port;

    // Registered in reverse priority: onCommand() puts each rule in front.
    port.onCommand(/^AT\^/i, huawei ? 'COMMAND NOT SUPPORT' : 'ERROR');
    if (huawei) {
      port.onCommand(/^AT\^CVOICE=\?$/i, () =>
        p.voice ? ['^CVOICE: (0,1)', 'OK'] : 'COMMAND NOT SUPPORT',
      );
      port.onCommand(/^AT\^CURC=/i, 'OK');
      port.onCommand(/^AT\^SYSCFG=/i, 'OK');
      port.onCommand(/^AT\^SYSCFGEX=/i, () => (p.lte ? 'OK' : 'COMMAND NOT SUPPORT'));
      port.onCommand('AT^CPIN?', () => {
        if (p.reportsPinAttempts === false) return 'COMMAND NOT SUPPORT';
        const code = this.simStatus === 'READY' ? 'READY' : this.simStatus;
        const times = this.simStatus === 'READY' ? '' : String(this.pinAttemptsLeft);
        return [`^CPIN: ${code},${times},10,${this.pinAttemptsLeft},10,3`, 'OK'];
      });
    } else {
      port.onCommand(/^AT\+WS46=/i, 'OK');
    }

    port.onCommand('AT+CGMI', [p.manufacturer, 'OK']);
    port.onCommand('AT+CGMM', [p.model, 'OK']);
    port.onCommand('AT+CGMR', [p.revision || '11.000.00.00.00', 'OK']);
    port.onCommand('AT+CGSN', [p.imei, 'OK']);
    port.onCommand('AT+CSQ', () => [`+CSQ: ${p.rssi ?? 25},99`, 'OK']);
    port.onCommand('AT+COPS?', () => [`+COPS: 0,0,"${p.operator || 'MockTel'}",2`, 'OK']);
    port.onCommand('AT+CREG?', ['+CREG: 0,1', 'OK']);
    port.onCommand('AT+CUSD=?', ['+CUSD: (0,1,2)', 'OK']);

    port.onCommand('AT+CPIN?', () => {
      if (this.simStatus === 'NO SIM') return '+CME ERROR: 10';
      return [`+CPIN: ${this.simStatus === 'READY' ? 'READY' : this.simStatus}`, 'OK'];
    });
    port.onCommand(/^AT\+CPIN="?(\w+)"?$/i, (m) => {
      if (this.simStatus === 'NO SIM') return '+CME ERROR: 10';
      if (this.simStatus === 'SIM PUK') return '+CME ERROR: 12';
      this.pinAttempts.push(m[1] ?? '');
      if (p.pin && m[1] !== p.pin) {
        this.pinAttemptsLeft = Math.max(0, this.pinAttemptsLeft - 1);
        if (this.pinAttemptsLeft === 0) this.simStatus = 'SIM PUK';
        return '+CME ERROR: 16';
      }
      this.pinAttemptsLeft = 3;
      this.simStatus = 'READY';
      return 'OK';
    });
    port.onCommand(/^AT\+CPINR/i, () =>
      p.reportsPinAttempts === false
        ? 'ERROR'
        : [`+CPINR: SIM PIN,${this.pinAttemptsLeft},3`, 'OK'],
    );

    port.onCommand(/^AT\+CMGR=(\d+)$/i, (m) => {
      const locked = this.simLocked();
      if (locked) return locked;
      const entry = this.storage.get(m[1] ?? '');
      if (!entry) return '+CMS ERROR: 321';
      return [`+CMGR: 0,,${Math.floor(entry.pduHex.length / 2)}`, entry.pduHex, 'OK'];
    });
    port.onCommand(/^AT\+CMGL/i, () => {
      const locked = this.simLocked();
      if (locked) return locked;
      const lines: string[] = [];
      for (const [idx, entry] of this.storage) {
        lines.push(`+CMGL: ${idx},0,,${Math.floor(entry.pduHex.length / 2)}`, entry.pduHex);
      }
      return [...lines, 'OK'];
    });
    port.onCommand(/^AT\+CMGD=(\d+)(?:,(\d+))?$/i, (m) => {
      if (m[2] && m[2] !== '0') {
        this.storage.clear();
      } else {
        this.storage.delete(m[1] ?? '');
      }
      return 'OK';
    });

    port.onCommand(/^AT\+CMGS=(\d+)$/i, (m) => {
      const locked = this.simLocked();
      if (locked) return locked;
      this.pendingSubmitLength = Number(m[1]);
      return '> ';
    });
    // The PDU sent after the prompt, terminated by Ctrl-Z.
    // eslint-disable-next-line no-control-regex
    port.onCommand(/^([0-9A-F]*)\x1A$/i, (m) => {
      const expected = this.pendingSubmitLength;
      this.pendingSubmitLength = undefined;
      if (expected === undefined) return 'ERROR';
      const pdu = m[1] ?? '';
      if (pdu.length / 2 - 1 !== expected) return '+CMS ERROR: 304';
      this.sentPdus.push(pdu.toUpperCase());
      return [`+CMGS: ${this.nextMessageRef++ % 256}`, 'OK'];
    });

    port.onCommand(/^ATD.+;$/i, () => (p.voice ? 'OK' : 'ERROR'));
  }
}
