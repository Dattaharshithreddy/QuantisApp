// ─────────────────────────────────────────────────────────────────────────────
// MarketContextCard  (v1.0.0)
//
// Displays Indian or Crypto market context alongside a prediction.
// Purely presentational — zero engine calls, zero ML impact.
//
// Rendering rules:
//   • Indian assets  → VIX, Breadth, FII/DII, PCR, Sector Strength
//   • Crypto assets  → Fear & Greed, BTC Dom, Market Trend, Funding, OI, Stable Dom
//   • Unavailable    → "Market Context unavailable" message (never hidden)
//   • kind === NONE  → null (no section rendered)
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { MarketContextSnapshot } from '../utils/marketContextSnapshot';
import type { MarketContext }       from '../utils/marketContext/marketContextTypes';
import type { CryptoMarketContext } from '../utils/cryptoMarketContext/cryptoMarketContextTypes';

// ── Reuse existing Common components where available ─────────────────────────
// We only use View/Text primitives to avoid coupling to Card/Pill internals.

interface Props {
  snapshot:  MarketContextSnapshot | null | undefined;
  T:         any;   // theme object — same shape used across all cards
  compact?:  boolean; // journal/review mode — less vertical spacing
}

// ── Sentiment colour helper ───────────────────────────────────────────────────
function sentimentColor(
  sentiment: string | undefined | null,
  T: any,
): string {
  if (!sentiment) return T.textDim ?? '#888';
  const s = sentiment.toUpperCase();
  if (s.includes('BULL') || s.includes('GREED') || s.includes('BUY') ||
      s.includes('RISK_ON') || s.includes('FALLING') && s.includes('VIX')) return T.green ?? '#22c55e';
  if (s.includes('BEAR') || s.includes('FEAR')  || s.includes('SELL') ||
      s.includes('RISK_OFF') || s.includes('EXTREME')) return T.red ?? '#ef4444';
  return T.textSub ?? '#aaa';
}

// ── Compact metric row ────────────────────────────────────────────────────────
function MetricRow({
  label, value, valueColor, T,
}: { label: string; value: string; valueColor?: string; T: any }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, { color: T.textDim }]}>{label}</Text>
      <Text style={[styles.value, { color: valueColor ?? T.text }]}>{value}</Text>
    </View>
  );
}

// ── Overall sentiment badge ───────────────────────────────────────────────────
function SentimentBadge({ sentiment, T }: { sentiment: string; T: any }) {
  const color = sentiment === 'BULLISH' ? (T.green ?? '#22c55e')
              : sentiment === 'BEARISH' ? (T.red   ?? '#ef4444')
              : (T.textDim ?? '#888');
  const emoji = sentiment === 'BULLISH' ? '🟢' : sentiment === 'BEARISH' ? '🔴' : '🟡';
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{emoji} {sentiment}</Text>
    </View>
  );
}

