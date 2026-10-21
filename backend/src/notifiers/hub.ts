import { EventName, matchesFilter, type AnyGatewayEvent, type EventBus } from '../events';
import { logger } from '../logger';
import type { DeliveryLog, DeliveryRecord, Notifier, NotifierSummary } from './types';

export interface NotifierHubOptions {
  /**
   * At most one `modem.status` per modem per interval reaches the sinks; in between, only
   * the latest state is kept and sent when the interval ends. 0 sends every update.
   * Socket.io is not throttled.
   */
  modemStatusMinIntervalMs: number;
}

interface StatusThrottle {
  lastSentAt: number;
  pending?: AnyGatewayEvent;
  timer?: NodeJS.Timeout;
}

const log = logger.child({ component: 'notifiers' });

/** Subscribes the configured sinks to the event bus. */
export class NotifierHub {
  private readonly throttles = new Map<string, StatusThrottle>();
  private readonly unsubscribe: () => void;

  constructor(
    bus: EventBus,
    private readonly notifiers: Notifier[],
    private readonly deliveryLog: DeliveryLog,
    private readonly options: NotifierHubOptions,
  ) {
    this.unsubscribe = notifiers.length > 0 ? bus.subscribe((e) => this.handle(e)) : () => true;
  }

  private handle(event: AnyGatewayEvent): void {
    if (event.event === EventName.ModemStatus) {
      this.throttleStatus(event);
      return;
    }
    if (event.event === EventName.ModemRemoved) this.dropPendingStatus(event.modem.id);
    this.fanOut(event);
  }

  private fanOut(event: AnyGatewayEvent): void {
    for (const notifier of this.notifiers) {
      if (!matchesFilter(notifier.filter, event)) continue;
      try {
        notifier.deliver(event);
      } catch (err) {
        log.error({ err, notifier: notifier.name, event: event.event }, 'notifier threw');
      }
    }
  }

  private throttleStatus(event: AnyGatewayEvent): void {
    const interval = this.options.modemStatusMinIntervalMs;
    if (interval <= 0) {
      this.fanOut(event);
      return;
    }

    const id = event.modem.id;
    const now = Date.now();
    const state = this.throttles.get(id);
    if (!state || (!state.timer && now - state.lastSentAt >= interval)) {
      this.throttles.set(id, { lastSentAt: now });
      this.fanOut(event);
      return;
    }

    state.pending = event;
    state.timer ??= setTimeout(
      () => {
        state.timer = undefined;
        const latest = state.pending;
        state.pending = undefined;
        if (!latest) return;
        state.lastSentAt = Date.now();
        this.fanOut(latest);
      },
      state.lastSentAt + interval - now,
    );
    state.timer.unref();
  }

  /** `modem.removed` carries the final state, so a held-back status would only be stale. */
  private dropPendingStatus(modemId: string): void {
    const state = this.throttles.get(modemId);
    if (!state) return;
    clearTimeout(state.timer);
    this.throttles.delete(modemId);
  }

  public get size(): number {
    return this.notifiers.length;
  }

  public summaries(): NotifierSummary[] {
    return this.notifiers.map((n) => n.describe());
  }

  public deliveries(): DeliveryRecord[] {
    return this.deliveryLog.list();
  }

  public async close(): Promise<void> {
    this.unsubscribe();
    for (const state of this.throttles.values()) clearTimeout(state.timer);
    this.throttles.clear();
    await Promise.allSettled(this.notifiers.map((n) => n.close()));
  }
}
