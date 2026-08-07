import React, { useMemo } from 'react';
// Presentational component — no state, no hooks, no memoization needed here.
// All data is precomputed in useChartIndicators and passed as props.
import { View, Text } from 'react-native';
import { Candle, pFmt } from '../../../utils/indicators';
import { getMarketStructureSnapshot } from '../../../utils/marketStructureSnapshot';
import { Card, SectionLabel, Pill } from '../../../components/Common';
import { RADIUS } from '../../../theme/colors';
import { ChartPatternSummary, PatternResult } from '../../../utils/chartPatterns';
import type { ValidatedPattern } from '../../../utils/patternValidation/patternValidationTypes';
import { PatternMatch } from '../../../utils/candlePatterns';
import type { TFSignal, Timeframe } from '../../../utils/mtf/mtfTypes';
import { computeTradeReadiness } from '../../../utils/mtf/tradeReadiness';
import { computeStrategyRegimeMatrix, recommendStrategy, recommendStrategyGlobal } from '../../../utils/strategy/strategyPerformance';
import { TradeReadinessCard } from './TradeReadinessCard';

type Props = {
  candles: Candle[];
  msSnapshot: any;
  smcSnap: any;
  fvgSnap: any;
  fvgBull: any[];
  fvgBear: any[];
  vwapSnap: any;
  vpSnap: any;
  mtfSnap: any;
  mtfSignals: TFSignal[];
  regimeSnap: any;
  T: any;
  geoPatterns?: ChartPatternSummary | null;
  validatedPatterns?: ValidatedPattern[];
  candlePatterns?: PatternMatch[];
  prediction?: { action: string; direction: string; confidence: number } | null;
  baseTF?: Timeframe;
  pricePrecision?: number;
  // Active strategy profile — passed through to computeTradeReadiness so gates
  // are applied before Trade Readiness state is shown. Optional: null = no strategy.
  strategyProfile?: any | null;
  // Optional completed trade records for strategy recommendation display.
  // Null/empty = no recommendation shown. Zero engine changes — pure analytics read.
  paperTrades?: Array<{
    strategyId: string | null | undefined;
    pnl: number; pnlPct: number;
    holdingBars: number; holdingMs: number;
    entryConfidence: number;
    regimeAtEntry: string;
    direction: 'LONG' | 'SHORT';
  }>;
};

