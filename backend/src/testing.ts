import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './server';

/** Shared by the gateway tests. */

export const TEST_TOKEN = 'test-token-0123456789abcdef';

/** A gateway config with auth on, as a real install has it. */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    mockMode: true,
    notifiers: { modemStatusMinIntervalMs: 0, sinks: [] },
    defaultCallDurationMs: 3_000,
    apiToken: TEST_TOKEN,
    corsOrigins: [],
    rateLimits: {
      smsMinIntervalMs: 0,
      smsDailyLimit: 0,
      callsHourlyLimit: 0,
      unlocksHourlyLimit: 0,
    },
    ...overrides,
  };
}

export const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

export function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
