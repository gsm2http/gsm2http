import { Terminal } from 'lucide-react';
import type { LogEntry } from '../hooks/useGateway';
import { formatTime } from '../format';

export function AtLog({ entries }: { entries: LogEntry[] }) {
  return (
    <section className="bg-slate-900 rounded-xl border border-slate-800 shadow-lg overflow-hidden flex flex-col mt-6">
      <div className="px-5 py-3 border-b border-slate-800 flex items-center justify-between bg-slate-900/50">
        <div className="flex items-center gap-2.5">
          <Terminal className="w-4 h-4 text-slate-400" />
          <h2 className="font-mono text-xs font-semibold text-slate-300">Raw Serial AT Terminal</h2>
        </div>
        <span className="text-[11px] text-slate-500 font-mono">{entries.length} events</span>
      </div>
      <div className="p-4 overflow-y-auto h-64 font-mono text-xs text-slate-400 space-y-2">
        {entries.length === 0 ? (
          <p className="text-slate-600 italic">Waiting for events...</p>
        ) : (
          entries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2.5">
              <span className="text-slate-600 whitespace-nowrap">
                [{formatTime(entry.timestamp)}]
              </span>
              {entry.modemId && (
                <span className="px-1 py-0.2 bg-slate-800 text-cyan-400 rounded text-[10px] font-mono whitespace-nowrap">
                  {entry.modemId}
                </span>
              )}
              <span className="text-blue-400 font-semibold whitespace-nowrap">{entry.event}</span>
              <span className="text-slate-300 break-all">
                {typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
