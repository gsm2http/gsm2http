import { useCallback, useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { errorMessage, listModems } from '../api/client';
import { API_URL } from '../api/config';
import { getToken, notifyUnauthorized } from '../api/token';
import type { CallEndedEvent, Modem, ServerToClientEvents } from '../api/types';

const MAX_LOG_ENTRIES = 100;
// Keeps long-running dashboards from growing without bound.
const MAX_FEED_ITEMS = 200;

const HANDLED_EVENTS = new Set([
  'sms.received',
  'call.incoming',
  'call.ended',
  'modems.list',
  'modem.status',
  'modem.raw',
]);

export interface LogEntry {
  id: string;
  event: string;
  data: unknown;
  timestamp: string;
  modemId?: string;
}

export interface SmsFeedItem {
  id: string;
  modemId: string;
  sender: string;
  recipientNumber?: string;
  text: string;
  timestamp: string;
}

export interface CallFeedItem {
  id: string;
  callId: string;
  modemId: string;
  number: string;
  recipientNumber?: string;
  timestamp: string;
  /** Set once `call.ended` arrives; until then the call is ringing. */
  ended?: Pick<CallEndedEvent['data'], 'reason' | 'rings' | 'durationMs'>;
}

let nextId = 0;
const newId = () => String(++nextId);

function modemIdOf(payload: unknown): string | undefined {
  if (typeof payload === 'object' && payload !== null && 'modemId' in payload) {
    const { modemId } = payload as { modemId: unknown };
    return typeof modemId === 'string' ? modemId : undefined;
  }
  return undefined;
}

function upsertModem(list: Modem[], modem: Modem): Modem[] {
  const index = list.findIndex((m) => m.id === modem.id);
  if (index < 0) return [...list, modem];
  const next = [...list];
  next[index] = modem;
  return next;
}

/** Live connection to the gsm2http server: modem list plus SMS, call and AT-log feeds. */
export function useGateway() {
  const [isConnected, setIsConnected] = useState(false);
  const [modems, setModems] = useState<Modem[]>([]);
  const [messages, setMessages] = useState<SmsFeedItem[]>([]);
  const [calls, setCalls] = useState<CallFeedItem[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  const addLog = useCallback((event: string, data: unknown, modemId?: string) => {
    const entry: LogEntry = {
      id: newId(),
      event,
      data,
      timestamp: new Date().toISOString(),
      modemId,
    };
    setLog((prev) => [entry, ...prev].slice(0, MAX_LOG_ENTRIES));
  }, []);

  useEffect(() => {
    listModems()
      .then((res) => setModems(res.modems))
      .catch((err: unknown) =>
        addLog('error', { message: `Failed to load modems: ${errorMessage(err)}` }),
      );

    // A callback, so reconnects pick up the current token.
    const options = { auth: (cb: (data: object) => void) => cb({ token: getToken() ?? '' }) };
    const socket: Socket<ServerToClientEvents> = API_URL ? io(API_URL, options) : io(options);

    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') notifyUnauthorized();
      else if (err.message === 'rate_limited') {
        addLog('error', { message: 'Too many failed logins; try again in a few minutes' });
      }
    });

    socket.on('connect', () => {
      setIsConnected(true);
      addLog('system', { message: 'Connected to server' });
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      addLog('system', { message: 'Disconnected from server' });
    });

    socket.on('modems.list', setModems);
    socket.on('modem.status', (e) => setModems((prev) => upsertModem(prev, e.data)));

    socket.on('sms.received', (e) => {
      const item: SmsFeedItem = {
        id: e.id,
        modemId: e.modem.id,
        sender: e.data.sender,
        recipientNumber: e.data.recipientNumber,
        text: e.data.text,
        timestamp: e.timestamp,
      };
      setMessages((prev) => [item, ...prev].slice(0, MAX_FEED_ITEMS));
      addLog('sms.received', e, e.modem.id);
    });

    socket.on('call.incoming', (e) => {
      const item: CallFeedItem = {
        id: e.id,
        callId: e.data.callId,
        modemId: e.modem.id,
        number: e.data.number,
        recipientNumber: e.data.recipientNumber,
        timestamp: e.timestamp,
      };
      setCalls((prev) => [item, ...prev].slice(0, MAX_FEED_ITEMS));
      addLog('call.incoming', e, e.modem.id);
    });

    socket.on('call.ended', (e) => {
      const { reason, rings, durationMs } = e.data;
      setCalls((prev) =>
        prev.map((c) =>
          c.callId === e.data.callId ? { ...c, ended: { reason, rings, durationMs } } : c,
        ),
      );
      addLog('call.ended', e, e.modem.id);
    });

    socket.on('modem.raw', (line) => addLog('modem.raw', line.event, line.modemId));

    // Anything else (sms.sent, modem.added, events added later) goes to the AT log as-is.
    socket.onAny((event: string, ...args: unknown[]) => {
      if (HANDLED_EVENTS.has(event)) return;
      const payload = args.length === 1 ? args[0] : args;
      addLog(event, payload, modemIdOf(payload));
    });

    return () => {
      socket.disconnect();
    };
  }, [addLog]);

  return { isConnected, modems, setModems, messages, calls, log, addLog };
}
