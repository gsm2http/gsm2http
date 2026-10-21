import type { NetworkMode } from '../types';
import { GenericDriver, isOk, parseAttempts } from './GenericDriver';
import type { ModemCapabilities, ModemContext, ModemIdentity, ModemStatePatch } from './types';

const HUAWEI_USB_VENDOR_ID = '12d1';

interface HuaweiModelQuirks {
  /** Voice calls work (overrides the ^CVOICE probe). */
  voice?: boolean;
  /** Network mode is set with ^SYSCFGEX (LTE-era firmware) rather than ^SYSCFG. */
  syscfgex?: boolean;
}

/** Known sticks. Models not listed fall back to probing. */
const MODEL_QUIRKS: Record<string, HuaweiModelQuirks> = {
  E173: { voice: true, syscfgex: false },
  E3531: { voice: false, syscfgex: false },
  E3372: { voice: false, syscfgex: true },
};

/** sys_mode values of ^MODE / ^SYSINFO. */
const SYS_MODES: Record<string, string> = {
  '0': 'none',
  '3': 'GSM',
  '5': 'WCDMA',
  '7': 'GSM/WCDMA',
  '15': 'TD-SCDMA',
  '17': 'LTE',
};

/** ^SYSCFGEX acqorder / ^SYSCFG mode+order arguments per network mode. */
const SYSCFGEX: Record<NetworkMode, string> = {
  auto: 'AT^SYSCFGEX="00",3FFFFFFF,1,2,7FFFFFFFFFFFFFFF,,',
  '3g': 'AT^SYSCFGEX="02",3FFFFFFF,1,2,7FFFFFFFFFFFFFFF,,',
  '2g': 'AT^SYSCFGEX="01",3FFFFFFF,1,2,7FFFFFFFFFFFFFFF,,',
};
const SYSCFG: Record<NetworkMode, string> = {
  auto: 'AT^SYSCFG=2,2,3FFFFFFF,2,4',
  '3g': 'AT^SYSCFG=14,2,3FFFFFFF,2,4',
  '2g': 'AT^SYSCFG=13,1,3FFFFFFF,2,4',
};

/**
 * Huawei USB sticks (E173, E3531, E3372 and relatives in serial/stick mode).
 */
export class HuaweiDriver extends GenericDriver {
  public override readonly name: string = 'huawei';
  public override readonly label: string = 'Huawei (^CVOICE, ^SYSCFG/^SYSCFGEX, ^RSSI/^MODE)';

  public override matches(identity: ModemIdentity): number {
    if (identity.usbVendorId?.toLowerCase() === HUAWEI_USB_VENDOR_ID) return 100;
    if (identity.manufacturer && /huawei/i.test(identity.manufacturer)) return 100;
    if (identity.model && this.quirksFor(identity)) return 50;
    return 0;
  }

  public override isFinalResponse(line: string): boolean {
    return super.isFinalResponse(line) || line === 'COMMAND NOT SUPPORT';
  }

  public override isUrc(line: string): boolean {
    return (
      super.isUrc(line) ||
      /^\^(BOOT|RSSI|MODE|DSFLOWRPT|SRVST|SIMST|ORIG|CONF|CONN|CEND):/.test(line)
    );
  }

  public override isCallEnded(line: string): boolean {
    return super.isCallEnded(line) || line.startsWith('^CEND:');
  }

  public override handleLine(line: string, ctx: ModemContext): ModemStatePatch | undefined {
    const rssi = /^\^RSSI:\s*(\d+)/.exec(line);
    if (rssi?.[1]) return { signalStrength: Number(rssi[1]) };

    const mode = /^\^MODE:\s*(\d+)/.exec(line);
    if (mode?.[1]) {
      const tech = SYS_MODES[mode[1]];
      return tech ? { accessTechnology: tech } : undefined;
    }

    return super.handleLine(line, ctx);
  }

  protected override initCommands(): string[] {
    const [cfun = 'AT+CFUN=1', ...rest] = super.initCommands();
    // ^CURC=0 silences the periodic ^RSSI/^DSFLOWRPT/^BOOT chatter
    return [cfun, 'AT^CURC=0', ...rest];
  }

  public override async probeCapabilities(ctx: ModemContext): Promise<ModemCapabilities> {
    const caps = await super.probeCapabilities(ctx);
    const quirks = this.quirksFor(ctx.identity);

    let voice = quirks?.voice;
    if (voice === undefined) {
      const lines = await ctx.send('AT^CVOICE=?', 2000).catch(() => [] as string[]);
      voice = lines.some((l) => l.includes('CVOICE')) || isOk(lines);
    }

    // ^CVOICE routes call audio as PCM over a USB serial interface on voice-capable sticks
    return { ...caps, voice, audio: voice };
  }

  /** `^CPIN: <code>,[<times>],<puk_times>,<pin_times>,...`; older firmware lacks +CPINR. */
  public override async queryPinAttemptsLeft(ctx: ModemContext): Promise<number | undefined> {
    const lines = await ctx.send('AT^CPIN?', 3000).catch((): string[] => []);
    return (
      parseAttempts(lines, /^\^CPIN:\s*[^,]*,[^,]*,\d*,(\d+)/) ??
      (await super.queryPinAttemptsLeft(ctx))
    );
  }

  public override async setNetworkMode(ctx: ModemContext, mode: NetworkMode): Promise<void> {
    const quirks = this.quirksFor(ctx.identity);
    const attempts =
      quirks?.syscfgex === false
        ? [SYSCFG[mode]]
        : quirks?.syscfgex
          ? [SYSCFGEX[mode]]
          : [SYSCFGEX[mode], SYSCFG[mode]];

    let lastResponse: string[] = [];
    for (const command of attempts) {
      try {
        lastResponse = await ctx.send(command, 3000);
        if (isOk(lastResponse)) return;
      } catch (err) {
        lastResponse = [err instanceof Error ? err.message : String(err)];
      }
    }
    throw new Error(`Network mode ${mode} rejected: ${lastResponse.join(' ') || 'no response'}`);
  }

  private quirksFor(identity: ModemIdentity): HuaweiModelQuirks | undefined {
    const model = (identity.model || '').toUpperCase();
    const key = Object.keys(MODEL_QUIRKS).find((k) => model.startsWith(k));
    return key ? MODEL_QUIRKS[key] : undefined;
  }
}
