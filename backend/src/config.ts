import path from 'node:path';
import { parseDriverOverrides, type DriverOverrides } from './modem/drivers/registry';
import { loadNotifiersConfig, type NotifiersConfig } from './notifiers/config';

export interface Config {
  port: number;
  /** Address to listen on. The Docker image sets 0.0.0.0. */
  host: string;
  mockMode: boolean;
  /** Explicit serial ports to probe; empty means discover automatically. */
  modemPorts: string[];
  /** IMEI or model name → SIM phone number. Most SIMs don't report their own number. */
  modemNumbers: Record<string, string>;
  /** Forced drivers per port; empty means auto-detect. */
  modemDrivers: DriverOverrides;
  /** Webhook and MQTT sinks, from CONFIG_FILE and the WEBHOOK_* / MQTT_* variables. */
  notifiers: NotifiersConfig;
  defaultCallDurationMs: number;
  /** How often to look for newly plugged-in modems. */
  scanIntervalMs: number;
  /** How often to sweep SIM storage for SMS whose +CMTI notice was missed. */
  pollIntervalMs: number;
  /** Built web UI to serve on the same origin; empty disables it. */
  staticDir: string;
  /** Bearer token required on the REST API and Socket.io; undefined only with AUTH_DISABLED=true. */
  apiToken: string | undefined;
  /** Browser origins allowed to call the API cross-origin; empty means same origin only. */
  corsOrigins: string[];
  rateLimits: RateLimits;
}

/** Per modem, kept in memory (a restart resets them); 0 disables a limit. */
export interface RateLimits {
  smsMinIntervalMs: number;
  smsDailyLimit: number;
  callsHourlyLimit: number;
  unlocksHourlyLimit: number;
}

/** Shorter tokens are refused: the API can send SMS and dial at the owner's expense. */
export const MIN_API_TOKEN_LENGTH = 32;

/** Lower values would keep a modem's AT queue busy with housekeeping. */
const MIN_INTERVAL_MS = 5_000;

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  return {
    port: parsePositiveInt(env.PORT, 9333, 'PORT'),
    host: env.HOST?.trim() || '127.0.0.1',
    mockMode: parseBoolean(env.MOCK_MODE),
    modemPorts: parsePortList(env.MODEM_PORTS),
    modemNumbers: parseModemNumbers(env.MODEM_NUMBERS),
    modemDrivers: parseDriverOverrides(env.MODEM_DRIVER),
    notifiers: loadNotifiersConfig(env),
    defaultCallDurationMs: parsePositiveInt(
      env.DEFAULT_CALL_DURATION_MS,
      10_000,
      'DEFAULT_CALL_DURATION_MS',
    ),
    scanIntervalMs: parseInterval(env.SCAN_INTERVAL_MS, 15_000, 'SCAN_INTERVAL_MS'),
    pollIntervalMs: parseInterval(env.POLL_INTERVAL_MS, 30_000, 'POLL_INTERVAL_MS'),
    staticDir: env.STATIC_DIR ?? path.resolve(__dirname, '../public'),
    apiToken: parseApiToken(env.API_TOKEN, parseBoolean(env.AUTH_DISABLED)),
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    rateLimits: {
      smsMinIntervalMs: parseLimit(env.SMS_MIN_INTERVAL_MS, 10_000, 'SMS_MIN_INTERVAL_MS'),
      smsDailyLimit: parseLimit(env.SMS_DAILY_LIMIT, 50, 'SMS_DAILY_LIMIT'),
      callsHourlyLimit: parseLimit(env.CALLS_HOURLY_LIMIT, 5, 'CALLS_HOURLY_LIMIT'),
      unlocksHourlyLimit: parseLimit(env.UNLOCK_HOURLY_LIMIT, 3, 'UNLOCK_HOURLY_LIMIT'),
    },
  };
}

function parseApiToken(value: string | undefined, authDisabled: boolean): string | undefined {
  if (authDisabled) return undefined;
  const token = value?.trim() ?? '';
  if (token === '') {
    throw new Error(
      'API_TOKEN is required. Generate one with `openssl rand -hex 32` and put it in .env, ' +
        'or set AUTH_DISABLED=true to run without authentication (localhost only!).',
    );
  }
  if (token.length < MIN_API_TOKEN_LENGTH || /\s/.test(token)) {
    throw new Error(
      `API_TOKEN must be at least ${MIN_API_TOKEN_LENGTH} characters with no spaces ` +
        '(try `openssl rand -hex 32`)',
    );
  }
  return token;
}

/** Comma-separated origins such as `https://ha.example.lan:8123`, or `*` for any. */
export function parseCorsOrigins(value: string | undefined): string[] {
  const origins = (value ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  for (const origin of origins) {
    if (origin === '*') continue;
    const parsed = URL.canParse(origin) ? new URL(origin) : undefined;
    if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(
        `CORS_ORIGINS entries must be origins like https://host:port, got "${origin}"`,
      );
    }
  }
  return origins;
}

function parseLimit(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a whole number (0 disables the limit), got "${value}"`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseInterval(value: string | undefined, fallback: number, name: string): number {
  const ms = parsePositiveInt(value, fallback, name);
  if (ms < MIN_INTERVAL_MS) throw new Error(`${name} must be at least ${MIN_INTERVAL_MS} ms`);
  return ms;
}

function parsePortList(value: string | undefined): string[] {
  if (!value || value.trim() === 'auto') return [];
  return value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/** Accepts JSON (`{"<imei>":"+1202..."}`) or `key=value` pairs separated by commas. */
export function parseModemNumbers(value: string | undefined): Record<string, string> {
  if (!value || value.trim() === '') return {};
  const numbers: Record<string, string> = {};

  if (value.trim().startsWith('{')) {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('MODEM_NUMBERS must be a JSON object or key=value pairs');
    }
    for (const [key, number] of Object.entries(parsed)) {
      if (typeof number === 'string') numbers[key.trim().toLowerCase()] = number.trim();
    }
    return numbers;
  }

  for (const pair of value.split(',')) {
    const [key, number] = pair.split('=');
    if (key?.trim() && number?.trim()) numbers[key.trim().toLowerCase()] = number.trim();
  }
  return numbers;
}
