import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DriverRegistry,
  GenericDriver,
  HuaweiDriver,
  ModemIdentity,
  defaultDriverRegistry,
  parseDriverOverrides,
} from '.';

class AcmeDriver extends GenericDriver {
  public override readonly name = 'acme';
  public override readonly label = 'ACME test driver';
  public override matches(identity: ModemIdentity): number {
    return identity.manufacturer === 'ACME' ? 100 : 0;
  }
}

describe('DriverRegistry', () => {
  it('selects the Huawei driver by AT+CGMI manufacturer', () => {
    assert.equal(
      defaultDriverRegistry.select({ manufacturer: 'huawei', model: 'E1550' }).name,
      'huawei',
    );
  });

  it('selects the Huawei driver by USB vendor id alone', () => {
    assert.equal(
      defaultDriverRegistry.select({ usbVendorId: '12D1', usbProductId: '1001' }).name,
      'huawei',
    );
  });

  it('selects the Huawei driver by a known model when the manufacturer is missing', () => {
    assert.equal(defaultDriverRegistry.select({ model: 'E3372h-153' }).name, 'huawei');
  });

  it('falls back to the generic driver for unknown hardware', () => {
    assert.equal(
      defaultDriverRegistry.select({ manufacturer: 'SIMCOM INCORPORATED', model: 'SIM7600E' }).name,
      'generic',
    );
    assert.equal(defaultDriverRegistry.select({}).name, 'generic');
  });

  it('honours forced drivers by full path, basename and wildcard', () => {
    const huaweiIdentity: ModemIdentity = { manufacturer: 'huawei', model: 'E173' };

    const byPath = parseDriverOverrides('/dev/ttyUSB0=generic');
    assert.equal(
      defaultDriverRegistry.select(huaweiIdentity, '/dev/ttyUSB0', byPath).name,
      'generic',
    );
    assert.equal(
      defaultDriverRegistry.select(huaweiIdentity, '/dev/ttyUSB1', byPath).name,
      'huawei',
    );

    const byBasename = parseDriverOverrides('ttyUSB2=generic');
    assert.equal(
      defaultDriverRegistry.select(huaweiIdentity, '/dev/ttyUSB2', byBasename).name,
      'generic',
    );

    const everywhere = parseDriverOverrides('Huawei');
    assert.equal(
      defaultDriverRegistry.select({ manufacturer: 'Quectel' }, '/dev/ttyUSB5', everywhere).name,
      'huawei',
    );
  });

  it('ignores an unknown forced driver and auto-detects instead', () => {
    const overrides = parseDriverOverrides('/dev/ttyUSB0=nope');
    assert.equal(
      defaultDriverRegistry.select({ manufacturer: 'huawei' }, '/dev/ttyUSB0', overrides).name,
      'huawei',
    );
  });

  it('parses mixed MODEM_DRIVER values', () => {
    assert.deepEqual(parseDriverOverrides(' generic , /dev/ttyUSB1=Huawei,ttyACM0=acme '), {
      '*': 'generic',
      '/dev/ttyUSB1': 'huawei',
      ttyACM0: 'acme',
    });
    assert.deepEqual(parseDriverOverrides(undefined), {});
  });

  it('lets an added driver take over its hardware, and later registrations win ties', () => {
    const registry = new DriverRegistry([new HuaweiDriver()]);
    assert.equal(registry.select({ manufacturer: 'ACME' }).name, 'generic');

    registry.register(new AcmeDriver());
    assert.equal(registry.select({ manufacturer: 'ACME' }).name, 'acme');
    assert.equal(registry.get('ACME')?.name, 'acme');
    assert.deepEqual(
      registry.list().map((d) => d.name),
      ['huawei', 'acme', 'generic'],
    );

    class AlsoHuawei extends HuaweiDriver {
      public override readonly name = 'huawei-custom';
    }
    registry.register(new AlsoHuawei());
    assert.equal(registry.select({ manufacturer: 'huawei' }).name, 'huawei-custom');
  });
});
