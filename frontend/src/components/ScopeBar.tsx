import type { Modem } from '../api/types';

interface Props {
  /** The selected modem, or undefined when showing all modems. */
  modem: Modem | undefined;
  showAll: boolean;
  onShowAllChange: (showAll: boolean) => void;
}

export function ScopeBar({ modem, showAll, onShowAllChange }: Props) {
  return (
    <div className="flex items-center justify-between bg-white px-4 py-2.5 rounded-xl border border-slate-200 shadow-sm text-xs text-slate-600">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-slate-700">Display Scope:</span>
        <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-bold">
          {modem ? `Filtered to ${modem.model || modem.id} (${modem.port})` : 'All Modems'}
        </span>
      </div>
      {modem && (
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => onShowAllChange(e.target.checked)}
            className="rounded text-blue-600 focus:ring-blue-500"
          />
          <span>Show messages & calls from all modems</span>
        </label>
      )}
    </div>
  );
}
