import 'dotenv/config';
import { loadConfig, type Config } from './config';
import { logger } from './logger';
import { ModemManager } from './modem/ModemManager';
import { createGateway } from './server';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  logger.fatal(`Invalid configuration: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
if (config.apiToken === undefined) {
  logger.warn(
    { host: config.host },
    LOOPBACK_HOSTS.has(config.host)
      ? 'AUTH_DISABLED=true: the API and live events are open to anyone who can reach this port'
      : 'AUTH_DISABLED=true on a non-loopback address: anyone on the network can send SMS, ' +
          'dial, unlock SIMs and read every incoming message',
  );
}
const modems = new ModemManager({
  mockMode: config.mockMode,
  ports: config.modemPorts,
  phoneNumbers: config.modemNumbers,
  driverOverrides: config.modemDrivers,
  scanIntervalMs: config.scanIntervalMs,
  pollIntervalMs: config.pollIntervalMs,
});
const gateway = createGateway(config, modems);
const { httpServer } = gateway;

httpServer.listen(config.port, config.host, () => {
  logger.info(
    {
      host: config.host,
      port: config.port,
      mockMode: config.mockMode,
      auth: config.apiToken !== undefined,
      corsOrigins: config.corsOrigins,
      notifiers: gateway.notifiers.summaries().map((n) => `${n.type}:${n.name} → ${n.target}`),
    },
    'gsm2http listening',
  );
});

/** Hangs up active calls and releases the serial ports, so the modem starts clean next time. */
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 5_000).unref();
  for (const { stream } of modems.getAllModems()) {
    if (stream.isDialing) stream.hangup();
  }
  // Give the hang-up commands a moment to reach the modem.
  setTimeout(() => {
    modems.close();
    void gateway.close().finally(() => httpServer.close(() => process.exit(0)));
  }, 300);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
