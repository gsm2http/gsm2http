import { Activity, Layers } from 'lucide-react';
import type { Modem } from '../api/types';
import { SimStatusBadge } from './SimStatusBadge';

interface Props {
  modems: Modem[];
  onManage: (modemId: string) => void;
  onQuery: (modemId: string) => void;
}

export function ModemInventory({ modems, onManage, onQuery }: Props) {
  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-blue-600" />
          <h2 className="font-bold text-slate-800 text-sm uppercase tracking-wider">
            Connected Modem Inventory ({modems.length})
          </h2>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {modems.map((m) => (
          <div
            key={m.id}
            className="border border-slate-200 rounded-xl p-4 bg-slate-50/60 hover:bg-white hover:border-blue-300 transition-all flex flex-col justify-between"
          >
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-slate-800 text-sm">{m.name}</span>
                <SimStatusBadge
                  status={m.simStatus}
                  className="text-[10px] px-2 py-0.5 rounded-full font-bold"
                />
              </div>
              <p className="text-xs font-mono text-slate-500 mb-2">{m.port}</p>

              <div className="space-y-1 text-xs text-slate-600 mb-3">
                {m.phoneNumber && (
                  <div className="flex justify-between items-center bg-blue-50/70 px-2 py-1 rounded border border-blue-200">
                    <span className="text-blue-700 font-semibold">Phone:</span>
                    <span className="font-mono font-bold text-blue-900">{m.phoneNumber}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-slate-400">Carrier:</span>
                  <span className="font-medium">{m.operator || 'Detecting...'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Signal:</span>
                  <span className="font-medium">{m.signalPercentage ?? 0}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Features:</span>
                  <span className="font-semibold text-slate-700">
                    {m.supportsVoice ? 'Voice + SMS' : 'SMS Only'}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex gap-2 pt-2 border-t border-slate-200">
              <button
                onClick={() => onManage(m.id)}
                className="flex-1 py-1 px-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-semibold transition-colors cursor-pointer"
              >
                Manage
              </button>
              <button
                onClick={() => onQuery(m.id)}
                className="py-1 px-2.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded text-xs font-medium transition-colors cursor-pointer"
                title="Query Diagnostics"
              >
                <Activity className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
