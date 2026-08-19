// ─────────────────────────────────────────────────────────────────────────────
// LiveSyncProvider  (v1.0.0)
//
// App-level singleton that keeps local live portfolio state in sync with
// the broker at all times. Mirrors PaperTradingMonitorProvider in structure.
//
// Runs reconciliation:
//   • Once on mount (startup check)
//   • Every 15 seconds while foregrounded
//   • When wsStatus transitions from error/reconnecting → live (reconnect)
//   • On app foreground (AppState active)
//
// Does NOT:
//   • Place, modify, or cancel any orders
//   • Affect paper trading in any way
//   • Block rendering — all reconciliation is non-blocking async
// ─────────────────────────────────────────────────────────────────────────────

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useData } from './DataContext';
import {
  reconcileOnce,
  startPeriodicReconciliation,
  stopPeriodicReconciliation,
} from '../utils/liveReconciliation';
import { getLivePortfolio } from '../utils/livePortfolio';
import { logger } from '../utils/logger';

const Ctx = createContext<{ lastSyncedAt: number }>({ lastSyncedAt: 0 });

export function useLiveSync() { return useContext(Ctx); }

export function LiveSyncProvider({ children }: { children: React.ReactNode }) {
  const { aoSession, prices, wsStatus } = useData();

  // Forward refs so interval callbacks always have the latest values
  // without needing to be recreated.
  const aoSessionRef   = useRef(aoSession);
  const pricesRef      = useRef(prices);
  const wsStatusRef    = useRef(wsStatus);
  const appStateRef    = useRef<AppStateStatus>(AppState.currentState);
  const inFlightRef    = useRef(false);
  const prevWsStatus   = useRef(wsStatus);

  useEffect(() => { aoSessionRef.current   = aoSession; }, [aoSession]);
  useEffect(() => { pricesRef.current      = prices;    }, [prices]);
  useEffect(() => { wsStatusRef.current    = wsStatus;  }, [wsStatus]);

  // ── AppState listener ──────────────────────────────────────────────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const wasBackground = appStateRef.current !== 'active';
      appStateRef.current = state;

      // Reconcile immediately on foreground return
      if (wasBackground && state === 'active') {
        logger.info('liveSync', 'App foregrounded — triggering reconciliation');
        triggerReconcile('app-foreground');
      }
    });
    return () => sub.remove();
  }, []);

  // ── wsStatus reconnect trigger ─────────────────────────────────────────────
  useEffect(() => {
    const prev = prevWsStatus.current;
    prevWsStatus.current = wsStatus;

    const wasDown    = prev === 'error' || prev === 'reconnecting';
    const isNowLive  = wsStatus === 'live';
    if (wasDown && isNowLive) {
      logger.info('liveSync', 'WebSocket reconnected — triggering reconciliation');
      triggerReconcile('ws-reconnect');
    }
  }, [wsStatus]);

  // ── Periodic reconciliation ────────────────────────────────────────────────
  useEffect(() => {
    // Only start if there's actually a live session to reconcile with
    startPeriodicReconciliation(
      () => aoSessionRef.current,
      () => {
        const lp: Record<string, number> = {};
        Object.entries(pricesRef.current).forEach(([sym, p]) => {
          if ((p as any)?.price) lp[sym] = (p as any).price;
        });
        return lp;
      },
    );

    // Startup reconciliation
    triggerReconcile('startup');

    return () => {
      stopPeriodicReconciliation();
    };
  }, []);

  // ── Helper ─────────────────────────────────────────────────────────────────
  async function triggerReconcile(trigger: string) {
    if (inFlightRef.current) return;
    if (appStateRef.current === 'background') return;

    // Check if there are any live positions to reconcile
    // — skip if portfolio is empty to avoid unnecessary broker API calls
    const portfolio = await getLivePortfolio();
    if (portfolio.openPositions.length === 0 && trigger !== 'startup') return;

    inFlightRef.current = true;
    try {
      const lp: Record<string, number> = {};
      Object.entries(pricesRef.current).forEach(([sym, p]) => {
        if ((p as any)?.price) lp[sym] = (p as any).price;
      });
      const result = await reconcileOnce(aoSessionRef.current, lp);
      if (result.ghosts.length > 0 || result.phantoms.length > 0) {
        logger.warn('liveSync',
          `[${trigger}] Reconciliation found discrepancies — ` +
          `ghosts: ${result.ghosts.length}, phantoms: ${result.phantoms.length}`
        );
      }
    } catch (e: any) {
      logger.error('liveSync', `[${trigger}] Reconciliation error: ${e.message}`);
    } finally {
      inFlightRef.current = false;
    }
  }

  return <Ctx.Provider value={{ lastSyncedAt: 0 }}>{children}</Ctx.Provider>;
}
