import { DIALABLE_NUMBER, SIM_PIN } from '../atInput';
import { PDUParser } from '../PDUParser';
import type { NetworkMode, SimStatus } from '../types';
import type {
  ModemCapabilities,
  ModemContext,
  ModemDriver,
  ModemIdentity,
  ModemStatePatch,
  SendSmsResult,
} from './types';

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isOk = (lines: string[]): boolean => lines.some((l) => l === 'OK');

/** The first number `pattern` captures from response lines, if any. */
export function parseAttempts(lines: string[], pattern: RegExp): number | undefined {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return undefined;
}

/** Maps a +CPIN: / +CME ERROR line to a SIM status (3GPP TS 27.007 §8.3, §9.2). */
export function parseSimStatus(line: string): SimStatus | undefined {
  if (line.includes('+CPIN: READY')) return 'READY';
  if (line.includes('+CPIN: SIM PIN') || line.includes('+CME ERROR: 11')) return 'SIM PIN';
  if (line.includes('+CPIN: SIM PUK') || line.includes('+CME ERROR: 12')) return 'SIM PUK';
  if (line.includes('+CPIN: NOT INSERTED') || line.includes('+CME ERROR: 10')) return 'NO SIM';
  return undefined;
}

/**
 * Standard 3GPP TS 27.007 / 27.005 behaviour. Used for any modem no other driver
 * claims, and the base class for vendor drivers.
 */
export class GenericDriver implements ModemDriver {
  public readonly name: string = 'generic';
  public readonly label: string = 'Generic 3GPP (TS 27.007 / 27.005)';

  public matches(_identity: ModemIdentity): number {
    return 1;
  }

  public isFinalResponse(line: string): boolean {
    return (
      line === 'OK' ||
      line === 'ERROR' ||
      line.startsWith('+CMS ERROR:') ||
      line.startsWith('+CME ERROR:') ||
      line === 'NO CARRIER' ||
      line === 'BUSY' ||
      line === 'NO ANSWER' ||
      line === 'NO DIALTONE'
    );
  }

  public isUrc(line: string): boolean {
    return (
      line.startsWith('+CMTI:') ||
      line.startsWith('+CMT:') ||
      line.startsWith('+CLIP:') ||
      line.startsWith('+CRING:') ||
      line.startsWith('+CUSD:') ||
      line === 'RING'
    );
  }

  public isCallEnded(line: string): boolean {
    return line === 'NO CARRIER' || line === 'BUSY' || line === 'NO ANSWER';
  }

