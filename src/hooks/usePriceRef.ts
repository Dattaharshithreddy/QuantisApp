// ─────────────────────────────────────────────────────────────────────────────
// usePriceRef — zero-render price subscription for AIChatScreen
//
// PriceRefUpdater is a child component that subscribes to DataContext prices.
// Its internal re-renders are isolated — parent AIChatScreen never re-renders.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useRef, useEffect, useLayoutEffect } from 'react';
import { useData } from '../context/DataContext';

function PriceRefUpdaterInner({
  symbol,
  onPrice,
}: {
  symbol: string;
  onPrice: (price: any) => void;
}) {
  const { prices } = useData();
  const cp = prices[symbol];

  // useLayoutEffect runs synchronously after DOM mutations, before paint
  // Safe to call callbacks here (not during render body)
  useLayoutEffect(() => {
    onPrice(cp ?? null);
  }, [cp, onPrice]);

  return null;
}

export const PriceRefUpdater = React.memo(PriceRefUpdaterInner);

export function usePriceRef(symbol: string) {
  const cpRef    = useRef<any>(null);
  const pricesRef = useRef<Record<string, any>>({});

  const updatePrice = React.useCallback((cp: any) => {
    cpRef.current = cp;
    if (cp && symbol) pricesRef.current[symbol] = cp; // mutate in place — no new object
  }, [symbol]);

  return { cpRef, pricesRef, updatePrice };
}
