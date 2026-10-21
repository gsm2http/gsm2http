import { connect, type IClientOptions } from 'mqtt';
import { EventName, type AnyGatewayEvent, type EventFilter } from '../events';
import { logger } from '../logger';
import type { ModemInfo } from '../modem/types';
import type { DeliveryLog, Notifier, NotifierStats, NotifierSummary } from './types';
import { redactUrl } from './webhook';

/** How long shutdown waits for the broker to acknowledge the offline message. */
const CLOSE_TIMEOUT_MS = 1_000;

export type MqttQos = 0 | 1 | 2;

export interface HomeAssistantOptions {
  /** Publish MQTT discovery configs so each modem shows up as a device. */
  discovery: boolean;
  /** Home Assistant's discovery prefix. */
  prefix: string;
}

export interface MqttNotifierOptions {
  name: string;
  url: string;
  filter: EventFilter;
  username?: string;
  password?: string;
  clientId?: string;
  /** Topics are `<topicPrefix>/<modemId>/<family>/<action>`, e.g. `gsm2http/modem-1/sms/received`. */
  topicPrefix: string;
  qos: MqttQos;
  /** Retain `modem/status`, so a new subscriber gets each modem's current state at once. */
  retainStatus: boolean;
  homeAssistant: HomeAssistantOptions;
  /** Publishes awaiting the broker beyond which new events are dropped. */
  maxPending?: number;
  log: DeliveryLog;
  /** Injected by tests. */
  connect?: (url: string, options: IClientOptions) => MqttClientLike;
}

/** The part of mqtt.js's MqttClient used here. */
export interface MqttClientLike {
  connected: boolean;
  publish(
    topic: string,
    message: string,
    options: { qos: MqttQos; retain: boolean },
    callback: (error?: Error) => void,
  ): unknown;
  on(event: 'connect' | 'close' | 'offline', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  /** `force` drops queued publishes instead of waiting for them to be acknowledged. */
  endAsync(force?: boolean): Promise<void>;
}

const DEFAULT_MAX_PENDING = 1_000;
const ONLINE = 'online';
const OFFLINE = 'offline';

/**
 * Publishes each event's JSON envelope to a broker. mqtt.js reconnects on its own and
 * queues publishes while offline, so delivery resumes after a broker restart. With QoS 1
 * (the default) a publish counts as delivered once the broker acknowledges it.
 */
export class MqttNotifier implements Notifier {
  public readonly type = 'mqtt' as const;
  public readonly name: string;
  public readonly filter: EventFilter;
  private readonly options: MqttNotifierOptions;
  private readonly client: MqttClientLike;
  private readonly log;
  private readonly stats: NotifierStats = { delivered: 0, failed: 0, pending: 0 };
  /** Last known state per modem ID, to re-announce discovery after a reconnect. */
  private readonly modems = new Map<string, ModemInfo>();
  private readonly announced = new Set<string>();
  private pending = 0;
  private closed = false;
  /** Reconnects happen every few seconds; only the first error of an outage is a warning. */
  private outageLogged = false;

  constructor(options: MqttNotifierOptions) {
    this.options = options;
    this.name = options.name;
    this.filter = options.filter;
    this.log = logger.child({ component: 'mqtt', notifier: options.name });

    const factory = options.connect ?? ((url, opts): MqttClientLike => connect(url, opts));
    this.client = factory(options.url, {
      username: options.username,
      password: options.password,
      clientId: options.clientId,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
      will: { topic: this.availabilityTopic, payload: Buffer.from(OFFLINE), qos: 1, retain: true },
    });

    this.client.on('connect', () => {
      this.log.info({ target: redactUrl(options.url) }, 'MQTT connected');
      this.outageLogged = false;
      this.publish(this.availabilityTopic, ONLINE, true);
      this.announced.clear();
      for (const info of this.modems.values()) this.announce(info);
    });
    this.client.on('offline', () => {
      if (!this.outageLogged) this.log.warn('MQTT broker unreachable, queueing events');
    });
    this.client.on('error', (err) => {
      this.stats.lastError = err.message;
      if (this.outageLogged) {
        this.log.debug({ err }, 'MQTT error');
      } else {
        this.log.warn(
          { err },
          'MQTT error (further errors until it reconnects are logged at debug)',
        );
        this.outageLogged = true;
      }
    });
  }

