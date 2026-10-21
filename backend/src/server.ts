import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Config } from './config';
import { bridgeModemEvents, EventBus } from './events';
import { checkToken, requireToken, type TokenCheck } from './http/auth';
import { errorHandler, notFound } from './http/errors';
import { RateLimiter } from './http/rateLimit';
import { configRouter } from './http/routes/config';
import { mockRouter } from './http/routes/mock';
import { modemsRouter } from './http/routes/modems';
import { notifiersRouter } from './http/routes/notifiers';
import { logger } from './logger';
import type { ModemManager } from './modem/ModemManager';
import { createNotifierHub, type NotifierHub, type NotifierOverrides } from './notifiers';
import { createSocketFeed, type GatewaySocketServer } from './socket';

export type ServerConfig = Pick<
  Config,
  'mockMode' | 'notifiers' | 'defaultCallDurationMs' | 'apiToken' | 'corsOrigins' | 'rateLimits'
> &
  Partial<Pick<Config, 'staticDir'>>;

/** Largest JSON body accepted: a 1530-character SMS fully \u-escaped fits with room to spare. */
const MAX_BODY_SIZE = '32kb';
/** Wrong tokens tolerated per client address before it is locked out for the window. */
const AUTH_FAILURE_LIMIT = 20;
const AUTH_FAILURE_WINDOW_MS = 5 * 60_000;

export interface Gateway {
  app: express.Express;
  httpServer: http.Server;
  io: GatewaySocketServer;
  bus: EventBus;
  notifiers: NotifierHub;
  /** Closes Socket.io and the notifiers (MQTT says goodbye); the HTTP server is left to the caller. */
  close(): Promise<void>;
}

/**
 * Wires the REST API, Socket.io and the outbound notifiers to a ModemManager. Modem
 * events go onto one event bus; Socket.io, webhooks and MQTT all consume it. Does not
 * listen.
 */
export function createGateway(
  config: ServerConfig,
  modems: ModemManager,
  overrides: NotifierOverrides = {},
): Gateway {
  const app = express();
  const httpServer = http.createServer(app);
  // No origins configured means same origin only: no CORS headers are sent at all.
  const corsOptions =
    config.corsOrigins.length === 0
      ? undefined
      : {
          origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins,
          allowedHeaders: ['Authorization', 'Content-Type'],
          maxAge: 600,
        };
  const bus = new EventBus();
  const io = createSocketFeed(httpServer, bus, modems, {
    cors: corsOptions,
    maxHttpBufferSize: 64 * 1024, // clients never send anything but the handshake
  });
  const notifiers = createNotifierHub(bus, config.notifiers, overrides);
  const auth: TokenCheck = {
    token: config.apiToken,
    failures: new RateLimiter(AUTH_FAILURE_LIMIT, AUTH_FAILURE_WINDOW_MS),
  };
  const startedAt = Date.now();

  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // Plain HTTP on a LAN is the common case; upgrading requests would break it.
          upgradeInsecureRequests: null,
        },
      },
      // HSTS belongs to the TLS-terminating proxy, which knows whether HTTPS is permanent.
      strictTransportSecurity: false,
    }),
  );
  if (corsOptions) app.use(cors(corsOptions));
  app.use(express.json({ limit: MAX_BODY_SIZE }));

  // Liveness for Docker and systemd. A missing modem is not unhealthy: scanning continues
  // and picks it up on replug, so a restart would not help.
  app.get('/healthz', (_req, res) => {
    const list = modems.getModemList();
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      mockMode: config.mockMode,
      modems: { total: list.length, connected: list.filter((m) => m.connected).length },
    });
  });

  // Everything under /api needs the token; /healthz and the UI's static files do not.
  app.use('/api', requireToken(auth));
  app.use(
    '/api/config',
    configRouter({
      notifiers,
      mockMode: config.mockMode,
      defaultCallDurationMs: config.defaultCallDurationMs,
      authEnabled: config.apiToken !== undefined,
    }),
  );
  app.use('/api/notifiers', notifiersRouter({ notifiers }));
  app.use(
    '/api/modems',
    modemsRouter({
      modems,
      defaultCallDurationMs: config.defaultCallDurationMs,
      rateLimits: config.rateLimits,
    }),
  );
  if (config.mockMode) app.use('/api/mock', mockRouter({ modems }));
  if (config.staticDir) serveWebUi(app, config.staticDir);
  app.use(notFound);
  app.use(errorHandler);

  bus.subscribe((e) => {
    if (e.event === 'sms.received') {
      logger.info(
        { modemId: e.modem.id, eventId: e.id, length: e.data.text.length },
        'SMS received',
      );
    } else if (e.event === 'call.incoming' || e.event === 'call.ended') {
      logger.info({ modemId: e.modem.id, eventId: e.id, callId: e.data.callId }, e.event);
    }
  });
  const detachModems = bridgeModemEvents(modems, bus);

  const close = async (): Promise<void> => {
    detachModems();
    await Promise.all([io.close(), notifiers.close()]);
  };

  // The socket streams every SMS and the raw AT log, so it needs the token as much as the API.
  io.use((socket, next) => {
    const { token } = socket.handshake.auth as { token?: unknown };
    const error = checkToken(auth, token, socket.handshake.address);
    next(error ? new Error(error.status === 429 ? 'rate_limited' : 'unauthorized') : undefined);
  });

  return { app, httpServer, io, bus, notifiers, close };
}

/** Serves the built UI on the same origin as the API, with SPA fallback to index.html. */
function serveWebUi(app: express.Express, dir: string): void {
  if (!fs.existsSync(path.join(dir, 'index.html'))) return;
  app.use(express.static(dir, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (
      req.method !== 'GET' ||
      req.path.startsWith('/api/') ||
      req.path.startsWith('/socket.io/')
    ) {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    // `root` keeps dot-directories in the install path (e.g. ~/.local) out of send's
    // dotfile check.
    res.sendFile('index.html', { root: dir });
  });
  logger.info({ dir }, 'serving web UI');
}
