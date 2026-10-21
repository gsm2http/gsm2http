import type { EventBus } from '../events';
import type { NotifiersConfig, SinkConfig } from './config';
import { NotifierHub } from './hub';
import { MqttNotifier, type MqttNotifierOptions } from './mqtt';
import { DeliveryLog, type Notifier } from './types';
import { WebhookNotifier, type WebhookNotifierOptions } from './webhook';

export * from './config';
export * from './hub';
export * from './retry';
export * from './signing';
export * from './types';

export interface NotifierOverrides {
  /** Injected by tests to talk to fake endpoints. */
  fetch?: WebhookNotifierOptions['fetch'];
  mqttConnect?: MqttNotifierOptions['connect'];
}

export function createNotifier(
  sink: SinkConfig,
  log: DeliveryLog,
  overrides: NotifierOverrides = {},
): Notifier {
  const filter = { events: sink.events, ...(sink.modems && { modems: sink.modems }) };
  if (sink.type === 'webhook') {
    return new WebhookNotifier({ ...sink, filter, log, fetch: overrides.fetch });
  }
  return new MqttNotifier({ ...sink, filter, log, connect: overrides.mqttConnect });
}

/** Builds every configured sink and subscribes them to the bus. */
export function createNotifierHub(
  bus: EventBus,
  config: NotifiersConfig,
  overrides: NotifierOverrides = {},
): NotifierHub {
  const log = new DeliveryLog();
  const notifiers = config.sinks.map((sink) => createNotifier(sink, log, overrides));
  return new NotifierHub(bus, notifiers, log, {
    modemStatusMinIntervalMs: config.modemStatusMinIntervalMs,
  });
}
