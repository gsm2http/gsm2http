import { logger } from '../logger';
import type { AnyGatewayEvent } from './schema';

export type EventListener = (event: AnyGatewayEvent) => void;

const log = logger.child({ component: 'event-bus' });

/**
 * In-process fan-out of gateway events. Every consumer (Socket.io, webhooks, MQTT)
 * subscribes here, so they all see the same events with the same IDs. Listeners run
 * synchronously; a listener that throws is logged and does not affect the others.
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  public publish(event: AnyGatewayEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.error({ err, event: event.event, eventId: event.id }, 'event listener failed');
      }
    }
  }

  /** Returns a function that removes the listener. */
  public subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
