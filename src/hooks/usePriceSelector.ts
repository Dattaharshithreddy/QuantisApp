// ─────────────────────────────────────────────────────────────────────────────
// usePriceSelector — price subscription with controlled re-render frequency
//
// PROBLEM: ChartScreen calls useData() which subscribes to the full `prices`
// context. Every price update (aggTrade ~50-200ms, miniTicker ~1s, AO poll ~5s)
// creates a new prices object → DataContext re-renders ALL consumers including
// ChartScreen → 700-line render runs 5-20x/second → JS thread saturated →
// button taps, navigation, and prediction all feel sluggish.
//
// SOLUTION: This hook subscribes to prices but only triggers a ChartScreen
// re-render when:
//   1. The price STATUS changes (cache→websocket = LOADING→LIVE label)
//   2. The price VALUE changes by more than PRICE_CHANGE_THRESHOLD (for display)
//   3. At most MAX_RENDER_HZ times per second
//
// The ref (cpRef) is always current — components that need the latest price
// for non-render purposes (prediction, order book) read from cpRef.current.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect, useCallback } from 'react';
import { useData } from '../context/DataContext';

const MAX_RENDER_HZ   = 2;    // Max ChartScreen re-renders per second from price
const MIN_INTERVAL_MS = 1000 / MAX_RENDER_HZ; // 500ms
const PRICE_CHANGE_THRESHOLD = 0.0001; // 0.01% — ignore sub-tick noise

export function usePriceSelector(symbol: string) {
  const { prices } = useData();
  const cpRaw = prices[symbol];

  // Always-current ref — zero re-render cost, used by prediction + order book
  const cpRef = useRef(cpRaw);
  cpRef.current = cpRaw;

  // Throttled state — triggers ChartScreen re-render at most 2x/sec
  const [cp, setCp] = useState(cpRaw);
  const lastRenderMs  = useRef(0);
  const lastSource    = useRef(cpRaw?.source);
  const lastPrice     = useRef(cpRaw?.price ?? 0);
  const pendingTimer  = useRef<any>(null);

  const maybeUpdate = useCallback(() => {
    const now   = Date.now();
    const cur   = cpRef.current;
    if (!cur) return;

    const sourceChanged = cur.source !== lastSource.current;
    const priceChanged  = lastPrice.current === 0
      ? true
      : Math.abs(cur.price - lastPrice.current) / lastPrice.current > PRICE_CHANGE_THRESHOLD;

    if (!sourceChanged && !priceChanged) return; // nothing meaningful changed

    const elapsed = now - lastRenderMs.current;
    if (elapsed >= MIN_INTERVAL_MS) {
      // Enough time has passed — update immediately
      lastRenderMs.current = now;
      lastSource.current   = cur.source;
      lastPrice.current    = cur.price;
      setCp({ ...cur });
    } else if (!pendingTimer.current) {
      // Schedule a deferred update for the remaining window
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = null;
        const latest = cpRef.current;
        if (!latest) return;
        lastRenderMs.current = Date.now();
        lastSource.current   = latest.source;
        lastPrice.current    = latest.price;
        setCp({ ...latest });
      }, MIN_INTERVAL_MS - elapsed);
    }
  }, []);

  useEffect(() => {
    maybeUpdate();
  }, [cpRaw, maybeUpdate]);

  // Cleanup pending timer on unmount
  useEffect(() => () => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
  }, []);

  return { cp, cpRef };
}
