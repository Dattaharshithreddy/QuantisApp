// ── LiveCandleCountdown — isolated 1s countdown timer ─────────────────────────
// FIX H-2: Previously the countdown timer (setNowTick every 1s) lived inside
// useChartData, which is called from ChartScreen. Every setNowTick → ChartScreen
// re-renders (740 lines, 6 hooks, all memoized children get new prop refs) just
// to update this small countdown label. Lifted into its own leaf component so
// only this tiny render runs every second, not the entire screen.
import React, { useState, useEffect } from 'react';
import { View, Text } from 'react-native';
import { Candle } from '../../../utils/indicators';

const TF_MS: Record<string, number> = {
  '5m': 300000, '15m': 900000, '30m': 1800000,
  '1h': 3600000, '4h': 14400000, '1D': 86400000,
};

type Props = {
  lastCandle: Candle | null;
  tf: string;
  T: any;
};

export function LiveCandleCountdown({ lastCandle, tf, T }: Props) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!lastCandle) return null;
  const intervalMs = TF_MS[tf];
  if (!intervalMs) return null;
  const remainingMs = Math.max(0, lastCandle.time + intervalMs - now);
  if (remainingMs <= 0) return null;

  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000) / 1000);
  const countdownLabel = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const changePct = ((lastCandle.close - lastCandle.open) / lastCandle.open) * 100;

  return (
    <View style={{
      flexDirection: 'row', justifyContent: 'space-between',
      backgroundColor: T.bg2, borderRadius: 6, padding: 10, marginTop: 8,
    }}>
      <Text style={{ color: T.textDim, fontSize: 10 }}>
        Live candle · closes in{' '}
        <Text style={{ color: T.text, fontWeight: '700' }}>{countdownLabel}</Text>
      </Text>
      <Text style={{
        color: changePct >= 0 ? T.green : T.red,
        fontSize: 10, fontWeight: '700',
      }}>
        {changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%
      </Text>
    </View>
  );
}
