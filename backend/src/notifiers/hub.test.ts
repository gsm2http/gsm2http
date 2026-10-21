import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEvent,
  EventBus,
  matchesEvent,
  matchesFilter,
  validateEventPatterns,
  type AnyGatewayEvent,
  type EventFilter,
  type ModemRef,
} from '../events';
import type { ModemInfo } from '../modem/types';
import { NotifierHub } from './hub';
import { DeliveryLog, type Notifier } from './types';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MODEM_1 = {
  id: 'modem-1',
  port: '/dev/ttyUSB0',
  imei: '000000000000001',
  phoneNumber: '+12025550100',
};
const MODEM_2 = { id: 'modem-2', port: '/dev/ttyUSB3', imei: '000000000000002' };

function info(id: string, signalPercentage: number): ModemInfo {
  return {
    id,
    port: '/dev/ttyUSB0',
    name: 'Huawei E173',
    model: 'E173',
    manufacturer: 'Huawei',
    imei: '000000000000001',
    driver: 'huawei',
    capabilities: { sms: true, voice: true, ussd: false, audio: false },
    simStatus: 'READY',
    signalPercentage,
    supportsVoice: true,
    connected: true,
    networkMode: 'auto',
  };
}

const sms = (modem: ModemRef = MODEM_1) =>
  createEvent('sms.received', modem, {
    sender: '+12025550199',
    text: 'hi',
    sentAt: '2026-10-14T19:04:12Z',
  });
const call = () =>
  createEvent('call.incoming', MODEM_1, {
    callId: 'call_1',
    direction: 'inbound',
    number: '+12025550199',
  });
const status = (signal: number, id = 'modem-1') =>
  createEvent('modem.status', { id, port: '/dev/ttyUSB0' }, info(id, signal));

class RecordingNotifier implements Notifier {
  public readonly type = 'webhook' as const;
  public readonly received: AnyGatewayEvent[] = [];
  constructor(
    public readonly name: string,
    public readonly filter: EventFilter,
  ) {}
  deliver(event: AnyGatewayEvent) {
    this.received.push(event);
  }
  describe() {
    return {
      name: this.name,
      type: this.type,
      target: '',
      events: this.filter.events,
      stats: { delivered: 0, failed: 0, pending: 0 },
    };
  }
  close() {
    return Promise.resolve();
  }
}

describe('event filters', () => {
  it('matches exact names, families and *', () => {
    assert.ok(matchesEvent(['*'], 'modem.status'));
    assert.ok(matchesEvent(['sms.received'], 'sms.received'));
    assert.ok(!matchesEvent(['sms.received'], 'sms.sent'));
    assert.ok(matchesEvent(['sms.*'], 'sms.sent'));
    assert.ok(!matchesEvent(['sms.*'], 'smsx.sent'));
    assert.ok(matchesEvent(['call.*', 'modem.added'], 'modem.added'));
    assert.ok(!matchesEvent(['call.*', 'modem.added'], 'modem.status'));
  });

  it('limits to modems by ID, IMEI or phone number', () => {
    assert.ok(matchesFilter({ events: ['*'], modems: ['modem-1'] }, sms()));
    assert.ok(matchesFilter({ events: ['*'], modems: ['000000000000001'] }, sms()));
    assert.ok(matchesFilter({ events: ['*'], modems: ['+12025550100'] }, sms()));
    assert.ok(!matchesFilter({ events: ['*'], modems: ['modem-1'] }, sms(MODEM_2)));
    assert.ok(matchesFilter({ events: ['*'], modems: [] }, sms(MODEM_2)), 'empty list = all');
  });

  it('rejects unknown event names and families at config time', () => {
    assert.deepEqual(validateEventPatterns(['sms.*', 'call.ended', '*'], 'x'), [
      'sms.*',
      'call.ended',
      '*',
    ]);
    assert.throws(
      () => validateEventPatterns(['sms.recieved'], 'notifiers[0].events'),
      /unknown event "sms.recieved"/,
    );
    assert.throws(() => validateEventPatterns(['voice.*'], 'x'), /unknown event "voice.\*"/);
    assert.throws(() => validateEventPatterns([], 'x'), /at least one event/);
  });
});

describe('notifier hub', () => {
  const hubWith = (notifiers: Notifier[], modemStatusMinIntervalMs = 0) => {
    const bus = new EventBus();
    const hub = new NotifierHub(bus, notifiers, new DeliveryLog(), { modemStatusMinIntervalMs });
    return { bus, hub };
  };

  it('delivers each event only to sinks whose filter matches', async () => {
    const smsOnly = new RecordingNotifier('sms', { events: ['sms.*'] });
    const everything = new RecordingNotifier('all', { events: ['*'] });
    const modem2 = new RecordingNotifier('m2', { events: ['*'], modems: ['modem-2'] });
    const { bus, hub } = hubWith([smsOnly, everything, modem2]);

    bus.publish(sms());
    bus.publish(call());
    bus.publish(sms(MODEM_2));

    assert.deepEqual(
      smsOnly.received.map((e) => e.event),
      ['sms.received', 'sms.received'],
    );
    assert.deepEqual(
      everything.received.map((e) => e.event),
      ['sms.received', 'call.incoming', 'sms.received'],
    );
    assert.deepEqual(
      modem2.received.map((e) => e.modem.id),
      ['modem-2'],
    );
    await hub.close();
  });

  it('keeps going when one sink throws', async () => {
    const broken = new RecordingNotifier('broken', { events: ['*'] });
    broken.deliver = () => {
      throw new Error('boom');
    };
    const ok = new RecordingNotifier('ok', { events: ['*'] });
    const { bus, hub } = hubWith([broken, ok]);
    bus.publish(sms());
    assert.equal(ok.received.length, 1);
    await hub.close();
  });

  it('coalesces modem.status per modem, sending the latest state at the end of the window', async () => {
    const sink = new RecordingNotifier('all', { events: ['*'] });
    const { bus, hub } = hubWith([sink], 60);

    bus.publish(status(10));
    bus.publish(status(20));
    bus.publish(status(30));
    bus.publish(status(70, 'modem-2'));
    bus.publish(sms()); // other events are never held back
    assert.deepEqual(
      sink.received.map((e) =>
        e.event === 'modem.status' ? `${e.modem.id}:${e.data.signalPercentage}` : e.event,
      ),
      ['modem-1:10', 'modem-2:70', 'sms.received'],
    );

    await tick(90);
    assert.deepEqual(
      sink.received.flatMap((e) => (e.event === 'modem.status' ? [e.data.signalPercentage] : [])),
      [10, 70, 30],
      'the intermediate 20 is skipped, 30 arrives after the window',
    );
    await hub.close();
  });

  it('drops a held-back status when the modem is removed', async () => {
    const sink = new RecordingNotifier('all', { events: ['*'] });
    const { bus, hub } = hubWith([sink], 40);
    bus.publish(status(10));
    bus.publish(status(20));
    bus.publish(
      createEvent(
        'modem.removed',
        { id: 'modem-1', port: '/dev/ttyUSB0' },
        { ...info('modem-1', 20), connected: false },
      ),
    );
    await tick(60);
    assert.deepEqual(
      sink.received.map((e) => e.event),
      ['modem.status', 'modem.removed'],
    );
    await hub.close();
  });

  it('stops delivering after close()', async () => {
    const sink = new RecordingNotifier('all', { events: ['*'] });
    const { bus, hub } = hubWith([sink]);
    await hub.close();
    bus.publish(sms());
    assert.equal(sink.received.length, 0);
  });
});
