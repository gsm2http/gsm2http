import path from 'node:path';
import { logger } from '../../logger';
import { GenericDriver } from './GenericDriver';
import type { ModemDriver, ModemIdentity } from './types';

/**
 * Forced driver choices, keyed by port path, port basename ('ttyUSB2') or '*' for all ports.
 */
export type DriverOverrides = Record<string, string>;

/**
 * Parses MODEM_DRIVER. Either a bare driver name applied to every port
 * ('generic'), or comma-separated port=driver pairs
 * ('/dev/ttyUSB0=huawei,ttyUSB3=generic').
 */
export function parseDriverOverrides(value: string | undefined): DriverOverrides {
  const overrides: DriverOverrides = {};
  if (!value) return overrides;

  for (const entry of value
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const eq = entry.lastIndexOf('=');
    if (eq === -1) {
      overrides['*'] = entry.toLowerCase();
    } else {
      const port = entry.slice(0, eq).trim();
      const driver = entry
        .slice(eq + 1)
        .trim()
        .toLowerCase();
      if (port && driver) overrides[port] = driver;
    }
  }
  return overrides;
}

export class DriverRegistry {
  private drivers: ModemDriver[] = [];
  private fallback: ModemDriver;

  constructor(drivers: ModemDriver[] = [], fallback: ModemDriver = new GenericDriver()) {
    this.fallback = fallback;
    for (const driver of drivers) this.register(driver);
  }

  /** Adds a driver. On equal match scores, the driver registered last wins. */
  public register(driver: ModemDriver): this {
    this.drivers = this.drivers.filter((d) => d.name !== driver.name);
    this.drivers.push(driver);
    return this;
  }

  public get(name: string): ModemDriver | undefined {
    const wanted = name.toLowerCase();
    if (this.fallback.name === wanted) return this.fallback;
    return this.drivers.find((d) => d.name === wanted);
  }

  public list(): ModemDriver[] {
    return [...this.drivers, this.fallback];
  }

  /**
   * Picks the driver for a device: an override for its port if one is configured,
   * otherwise the best-scoring match, otherwise the generic fallback.
   */
  public select(
    identity: ModemIdentity,
    portPath?: string,
    overrides: DriverOverrides = {},
  ): ModemDriver {
    const forced = portPath
      ? (overrides[portPath] ?? overrides[path.basename(portPath)] ?? overrides['*'])
      : overrides['*'];

    if (forced) {
      const driver = this.get(forced);
      if (driver) return driver;
      logger.warn(
        { driver: forced, port: portPath ?? 'all ports', known: this.list().map((d) => d.name) },
        'unknown driver forced; falling back to auto-detection',
      );
    }

    let best: ModemDriver = this.fallback;
    let bestScore = 0;
    for (const driver of this.drivers) {
      const score = driver.matches(identity);
      if (score > 0 && score >= bestScore) {
        best = driver;
        bestScore = score;
      }
    }
    return best;
  }
}
