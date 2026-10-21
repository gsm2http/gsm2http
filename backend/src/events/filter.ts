import { EVENT_TYPES, type AnyGatewayEvent } from './schema';

/**
 * Which events a sink receives. `events` entries are exact names (`sms.received`), a
 * family (`sms.*`) or `*`. `modems`, when set, limits delivery to modems whose ID, IMEI or
 * phone number is listed.
 */
export interface EventFilter {
  events: string[];
  modems?: string[];
}

const FAMILIES = new Set(EVENT_TYPES.map((e) => e.split('.')[0]));

/** Throws on unknown event names, so a typo in the config fails at startup, not silently. */
export function validateEventPatterns(patterns: string[], source: string): string[] {
  if (patterns.length === 0) throw new Error(`${source}: list at least one event, or "*"`);
  for (const pattern of patterns) {
    if (pattern === '*') continue;
    const family = pattern.endsWith('.*') ? pattern.slice(0, -2) : undefined;
    if (family !== undefined ? FAMILIES.has(family) : EVENT_TYPES.includes(pattern as never)) {
      continue;
    }
    throw new Error(
      `${source}: unknown event "${pattern}". Known events: ${EVENT_TYPES.join(', ')}`,
    );
  }
  return patterns;
}

export function matchesEvent(patterns: readonly string[], event: string): boolean {
  return patterns.some(
    (p) => p === '*' || p === event || (p.endsWith('.*') && event.startsWith(p.slice(0, -1))),
  );
}

export function matchesFilter(filter: EventFilter, event: AnyGatewayEvent): boolean {
  if (!matchesEvent(filter.events, event.event)) return false;
  if (!filter.modems || filter.modems.length === 0) return true;
  const { id, imei, phoneNumber } = event.modem;
  return filter.modems.some((m) => m === id || m === imei || m === phoneNumber);
}
