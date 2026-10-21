import type { ModemManager, ModemManagerEvents } from '../modem/ModemManager';
import type { ModemInfo } from '../modem/types';
import type { EventBus } from './bus';
import { createEvent, EventName, modemRef, type ModemRef } from './schema';

type BridgedEvent = 'added' | 'removed' | 'status' | 'sms' | 'smsSent' | 'call' | 'callEnded';
type Handlers = { [K in BridgedEvent]: (...args: ModemManagerEvents[K]) => void };

/**
 * Publishes a ModemManager's events on the bus as versioned gateway events. Modems that
 * are already registered (the mock fleet, or anything found before this is called) get a
 * `modem.added` immediately, so subscribers always see `added` before a modem's other
 * events. Returns a function that detaches the bridge.
 */
export function bridgeModemEvents(modems: ModemManager, bus: EventBus): () => void {
  /** Taken from the live modem, so events carry the stable keys (IMEI, number) too. */
  const refFor = (modemId: string, modemPort: string): ModemRef => {
    const stream = modems.getModem(modemId)?.stream;
    return stream?.id === modemId
      ? modemRef(stream.getInfo())
      : modemRef({ id: modemId, port: modemPort });
  };
  const modemEvent =
    (event: typeof EventName.ModemAdded | typeof EventName.ModemRemoved) => (info: ModemInfo) =>
      bus.publish(createEvent(event, modemRef(info), info));

  const handlers: Handlers = {
    added: modemEvent(EventName.ModemAdded),
    removed: modemEvent(EventName.ModemRemoved),
    status: (info) => bus.publish(createEvent(EventName.ModemStatus, modemRef(info), info)),
    sms: (sms) => {
      bus.publish(
        createEvent(EventName.SmsReceived, refFor(sms.modemId, sms.modemPort), {
          sender: sms.sender,
          ...(sms.recipientNumber && { recipientNumber: sms.recipientNumber }),
          text: sms.text,
          sentAt: toIsoString(sms.timestamp),
        }),
      );
    },
    smsSent: (sms) => {
      const ref = refFor(sms.modemId, sms.modemPort);
      const data = {
        to: sms.to,
        ...(ref.phoneNumber && { from: ref.phoneNumber }),
        text: sms.text,
        parts: sms.parts,
        messageReferences: sms.messageReferences,
      };
      bus.publish(createEvent(EventName.SmsSent, ref, data, new Date(sms.timestamp)));
    },
    call: (call) => {
      const data = {
        callId: call.callId,
        direction: 'inbound' as const,
        number: call.number,
        ...(call.recipientNumber && { recipientNumber: call.recipientNumber }),
      };
      const ref = refFor(call.modemId, call.modemPort);
      bus.publish(createEvent(EventName.CallIncoming, ref, data, new Date(call.timestamp)));
    },
    callEnded: (call) => {
      const { modemId, modemPort, timestamp, ...data } = call;
      const ref = refFor(modemId, modemPort);
      bus.publish(createEvent(EventName.CallEnded, ref, data, new Date(timestamp)));
    },
  };

  for (const info of modems.getModemList()) handlers.added(info);

  const names = Object.keys(handlers) as BridgedEvent[];
  for (const name of names) modems.on(name, handlers[name]);
  return () => {
    for (const name of names) modems.off(name, handlers[name]);
  };
}

/** PDU timestamps carry the SMSC's offset (`+02:00`); events always use UTC `Z` form. */
function toIsoString(value: string): string {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}
