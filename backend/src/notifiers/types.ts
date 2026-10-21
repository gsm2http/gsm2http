import type { AnyGatewayEvent, EventFilter } from '../events';

export type NotifierType = 'webhook' | 'mqtt';

/**
 * An outbound sink. The hub hands it every event that passes `filter`; the sink owns
 * delivery from there (queueing, retries, reconnects) and must never throw from `deliver`.
 */
export interface Notifier {
  readonly name: string;
  readonly type: NotifierType;
  readonly filter: EventFilter;
  deliver(event: AnyGatewayEvent): void;
  describe(): NotifierSummary;
  /** Stops retries and releases connections. Pending deliveries are abandoned. */
  close(): Promise<void>;
}

export interface NotifierSummary {
  name: string;
  type: NotifierType;
  /** Where events go, with secrets (paths, credentials, query strings) left out. */
  target: string;
  events: string[];
  modems?: string[];
  signed?: boolean;
  /** MQTT only: whether the broker connection is up. */
  connected?: boolean;
  stats: NotifierStats;
}

export interface NotifierStats {
  delivered: number;
  failed: number;
  /** Deliveries in flight or waiting for a retry. */
  pending: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
}

export type DeliveryOutcome = 'delivered' | 'retrying' | 'failed' | 'dropped';

/** One delivery attempt. Never holds the payload: SMS text stays out of the log. */
export interface DeliveryRecord {
  notifier: string;
  eventId: string;
  event: string;
  attempt: number;
  outcome: DeliveryOutcome;
  at: string;
  durationMs?: number;
  /** HTTP status, for webhooks that got a response. */
  status?: number;
  error?: string;
  /** When the next attempt is due, for `retrying`. */
  retryAt?: string;
}

const DEFAULT_LOG_SIZE = 100;

/** The most recent delivery attempts across all sinks, newest first. */
export class DeliveryLog {
  private readonly records: DeliveryRecord[] = [];

  constructor(private readonly size = DEFAULT_LOG_SIZE) {}

  public add(record: DeliveryRecord): void {
    this.records.unshift(record);
    if (this.records.length > this.size) this.records.length = this.size;
  }

  public list(): DeliveryRecord[] {
    return [...this.records];
  }
}
