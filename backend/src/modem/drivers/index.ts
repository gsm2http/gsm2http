import { DriverRegistry } from './registry';
import { GenericDriver } from './GenericDriver';
import { HuaweiDriver } from './HuaweiDriver';

export * from './types';
export { GenericDriver } from './GenericDriver';
export { HuaweiDriver } from './HuaweiDriver';
export { DriverRegistry, parseDriverOverrides } from './registry';
export type { DriverOverrides } from './registry';

/**
 * The drivers gsm2http ships with. To support new hardware, add your driver here
 * (see docs/ADDING_A_MODEM.md). GenericDriver is the fallback and is not listed.
 */
export const defaultDriverRegistry = new DriverRegistry([new HuaweiDriver()], new GenericDriver());
