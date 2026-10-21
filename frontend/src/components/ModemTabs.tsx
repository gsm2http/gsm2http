import { Layers, Radio, RefreshCw, ShieldAlert } from 'lucide-react';
import type { Modem } from '../api/types';
import { ALL_MODEMS, type ModemSelection } from '../selection';

interface Props {
  modems: Modem[];
  selection: ModemSelection;
  onSelect: (selection: ModemSelection) => void;
  isScanning: boolean;
  onScan: () => void;
}

export function ModemTabs({ modems, selection, onSelect, isScanning, onScan }: Props) {
  const isAllSelected = selection === ALL_MODEMS;

  return (
    <div className="bg-slate-100 border-b border-slate-200 px-6 py-2 flex items-center justify-between overflow-x-auto gap-4">
      <div className="flex items-center gap-2">
        <button
          onClick={() => onSelect(ALL_MODEMS)}
          className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
            isAllSelected
              ? 'bg-blue-600 text-white shadow-sm'
              : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200'
          }`}
        >
          <Layers className="w-3.5 h-3.5" />
          <span>All Modems</span>
          <span
            className={`ml-1 px-1.5 py-0.2 rounded-full text-[10px] ${
              isAllSelected ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-600'
            }`}
          >
            {modems.length}
          </span>
        </button>

        {modems.map((modem) => (
          <ModemTab
            key={modem.id}
            modem={modem}
            isSelected={selection === modem.id}
            onSelect={() => onSelect(modem.id)}
          />
        ))}
      </div>

      <button
        onClick={onScan}
        disabled={isScanning}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-50 text-slate-700 rounded-lg text-xs font-medium border border-slate-300 shadow-sm cursor-pointer disabled:opacity-50"
        title="Rescan USB ports for new or re-plugged modems"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin text-blue-600' : ''}`} />
        <span>{isScanning ? 'Scanning...' : 'Scan Modems'}</span>
      </button>
    </div>
  );
}

interface ModemTabProps {
  modem: Modem;
  isSelected: boolean;
  onSelect: () => void;
}

function ModemTab({ modem, isSelected, onSelect }: ModemTabProps) {
  return (
    <button
      onClick={onSelect}
      className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
        isSelected
          ? 'bg-white text-blue-700 border-2 border-blue-600 shadow-sm'
          : 'bg-white text-slate-700 hover:bg-slate-200 border border-slate-200'
      }`}
    >
      <Radio className={`w-3.5 h-3.5 ${isSelected ? 'text-blue-600' : 'text-slate-400'}`} />
      <div className="flex flex-col text-left">
        <div className="flex items-center gap-1.5">
          <span className="font-bold leading-tight">{modem.model || modem.name}</span>
          {modem.phoneNumber && (
            <span
              className={`text-[10px] font-mono font-bold px-1.5 py-0.2 rounded ${
                isSelected ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'
              }`}
            >
              {modem.phoneNumber}
            </span>
          )}
        </div>
        <span className="text-[10px] text-slate-500 leading-tight">{modem.port}</span>
      </div>

      {modem.simStatus === 'SIM PIN' ? (
        <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300">
          <ShieldAlert className="w-2.5 h-2.5 text-amber-600" />
          PIN
        </span>
      ) : modem.simStatus === 'READY' ? (
        <span className="w-2 h-2 rounded-full bg-green-500" title="SIM Ready"></span>
      ) : (
        <span className="w-2 h-2 rounded-full bg-red-500" title={modem.simStatus}></span>
      )}

      {modem.supportsVoice ? (
        <span className="hidden md:inline px-1 py-0.2 rounded text-[9px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">
          Voice
        </span>
      ) : (
        <span className="hidden md:inline px-1 py-0.2 rounded text-[9px] font-medium bg-slate-100 text-slate-600 border border-slate-200">
          SMS
        </span>
      )}
    </button>
  );
}
