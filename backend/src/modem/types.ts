import type { ModemCapabilities, ModemDriver, ModemIdentity } from './drivers/types';
import type { SimulatedModem } from './mock/SimulatedModem';
import type { ModemTransport } from './transport/ModemTransport';

export type SimStatus = 'READY' | 'SIM PIN' | 'SIM PUK' | 'NO SIM' | 'ERROR' | 'UNKNOWN';

export type NetworkMode = '2g' | '3g' | 'auto';

export const NETWORK_MODES: readonly NetworkMode[] = ['2g', '3g', 'auto'];

export interface ModemInfo {
  id: string;
  port: string;
  name: string;
  model: string;
  manufacturer: string;
  revision?: string;
  imei: string;
  /** Name of the driver handling this modem, e.g. `huawei` or `generic`. */
  driver: string;
  capabilities: ModemCapabilities;
  simStatus: SimStatus;
  phoneNumber?: string;
  operator?: string;
  /** Raw `+CSQ` RSSI: 0–31, or 99 for unknown. */
  signalStrength?: number;
  signalPercentage?: number;
  /** Radio access technology in use, e.g. `GSM`, `WCDMA` or `LTE`. */
  accessTechnology?: string;
  supportsVoice: boolean;
  connected: boolean;
  networkMode: NetworkMode;
  isDialing?: boolean;
}

export interface DialResult {
  success: boolean;
  message: string;
  /** Matches the `callId` of the `call.ended` event this call produces. */
  callId?: string;
  durationMs?: number;
  busy?: boolean;
  completion?: Promise<DialResult>;
}

export interface ModemStreamOptions {
  id: string;
  portPath: string;
  /** An already-open port handed over by discovery, or a FakeSerialPort. Required unless `mockMode` is set. */
  transport?: ModemTransport;
  /** Chosen from the default registry by `identity` when omitted. */
  driver?: ModemDriver;
  identity?: ModemIdentity;
  /** Without a transport, runs against a SimulatedModem built from these options. */
  mockMode?: boolean;
  /** The simulated device behind a FakeSerialPort, used by the mock helpers. */
  simulator?: SimulatedModem;
  name?: string;
  model?: string;
  manufacturer?: string;
  imei?: string;
  phoneNumber?: string;
  operator?: string;
  signalStrength?: number;
  supportsVoice?: boolean;
  simStatus?: SimStatus;
  networkMode?: NetworkMode;
  /** How often to sweep SIM storage for messages whose +CMTI was missed. */
  pollIntervalMs?: number;
}

export interface RawLine {
  id: string;
  modemId: string;
  modemPort: string;
  modemName: string;
  event: string;
  timestamp: string;
}

export interface ReceivedSms {
  modemId: string;
  modemPort: string;
  recipientNumber?: string;
  sender: string;
  text: string;
  timestamp: string;
}

export interface IncomingCall {
  modemId: string;
  modemPort: string;
  recipientNumber?: string;
  /** One ID per call, however many times it rings. */
  callId: string;
  number: string;
  timestamp: string;
}

export interface SentSms {
  modemId: string;
  modemPort: string;
  to: string;
  text: string;
  parts: number;
  messageReferences: number[];
  timestamp: string;
}

/** Why a call ended. Documented in docs/events.md under `call.ended`. */
export type CallEndReason =
  /** Inbound: the caller gave up or the network diverted the call. gsm2http never answers. */
  | 'missed'
  /** Outbound: the requested duration elapsed and gsm2http hung up. */
  | 'completed'
  /** Outbound: hung up through the API. */
  | 'hangup'
  /** Outbound: the network or the other side ended the call (`NO CARRIER`, `^CEND`). */
  | 'remote_hangup'
  | 'busy'
  | 'no_answer'
  /** Outbound: the modem refused to dial. */
  | 'failed'
  /** Outbound: a new dial with `force` replaced this call. */
  | 'replaced'
  /** The modem was unplugged or gsm2http shut down. */
  | 'modem_closed';

export interface EndedCall {
  modemId: string;
  modemPort: string;
  callId: string;
  direction: 'inbound' | 'outbound';
  number: string;
  reason: CallEndReason;
  startedAt: string;
  durationMs: number;
  rings?: number;
  detail?: string;
  timestamp: string;
}
