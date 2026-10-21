export type SimStatus = 'READY' | 'SIM PIN' | 'SIM PUK' | 'NO SIM' | 'ERROR' | 'UNKNOWN';

export type NetworkMode = '2g' | '3g' | 'auto';

export interface Modem {
  id: string;
  port: string;
  name: string;
  model: string;
  manufacturer: string;
  imei: string;
  simStatus: SimStatus;
  phoneNumber?: string;
  operator?: string;
  /** Raw +CSQ value: 0–31, or 99 when unknown. */
  signalStrength?: number;
  signalPercentage?: number;
  supportsVoice: boolean;
  connected: boolean;
  networkMode: NetworkMode;
  isDialing?: boolean;
}

/** Which modem an event is about. `imei` is the stable key; `id` follows discovery order. */
export interface ModemRef {
  id: string;
  port: string;
  imei?: string;
  phoneNumber?: string;
}

/** The versioned envelope every event uses, over Socket.io, webhooks and MQTT (docs/events.md). */
export interface GatewayEvent<E extends string, D> {
  schemaVersion: 1;
  id: string;
  event: E;
  timestamp: string;
  modem: ModemRef;
  data: D;
}

export type SmsReceivedEvent = GatewayEvent<
  'sms.received',
  { sender: string; recipientNumber?: string; text: string; sentAt: string }
>;

export type SmsSentEvent = GatewayEvent<
  'sms.sent',
  { to: string; from?: string; text: string; parts: number; messageReferences: number[] }
>;

export type CallIncomingEvent = GatewayEvent<
  'call.incoming',
  { callId: string; direction: 'inbound'; number: string; recipientNumber?: string }
>;

export type CallEndedEvent = GatewayEvent<
  'call.ended',
  {
    callId: string;
    direction: 'inbound' | 'outbound';
    number: string;
    reason: string;
    startedAt: string;
    durationMs: number;
    rings?: number;
    detail?: string;
  }
>;

export type ModemEvent<E extends 'modem.added' | 'modem.removed' | 'modem.status'> = GatewayEvent<
  E,
  Modem
>;

export interface ModemRawEvent {
  id: string;
  modemId: string;
  modemPort: string;
  modemName: string;
  /** One raw AT line, or a `[System …]` note from the server. */
  event: string;
  timestamp: string;
}

export interface ServerToClientEvents {
  'modems.list': (modems: Modem[]) => void;
  'modem.added': (event: ModemEvent<'modem.added'>) => void;
  'modem.removed': (event: ModemEvent<'modem.removed'>) => void;
  'modem.status': (event: ModemEvent<'modem.status'>) => void;
  'sms.received': (event: SmsReceivedEvent) => void;
  'sms.sent': (event: SmsSentEvent) => void;
  'call.incoming': (event: CallIncomingEvent) => void;
  'call.ended': (event: CallEndedEvent) => void;
  'modem.raw': (line: ModemRawEvent) => void;
}

export interface ServerConfig {
  mockMode: boolean;
  authEnabled: boolean;
  defaultCallDurationMs: number;
  notifierCount: number;
}

export interface NotifierSummary {
  name: string;
  type: 'webhook' | 'mqtt';
  /** Origin only; paths and credentials are never sent to the UI. */
  target: string;
  events: string[];
  modems?: string[];
  signed?: boolean;
  connected?: boolean;
  stats: {
    delivered: number;
    failed: number;
    pending: number;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    lastError?: string;
  };
}

export interface DeliveryRecord {
  notifier: string;
  eventId: string;
  event: string;
  attempt: number;
  outcome: 'delivered' | 'retrying' | 'failed' | 'dropped';
  at: string;
  status?: number;
  error?: string;
  retryAt?: string;
}

export interface NotifiersResponse {
  notifiers: NotifierSummary[];
  deliveries: DeliveryRecord[];
}

export interface MessageResponse {
  success: true;
  message?: string;
  modemId?: string;
}

export interface ModemListResponse {
  modems: Modem[];
}

export interface DialRequest {
  to: string;
  durationMs?: number;
  durationSeconds?: number;
  sync?: boolean;
  force?: boolean;
}

export interface DialResponse {
  success: true;
  completed: boolean;
  message: string;
  callId: string;
  durationMs: number;
  from: string;
  to: string;
  modemId: string;
  modemPort: string;
}

export interface MockSmsRequest {
  modemId?: string;
  sender?: string;
  text?: string;
  testCase?: 'multipart-ucs2';
}

export interface MockCallRequest {
  modemId?: string;
  number?: string;
}

export interface ErrorResponse {
  success: false;
  error: string;
}
