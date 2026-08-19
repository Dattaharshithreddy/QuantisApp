import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { useData } from './DataContext';
import { runScanCycle, getScannerStatus, getScannerConfig, maybeSendDailySummary, ScannerStatus, ScannerConfig } from '../utils/watchlistScanner';
import { getNamedWatchlists, getActiveWatchlistName, resolveWatchlistAssets } from '../utils/multiWatchlist';
import { setBackgroundScanCallback, registerBackgroundTask, unregisterBackgroundTask } from '../utils/backgroundTask';
import { logger } from '../utils/logger';

// FIX (Phase 1 — Persistent Scanner): previously the polling interval lived
// entirely inside ScannerDashboardScreen's useEffect/useRef — meaning it was
// torn down the instant you navigated away from that screen (correct React
// cleanup, but the WRONG architecture for "the scanner keeps running").
// Moving interval ownership here, into a provider mounted once at the App
// root, means the interval survives navigation to any other screen, and on
// app launch this provider's mount effect restores + resumes polling
// automatically if it was previously enabled — addressing "restore pending
// timers safely" without any fragile cross-screen state sharing.
//
// HONEST LIMIT, stated plainly rather than glossed over: this provider only
// runs while the JS engine is alive — i.e. the app is open (foreground OR
// briefly backgrounded within OS limits). It does NOT run while the app is
// fully closed/terminated. See backgroundTask.ts for the best-effort
// supplement and its documented constraints; true always-on operation
// needs a server-side architecture, out of scope for a client-only app.

const ENABLED_KEY = 'scannerEnabled';

type ScannerServiceState = {
  enabled: boolean;
  status: ScannerStatus | null;
  toggleEnabled: () => Promise<void>;
  scanNow: () => Promise<void>;
};

const Ctx = createContext<ScannerServiceState>({} as ScannerServiceState);

export function ScannerServiceProvider({ children }: { children: React.ReactNode }) {
  const { allAssets, prices, aoSession, avKey } = useData();
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<ScannerStatus | null>(null);
  const intervalRef = useRef<any>(null);
  const restoredRef = useRef(false);

  const scanNow = useCallback(async () => {
    const livePrices: Record<string, number> = {};
    Object.entries(prices).forEach(([sym, p]) => { livePrices[sym] = p.price; });
    const namedLists = await getNamedWatchlists();
    const activeName = await getActiveWatchlistName();
    const assets = resolveWatchlistAssets(allAssets, activeName, namedLists);
    if (!assets.length) return;
    const result = await runScanCycle(assets, '15m', livePrices, aoSession, avKey);
    setStatus(result);
    await maybeSendDailySummary();
  }, [allAssets, prices, aoSession, avKey]);

  // FIX (found via direct simulation before trusting this): scanNow's
  // identity changes on every price tick (it closes over `prices`), which
  // change very frequently. An earlier version of this provider had the
  // interval-setup effect depend on a callback derived from scanNow — its
  // cleanup fired on every single price tick, but the restoration guard
  // prevented the effect body from ever restarting the interval after the
  // first tick, silently killing the "persistent" scanner within seconds.
  // Fixed by routing the interval's actual callback through a ref that's
  // kept fresh separately, so the interval itself never needs to be
  // recreated when scanNow's identity changes.
  const scanNowRef = useRef(scanNow);
  useEffect(() => { scanNowRef.current = scanNow; }, [scanNow]);

  // Supply the background task with the same scan logic — best-effort only,
  // see backgroundTask.ts for exactly why this can't be relied upon as the
  // primary mechanism. Registration failures (e.g. running in Expo Go) are
  // caught and logged, never thrown — the foreground scanner below is what
  // actually matters and must never be blocked by this.
  useEffect(() => {
    setBackgroundScanCallback(() => scanNowRef.current());
  }, []);

  const startPolling = useCallback(async (config: ScannerConfig) => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => { scanNowRef.current(); }, config.pollingIntervalMs);
  }, []); // stable identity — never depends on scanNow directly

  const toggleEnabled = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    await KVStore.set(ENABLED_KEY, next ? 'true' : 'false');
    if (next) {
      const config = await getScannerConfig();
      await startPolling(config);
      scanNowRef.current(); // kick off immediately rather than waiting a full interval
      const bg = await registerBackgroundTask();
      logger.info('ScannerService', `Background task registration: ${bg.registered ? 'ok' : 'unavailable'} — ${bg.reason}`);
    } else {
      clearInterval(intervalRef.current);
      await unregisterBackgroundTask();
    }
  }, [enabled, startPolling]);

  // App-launch restoration — runs exactly once (startPolling is now stable,
  // so this effect's dependency array never changes after mount, meaning
  // its cleanup only ever fires on true provider unmount, not on every
  // price tick).
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    (async () => {
      const wasEnabled = (await KVStore.get(ENABLED_KEY)) === 'true';
      const savedStatus = await getScannerStatus();
      setStatus(savedStatus);
      setEnabled(wasEnabled);
      if (wasEnabled) {
        logger.info('ScannerService', 'Restoring scanner state on launch — resuming polling.');
        const config = await getScannerConfig();
        await startPolling(config);
        const bg = await registerBackgroundTask();
        logger.info('ScannerService', `Background task re-registration on launch: ${bg.registered ? 'ok' : 'unavailable'} — ${bg.reason}`);
      }
    })();
    return () => clearInterval(intervalRef.current);
  }, [startPolling]);

  return (
    <Ctx.Provider value={{ enabled, status, toggleEnabled, scanNow }}>
      {children}
    </Ctx.Provider>
  );
}

export const useScannerService = () => useContext(Ctx);
