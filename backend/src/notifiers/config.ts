import fs from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateEventPatterns } from '../events/filter';
import type { HomeAssistantOptions, MqttQos } from './mqtt';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './retry';

export interface WebhookSinkConfig {
  type: 'webhook';
  name: string;
  url: string;
  events: string[];
  modems?: string[];
  secret?: string;
  timeoutMs: number;
  retry: RetryPolicy;
  headers: Record<string, string>;
}

export interface MqttSinkConfig {
  type: 'mqtt';
  name: string;
  url: string;
  events: string[];
  modems?: string[];
  username?: string;
  password?: string;
  clientId?: string;
  topicPrefix: string;
  qos: MqttQos;
  retainStatus: boolean;
  homeAssistant: HomeAssistantOptions;
}

export type SinkConfig = WebhookSinkConfig | MqttSinkConfig;

export interface NotifiersConfig {
  sinks: SinkConfig[];
  modemStatusMinIntervalMs: number;
}

type Env = Record<string, string | undefined>;

/**
 * Everything but `modem.status`, which changes with every signal fluctuation. Over HTTP
 * that is an automation run each time; opt in with `events: ["*"]`.
 */
export const DEFAULT_WEBHOOK_EVENTS = ['sms.*', 'call.*', 'modem.added', 'modem.removed'];
export const DEFAULT_MQTT_EVENTS = ['*'];
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_MODEM_STATUS_MIN_INTERVAL_MS = 10_000;
export const DEFAULT_TOPIC_PREFIX = 'gsm2http';

/** Reads CONFIG_FILE (if set) and the notifier env vars into one list of sinks. */
export function loadNotifiersConfig(env: Env): NotifiersConfig {
  const file = env.CONFIG_FILE?.trim();
  if (!file) return parseNotifiersConfig(undefined, env);

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`CONFIG_FILE: cannot read ${file}: ${(err as Error).message}`, { cause: err });
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    throw new Error(`${file}: ${(err as Error).message}`, { cause: err });
  }
  return parseNotifiersConfig(parsed ?? {}, env, file);
}

/**
 * Sinks from the file come first, then those from env vars (`WEBHOOK_URL`, `MQTT_URL`).
 * Both are optional, and they can be combined. `WEBHOOK_SECRET` signs env webhooks and is
 * the default for file webhooks that set no `secret` of their own.
 */
export function parseNotifiersConfig(
  file: unknown,
  env: Env,
  source = 'config file',
): NotifiersConfig {
  const root = Reader.root(file ?? {}, source, env);
  root.allowOnly(['notifiers', 'events']);

  const events = root.object('events');
  events?.allowOnly(['modemStatusMinIntervalMs']);

  const sinks: SinkConfig[] = [];
  const list = root.list('notifiers') ?? [];
  list.forEach((entry) => sinks.push(parseSink(entry, env)));
  sinks.push(...envSinks(env));

  const names = new Set<string>();
  for (const sink of sinks) {
    if (names.has(sink.name)) {
      throw new Error(`notifier name "${sink.name}" is used twice; give each sink a unique name`);
    }
    names.add(sink.name);
  }

  return {
    sinks,
    modemStatusMinIntervalMs:
      envInt(env, 'MODEM_STATUS_MIN_INTERVAL_MS', { min: 0 }) ??
      events?.int('modemStatusMinIntervalMs', { min: 0 }) ??
      DEFAULT_MODEM_STATUS_MIN_INTERVAL_MS,
  };
}

function parseSink(entry: Reader, env: Env): SinkConfig {
  const type = entry.string('type', { required: true });
  if (type === 'webhook') return parseWebhook(entry, env);
  if (type === 'mqtt') return parseMqtt(entry);
  throw entry.error('type', `must be "webhook" or "mqtt", got "${type}"`);
}