  private get availabilityTopic(): string {
    return `${this.options.topicPrefix}/status`;
  }

  public topicFor(event: AnyGatewayEvent): string {
    return `${this.options.topicPrefix}/${topicSegment(event.modem.id)}/${event.event.replace('.', '/')}`;
  }

  public deliver(event: AnyGatewayEvent): void {
    if (this.closed) return;
    if (this.pending >= (this.options.maxPending ?? DEFAULT_MAX_PENDING)) {
      this.options.log.add(this.recordFields(event, 'dropped', 'too many pending publishes'));
      this.log.error({ event: event.event, eventId: event.id }, 'MQTT queue full, event dropped');
      return;
    }

    const isModemEvent =
      event.event === EventName.ModemAdded ||
      event.event === EventName.ModemStatus ||
      event.event === EventName.ModemRemoved;
    if (isModemEvent) {
      this.modems.set(event.modem.id, event.data);
      this.announce(event.data);
    }

    const payload = JSON.stringify(event);
    const retain = this.options.retainStatus && event.event === EventName.ModemStatus;
    this.publishTracked(event, this.topicFor(event), payload, retain);
    // The retained state should not stay "connected" after the modem is gone.
    if (this.options.retainStatus && event.event === EventName.ModemRemoved) {
      const statusTopic = `${this.options.topicPrefix}/${topicSegment(event.modem.id)}/modem/status`;
      this.publish(statusTopic, JSON.stringify({ ...event, event: EventName.ModemStatus }), true);
    }
  }

  private publishTracked(
    event: AnyGatewayEvent,
    topic: string,
    payload: string,
    retain: boolean,
  ): void {
    this.pending++;
    const started = Date.now();
    this.client.publish(topic, payload, { qos: this.options.qos, retain }, (err) => {
      this.pending--;
      const durationMs = Date.now() - started;
      if (err) {
        this.stats.failed++;
        this.stats.lastFailureAt = new Date().toISOString();
        this.stats.lastError = err.message;
        this.options.log.add({ ...this.recordFields(event, 'failed', err.message), durationMs });
        this.log.error(
          { err, event: event.event, eventId: event.id, topic },
          'MQTT publish failed',
        );
        return;
      }
      this.stats.delivered++;
      this.stats.lastSuccessAt = new Date().toISOString();
      this.options.log.add({ ...this.recordFields(event, 'delivered'), durationMs });
      this.log.debug({ event: event.event, eventId: event.id, topic }, 'MQTT published');
    });
  }

  /** Housekeeping publishes (availability, discovery) that are not events. */
  private publish(topic: string, payload: string, retain: boolean): void {
    this.client.publish(topic, payload, { qos: 1, retain }, (err) => {
      if (err) this.log.warn({ err, topic }, 'MQTT publish failed');
    });
  }

  private recordFields(
    event: AnyGatewayEvent,
    outcome: 'delivered' | 'failed' | 'dropped',
    error?: string,
  ) {
    return {
      notifier: this.name,
      eventId: event.id,
      event: event.event,
      attempt: 1,
      outcome,
      at: new Date().toISOString(),
      ...(error && { error }),
    };
  }

  /** Publishes Home Assistant discovery for a modem once per connection. */
  private announce(info: ModemInfo): void {
    const ha = this.options.homeAssistant;
    if (!ha.discovery || !this.client.connected) return;
    const key = discoveryKey(info);
    if (this.announced.has(key)) return;
    this.announced.add(key);

    for (const { component, objectId, config } of homeAssistantDiscovery(info, this.options)) {
      const topic = `${ha.prefix}/${component}/gsm2http_${key}/${objectId}/config`;
      this.publish(topic, JSON.stringify(config), true);
    }
  }

