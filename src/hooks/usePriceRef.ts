// ─────────────────────────────────────────────────────────────────────────────
// usePriceRef — zero-render price subscription
//
// PROBLEM: AIChatScreen must never re-render from price ticks.
// Price is needed only for ref reads (buildContext), never for JSX.
//
// usePriceSelector throttles to 2x/sec — still too many for chat.
// This hook gives a ALWAYS-CURRENT ref that causes ZERO re-renders.
//
// HOW:
//   - A child component (PriceRefUpdater) subscribes to DataContext
//   - It updates the shared ref via a callback
//   - It renders nothing (returns null)
//   - Parent AIChatScreen never re-renders from price changes
//
// INVARIANT:
//   price update → DataContext update → PriceRefUpdater internal render
//              → AIChatScreen = 0 renders
// ─────────────────────────────────────────────────────────────────────────────
import React, { useRef, useEffect } from 'react';
import { useData } from '../context/DataContext';

// Internal component that subscribes to prices but renders nothing
// Lives as a child of AIChatScreen so its re-renders don't affect AIChatScreen
function PriceRefUpdaterInner({
  symbol,
  onPrice,
}: {
  symbol: string;
  onPrice: (price: any) => void;
}) {
  const { prices } = useData();
  const cp = prices[symbol];
  // Sync ref without setState — this component re-renders but parent does NOT
  useEffect(() => {
    if (cp) onPrice(cp);
  }); // no dep array — runs every render (every price tick)
  onPrice(cp); // synchronous update for immediate reads
  return null;
}

export const PriceRefUpdater = React.memo(PriceRefUpdaterInner);

// ─────────────────────────────────────────────────────────────────────────────
// Hook for the parent component (AIChatScreen)
// Returns a ref that is always current, causes ZERO parent renders
// ─────────────────────────────────────────────────────────────────────────────
export function usePriceRef(symbol: string) {
  const cpRef = useRef<any>(null);
  const pricesRef = useRef<Record<string, any>>({});

  // Callback to update refs — stable reference (useRef, not useState)
  const updatePrice = React.useCallback((cp: any) => {
    cpRef.current = cp;
    if (cp && symbol) {
      pricesRef.current = { ...pricesRef.current, [symbol]: cp };
    }
  }, [symbol]);

  return { cpRef, pricesRef, updatePrice };
}