function parseWebhook(entry: Reader, env: Env): WebhookSinkConfig {
  entry.allowOnly([
    'type',
    'name',
    'url',
    'events',
    'modems',
    'secret',
    'timeoutMs',
    'retry',
    'headers',
  ]);
  const url = entry.url('url', ['http:', 'https:']);
  const retry = entry.object('retry');
  retry?.allowOnly(['maxAttempts', 'initialDelayMs', 'maxDelayMs', 'factor']);
  const secret = entry.has('secret') ? entry.string('secret') : envString(env, 'WEBHOOK_SECRET');

  return {
    type: 'webhook',
    name: entry.string('name') ?? entry.defaultName('webhook'),
    url,
    events: entry.events('events', DEFAULT_WEBHOOK_EVENTS),
    ...optional('modems', entry.stringList('modems')),
    ...optional('secret', secret || undefined),
    timeoutMs: entry.int('timeoutMs', { min: 1 }) ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
    retry: {
      maxAttempts: retry?.int('maxAttempts', { min: 1 }) ?? DEFAULT_RETRY_POLICY.maxAttempts,
      initialDelayMs:
        retry?.int('initialDelayMs', { min: 0 }) ?? DEFAULT_RETRY_POLICY.initialDelayMs,
      maxDelayMs: retry?.int('maxDelayMs', { min: 0 }) ?? DEFAULT_RETRY_POLICY.maxDelayMs,
      factor: retry?.number('factor', { min: 1 }) ?? DEFAULT_RETRY_POLICY.factor,
    },
    headers: entry.stringMap('headers') ?? {},
  };
}

function parseMqtt(entry: Reader): MqttSinkConfig {
  entry.allowOnly([
    'type',
    'name',
    'url',
    'events',
    'modems',
    'username',
    'password',
    'clientId',
    'topicPrefix',
    'qos',
    'retainStatus',
    'homeAssistant',
  ]);
  const ha = entry.object('homeAssistant');
  ha?.allowOnly(['discovery', 'prefix']);
  const qos = entry.int('qos', { min: 0 }) ?? 1;
  if (qos > 2) throw entry.error('qos', 'must be 0, 1 or 2');

  return {
    type: 'mqtt',
    name: entry.string('name') ?? entry.defaultName('mqtt'),
    url: entry.url('url', ['mqtt:', 'mqtts:', 'ws:', 'wss:']),
    events: entry.events('events', DEFAULT_MQTT_EVENTS),
    ...optional('modems', entry.stringList('modems')),
    ...optional('username', entry.string('username')),
    ...optional('password', entry.string('password')),
    ...optional('clientId', entry.string('clientId')),
    topicPrefix: topicPrefix(entry.string('topicPrefix') ?? DEFAULT_TOPIC_PREFIX, entry.path),
    qos: qos as MqttQos,
    retainStatus: entry.boolean('retainStatus') ?? true,
    homeAssistant: {
      discovery: ha?.boolean('discovery') ?? false,
      prefix: ha?.string('prefix') ?? 'homeassistant',
    },
  };
}

