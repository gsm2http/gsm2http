import { LogOut, Radio, Wifi, WifiOff } from 'lucide-react';

interface Props {
  modemCount: number;
  /** Configured webhook and MQTT sinks; null until the config has loaded. */
  notifierCount: number | null;
  isConnected: boolean;
  /** Shown only when the server requires a token. */
  onSignOut?: () => void;
}

export function Header({ modemCount, notifierCount, isConnected, onSignOut }: Props) {
  return (
    <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm">
      <div className="flex items-center gap-3">
        <div className="bg-blue-600 p-2.5 rounded-xl shadow-sm text-white">
          <Radio className="w-5 h-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold text-slate-800">gsm2http</h1>
            <span className="px-2 py-0.5 text-xs font-semibold bg-blue-100 text-blue-700 rounded-full">
              Multi-Modem
            </span>
          </div>
          <p className="text-xs text-slate-500">Self-hosted HTTP gateway for USB cellular modems</p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 bg-slate-100 text-slate-700 rounded-full text-xs font-semibold">
          <Radio className="w-3.5 h-3.5 text-blue-600" />
          <span>
            {modemCount} {modemCount === 1 ? 'Modem' : 'Modems'} Active
          </span>
        </div>

        {notifierCount !== null && (
          <div
            className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 text-slate-700 rounded-full border border-slate-200 text-xs font-medium shadow-sm"
            title={
              notifierCount > 0
                ? `${notifierCount} notifier${notifierCount === 1 ? '' : 's'} configured`
                : 'No webhook or MQTT notifier configured'
            }
          >
            <div
              className={`w-2 h-2 rounded-full ${notifierCount > 0 ? 'bg-green-500' : 'bg-red-500'}`}
            ></div>
            <span>Notifiers</span>
          </div>
        )}

        {isConnected ? (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 text-green-700 rounded-full border border-green-200 text-xs font-medium shadow-sm">
            <Wifi className="w-3.5 h-3.5" />
            <span>Connected</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-50 text-red-700 rounded-full border border-red-200 text-xs font-medium shadow-sm">
            <WifiOff className="w-3.5 h-3.5" />
            <span>Disconnected</span>
          </div>
        )}

        {onSignOut && (
          <button
            onClick={onSignOut}
            title="Forget the API token in this browser"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-600 rounded-full border border-slate-200 text-xs font-medium shadow-sm cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        )}
      </div>
    </header>
  );
}
