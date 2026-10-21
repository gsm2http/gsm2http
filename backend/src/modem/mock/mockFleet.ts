import type { NetworkMode } from '../types';
import type { SimulatedModemProfile } from './SimulatedModem';

export interface MockModemDefinition {
  id: string;
  name: string;
  portPath: string;
  phoneNumber?: string;
  networkMode?: NetworkMode;
  profile: SimulatedModemProfile;
}

/** The device a `new ModemStream({ mockMode: true })` simulates unless told otherwise. */
export const DEFAULT_SIMULATED_PROFILE: SimulatedModemProfile = {
  manufacturer: 'Huawei',
  model: 'E173',
  imei: '000000000000000',
  usbVendorId: '12d1',
  dialect: 'huawei',
  simStatus: 'READY',
  voice: true,
};

/** The simulated modems MOCK_MODE starts with. */
export const DEFAULT_MOCK_FLEET: MockModemDefinition[] = [
  {
    id: 'modem-1',
    name: 'Huawei E173 (Voice + SMS)',
    portPath: '/dev/ttyUSB0',
    phoneNumber: '+12025550100',
    networkMode: '3g',
    profile: {
      manufacturer: 'Huawei',
      model: 'E173',
      imei: '000000000000001',
      usbVendorId: '12d1',
      dialect: 'huawei',
      simStatus: 'READY',
      operator: 'Mock Carrier A',
      rssi: 26,
      voice: true,
    },
  },
  {
    id: 'modem-2',
    name: 'Huawei E3531 (SMS only)',
    portPath: '/dev/ttyUSB3',
    phoneNumber: '+12025550101',
    networkMode: 'auto',
    profile: {
      manufacturer: 'Huawei',
      model: 'E3531',
      imei: '000000000000002',
      usbVendorId: '12d1',
      dialect: 'huawei',
      simStatus: 'SIM PIN',
      operator: 'Mock Carrier B',
      rssi: 19,
      voice: false,
    },
  },
];