// ── Indian context panel ──────────────────────────────────────────────────────
function IndianContextPanel({ ctx, T, compact }: { ctx: MarketContext; T: any; compact?: boolean }) {
  const { vix, breadth, fiidii, pcr, sectors, available } = ctx;

  if (available.length === 0) {
    return <Text style={[styles.unavailable, { color: T.textDim }]}>Market Context unavailable</Text>;
  }

  const vixColor = vix
    ? (vix.regime === 'LOW' ? (T.green ?? '#22c55e')
    : vix.regime === 'NORMAL' ? (T.textSub ?? '#aaa')
    : vix.regime === 'HIGH' ? '#f59e0b'
    : (T.red ?? '#ef4444'))
    : T.textDim;

  const adrColor = breadth
    ? (breadth.adTrend === 'BULLISH' ? (T.green ?? '#22c55e')
    : breadth.adTrend === 'BEARISH' ? (T.red ?? '#ef4444')
    : T.textSub)
    : T.textDim;

  const fiiBiasColor = fiidii
    ? sentimentColor(fiidii.bias, T)
    : T.textDim;

  const pcrColor = pcr
    ? sentimentColor(pcr.sentiment, T)
    : T.textDim;

  // Overall heuristic — used in badge
  const signals: number[] = [];
  if (breadth)  signals.push(breadth.adTrend === 'BULLISH' ? 1 : breadth.adTrend === 'BEARISH' ? -1 : 0);
  if (vix)      signals.push(vix.trend === 'FALLING' ? 1 : vix.trend === 'RISING' ? -1 : 0);
  if (fiidii)   signals.push(fiidii.bias === 'FII_BUY' ? 1 : fiidii.bias === 'FII_SELL' ? -1 : 0);
  if (pcr)      signals.push(pcr.isContrarianBull ? 1 : pcr.isContrarianBear ? -1 : 0);
  const avg = signals.length ? signals.reduce((a, b) => a + b, 0) / signals.length : 0;
  const overall = avg >  0.3 ? 'BULLISH' : avg < -0.3 ? 'BEARISH' : 'NEUTRAL';

  return (
    <View>
      <View style={styles.headerRow}>
        <Text style={[styles.sectionTitle, { color: T.textSub }]}>🇮🇳 INDIAN MARKET</Text>
        <SentimentBadge sentiment={overall} T={T} />
      </View>

      {vix && (
        <MetricRow
          label="India VIX"
          value={`${vix.current.toFixed(1)}  ${vix.regime}  ${vix.trend}`}
          valueColor={vixColor}
          T={T}
        />
      )}
      {breadth && (
        <MetricRow
          label="Breadth A/D"
          value={`${(breadth.adRatio * 100).toFixed(0)}%  ${breadth.adTrend}${breadth.breadthThrust ? '  ⚡ THRUST' : ''}`}
          valueColor={adrColor}
          T={T}
        />
      )}
      {fiidii && (
        <MetricRow
          label="FII / DII"
          value={`${fiidii.bias}  FII ${fiidii.fiiNetCash >= 0 ? '+' : ''}${(fiidii.fiiNetCash / 100).toFixed(0)}Cr`}
          valueColor={fiiBiasColor}
          T={T}
        />
      )}
      {pcr && (
        <MetricRow
          label="Put/Call Ratio"
          value={`${pcr.current.toFixed(2)}  ${pcr.sentiment}`}
          valueColor={pcrColor}
          T={T}
        />
      )}
      {sectors && (
        <MetricRow
          label="Sector Leader"
          value={`${sectors.leader}  (${(sectors.participation * 100).toFixed(0)}% sectors outperform)`}
          valueColor={T.textSub}
          T={T}
        />
      )}
    </View>
  );
}

