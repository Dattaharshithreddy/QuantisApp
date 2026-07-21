// ── IndicatorPanel — Technical Indicator Summary card ─────────────────────────
// Read-only display. None of this feeds ML/confidence/training/trading.
// All UI-helper derivations (rsiZone, macdColor, trendLabel) live here.
import React from 'react';
import { View, Text } from 'react-native';
import { pFmt } from '../../../utils/indicators';
import { Card, SectionLabel, Gauge, MetricBox } from '../../../components/Common';
import { RADIUS } from '../../../theme/colors';

type TechSummary = {
  snapshot: {
    rsi: number; macdBullish: boolean; macdHistogram: number | null;
    aboveEma200: boolean | null; adxValue: number | null; adxStrengthening: boolean;
    relativeVolume: number | null; volumeExpansion: boolean;
  };
  atrValue: number | null;
  bb: { upper: number | null; mid: number | null; lower: number | null; widthPct: number | null } | null;
};

type Props = { techSummary: TechSummary; T: any };

export function IndicatorPanel({ techSummary, T }: Props) {
  const s = techSummary.snapshot;
  const rsiZone = s.rsi >= 70
    ? { label: 'Overbought', color: T.red }
    : s.rsi <= 30 ? { label: 'Oversold', color: T.green }
    : { label: 'Neutral', color: T.textDim };
  const macdColor  = s.macdBullish ? T.green : T.red;
  const trendColor = s.aboveEma200 == null ? T.textDim : s.aboveEma200 ? T.green : T.red;
  const trendLabel = s.aboveEma200 == null ? '< 200 candles' : s.aboveEma200 ? 'Above EMA200 (Bullish)' : 'Below EMA200 (Bearish)';

  return (
    <Card theme={T} style={{ marginTop: 14 }}>
      <SectionLabel theme={T}>📐 TECHNICAL INDICATORS</SectionLabel>

      <View style={{ marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 }}>RSI (14)</Text>
          <View style={{ backgroundColor: rsiZone.color + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 2 }}>
            <Text style={{ color: rsiZone.color, fontSize: 9, fontWeight: '800' }}>{rsiZone.label}</Text>
          </View>
        </View>
        <Gauge value={s.rsi} color={rsiZone.color} label="" theme={T} size="sm" />
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <MetricBox label="MACD" value={s.macdBullish ? '▲ Bullish' : '▼ Bearish'} valueColor={macdColor} bg={macdColor + '12'} sub={s.macdHistogram != null ? `hist ${s.macdHistogram.toFixed(2)}` : '—'} theme={T} />
        <MetricBox label="TREND (EMA200)" value={trendLabel} valueColor={trendColor} bg={trendColor + '12'} theme={T} />
      </View>

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <MetricBox label="ADX (TREND STRENGTH)" value={`${s.adxValue != null ? s.adxValue.toFixed(0) : 'Insufficient data'}${s.adxStrengthening ? ' ↗' : ''}`} theme={T} />
        <MetricBox label="VOLUME"
          value={`${s.relativeVolume != null ? `${s.relativeVolume.toFixed(2)}×` : 'No baseline'}${s.volumeExpansion ? ' Expansion' : ''}`}
          valueColor={s.volumeExpansion ? T.amber : T.text}
          bg={s.volumeExpansion ? T.amber + '12' : T.bg3}
          theme={T} />
      </View>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 9 }}>
          <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>ATR (14) — VOLATILITY</Text>
          <Text style={{ color: T.text, fontSize: 12, fontWeight: '800', marginTop: 3 }}>{techSummary.atrValue != null ? pFmt(techSummary.atrValue) : 'Insufficient data'}</Text>
          <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>Avg true range — used for SL/TP sizing</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 9 }}>
          <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>BOLLINGER BANDS (20, 2σ)</Text>
          {techSummary.bb?.upper != null ? (
            <>
              <Text style={{ color: T.text, fontSize: 11, fontWeight: '700', marginTop: 3 }}>{pFmt(techSummary.bb.upper)} / {pFmt(techSummary.bb.mid!)} / {pFmt(techSummary.bb.lower!)}</Text>
              <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>Width {techSummary.bb.widthPct!.toFixed(2)}%</Text>
            </>
          ) : <Text style={{ color: T.textDim, fontSize: 11, marginTop: 3 }}>{'< 20 candles'}</Text>}
        </View>
      </View>
    </Card>
  );
}