  public describe(): NotifierSummary {
    return {
      name: this.name,
      type: this.type,
      target: redactUrl(this.options.url),
      events: this.filter.events,
      ...(this.filter.modems && { modems: this.filter.modems }),
      connected: this.client.connected,
      stats: { ...this.stats, pending: this.pending },
    };
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.client.connected) {
      // The broker may have gone away without `connected` noticing yet, so don't wait
      // for the PUBACK forever.
      await Promise.race([
        new Promise<void>((resolve) => {
          this.client.publish(this.availabilityTopic, OFFLINE, { qos: 1, retain: true }, () => {
            resolve();
          });
        }),
        new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref()),
      ]);
    }
    // Forced: queued QoS 1 publishes would otherwise hold shutdown until a broker that
    // may never come back acknowledges them.
    await this.client.endAsync(true);
  }
}

/** MQTT forbids `+` and `#` in topic names and `/` would add a level. */
function topicSegment(value: string): string {
  return value.replace(/[+#/]/g, '_');
}

/** IMEI where known: it stays the same when the modem ID changes after a restart. */
function discoveryKey(info: ModemInfo): string {
  return (info.imei || info.id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

interface DiscoveryEntry {
  component: 'sensor' | 'binary_sensor' | 'event';
  objectId: string;
  config: Record<string, unknown>;
}

/**
 * Home Assistant MQTT discovery payloads for one modem: signal, operator, SIM status and
 * connectivity sensors read from the retained status topic, and event entities for
 * incoming SMS and calls. See docs/recipes/home-assistant.md.
 */
export function homeAssistantDiscovery(
  info: ModemInfo,
  options: Pick<MqttNotifierOptions, 'topicPrefix'>,
): DiscoveryEntry[] {
  const key = discoveryKey(info);
  const base = `${options.topicPrefix}/${topicSegment(info.id)}`;
  const label = [info.manufacturer, info.model].filter((s) => s && s !== 'Unknown').join(' ');
  const common = {
    availability_topic: `${options.topicPrefix}/status`,
    device: {
      identifiers: [`gsm2http_${key}`],
      name: label || info.id,
      ...(info.manufacturer !== 'Unknown' && { manufacturer: info.manufacturer }),
      ...(info.model !== 'Unknown' && { model: info.model }),
      ...(info.revision && { sw_version: info.revision }),
    },
    origin: { name: 'gsm2http', support_url: 'https://github.com/gsm2http/gsm2http' },
  };
  const status = { ...common, state_topic: `${base}/modem/status` };
  const entry = (
    component: DiscoveryEntry['component'],
    objectId: string,
    config: Record<string, unknown>,
  ): DiscoveryEntry => ({
    component,
    objectId,
    config: { unique_id: `gsm2http_${key}_${objectId}`, ...config },
  });

  return [
    entry('sensor', 'signal', {
      ...status,
      name: 'Signal',
      value_template: '{{ value_json.data.signalPercentage }}',
      unit_of_measurement: '%',
      state_class: 'measurement',
      icon: 'mdi:signal',
    }),
    entry('sensor', 'operator', {
      ...status,
      name: 'Operator',
      value_template: '{{ value_json.data.operator }}',
      icon: 'mdi:radio-tower',
    }),
    entry('sensor', 'sim', {
      ...status,
      name: 'SIM status',
      value_template: '{{ value_json.data.simStatus }}',
      icon: 'mdi:sim',
    }),
    entry('binary_sensor', 'connected', {
      ...status,
      name: 'Connected',
      device_class: 'connectivity',
      value_template: "{{ 'ON' if value_json.data.connected else 'OFF' }}",
    }),
    entry('event', 'sms', {
      ...common,
      name: 'SMS',
      state_topic: `${base}/sms/received`,
      event_types: [EventName.SmsReceived],
      value_template:
        "{{ {'event_type': value_json.event, 'sender': value_json.data.sender, 'text': value_json.data.text} | to_json }}",
      icon: 'mdi:message-text',
    }),
    entry('event', 'call', {
      ...common,
      name: 'Incoming call',
      state_topic: `${base}/call/incoming`,
      event_types: [EventName.CallIncoming],
      value_template:
        "{{ {'event_type': value_json.event, 'number': value_json.data.number, 'call_id': value_json.data.callId} | to_json }}",
      icon: 'mdi:phone-incoming',
    }),
  ];
}