// ── Crypto context panel ──────────────────────────────────────────────────────
function CryptoContextPanel({ ctx, T, compact }: { ctx: CryptoMarketContext; T: any; compact?: boolean }) {
  const { fearGreed, marketCap, funding, openInterest, stablecoin, available } = ctx;

  if (available.length === 0) {
    return <Text style={[styles.unavailable, { color: T.textDim }]}>Market Context unavailable</Text>;
  }

  const fgColor = fearGreed
    ? (fearGreed.value <= 25 ? (T.red ?? '#ef4444')
    : fearGreed.value <= 45 ? '#f97316'
    : fearGreed.value <= 55 ? (T.textSub ?? '#aaa')
    : fearGreed.value <= 75 ? '#22c55e'
    : '#16a34a')
    : T.textDim;

  const fundingColor = funding
    ? (funding.sentiment === 'EXTREME_LONG'  ? (T.red   ?? '#ef4444')
    : funding.sentiment === 'LONG_BIASED'   ? '#f97316'
    : funding.sentiment === 'EXTREME_SHORT' ? (T.green  ?? '#22c55e')
    : funding.sentiment === 'SHORT_BIASED'  ? '#86efac'
    : T.textSub)
    : T.textDim;

  const oiColor = openInterest
    ? (openInterest.conviction === 'BULLISH' ? (T.green ?? '#22c55e')
    : openInterest.conviction === 'BEARISH' ? (T.red ?? '#ef4444')
    : T.textSub)
    : T.textDim;

  const stableColor = stablecoin
    ? (stablecoin.signal === 'RISK_ON' ? (T.green ?? '#22c55e')
    : stablecoin.signal === 'RISK_OFF' ? (T.red ?? '#ef4444')
    : T.textSub)
    : T.textDim;

  // Overall heuristic
  const fg = fearGreed?.value ?? 50;
  const fr = funding?.fundingRate ?? 0;
  const ss = stablecoin?.signal;
  const sigs = [
    (fg - 50) / 50,
    Math.sign(fr) * Math.min(Math.abs(fr) / 0.05, 1) * -1,
    ss === 'RISK_ON' ? 1 : ss === 'RISK_OFF' ? -1 : 0,
  ];
  const avg = sigs.reduce((a, b) => a + b, 0) / sigs.length;
  const overall = avg >  0.25 ? 'BULLISH' : avg < -0.25 ? 'BEARISH' : 'NEUTRAL';

  return (
    <View>
      <View style={styles.headerRow}>
        <Text style={[styles.sectionTitle, { color: T.textSub }]}>₿ CRYPTO MARKET</Text>
        <SentimentBadge sentiment={overall} T={T} />
      </View>

      {fearGreed && (
        <MetricRow
          label="Fear & Greed"
          value={`${fearGreed.value}  ${fearGreed.classification}  ${fearGreed.trend}`}
          valueColor={fgColor}
          T={T}
        />
      )}
      {marketCap && (
        <MetricRow
          label="BTC Dominance"
          value={`${marketCap.btcDominance.toFixed(1)}%  ${marketCap.regime}  (${marketCap.btcDominanceChange24h >= 0 ? '+' : ''}${marketCap.btcDominanceChange24h.toFixed(2)}pp 24h)`}
          valueColor={T.textSub}
          T={T}
        />
      )}
      {marketCap && (
        <MetricRow
          label="Total Market"
          value={`${marketCap.totalChange24h >= 0 ? '+' : ''}${marketCap.totalChange24h.toFixed(2)}% 24h`}
          valueColor={marketCap.totalChange24h >= 0 ? (T.green ?? '#22c55e') : (T.red ?? '#ef4444')}
          T={T}
        />
      )}
      {funding && (
        <MetricRow
          label="Funding Rate"
          value={`${(funding.fundingRate * 100).toFixed(4)}%  ${funding.sentiment}${funding.isOverheated ? '  ⚠️ OVERHEATED' : ''}`}
          valueColor={fundingColor}
          T={T}
        />
      )}
      {openInterest && (
        <MetricRow
          label="Open Interest"
          value={`${openInterest.trend}  ${openInterest.conviction}  (${openInterest.change24h >= 0 ? '+' : ''}${openInterest.change24h.toFixed(1)}% 24h)`}
          valueColor={oiColor}
          T={T}
        />
      )}
      {stablecoin && (
        <MetricRow
          label="Stablecoin Dom"
          value={`${stablecoin.totalStableDom.toFixed(1)}%  ${stablecoin.signal}  ${stablecoin.trend}`}
          valueColor={stableColor}
          T={T}
        />
      )}
    </View>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function MarketContextCard({ snapshot, T, compact = false }: Props) {
  // NONE kind: render nothing at all — asset type unknown
  if (!snapshot || snapshot.kind === 'NONE') return null;

  return (
    <View style={[styles.container, compact && styles.containerCompact, { borderColor: T.border ?? '#2a2a2a', backgroundColor: T.surface2 ?? T.card ?? '#111' }]}>
      <Text style={[styles.heading, { color: T.textDim }]}>MARKET CONTEXT</Text>
      {snapshot.kind === 'INDIAN' && (
        <IndianContextPanel ctx={snapshot.ctx} T={T} compact={compact} />
      )}
      {snapshot.kind === 'CRYPTO' && (
        <CryptoContextPanel ctx={snapshot.ctx} T={T} compact={compact} />
      )}
      <Text style={[styles.timestamp, { color: T.textDim }]}>
        Captured {new Date(snapshot.capturedAt).toLocaleTimeString()}
      </Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginTop: 12,
    gap: 4},
  containerCompact: {
    padding: 8,
    marginTop: 8},
  heading: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    marginBottom: 6},
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8},
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6},
  badge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2},
  badgeText: {
    fontSize: 10,
    fontWeight: '700'},
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2},
  label: {
    fontSize: 11,
    flex: 1},
  value: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'right',
    flex: 2},
  unavailable: {
    fontSize: 11,
    fontStyle: 'italic',
    textAlign: 'center',
    paddingVertical: 8},
  timestamp: {
    fontSize: 9,
    marginTop: 6,
    textAlign: 'right'},
});
