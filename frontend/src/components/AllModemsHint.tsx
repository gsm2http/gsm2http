import { Layers } from 'lucide-react';

export function AllModemsHint({ modemCount }: { modemCount: number }) {
  return (
    <div className="mb-6 bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
      <Layers className="w-8 h-8 text-blue-500 mx-auto mb-2" />
      <h3 className="font-bold text-slate-800 text-sm mb-1">All Modems View</h3>
      <p className="text-xs text-slate-500 mb-3">
        Viewing combined activity across all {modemCount} connected modems.
      </p>
      <p className="text-[11px] text-slate-400 border-t border-slate-200 pt-2.5">
        Select an individual modem tab above to manage SIM PIN unlock, network preferences, and
        voice calls.
      </p>
    </div>
  );
}
