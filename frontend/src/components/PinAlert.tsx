import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import type { Modem } from '../api/types';
import { isValidPin } from '../pin';

interface Props {
  modem: Modem;
  onUnlock: (modemId: string, pin: string) => Promise<string | null>;
}

export function PinAlert({ modem, onUnlock }: Props) {
  const [pin, setPin] = useState('');

  const handleUnlock = async () => {
    const error = await onUnlock(modem.id, pin);
    if (error === null) setPin('');
  };

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 flex flex-wrap items-center justify-between gap-3 text-amber-900 shadow-inner">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-amber-100 rounded-lg text-amber-700">
          <AlertTriangle className="w-5 h-5" />
        </div>
        <div>
          <p className="font-semibold text-sm">
            SIM PIN Required (+CME ERROR: 11) on {modem.name} ({modem.port})
          </p>
          <p className="text-xs text-amber-700">
            This modem is locked. Periodic SMS polling is paused to prevent error loops. Enter the
            SIM PIN to unlock.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          inputMode="numeric"
          placeholder="Enter PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="w-28 px-2.5 py-1 text-sm bg-white border border-amber-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-amber-500"
        />
        <button
          onClick={() => void handleUnlock()}
          disabled={!isValidPin(pin)}
          className="px-3 py-1 bg-amber-700 hover:bg-amber-800 disabled:bg-amber-300 text-white text-xs font-semibold rounded-lg shadow-sm cursor-pointer transition-colors"
        >
          Unlock SIM
        </button>
      </div>
    </div>
  );
}
