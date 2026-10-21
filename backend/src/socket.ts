import type http from 'node:http';
import { Server as SocketServer, type ServerOptions } from 'socket.io';
import {
  EventName,
  type AnyGatewayEvent,
  type EventBus,
  type EventType,
  type GatewayEvent,
} from './events';
import { logger } from './logger';
import type { ModemManager } from './modem/ModemManager';
import type { ModemInfo, RawLine } from './modem/types';

/**
 * Every bus event under its own name, with the same envelope webhooks get, plus two
 * UI-only feeds: the modem list snapshot and the raw AT log. The raw log carries PDUs and
 * phone numbers, so it is never put on the bus and never reaches webhooks or MQTT.
 */
export type ServerToClientEvents = {
  [K in EventType]: (event: GatewayEvent<K>) => void;
} & {
  'modems.list': (modems: ModemInfo[]) => void;
  'modem.raw': (line: RawLine) => void;
};

export type GatewaySocketServer = SocketServer<Record<string, never>, ServerToClientEvents>;

export function createSocketFeed(
  httpServer: http.Server,
  bus: EventBus,
  modems: ModemManager,
  options: Partial<ServerOptions> = {},
): GatewaySocketServer {
  // CORS and authentication are the caller's: see createGateway.
  const io: GatewaySocketServer = new SocketServer(httpServer, options);

  bus.subscribe((event) => {
    emitEvent(io, event);
    if (event.event === EventName.ModemAdded || event.event === EventName.ModemRemoved) {
      io.emit('modems.list', modems.getModemList());
    }
  });
  modems.on('raw', (line) => io.emit('modem.raw', line));

  io.on('connection', (socket) => {
    logger.debug({ socketId: socket.id }, 'socket connected');
    socket.emit('modems.list', modems.getModemList());
    socket.on('disconnect', () => logger.debug({ socketId: socket.id }, 'socket disconnected'));
  });

  return io;
}

function emitEvent(io: GatewaySocketServer, event: AnyGatewayEvent): void {
  // The union defeats socket.io's per-event typing; the mapped type above guarantees the
  // name and payload match.
  (
    io.emit as (this: GatewaySocketServer, name: EventType, payload: AnyGatewayEvent) => boolean
  ).call(io, event.event, event);
}
