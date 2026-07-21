import React, { createContext, useContext, useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { useData } from './DataContext';
import { monitorOpenPositions }        from '../utils/paperTradingEngine';
import { monitorShadowTrades }         from '../utils/shadowTradeJournal';
import { monitorFuturesPositions }     from '../utils/futures/futuresPortfolio';
import { monitorBnFuturesPositions }   from '../utils/futures/binance/bnFuturesPortfolio';
import { logger } from '../utils/logger';

// App-level singleton that calls all position monitors on a 5-second tick
// so that SL/TP hits, notifications, MTM settlement, and funding payments
// fire regardless of which screen is open.
//
// Monitors run in this order each tick:
//   1. Paper equity positions    (SL/TP, notifications)
//   2. Shadow trades             (outcome tracking)
//   3. NSE futures positions     (SL/TP, expiry, MTM at 3:30pm)
//   4. Binance perp futures      (SL/TP, liquidation, 8h funding)
//
// Architecture: prices forwarded through a ref so the interval never needs
// to be recreated when prices change.

const POLL_MS = 5_000;

// Map DataContext price keys to the format each futures monitor expects.
// NSE futures monitor needs underlying symbols (NIFTY, BANKNIFTY, etc.)
// Binance futures monitor needs full perp symbols (BTCUSDT, ETHUSDT, etc.)
function buildLivePrices(prices: Record<string, any>): Record<string, number> {
  const lp: Record<string, number> = {};
  Object.entries(prices).forEach(([sym, p]) => {
    if ((p as any)?.price && Number.isFinite((p as any).price) && (p as any).price > 0)
      lp[sym] = (p as any).price;
  });
  return lp;
}

// Map QUANTIS internal symbols to Binance perp symbols for the monitor
const BN_PERP_MAP: Record<string, string> = {
  BTCUSD: 'BTCUSDT', ETHUSD: 'ETHUSDT', BNBUSD: 'BNBUSDT', SOLUSD: 'SOLUSDT',
  XRPUSD: 'XRPUSDT', ADAUSD: 'ADAUSDT', DOGEUSD: 'DOGEUSDT',
  AVAXUSD: 'AVAXUSDT', DOTUSD: 'DOTUSDT', MATICUSD: 'MATICUSDT',
};

function buildBnPerpPrices(prices: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  Object.entries(prices).forEach(([sym, p]) => {
    const price = (p as any)?.price;
    if (!price || !Number.isFinite(price) || price <= 0) return;
    // Include both the QUANTIS key and the mapped Binance perp key
    out[sym] = price;
    const perpKey = BN_PERP_MAP[sym];
    if (perpKey) out[perpKey] = price;
  });
  return out;
}

const Ctx = createContext<Record<string, never>>({});

export function PaperTradingMonitorProvider({ children }: { children: React.ReactNode }) {
  const { prices } = useData();

  const pricesRef = useRef(prices);
  useEffect(() => { pricesRef.current = prices; }, [prices]);

  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', s => { appStateRef.current = s; });
    return () => sub.remove();
  }, []);

  const inFlightRef = useRef(false);

  useEffect(() => {
    const tick = async () => {
      if (appStateRef.current === 'background') return;
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const lp    = buildLivePrices(pricesRef.current);
        const bnLp  = buildBnPerpPrices(pricesRef.current);
        if (!Object.keys(lp).length) return;

        // 1. Paper equity
        await monitorOpenPositions(lp);
        // 2. Shadow journal
        await monitorShadowTrades(lp);
        // 3. NSE futures — uses underlying names (NIFTY, BANKNIFTY, etc.)
        //    The futures monitor reads open positions and checks their .underlying
        //    field against livePrices. We pass all prices — it only uses what matches.
        await monitorFuturesPositions(lp);
        // 4. Binance perpetuals — needs BTCUSDT, ETHUSDT format
        //    No funding rates from DataContext yet — pass empty so only SL/TP/liq fires.
        //    Funding is self-managed inside applyFundingPayments via lastFundingAt check.
        await monitorBnFuturesPositions(bnLp, {});
      } catch (e: any) {
        logger.warn('PaperTradingMonitor', `tick error: ${e?.message ?? e}`);
      } finally {
        inFlightRef.current = false;
      }
    };

    const id = setInterval(tick, POLL_MS);
    logger.info('PaperTradingMonitor', 'Global position monitor started (equity + NSE futures + Binance perps).');
    return () => {
      clearInterval(id);
      logger.info('PaperTradingMonitor', 'Global position monitor stopped.');
    };
  }, []);

  return <Ctx.Provider value={{}}>{children}</Ctx.Provider>;
}

export const usePaperTradingMonitor = () => useContext(Ctx);
