import { randomUUID } from 'node:crypto';
import type { CallEndReason, ModemInfo } from '../modem/types';

export type { CallEndReason };

/**
 * Version of the event envelope and payloads below. Adding a field is not a breaking
 * change; renaming, removing or changing the meaning of one bumps this number.
 * See docs/events.md.
 */
export const SCHEMA_VERSION = 1;

/** Public events. Webhooks, MQTT and Socket.io all carry exactly these. */
export const EventName = {
  SmsReceived: 'sms.received',
  SmsSent: 'sms.sent',
  CallIncoming: 'call.incoming',
  CallEnded: 'call.ended',
  ModemAdded: 'modem.added',
  ModemRemoved: 'modem.removed',
  ModemStatus: 'modem.status',
} as const;

export type EventType = (typeof EventName)[keyof typeof EventName];

export const EVENT_TYPES: readonly EventType[] = Object.values(EventName);

/** Which modem an event is about. `imei` is the stable key; `id` follows discovery order. */
export interface ModemRef {
  id: string;
  port: string;
  imei?: string;
  phoneNumber?: string;
}

export interface SmsReceivedData {
  /** E.164 number, or an alphanumeric sender ID such as `BANK`. */
  sender: string;
  /** The receiving SIM's number, from MODEM_NUMBERS. */
  recipientNumber?: string;
  text: string;
  /** When the network (SMSC) accepted the message, from the PDU. */
  sentAt: string;
}

export interface SmsSentData {
  to: string;
  /** The sending SIM's number, from MODEM_NUMBERS. */
  from?: string;
  text: string;
  parts: number;
  /** TP-Message-Reference per part, as returned by the network. */
  messageReferences: number[];
}

export type CallDirection = 'inbound' | 'outbound';

export interface CallIncomingData {
  /** Correlates this call with its `call.ended`. */
  callId: string;
  direction: 'inbound';
  /** Caller ID; empty when the caller withheld it. */
  number: string;
  recipientNumber?: string;
}

export interface CallEndedData {
  callId: string;
  direction: CallDirection;
  /** The other party: the caller for inbound calls, the dialled number for outbound. */
  number: string;
  reason: CallEndReason;
  startedAt: string;
  durationMs: number;
  /** Inbound only: how many rings were seen. */
  rings?: number;
  /** The modem's own result line, when the network ended the call. */
  detail?: string;
}

export interface EventDataMap {
  'sms.received': SmsReceivedData;
  'sms.sent': SmsSentData;
  'call.incoming': CallIncomingData;
  'call.ended': CallEndedData;
  'modem.added': ModemInfo;
  'modem.removed': ModemInfo;
  'modem.status': ModemInfo;
}

export interface GatewayEvent<T extends EventType = EventType> {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Unique per event; stays the same across retries and sinks. Use it to de-duplicate. */
  id: string;
  event: T;
  /** When gsm2http observed the event (ISO 8601). */
  timestamp: string;
  modem: ModemRef;
  data: EventDataMap[T];
}

/** Discriminated on `event`, so `if (e.event === 'sms.received') e.data.text` type-checks. */
export type AnyGatewayEvent = { [K in EventType]: GatewayEvent<K> }[EventType];

export function createEvent<T extends EventType>(
  event: T,
  modem: ModemRef,
  data: EventDataMap[T],
  timestamp: Date = new Date(),
): GatewayEvent<T> {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: `evt_${randomUUID().replaceAll('-', '')}`,
    event,
    timestamp: timestamp.toISOString(),
    modem,
    data,
  };
}

export function modemRef(
  info: Pick<ModemInfo, 'id' | 'port'> & Partial<Pick<ModemInfo, 'imei' | 'phoneNumber'>>,
): ModemRef {
  const ref: ModemRef = { id: info.id, port: info.port };
  if (info.imei) ref.imei = info.imei;
  if (info.phoneNumber) ref.phoneNumber = info.phoneNumber;
  return ref;
}
