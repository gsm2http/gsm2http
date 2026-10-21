import { Activity, Phone, PhoneCall, Send, Signal, Unlock, VolumeX } from 'lucide-react';
import { useState } from 'react';
import type { Modem, NetworkMode } from '../api/types';
import type { ModemActions } from '../hooks/useModemActions';
import { isValidPin } from '../pin';
import { SimStatusBadge } from './SimStatusBadge';

const NETWORK_MODES: { mode: NetworkMode; label: string }[] = [
  { mode: '2g', label: 'Force 2G' },
  { mode: '3g', label: 'Force 3G' },
  { mode: 'auto', label: 'Auto' },
];

const sectionTitle = 'text-xs font-semibold text-slate-400 uppercase tracking-wider';

interface Props {
  modem: Modem;
  actions: ModemActions;
  isMockMode: boolean;
  defaultCallDurationMs: number | undefined;
}

export function ModemControls({ modem, actions, isMockMode, defaultCallDurationMs }: Props) {
  return (
    <>
      <ModemProfile modem={modem} />
      <PinUnlock modem={modem} onUnlock={actions.unlock} />

      <button
        onClick={() => void actions.query(modem.id)}
        className="w-full flex items-center justify-center gap-2 px-4 py-2 mb-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg transition-colors border border-slate-300 font-medium text-xs shadow-sm cursor-pointer"
      >
        <Activity className="w-3.5 h-3.5" />
        Query SIM / Network Info ({modem.id})
      </button>

      <h2 className={`${sectionTitle} mb-2`}>Network Selection</h2>
      <div className="flex gap-2 mb-6">
        {NETWORK_MODES.map(({ mode, label }) => (
          <button
            key={mode}
            onClick={() => void actions.setNetwork(modem.id, mode)}
            className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
              modem.networkMode === mode
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <h2 className={`${sectionTitle} mb-3`}>Outbound Call</h2>
      {modem.supportsVoice ? (
        <DialForm modemId={modem.id} onDial={actions.dial} durationMs={defaultCallDurationMs} />
      ) : (
        <div className="bg-slate-50 border border-slate-200 p-3 rounded-lg text-xs text-slate-500 mb-6 flex items-center gap-2">
          <VolumeX className="w-4 h-4 text-slate-400 shrink-0" />
          <span>Voice calls not supported on this model (SMS only).</span>
        </div>
      )}

      {isMockMode && <MockControls modemId={modem.id} actions={actions} />}
    </>
  );
}

function ModemProfile({ modem }: { modem: Modem }) {
  return (
    <div className="mb-6 bg-slate-50 border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">
          Active Device
        </span>
        <SimStatusBadge
          status={modem.simStatus}
          className="text-xs px-2 py-0.5 rounded-full font-semibold"
        />
      </div>
      <h3 className="font-bold text-slate-800 text-sm">{modem.name}</h3>
      <p className="text-xs text-slate-500 font-mono mb-3">{modem.port}</p>

      <div className="space-y-1.5 text-xs text-slate-600 border-t border-slate-200 pt-2.5">
        {modem.phoneNumber && (
          <div className="flex justify-between items-center bg-blue-50/70 p-1.5 rounded-lg border border-blue-200">
            <span className="text-blue-700 font-semibold">SIM Number:</span>
            <span className="font-mono font-bold text-blue-900">{modem.phoneNumber}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-slate-400">IMEI:</span>
          <span className="font-mono font-medium">{modem.imei || 'N/A'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Carrier:</span>
          <span className="font-medium">{modem.operator || 'Detecting...'}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-slate-400">Signal:</span>
          <div className="flex items-center gap-1.5">
            <Signal className="w-3.5 h-3.5 text-blue-600" />
            <span className="font-medium">{modem.signalPercentage ?? 0}%</span>
          </div>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-400">Voice Support:</span>
          <span
            className={`font-semibold ${modem.supportsVoice ? 'text-indigo-600' : 'text-slate-500'}`}
          >
            {modem.supportsVoice ? 'Voice + SMS' : 'SMS Only'}
          </span>
        </div>
      </div>
    </div>
  );
}

interface PinUnlockProps {
  modem: Modem;
  onUnlock: ModemActions['unlock'];
}

function PinUnlock({ modem, onUnlock }: PinUnlockProps) {
  const [pin, setPin] = useState('');
  const [feedback, setFeedback] = useState<{ message: string; isError: boolean } | null>(null);

  const handleUnlock = async () => {
    setFeedback(null);
    const error = await onUnlock(modem.id, pin);
    if (error === null) {
      setPin('');
      setFeedback({ message: `Modem ${modem.id} unlocked.`, isError: false });
      setTimeout(() => setFeedback(null), 5000);
    } else {
      setFeedback({ message: error, isError: true });
    }
  };

  return (
    <>
      <h2 className={`${sectionTitle} mb-3`}>Unlock SIM ({modem.id})</h2>
      <div className="flex gap-2 mb-2">
        <input
          type="password"
          inputMode="numeric"
          placeholder="SIM PIN"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
        />
        <button
          onClick={() => void handleUnlock()}
          disabled={!isValidPin(pin)}
          className="flex items-center justify-center p-2 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg transition-colors shadow-sm cursor-pointer"
          title="Unlock SIM PIN"
        >
          <Unlock className="w-4 h-4" />
        </button>
      </div>
      {feedback && (
        <p className={`text-xs mb-4 ${feedback.isError ? 'text-red-600' : 'text-green-600'}`}>
          {feedback.message}
        </p>
      )}
    </>
  );
}

interface DialFormProps {
  modemId: string;
  onDial: ModemActions['dial'];
  /** Server default; when unknown the request omits it and the server applies its own. */
  durationMs: number | undefined;
}

function DialForm({ modemId, onDial, durationMs }: DialFormProps) {
  const [number, setNumber] = useState('');
  const [isDialing, setIsDialing] = useState(false);

  const handleDial = async () => {
    setIsDialing(true);
    const ok = await onDial(modemId, number, durationMs);
    if (ok) setNumber('');
    setIsDialing(false);
  };

  const durationLabel = durationMs === undefined ? '' : ` (${Math.round(durationMs / 1000)} s)`;

  return (
    <div className="flex flex-col gap-2 mb-6">
      <input
        type="tel"
        placeholder="+12025550199"
        value={number}
        onChange={(e) => setNumber(e.target.value)}
        className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors"
      />
      <button
        onClick={() => void handleDial()}
        disabled={!number || isDialing}
        className="w-full flex items-center justify-center gap-2 p-2 bg-green-600 hover:bg-green-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-lg transition-colors shadow-sm font-medium text-xs cursor-pointer"
      >
        <Phone className="w-3.5 h-3.5" />
        {isDialing ? 'Dialing...' : `Dial & hang up${durationLabel}`}
      </button>
    </div>
  );
}

interface MockControlsProps {
  modemId: string;
  actions: ModemActions;
}

function MockControls({ modemId, actions }: MockControlsProps) {
  return (
    <>
      <h2 className={`${sectionTitle} mb-3`}>Mock Testing</h2>
      <div className="space-y-2 mb-6">
        <button
          onClick={() => void actions.simulateSms(modemId)}
          className="w-full flex items-center gap-2.5 px-3 py-2 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-lg border border-blue-200 font-medium text-xs text-left shadow-sm cursor-pointer"
        >
          <Send className="w-3.5 h-3.5 text-blue-600" />
          <span>Simulate SMS on {modemId}</span>
        </button>
        <button
          onClick={() => void actions.simulateMultipartSms(modemId)}
          className="w-full flex items-center gap-2.5 px-3 py-2 bg-cyan-50 hover:bg-cyan-100 text-cyan-800 rounded-lg border border-cyan-200 font-medium text-xs text-left shadow-sm cursor-pointer"
        >
          <Send className="w-3.5 h-3.5 text-cyan-600" />
          <span>Simulate 4-part UCS-2 SMS ({modemId})</span>
        </button>
        <button
          onClick={() => void actions.simulateCall(modemId)}
          className="w-full flex items-center gap-2.5 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg border border-indigo-200 font-medium text-xs text-left shadow-sm cursor-pointer"
        >
          <PhoneCall className="w-3.5 h-3.5 text-indigo-600" />
          <span>Simulate Call on {modemId}</span>
        </button>
      </div>
    </>
  );
}
