import { ModemStream } from '../ModemStream';
import { SimulatedModem, SimulatedModemProfile } from '../mock/SimulatedModem';
import { ModemDriver } from './types';

export const GENERIC_PROFILE: SimulatedModemProfile = {
  manufacturer: 'ACME Wireless',
  model: 'AW-100',
  imei: '351234567890123',
  dialect: 'generic',
  simStatus: 'READY',
  operator: 'Test Net',
  rssi: 20,
};

export const HUAWEI_PROFILE: SimulatedModemProfile = {
  manufacturer: 'huawei',
  model: 'E173',
  imei: '860000000000101',
  usbVendorId: '12d1',
  dialect: 'huawei',
  simStatus: 'READY',
  operator: 'Test Net',
  rssi: 20,
  voice: true,
};

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
  what = 'condition',
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A ModemStream wired to a simulated device, with the startup sequence finished.
 */
export async function startModem(profile: SimulatedModemProfile, driver?: ModemDriver) {
  const simulator = new SimulatedModem(profile, '/dev/ttyFAKE0');
  const stream = new ModemStream({
    id: 'test-modem',
    portPath: '/dev/ttyFAKE0',
    transport: simulator.port,
    simulator,
    driver,
    identity: simulator.identity,
    imei: profile.imei,
    simStatus: simulator.simStatus,
  });

  // Startup ends with AT+COPS?; once its answer arrived the modem is idle
  await waitFor(
    () => simulator.port.received.includes('AT+COPS?') && stream.operatorName !== '',
    2000,
    'startup sequence',
  );
  await new Promise((r) => setTimeout(r, 20));
  simulator.port.received.length = 0;
  return { stream, simulator, port: simulator.port };
}
