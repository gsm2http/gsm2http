import { useCallback, useState } from 'react';
import { AllModemsHint } from './components/AllModemsHint';
import { AtLog } from './components/AtLog';
import { CallsPanel } from './components/CallsPanel';
import { Header } from './components/Header';
import { ModemControls } from './components/ModemControls';
import { ModemInventory } from './components/ModemInventory';
import { ModemTabs } from './components/ModemTabs';
import { PinAlert } from './components/PinAlert';
import { ScopeBar } from './components/ScopeBar';
import { SmsPanel } from './components/SmsPanel';
import { NotifierStatus } from './components/NotifierStatus';
import { useGateway } from './hooks/useGateway';
import { useModemActions } from './hooks/useModemActions';
import { useServerConfig } from './hooks/useServerConfig';
import { ALL_MODEMS, type ModemSelection } from './selection';

export default function App({ onSignOut }: { onSignOut: () => void }) {
  const { isConnected, modems, setModems, messages, calls, log, addLog } = useGateway();
  const logError = useCallback((message: string) => addLog('error', { message }), [addLog]);
  const { config } = useServerConfig(logError);
  const actions = useModemActions(addLog, setModems);

  const [selection, setSelection] = useState<ModemSelection>(ALL_MODEMS);
  const [showAllInPanels, setShowAllInPanels] = useState(false);

  // A selected modem that has since been unplugged falls back to the first one.
  const currentModem =
    selection === ALL_MODEMS ? undefined : (modems.find((m) => m.id === selection) ?? modems[0]);

  const isFiltered = currentModem !== undefined && !showAllInPanels;
  const visibleMessages = isFiltered
    ? messages.filter((m) => m.modemId === currentModem.id)
    : messages;
  const visibleCalls = isFiltered ? calls.filter((c) => c.modemId === currentModem.id) : calls;
  const visibleLog = isFiltered
    ? log.filter((e) => !e.modemId || e.modemId === currentModem.id)
    : log;

  const recipientFor = (modemId: string) => modems.find((m) => m.id === modemId)?.phoneNumber;
  const pinLockedModem = modems.find((m) => m.simStatus === 'SIM PIN');

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      <Header
        modemCount={modems.length}
        notifierCount={config?.notifierCount ?? null}
        isConnected={isConnected}
        onSignOut={config?.authEnabled ? onSignOut : undefined}
      />

      <ModemTabs
        modems={modems}
        selection={selection}
        onSelect={setSelection}
        isScanning={actions.isScanning}
        onScan={() => void actions.scan()}
      />

      {pinLockedModem && <PinAlert modem={pinLockedModem} onUnlock={actions.unlock} />}

      <div className="flex-1 flex overflow-hidden">
        <aside className="w-80 bg-white border-r border-slate-200 flex flex-col p-6 shadow-sm z-10 overflow-y-auto">
          {currentModem ? (
            <ModemControls
              key={currentModem.id}
              modem={currentModem}
              actions={actions}
              isMockMode={config?.mockMode ?? false}
              defaultCallDurationMs={config?.defaultCallDurationMs}
            />
          ) : (
            <AllModemsHint modemCount={modems.length} />
          )}

          {config && <NotifierStatus />}
        </aside>

        <main className="flex-1 overflow-y-auto p-6">
          <div className="max-w-6xl mx-auto space-y-6">
            {selection === ALL_MODEMS && (
              <ModemInventory
                modems={modems}
                onManage={setSelection}
                onQuery={(modemId) => void actions.query(modemId)}
              />
            )}

            <ScopeBar
              modem={currentModem}
              showAll={showAllInPanels}
              onShowAllChange={setShowAllInPanels}
            />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <SmsPanel messages={visibleMessages} recipientFor={recipientFor} />
              <CallsPanel calls={visibleCalls} recipientFor={recipientFor} />
            </div>

            <AtLog entries={visibleLog} />
          </div>
        </main>
      </div>
    </div>
  );
}