  public handleLine(line: string, _ctx: ModemContext): ModemStatePatch | undefined {
    const simStatus = parseSimStatus(line);
    if (simStatus) return { simStatus };

    const csq = /^\+CSQ:\s*(\d+)/.exec(line);
    if (csq?.[1]) return { signalStrength: Number(csq[1]) };

    const cops = /^\+COPS:\s*\d+,\d+,"([^"]+)"(?:,(\d+))?/.exec(line);
    if (cops?.[1]) {
      const patch: ModemStatePatch = { operator: cops[1] };
      const act = cops[2] !== undefined ? GenericDriver.ACCESS_TECHNOLOGIES[cops[2]] : undefined;
      if (act) patch.accessTechnology = act;
      return patch;
    }
    return undefined;
  }

  /** <AcT> values of +COPS (TS 27.007 §7.3). */
  protected static readonly ACCESS_TECHNOLOGIES: Record<string, string> = {
    '0': 'GSM',
    '2': 'UTRAN',
    '3': 'GSM/EGPRS',
    '4': 'UTRAN/HSDPA',
    '5': 'UTRAN/HSUPA',
    '6': 'UTRAN/HSPA',
    '7': 'LTE',
  };

  public async querySimStatus(ctx: ModemContext): Promise<SimStatus> {
    const lines = await ctx.send('AT+CPIN?', 3000);
    for (const line of lines) {
      const status = parseSimStatus(line);
      if (status) return status;
    }
    return ctx.getInfo().simStatus;
  }

  /** The init sequence, in order. Override to add vendor commands. */
  protected initCommands(): string[] {
    return [
      'AT+CFUN=1',
      'AT+CPMS="SM","SM","SM"', // read/write/receive storage on the SIM
      'AT+CMGF=0', // PDU mode
      'AT+CNMI=2,1,0,0,0', // announce new SMS with +CMTI
    ];
  }

  public async init(ctx: ModemContext): Promise<void> {
    for (const command of this.initCommands()) {
      await ctx.send(command);
    }
  }

  public async probeCapabilities(ctx: ModemContext): Promise<ModemCapabilities> {
    const ussd = isOk(await ctx.send('AT+CUSD=?', 2000).catch((): string[] => []));
    // Plain 3GPP gives no reliable way to tell a voice-capable stick from a
    // data-only one, so voice stays off until a vendor driver says otherwise.
    return { sms: true, voice: false, ussd, audio: false };
  }

  public async unlock(ctx: ModemContext, pin: string): Promise<boolean> {
    if (!SIM_PIN.test(pin)) throw new Error('PIN must be 4 to 8 digits');
    const lines = await ctx.send(`AT+CPIN="${pin}"`, 5000);
    return isOk(lines);
  }

  /** AT+CPINR (TS 27.007 §8.65): `+CPINR: SIM PIN,<retries>,<default retries>`. */
  public async queryPinAttemptsLeft(ctx: ModemContext): Promise<number | undefined> {
    const lines = await ctx.send('AT+CPINR="SIM PIN"', 3000);
    return parseAttempts(lines, /^\+CPINR:\s*"?SIM PIN"?,\s*(\d+)/);
  }

  public async sendSms(ctx: ModemContext, to: string, text: string): Promise<SendSmsResult> {
    const parts = PDUParser.encodeSubmitPdus({ recipient: to, text });
    const messageReferences: number[] = [];

    for (const [i, part] of parts.entries()) {
      const lines = await ctx.sendWithPrompt(`AT+CMGS=${part.tpduLength}`, part.pdu, 60000);
      const ref = lines.map((l) => /^\+CMGS:\s*(\d+)/.exec(l)?.[1]).find(Boolean);
      if (!ref) {
        throw new Error(
          `SMS part ${i + 1}/${parts.length} rejected: ${lines.join(' ') || 'no response'}`,
        );
      }
      messageReferences.push(Number(ref));
    }

    return { parts: parts.length, messageReferences };
  }

  public async dial(ctx: ModemContext, number: string): Promise<void> {
    // `;` makes this a voice call; anything after the number would be a second command.
    if (!DIALABLE_NUMBER.test(number)) throw new Error('Not a dialable number');
    let lines: string[];
    try {
      lines = await ctx.send(`ATD${number};`);
    } catch {
      return; // some firmware only answers ATD once the call connects; the call timer still runs
    }
    // NO CARRIER / BUSY also end the command, but the stream already treats those as call end
    if (lines.some((l) => l.includes('ERROR'))) {
      throw new Error(lines.join(' '));
    }
  }

  public async hangup(ctx: ModemContext): Promise<void> {
    // Fast hangup: AT+CHUP right away, ATH shortly after for firmware that ignores CHUP
    ctx.write('AT+CHUP');
    await delay(50);
    ctx.write('ATH');
  }

  public async querySignal(ctx: ModemContext): Promise<ModemStatePatch> {
    const lines = await ctx.send('AT+CSQ', 2000);
    return this.collectState(lines, ctx);
  }

  public async queryNetwork(ctx: ModemContext): Promise<ModemStatePatch> {
    const creg = await ctx.send('AT+CREG?', 2000);
    const cops = await ctx.send('AT+COPS?', 2000);
    return this.collectState([...creg, ...cops], ctx);
  }

  public async setNetworkMode(ctx: ModemContext, mode: NetworkMode): Promise<void> {
    // AT+WS46 (TS 27.007 §5.9): 12 = GERAN only, 22 = UTRAN only, 25 = all 3GPP RATs
    const ws46: Record<NetworkMode, number> = { '2g': 12, '3g': 22, auto: 25 };
    const lines = await ctx.send(`AT+WS46=${ws46[mode]}`, 3000);
    if (!isOk(lines)) {
      throw new Error(
        `Modem does not support AT+WS46 network selection (${lines.join(' ') || 'no response'})`,
      );
    }
  }

  /** Runs response lines through handleLine() and merges the results. */
  protected collectState(lines: string[], ctx: ModemContext): ModemStatePatch {
    const patch: ModemStatePatch = {};
    for (const line of lines) {
      Object.assign(patch, this.handleLine(line, ctx));
    }
    return patch;
  }
}