export const MarketStructureCard = React.memo(function MarketStructureCard({ candles, msSnapshot, smcSnap, fvgSnap, fvgBull, fvgBear, vwapSnap, vpSnap, mtfSnap, mtfSignals = [], regimeSnap, T, geoPatterns = null, validatedPatterns = [], candlePatterns = [], prediction = null, baseTF = '15m', pricePrecision = 2, paperTrades = [], strategyProfile = null }: Props) {
  const snap = getMarketStructureSnapshot(candles);

  // ── Trade Readiness — translate engine outputs to plain English ───────────
  // computeTradeReadiness reads existing engine outputs only. No new logic.
  // topPattern: the highest-confidence confirmed pattern, for Decision Breakdown.
  const topConfirmedForReadiness = validatedPatterns
    .filter(vp => vp.status !== 'FAILED' && vp.status !== 'EXPIRED' && vp.confidence >= 40)
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null;

  const readiness = computeTradeReadiness({
    prediction,
    mtfSnap,
    mtfSignals,
    regimeSnap,
    baseTF,
    lastSwingHigh: snap?.lastSwingHigh ?? null,
    lastSwingLow:  snap?.lastSwingLow  ?? null,
    pricePrecision,
    smcSnap: smcSnap ?? null,
    msSnapshot: snap ?? null,
    topPattern: topConfirmedForReadiness
      ? { direction: topConfirmedForReadiness.direction, confidence: topConfirmedForReadiness.confidence }
      : null,
    strategyProfile: strategyProfile ?? null});
  if (!snap) return null;

  const structColor = (s: string) => s === 'HH' || s === 'HL' ? T.green : s === 'LH' || s === 'LL' ? T.red : T.textDim;
  const structIcon  = (s: string) => s === 'HH' || s === 'HL' ? '▲' : s === 'LH' || s === 'LL' ? '▼' : '—';

  // ── Sections rendered by this component ─────────────────────────────────────
  // 1. Market Structure (HH/HL/LH/LL + candlestick patterns)
  // 2. SMC (Order Blocks, Liquidity, PD Bias)
  // 3. FVG (Fair Value Gaps)
  // 4. VWAP + Volume Profile
  // 5. Chart Patterns + MTF
  // 6. Trade Readiness
  // 7. Market Regime + Strategy Recommendation
  // 8. Pivot Levels
  // Next step: extract each section into a named sub-component file in
  //   chart/components/sections/ — blocked pending unit test coverage to
  //   catch any JSX scope regressions during extraction.
  // ─────────────────────────────────────────────────────────────────────────────
  const PricePill = ({ label, value, color }: { label: string; value: number; color: string }) => (
    <View style={{ alignItems: 'center', backgroundColor: color + '14', borderRadius: RADIUS.sm, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: color + '35' }}>
      <Text style={{ color, fontSize: 9, fontWeight: '700', letterSpacing: 0.3 }}>{label}</Text>
      <Text style={{ color, fontSize: 11, fontWeight: '800', marginTop: 1 }}>{pFmt(value)}</Text>
    </View>
  );

  // ── Strategy recommendation — pure analytics read of paper trade history ─────
  // Rolling window: last 100 trades per (strategy, regime) cell.
  // Prevents stale history from dominating as market conditions evolve.
  const ROLLING_WINDOW = 100;

  const strategyRecommendation = React.useMemo(() => {
    if (!regimeSnap || !paperTrades || paperTrades.length < 5) return null;
    try {
      const opts = { recencyWindow: ROLLING_WINDOW };
      const matrix = computeStrategyRegimeMatrix(paperTrades as any, opts);
      // Try per-regime recommendation first (best quality)
      const perRegime = recommendStrategy(regimeSnap.label, matrix, opts);
      if (perRegime) return { ...perRegime, isGlobalFallback: false };
      // Fix #10: fall back to global stats when per-regime data is insufficient
      return recommendStrategyGlobal(paperTrades as any, opts) ?? null;
    } catch { return null; }
  }, [regimeSnap?.label, paperTrades?.length]);

  return (
    <Card theme={T} style={{ marginTop: 14 }}>
      {/* ── SECTION 1: Market Structure (HH/HL/LH/LL + candlestick patterns) ── */}
      <SectionLabel theme={T}>MARKET STRUCTURE</SectionLabel>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1, backgroundColor: structColor(snap.structureHighs) + '12', borderRadius: RADIUS.sm, padding: 10, alignItems: 'center' }}>
          <Text style={{ color: structColor(snap.structureHighs), fontWeight: '800', fontSize: 15 }}>{structIcon(snap.structureHighs)} {snap.structureHighs}</Text>
          <Text style={{ color: T.textDim, fontSize: 8, marginTop: 3, fontWeight: '700', letterSpacing: 0.3 }}>SWING HIGHS</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: structColor(snap.structureLows) + '12', borderRadius: RADIUS.sm, padding: 10, alignItems: 'center' }}>
          <Text style={{ color: structColor(snap.structureLows), fontWeight: '800', fontSize: 15 }}>{structIcon(snap.structureLows)} {snap.structureLows}</Text>
          <Text style={{ color: T.textDim, fontSize: 8, marginTop: 3, fontWeight: '700', letterSpacing: 0.3 }}>SWING LOWS</Text>
        </View>
      </View>

      {snap.patterns.length > 0 && (
        <View style={{ marginBottom: 12 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>🕯️ CANDLESTICK PATTERNS</Text>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
            {snap.patterns.map((p: any, i: number) => (
              <Pill key={i} label={p.name} color={p.bullish === true ? T.green : p.bullish === false ? T.red : T.textDim} active />
            ))}
          </View>
        </View>
      )}

      {/* ── SECTION 2: SMC (Order Blocks, Liquidity, PD Bias) ── */}
      {smcSnap && (
        <View style={{ marginBottom: 14 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>💰 SMART MONEY CONCEPTS</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            {smcSnap.bullOBStrength > 0.1 && (
              <View style={{ backgroundColor: T.green+'18', borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3, borderLeftWidth: 2, borderLeftColor: T.green }}>
                <Text style={{ color: T.green, fontSize: 9, fontWeight: '700', flexShrink: 1 }}>▲ Bull OB {(smcSnap.bullOBStrength*100).toFixed(0)}%{smcSnap.obFreshness ? ' · FRESH' : ''}</Text>
              </View>
            )}
            {smcSnap.bearOBStrength > 0.1 && (
              <View style={{ backgroundColor: T.red+'18', borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3, borderLeftWidth: 2, borderLeftColor: T.red }}>
                <Text style={{ color: T.red, fontSize: 9, fontWeight: '700', flexShrink: 1 }}>▼ Bear OB {(smcSnap.bearOBStrength*100).toFixed(0)}%</Text>
              </View>
            )}
            {smcSnap.liquiditySweep > 0 && (
              <View style={{ backgroundColor: T.amber+'18', borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3, borderLeftWidth: 2, borderLeftColor: T.amber }}>
                <Text style={{ color: T.amber, fontSize: 9, fontWeight: '700' }}>⚡ LIQ SWEEP{smcSnap.stopHuntProb > 0 ? ' · STOP HUNT' : ''}</Text>
              </View>
            )}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: T.bg3, borderRadius: 6, padding: 8 }}>
            <View>
              <Text style={{ color: T.textDim, fontSize: 8 }}>PD ZONE</Text>
              <Text style={{ color: smcSnap.pdBias > 0.2 ? T.green : smcSnap.pdBias < -0.2 ? T.red : T.amber, fontSize: 10, fontWeight: '700' }}>
                {smcSnap.pdBias > 0.2 ? 'DISCOUNT' : smcSnap.pdBias < -0.2 ? 'PREMIUM' : 'EQUILIB'}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: T.textDim, fontSize: 8 }}>OB CONF</Text>
              <Text style={{ color: T.text, fontSize: 10, fontWeight: '600' }}>{(smcSnap.obConfidence*100).toFixed(0)}%</Text>
            </View>
          </View>
        </View>
      )}

      {/* ── SECTION 3: FVG (Fair Value Gaps) ── */}
      {(fvgBull?.length > 0 || fvgBear?.length > 0) && (
        <View style={{ marginBottom: 14 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>📊 FAIR VALUE GAPS</Text>
          {fvgBull?.map((fvg: any, idx: number) => (
            <View key={idx} style={{ backgroundColor: T.green+'12', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 2, flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: T.green, fontSize: 9, fontWeight: '600', flexShrink: 1 }}>▲ Bull {fvg.gapLow.toFixed(2)}–{fvg.gapHigh.toFixed(2)}</Text>
              <Text style={{ color: T.textDim, fontSize: 9 }}>{fvg.status === 'partial' ? `${(fvg.fillPct*100).toFixed(0)}% filled` : fvg.status} age:{fvg.age}</Text>
            </View>
          ))}
          {fvgBear?.map((fvg: any, idx: number) => (
            <View key={idx} style={{ backgroundColor: T.red+'12', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, marginBottom: 2, flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: T.red, fontSize: 9, fontWeight: '600', flexShrink: 1 }}>▼ Bear {fvg.gapLow.toFixed(2)}–{fvg.gapHigh.toFixed(2)}</Text>
              <Text style={{ color: T.textDim, fontSize: 9 }}>{fvg.status === 'partial' ? `${(fvg.fillPct*100).toFixed(0)}% filled` : fvg.status} age:{fvg.age}</Text>
            </View>
          ))}
        </View>
      )}

      {/* ── SECTION 4: VWAP + Volume Profile ── */}
      {vwapSnap && (
        <View style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 7, marginBottom: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3, gap: 4 }}>
            <Text style={{ color: T.textDim, fontSize: 8, flexShrink: 1 }}>SESSION VWAP</Text>
            <Text style={{ color: T.textDim, fontSize: 8, flexShrink: 1, textAlign: 'center' }}>WEEKLY</Text>
            <Text style={{ color: T.textDim, fontSize: 8, flexShrink: 1, textAlign: 'right' }}>MONTHLY</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 4 }}>
            <Text style={{ color: T.accent, fontSize: 10, fontWeight: '700', flexShrink: 1 }}>{vwapSnap.sessionVWAP.toFixed(2)}</Text>
            <Text style={{ color: T.text, fontSize: 10, flexShrink: 1, textAlign: 'center' }}>{vwapSnap.weeklyVWAP.toFixed(2)}</Text>
            <Text style={{ color: T.text, fontSize: 10, flexShrink: 1, textAlign: 'right' }}>{vwapSnap.monthlyVWAP.toFixed(2)}</Text>
          </View>
        </View>
      )}
      {vpSnap && (
        <View style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 7, marginBottom: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 }}>
            <View><Text style={{ color: T.textDim, fontSize: 8 }}>POC</Text><Text style={{ color: T.amber, fontSize: 10, fontWeight: '700' }}>{vpSnap.poc.toFixed(2)}</Text></View>
            <View style={{ alignItems: 'center' }}><Text style={{ color: T.textDim, fontSize: 8 }}>VAH</Text><Text style={{ color: T.green, fontSize: 10, fontWeight: '600' }}>{vpSnap.vah.toFixed(2)}</Text></View>
            <View style={{ alignItems: 'flex-end' }}><Text style={{ color: T.textDim, fontSize: 8 }}>VAL</Text><Text style={{ color: T.red, fontSize: 10, fontWeight: '600' }}>{vpSnap.val.toFixed(2)}</Text></View>
          </View>
        </View>
      )}

      {/* ── SECTION 5: Chart Patterns + MTF ── */}
        {/* ── Chart Patterns — validated by Pattern Validation Framework ─── */}
        <View style={{ marginBottom: 14 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>📐 CHART PATTERNS</Text>
          {(() => {
            // Use validated patterns when available; fall back to raw geometry
            // so the card degrades gracefully if validation hasn't run yet.
            if (validatedPatterns.length > 0) {
              // Primary: validated patterns with confidence >= 40 (tradeable quality)
              const tradeable = validatedPatterns
                .filter(vp => vp.status !== 'FAILED' && vp.status !== 'EXPIRED' && vp.confidence >= 40)
                .slice(0, 2);
              // Secondary: forming patterns below threshold — shown with a FORMING label
              // so the chart badge and the card are never contradictory to the user.
              const forming = validatedPatterns
                .filter(vp => vp.status !== 'FAILED' && vp.status !== 'EXPIRED' && vp.confidence < 40)
                .slice(0, 1);
              const toShow = tradeable.length ? tradeable : [];
              if (!toShow.length && !forming.length) return <Text style={{ color: T.textDim, fontSize: 10 }}>No tradeable pattern detected</Text>;
              if (!toShow.length && forming.length) return (
                <View style={{ backgroundColor: (T.amber ?? '#F59E0B') + '18', borderRadius: 6, padding: 8, borderLeftWidth: 2, borderLeftColor: T.amber ?? '#F59E0B' }}>
                  <Text style={{ color: T.amber ?? '#F59E0B', fontSize: 10, fontWeight: '700' }}>🔄 {forming[0].patternName} — FORMING</Text>
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 3 }}>Detected geometrically but not yet confirmed. Confidence {forming[0].confidence.toFixed(0)}% — below the 40% tradeable threshold.</Text>
                </View>
              );
              return toShow.map((vp, idx) => {
                const col = vp.direction === 'bullish' ? T.green : vp.direction === 'bearish' ? T.red : T.amber ?? '#F59E0B';
                const icon = vp.direction === 'bullish' ? '🟢' : vp.direction === 'bearish' ? '🔴' : '🟡';
                const statusCol = vp.status === 'CONFIRMED' ? T.green : vp.status === 'DETECTED' ? T.amber : T.textDim;
                const statusIcon = vp.status === 'CONFIRMED' ? '✅' : vp.status === 'DETECTED' ? '👁' : vp.status === 'FORMING' ? '🔄' : '⚠️';
                const topReason  = vp.reasons[0] ?? null;
                const topFailed  = vp.failedConditions[0] ?? null;
                return (
                  <View key={vp.patternId} style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 8, marginBottom: 6 }}>
                    {/* Header: name + direction + status */}
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <Text style={{ color: col, fontSize: 10, fontWeight: '700', flexShrink: 1 }}>{icon} {vp.patternName}</Text>
                      <View style={{ flexDirection: 'row', gap: 4 }}>
                        <View style={{ backgroundColor: statusCol + '22', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
                          <Text style={{ color: statusCol, fontSize: 7, fontWeight: '700' }}>{statusIcon} {vp.status}</Text>
                        </View>
                        <View style={{ backgroundColor: col + '22', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
                          <Text style={{ color: col, fontSize: 7, fontWeight: '700' }}>{vp.direction.toUpperCase()}</Text>
                        </View>
                      </View>
                    </View>
                    {/* Confidence + risk levels */}
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 3 }}>
                      <Text style={{ color: T.textDim, fontSize: 9 }}>Confidence <Text style={{ color: vp.confidence >= 70 ? T.green : vp.confidence >= 50 ? T.amber : T.red, fontWeight: '700' }}>{vp.confidence}/100</Text></Text>
                      {vp.risk?.target2 != null && <Text style={{ color: T.textDim, fontSize: 9 }}>Target <Text style={{ color: col, fontWeight: '600' }}>{vp.risk.target2.toFixed(2)}</Text></Text>}
                      {vp.risk?.stopLoss != null && <Text style={{ color: T.textDim, fontSize: 9 }}>Stop <Text style={{ color: T.red, fontWeight: '600' }}>{vp.risk.stopLoss.toFixed(2)}</Text></Text>}
                      {vp.risk?.riskReward2 != null && <Text style={{ color: T.textDim, fontSize: 9 }}>R:R <Text style={{ color: T.text, fontWeight: '600' }}>1:{vp.risk.riskReward2.toFixed(1)}</Text></Text>}
                    </View>
                    {/* Explainability: top reason + top failed condition */}
                    {topReason  && <Text style={{ color: T.green, fontSize: 8 }}>✓ {topReason}</Text>}
                    {topFailed  && <Text style={{ color: T.red,   fontSize: 8 }}>✗ {topFailed}</Text>}
                  </View>
                );
              });
            }
            // Fallback: raw geometry (no validation yet)
            if (!geoPatterns || !geoPatterns.patterns.length)
              return <Text style={{ color: T.textDim, fontSize: 10 }}>No active chart pattern</Text>;
            const best = geoPatterns.patterns[0];
            const toShow: PatternResult[] = [best];
            if (geoPatterns.patterns.length > 1 && Math.abs(best.strength - geoPatterns.patterns[1].strength) <= 0.05)
              toShow.push(geoPatterns.patterns[1]);
            return toShow.map((p, idx) => {
              const col = p.direction === 'bullish' ? T.green : p.direction === 'bearish' ? T.red : T.amber ?? '#F59E0B';
              const icon = p.direction === 'bullish' ? '🟢' : p.direction === 'bearish' ? '🔴' : '🟡';
              return (
                <View key={idx} style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 8, marginBottom: 6 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                    <Text style={{ color: col, fontSize: 10, fontWeight: '700', flexShrink: 1 }}>{icon} {p.name}</Text>
                    <View style={{ backgroundColor: col + '22', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, marginLeft: 6 }}>
                      <Text style={{ color: col, fontSize: 8, fontWeight: '700' }}>{p.direction === 'bullish' ? 'BULLISH' : p.direction === 'bearish' ? 'BEARISH' : 'NEUTRAL'}</Text>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                    <Text style={{ color: T.textDim, fontSize: 9 }}>Strength <Text style={{ color: T.text, fontWeight: '600' }}>{(p.strength * 100).toFixed(0)}%</Text></Text>
                    {p.target != null && <Text style={{ color: T.textDim, fontSize: 9 }}>Target <Text style={{ color: col, fontWeight: '600' }}>{p.target.toFixed(2)}</Text></Text>}
                    {p.stopLevel != null && <Text style={{ color: T.textDim, fontSize: 9 }}>Stop <Text style={{ color: T.red, fontWeight: '600' }}>{p.stopLevel.toFixed(2)}</Text></Text>}
                  </View>
                </View>
              );
            });
          })()}
        </View>

        {/* ── Candle Patterns ─────────────────────────────────── */}
        {candlePatterns.length > 0 && (
          <View style={{ marginBottom: 14 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>🕯️ CANDLE PATTERNS</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {candlePatterns.map((cp, idx) => {
                const col = cp.bullish === true ? T.green : cp.bullish === false ? T.red : T.textSub;
                const icon = cp.bullish === true ? '🟢' : cp.bullish === false ? '🔴' : '🟡';
                return (
                  <View key={idx} style={{ backgroundColor: T.bg3, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: col + '44' }}>
                    <Text style={{ color: col, fontSize: 9, fontWeight: '600' }}>{icon} {cp.name}</Text>
                  </View>
                );
              })}
            </View>
          </View>
        )}

      {/* ── SECTION 6: Trade Readiness ── */}
      {/* Trade Readiness — replaces raw MTF score row.
           DEV: raw MTF score is preserved inside TradeReadinessCard behind __DEV__ flag.
           Remove DevDebugRow inside TradeReadinessCard.tsx when ready for production. */}
      <TradeReadinessCard
        readiness={readiness}
        mtfScore={mtfSnap?.overallMTFScore ?? 0}
        chochAlignment={mtfSnap?.chochAlignment ?? 0}
        htfBias={mtfSnap?.htfBias ?? 0}
        T={T}
      />

      {/* ── SECTION 7: Market Regime + Strategy Recommendation ── */}
      {regimeSnap && (
        <View>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 5 }}>🎯 MARKET REGIME</Text>
          <View style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ color: regimeSnap.label.includes('BULL') ? T.green : regimeSnap.label.includes('BEAR') ? T.red : regimeSnap.label === 'BREAKOUT' ? T.amber : T.textDim, fontSize: 12, fontWeight: '800' }}>
                {regimeSnap.label.replace(/_/g, ' ')}
              </Text>
              <Text style={{ color: T.textDim, fontSize: 9 }}>Confidence {(regimeSnap.confidence*100).toFixed(0)}%</Text>
            </View>
          </View>

          {/* Strategy recommendation — shown when sufficient paper trade history exists */}
          {strategyRecommendation && (
            <View style={{
              marginTop: 8, flexDirection: 'row', alignItems: 'flex-start', gap: 8,
              backgroundColor: T.blue + '0D', borderRadius: 6,
              borderWidth: 1, borderColor: T.blue + '30', padding: 8}}>
              <Text style={{ fontSize: 12, marginTop: 1 }}>💡</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.4, marginBottom: 2 }}>
                  {(strategyRecommendation as any)?.isGlobalFallback ? 'BEST STRATEGY (ALL REGIMES)' : 'BEST STRATEGY FOR THIS REGIME'}
                </Text>
                <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>
                  {strategyRecommendation.strategyId}
                  {'  '}
                  <Text style={{ color: T.green, fontWeight: '600' }}>
                    {strategyRecommendation.winRate.toFixed(0)}% win
                  </Text>
                  {'  '}
                  <Text style={{ color: T.textDim, fontWeight: '500' }}>
                    {strategyRecommendation.tradeCount} trades
                  </Text>
                </Text>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>
                  {strategyRecommendation.confidence} confidence
                </Text>
              </View>
            </View>
          )}
        </View>
      )}

      {/* ── SECTION 8: Pivot Levels ── */}
      {msSnapshot && msSnapshot.pivots?.length > 0 && (
        <View style={{ marginTop: 12 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>PIVOT LEVELS</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {msSnapshot.pivots.slice(0, 6).map((p: any, i: number) => (
              <PricePill key={i} label={p.label} value={p.price} color={p.type === 'support' ? T.green : T.red} />
            ))}
          </View>
        </View>
      )}
    </Card>
  );
});
