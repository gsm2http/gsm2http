import { useEffect, useState } from 'react';
import { errorMessage, getNotifiers } from '../api/client';
import type { NotifiersResponse, NotifierSummary } from '../api/types';
import { formatTime } from '../format';

const REFRESH_MS = 10_000;
const RECENT_DELIVERIES = 5;

function health(n: NotifierSummary): { dot: string; label: string } {
  if (n.type === 'mqtt' && !n.connected) return { dot: 'bg-red-500', label: 'Broker offline' };
  if (n.stats.pending > 0) return { dot: 'bg-amber-500', label: `${n.stats.pending} pending` };
  const lastFailure = n.stats.lastFailureAt ?? '';
  if (lastFailure > (n.stats.lastSuccessAt ?? '')) {
    return { dot: 'bg-red-500', label: n.stats.lastError ?? 'Failing' };
  }
  return { dot: 'bg-green-500', label: n.stats.delivered > 0 ? 'OK' : 'Idle' };
}

/**
 * Read-only view of the webhook and MQTT sinks. They are configured in CONFIG_FILE or
 * env vars (see docs/events.md), never from the UI.
 */
export function NotifierStatus() {
  const [data, setData] = useState<NotifiersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getNotifiers()
        .then((res) => {
          if (cancelled) return;
          setData(res);
          setError(null);
        })
        .catch((err: unknown) => !cancelled && setError(errorMessage(err)));
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
        Notifiers
      </h2>
      <div className="mb-6 flex flex-col gap-2">
        {error && <p className="text-xs text-red-600">{error}</p>}
        {data && data.notifiers.length === 0 && (
          <p className="text-xs text-slate-500 bg-slate-50 p-2 rounded border border-slate-200">
            No webhook or MQTT notifier configured. Set <code>WEBHOOK_URL</code>,{' '}
            <code>MQTT_URL</code> or <code>CONFIG_FILE</code>.
          </p>
        )}
        {data?.notifiers.map((n) => {
          const { dot, label } = health(n);
          return (
            <div key={n.name} className="text-xs bg-slate-50 p-2 rounded border border-slate-200">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-700 truncate">
                  {n.name}{' '}
                  <span className="font-normal text-slate-400">
                    {n.type}
                    {n.signed ? ' · signed' : ''}
                  </span>
                </span>
                <span className="flex items-center gap-1.5 text-slate-500 shrink-0" title={label}>
                  <span className={`w-2 h-2 rounded-full ${dot}`} />
                  <span className="max-w-24 truncate">{label}</span>
                </span>
              </div>
              <div className="text-slate-500 truncate" title={n.target}>
                {n.target}
              </div>
              <div className="text-slate-400 truncate" title={n.events.join(', ')}>
                {n.events.join(', ')} · {n.stats.delivered} sent · {n.stats.failed} failed
              </div>
            </div>
          );
        })}
        {data && data.deliveries.length > 0 && (
          <ul className="text-[11px] text-slate-500 font-mono">
            {data.deliveries.slice(0, RECENT_DELIVERIES).map((d) => (
              <li
                key={`${d.eventId}-${d.notifier}-${d.attempt}`}
                className="truncate"
                title={d.error}
              >
                {formatTime(d.at)} {d.notifier} {d.event} {d.outcome}
                {d.status ? ` ${d.status}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
