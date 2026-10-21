import { API_URL } from './config';
import { getToken, notifyUnauthorized } from './token';
import type {
  DialRequest,
  DialResponse,
  ErrorResponse,
  MessageResponse,
  MockCallRequest,
  MockSmsRequest,
  ModemListResponse,
  NetworkMode,
  NotifiersResponse,
  ServerConfig,
} from './types';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as { error: unknown }).error === 'string'
  );
}

async function request<T>(path: string, { method = 'GET', body }: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(`${API_URL}${path}`, init);
  const data: unknown = await res.json().catch(() => undefined);

  if (res.status === 401) notifyUnauthorized();
  if (!res.ok) {
    const message = isErrorResponse(data) ? data.error : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const modemPath = (modemId: string, action: string) =>
  `/api/modems/${encodeURIComponent(modemId)}/${action}`;

export const getConfig = () => request<ServerConfig>('/api/config');

export const getNotifiers = () => request<NotifiersResponse>('/api/notifiers');

export const listModems = () => request<ModemListResponse>('/api/modems');

export const scanModems = () => request<ModemListResponse>('/api/modems/scan', { method: 'POST' });

export const unlockSim = (modemId: string, pin: string) =>
  request<MessageResponse>(modemPath(modemId, 'unlock'), { method: 'POST', body: { pin } });

export const queryModem = (modemId: string) =>
  request<MessageResponse>(modemPath(modemId, 'query'), { method: 'POST' });

export const setNetworkMode = (modemId: string, type: NetworkMode) =>
  request<MessageResponse>(modemPath(modemId, 'network'), { method: 'POST', body: { type } });

export const dial = (modemId: string, body: DialRequest) =>
  request<DialResponse>(modemPath(modemId, 'dial'), { method: 'POST', body });

export const mockSms = (body: MockSmsRequest) =>
  request<MessageResponse>('/api/mock/sms', { method: 'POST', body });

export const mockCall = (body: MockCallRequest) =>
  request<MessageResponse>('/api/mock/call', { method: 'POST', body });

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
