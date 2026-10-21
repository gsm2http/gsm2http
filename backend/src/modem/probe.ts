import { ModemIdentity } from './drivers/types';
import { parseSimStatus } from './drivers/GenericDriver';
import { LineSplitter, ModemTransport } from './transport/ModemTransport';
import { SimStatus } from './types';

export interface ProbeResult {
  identity: ModemIdentity;
  imei: string;
  simStatus: SimStatus;
}

export interface ProbeOptions {
  /** Time to let the port settle before the first command. */
  settleMs?: number;
  commandTimeoutMs?: number;
}

/**
 * Checks whether a freshly opened port is an AT command interface and reads the
 * vendor-neutral identity used to pick a driver. Returns null for ports that do
 * not answer (GPS / diagnostic / PCUI-less interfaces of the same stick).
 *
 * Leaves the transport open either way; the caller decides whether to keep it.
 */
export async function probeModem(
  transport: ModemTransport,
  options: ProbeOptions = {},
): Promise<ProbeResult | null> {
  const settleMs = options.settleMs ?? 300;
  const timeoutMs = options.commandTimeoutMs ?? 800;

  let collector: ((line: string) => void) | null = null;
  const splitter = new LineSplitter((line) => {
    const trimmed = line.trim();
    if (trimmed && collector) collector(trimmed);
  });
  const onData = (chunk: Buffer | string) => splitter.push(chunk);
  transport.on('data', onData);

  const send = (command: string, waitMs: number = timeoutMs): Promise<string[]> =>
    new Promise((resolve) => {
      const lines: string[] = [];
      const finish = () => {
        clearTimeout(timer);
        collector = null;
        resolve(lines);
      };
      const timer = setTimeout(finish, waitMs);
      collector = (line) => {
        lines.push(line);
        if (
          line === 'OK' ||
          line === 'ERROR' ||
          line.includes('+CMS ERROR') ||
          line.includes('+CME ERROR') ||
          line === 'COMMAND NOT SUPPORT'
        ) {
          finish();
        }
      };
      if (!transport.isOpen) {
        finish();
        return;
      }
      try {
        transport.write(`${command}\r\n`);
      } catch {
        finish();
      }
    });

  /**
   * First line that is an actual answer, not an echo, URC or result code.
   * Some firmware prefixes the answer ('+CGMM: "EC25"'), so that is stripped.
   */
  const info = (lines: string[]) =>
    lines
      .map((l) => l.replace(/^\+CG(MI|MM|MR|SN):\s*/, '').replace(/^"(.*)"$/, '$1'))
      .find(
        (l) => l && l !== 'OK' && !l.includes('ERROR') && !/^AT/i.test(l) && !/^[+^]/.test(l),
      ) || '';

  try {
    if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));

    await send('ATE0', timeoutMs * 1.5);
    const at = await send('AT');
    if (!at.includes('OK')) return null;

    const manufacturer = info(await send('AT+CGMI'));
    const model = info(await send('AT+CGMM'));
    const revision = info(await send('AT+CGMR'));
    const imei = info(await send('AT+CGSN')).match(/^\d{14,16}$/)?.[0] || '';

    let simStatus: SimStatus = 'UNKNOWN';
    for (const line of await send('AT+CPIN?')) {
      const status = parseSimStatus(line);
      if (status) {
        simStatus = status;
        break;
      }
    }

    if (!imei && !model && simStatus === 'UNKNOWN') return null;

    return {
      identity: {
        manufacturer: manufacturer || undefined,
        model: model || undefined,
        revision: revision || undefined,
      },
      imei,
      simStatus,
    };
  } finally {
    transport.removeListener('data', onData);
  }
}
