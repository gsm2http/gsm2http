import { useState } from 'react';
import * as api from '../api/client';
import type { Modem, NetworkMode } from '../api/types';

type Log = (event: string, data: unknown, modemId?: string) => void;

/** REST actions on modems. Results and failures are reported to the AT log. */
export function useModemActions(addLog: Log, setModems: (modems: Modem[]) => void) {
  const [isScanning, setIsScanning] = useState(false);

  const logError = (message: string, modemId?: string) => addLog('error', { message }, modemId);

  const scan = async () => {
    setIsScanning(true);
    try {
      const res = await api.scanModems();
      setModems(res.modems);
    } catch (err) {
      logError(`Scan failed: ${api.errorMessage(err)}`);
    } finally {
      setIsScanning(false);
    }
  };

  /** Resolves to an error message, or null on success. */
  const unlock = async (modemId: string, pin: string): Promise<string | null> => {
    try {
      await api.unlockSim(modemId, pin);
      addLog('system', { message: `SIM on ${modemId} unlocked` }, modemId);
      return null;
    } catch (err) {
      const message = api.errorMessage(err);
      logError(`Unlock failed: ${message}`, modemId);
      return message;
    }
  };

  const query = async (modemId: string) => {
    try {
      await api.queryModem(modemId);
      addLog('system', { message: `Sent diagnostic query sequence to ${modemId}` }, modemId);
    } catch (err) {
      logError(`Diagnostic query failed: ${api.errorMessage(err)}`, modemId);
    }
  };

  const setNetwork = async (modemId: string, type: NetworkMode) => {
    try {
      await api.setNetworkMode(modemId, type);
      addLog('system', { message: `Switched network mode to ${type} on ${modemId}` }, modemId);
    } catch (err) {
      logError(`Network switch failed: ${api.errorMessage(err)}`, modemId);
    }
  };

  const dial = async (modemId: string, to: string, durationMs?: number): Promise<boolean> => {
    try {
      await api.dial(modemId, { to, durationMs });
      addLog('system', { message: `Dial request sent to ${to} on ${modemId}` }, modemId);
      return true;
    } catch (err) {
      logError(`Dial failed: ${api.errorMessage(err)}`, modemId);
      return false;
    }
  };

  const simulateSms = async (modemId: string) => {
    try {
      await api.mockSms({
        modemId,
        sender: '+12025550199',
        text: `Mock SMS message delivered to ${modemId}`,
      });
    } catch (err) {
      logError(`Mock SMS failed: ${api.errorMessage(err)}`, modemId);
    }
  };

  const simulateMultipartSms = async (modemId: string) => {
    try {
      await api.mockSms({ modemId, testCase: 'multipart-ucs2' });
    } catch (err) {
      logError(`Mock multipart SMS failed: ${api.errorMessage(err)}`, modemId);
    }
  };

  const simulateCall = async (modemId: string) => {
    try {
      await api.mockCall({ modemId, number: '+12025550188' });
    } catch (err) {
      logError(`Mock call failed: ${api.errorMessage(err)}`, modemId);
    }
  };

  return {
    isScanning,
    scan,
    unlock,
    query,
    setNetwork,
    dial,
    simulateSms,
    simulateMultipartSms,
    simulateCall,
  };
}

export type ModemActions = ReturnType<typeof useModemActions>;