function envSinks(env: Env): SinkConfig[] {
  const sinks: SinkConfig[] = [];
  const urls = (envString(env, 'WEBHOOK_URL') ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  urls.forEach((url, i) => {
    if (!isUrl(url, ['http:', 'https:'])) {
      throw new Error(`WEBHOOK_URL: "${url}" is not an absolute http(s) URL`);
    }
    const events = envList(env, 'WEBHOOK_EVENTS');
    const secret = envString(env, 'WEBHOOK_SECRET');
    sinks.push({
      type: 'webhook',
      name: urls.length === 1 ? 'webhook' : `webhook-${i + 1}`,
      url,
      events: events ? validateEventPatterns(events, 'WEBHOOK_EVENTS') : DEFAULT_WEBHOOK_EVENTS,
      ...optional('secret', secret),
      timeoutMs: envInt(env, 'WEBHOOK_TIMEOUT_MS', { min: 1 }) ?? DEFAULT_WEBHOOK_TIMEOUT_MS,
      retry: {
        ...DEFAULT_RETRY_POLICY,
        maxAttempts:
          envInt(env, 'WEBHOOK_MAX_ATTEMPTS', { min: 1 }) ?? DEFAULT_RETRY_POLICY.maxAttempts,
      },
      headers: {},
    });
  });

  const mqttUrl = envString(env, 'MQTT_URL');
  if (mqttUrl) {
    if (!isUrl(mqttUrl, ['mqtt:', 'mqtts:', 'ws:', 'wss:'])) {
      throw new Error(`MQTT_URL: "${mqttUrl}" must be an mqtt://, mqtts://, ws:// or wss:// URL`);
    }
    const events = envList(env, 'MQTT_EVENTS');
    sinks.push({
      type: 'mqtt',
      name: 'mqtt',
      url: mqttUrl,
      events: events ? validateEventPatterns(events, 'MQTT_EVENTS') : DEFAULT_MQTT_EVENTS,
      ...optional('username', envString(env, 'MQTT_USERNAME')),
      ...optional('password', envString(env, 'MQTT_PASSWORD')),
      ...optional('clientId', envString(env, 'MQTT_CLIENT_ID')),
      topicPrefix: topicPrefix(
        envString(env, 'MQTT_TOPIC_PREFIX') ?? DEFAULT_TOPIC_PREFIX,
        'MQTT_TOPIC_PREFIX',
      ),
      qos: 1,
      retainStatus: true,
      homeAssistant: {
        discovery: envBoolean(env, 'MQTT_HA_DISCOVERY') ?? false,
        prefix: envString(env, 'MQTT_HA_PREFIX') ?? 'homeassistant',
      },
    });
  }
  return sinks;
}

function topicPrefix(value: string, source: string): string {
  const prefix = value.replace(/\/+$/, '');
  if (!prefix || /[+#]/.test(prefix)) {
    throw new Error(`${source}: topic prefix must be non-empty and contain no "+" or "#"`);
  }
  return prefix;
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function isUrl(value: string, protocols: string[]): boolean {
  return URL.canParse(value) && protocols.includes(new URL(value).protocol);
}

function envString(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function envList(env: Env, name: string): string[] | undefined {
  const value = envString(env, name);
  return value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function envInt(env: Env, name: string, { min }: { min: number }): number | undefined {
  const value = envString(env, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min)
    throw new Error(`${name} must be an integer ≥ ${min}, got "${value}"`);
  return n;
}

function envBoolean(env: Env, name: string): boolean | undefined {
  const value = envString(env, name);
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

/** `${NAME}` and `${NAME:-fallback}` in string values; `$${` stays a literal `${`. */
export function interpolate(value: string, env: Env, where: string): string {
  return value.replace(
    /\$(\$?)\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (match, escaped, name: string, fallback?: string) => {
      if (escaped) return match.slice(1);
      const resolved = env[name];
      if (resolved !== undefined && resolved !== '') return resolved;
      if (fallback !== undefined) return fallback;
      throw new Error(`${where}: environment variable ${name} is not set`);
    },
  );
}

/** Typed, path-aware access to one object in the config file. */
class Reader {
  private constructor(
    private readonly value: Record<string, unknown>,
    public readonly path: string,
    private readonly env: Env,
    private readonly index?: number,
  ) {}

  public static root(value: unknown, source: string, env: Env): Reader {
    if (!isPlainObject(value)) throw new Error(`${source}: must be a mapping at the top level`);
    return new Reader(value, source, env);
  }

  public error(key: string, message: string): Error {
    return new Error(`${this.path}.${key}: ${message}`);
  }

  public has(key: string): boolean {
    return this.value[key] !== undefined && this.value[key] !== null;
  }

  public allowOnly(keys: string[]): void {
    for (const key of Object.keys(this.value)) {
      if (!keys.includes(key)) {
        throw new Error(`${this.path}: unknown setting "${key}". Allowed: ${keys.join(', ')}`);
      }
    }
  }

  public defaultName(type: string): string {
    return this.index === undefined ? type : `${type}-${this.index + 1}`;
  }

  public string(key: string, opts?: { required?: false }): string | undefined;
  public string(key: string, opts: { required: true }): string;
  public string(key: string, { required = false } = {}): string | undefined {
    const raw = this.value[key];
    if (raw === undefined || raw === null) {
      if (required) throw this.error(key, 'is required');
      return undefined;
    }
    // YAML turns unquoted 007123 into 7123 and long digit strings into floats, which would
    // silently corrupt secrets and passwords.
    if (typeof raw === 'number') throw this.error(key, `must be a quoted string, e.g. '${raw}'`);
    if (typeof raw !== 'string') throw this.error(key, 'must be a string');
    return interpolate(raw, this.env, `${this.path}.${key}`).trim();
  }

  public url(key: string, protocols: string[]): string {
    const value = this.string(key, { required: true });
    if (!isUrl(value, protocols)) {
      throw this.error(
        key,
        `"${value}" must be an absolute URL (${protocols.map((p) => `${p}//`).join(', ')})`,
      );
    }
    return value;
  }

  public number(key: string, { min }: { min: number }): number | undefined {
    const raw = this.value[key];
    if (raw === undefined || raw === null) return undefined;
    const n =
      typeof raw === 'string' ? Number(interpolate(raw, this.env, `${this.path}.${key}`)) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min) {
      throw this.error(key, `must be a number ≥ ${min}`);
    }
    return n;
  }

  public int(key: string, opts: { min: number }): number | undefined {
    const n = this.number(key, opts);
    if (n !== undefined && !Number.isInteger(n)) throw this.error(key, 'must be a whole number');
    return n;
  }

  public boolean(key: string): boolean | undefined {
    const raw = this.value[key];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw === 'boolean') return raw;
    const s = typeof raw === 'string' ? interpolate(raw, this.env, `${this.path}.${key}`) : raw;
    if (s === 'true') return true;
    if (s === 'false') return false;
    throw this.error(key, 'must be true or false');
  }

  public stringList(key: string): string[] | undefined {
    const raw = this.value[key];
    if (raw === undefined || raw === null) return undefined;
    const items = typeof raw === 'string' ? raw.split(',') : raw;
    if (!Array.isArray(items) || !items.every((i) => typeof i === 'string')) {
      throw this.error(key, 'must be a list of strings');
    }
    return items.map((i) => interpolate(i, this.env, `${this.path}.${key}`).trim()).filter(Boolean);
  }

  public events(key: string, fallback: string[]): string[] {
    const list = this.stringList(key);
    return list ? validateEventPatterns(list, `${this.path}.${key}`) : fallback;
  }

  public stringMap(key: string): Record<string, string> | undefined {
    const raw = this.value[key];
    if (raw === undefined || raw === null) return undefined;
    if (!isPlainObject(raw)) throw this.error(key, 'must be a mapping');
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number')
        throw this.error(`${key}.${k}`, `must be a quoted string, e.g. '${v}'`);
      if (typeof v !== 'string') throw this.error(`${key}.${k}`, 'must be a string');
      map[k] = interpolate(v, this.env, `${this.path}.${key}.${k}`);
    }
    return map;
  }

  public object(key: string): Reader | undefined {
    const raw = this.value[key];
    if (raw === undefined || raw === null) return undefined;
    if (!isPlainObject(raw)) throw this.error(key, 'must be a mapping');
    return new Reader(raw, `${this.path}.${key}`, this.env);
  }

  public list(key: string): Reader[] | undefined {
    const raw = this.value[key];
    if (raw === undefined || raw === null) return undefined;
    if (!Array.isArray(raw)) throw this.error(key, 'must be a list');
    return raw.map((item, i) => {
      const path = `${this.path}.${key}[${i}]`;
      if (!isPlainObject(item)) throw new Error(`${path}: must be a mapping`);
      return new Reader(item, path, this.env, i);
    });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
