import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, SectionLabel } from '../components/Common';
import { pFmt } from '../utils/indicators';
import CandlestickChart from '../components/CandlestickChart';
import { PaperTradeRecord } from '../utils/paperTradeJournal';
import { formatTradeQualityScore } from '../utils/tradeQuality';
import { useData } from '../context/DataContext';
import { getPricePrecisionSync } from '../utils/pricePrecision';
import { OrderBookCard } from '../components/OrderBookCard';
import { tradeEconomicsWarning } from '../utils/tradeEconomics';

// Reuses the EXACT existing CandlestickChart component — no new chart
// rendering logic. Shows the candles, top features, and regime label that
// were SNAPSHOTTED at the moment the trade actually opened (stored on the
// position at entry time, in paperPortfolio.ts) — never recomputed after
// the fact. This is what makes "no future information visible" genuinely
// true here: the data being displayed is literally frozen from that moment,
// not a fresh calculation that could accidentally use later candles.
export default function PaperReplayScreen({ route }: any) {
  const { theme: T } = useTheme();
  const { allAssets } = useData();
  const trade: PaperTradeRecord = route?.params?.trade;

  if (!trade) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}><Text style={{ color: T.textDim, padding: 20 }}>No trade selected.</Text></SafeAreaView>;
  }

  const tradeAsset = allAssets.find(a => a.symbol === trade.symbol);
  const replayPricePrecision = tradeAsset ? getPricePrecisionSync(tradeAsset) : 2;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 20, fontWeight: '800', marginBottom: 4 }}>Replay: {trade.symbol}</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 14 }}>What the AI actually saw at the moment it opened this trade — frozen at entry time, not recalculated with hindsight.</Text>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>CHART AT DECISION TIME</SectionLabel>
          <CandlestickChart data={trade.recentCandles || []} theme={T} showMA height={260} expandable={false} noDataMessage="Candle snapshot not available for this trade." />
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8 }}>Market regime at entry: <Text style={{ color: T.text, fontWeight: '700' }}>{trade.marketRegime}</Text></Text>
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>AI PREDICTION AT ENTRY</SectionLabel>
          <Row label="Confidence" value={`${trade.aiConfidence.toFixed(0)}/100`} T={T} />
          <Row label="Model Version" value={`v${trade.modelVersion}`} T={T} />
          <Row label="Prediction Horizon" value={`${trade.predictionHorizon}-bar`} T={T} />
          {trade.tradeQuality && (
            <Row label="Trade Quality" value={`${formatTradeQualityScore(trade.tradeQuality.score)}/100 ${trade.tradeQuality.stars} Grade ${trade.tradeQuality.grade}`} color={T.accent} T={T} />
          )}
          <Row label="Entry Reason" value={trade.entryReason} T={T} multiline />
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>TOP CONTRIBUTING FEATURES AT ENTRY</SectionLabel>
          {trade.topFeatures.map(f => (
            <Row key={f.name} label={f.name} value={f.value.toFixed(4)} T={T} />
          ))}
        </Card>

        {trade.orderBookSnapshot && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>ORDER BOOK AT ENTRY</SectionLabel>
            <OrderBookCard snapshot={trade.orderBookSnapshot} unavailableReason={null} pricePrecision={replayPricePrecision} theme={T} />
          </Card>
        )}

        <Card theme={T}>
          <SectionLabel theme={T}>TRADE LEVELS</SectionLabel>
          <Row label="Entry" value={pFmt(trade.entryPrice)} T={T} />
          <Row label="Exit" value={pFmt(trade.exitPrice)} T={T} />
          <Row label="Exit Reason" value={trade.exitReason} T={T} />
          <Row label="Gross P&L" value={`${trade.grossPnl >= 0 ? '+' : ''}${pFmt(trade.grossPnl)}`} color={trade.grossPnl >= 0 ? T.green : T.red} T={T} />
          <Row label="Total Fees (entry + exit)" value={`-${pFmt(trade.totalFees)}`} color={T.red} T={T} />
          <Row label="Slippage Cost (est.)" value={pFmt(trade.slippageCost)} T={T} />
          <Row label="Result" value={`${trade.pnl >= 0 ? '+' : ''}${pFmt(trade.pnl)} (${trade.pnlPct.toFixed(2)}%)`} color={trade.pnl >= 0 ? T.green : T.red} T={T} />
          <Row label="Prediction Outcome" value={trade.predictionResult === 'CORRECT' ? '✅ Correct' : trade.predictionResult === 'INCORRECT' ? '❌ Incorrect' : '➖ Neutral'} color={trade.predictionResult === 'CORRECT' ? T.green : trade.predictionResult === 'INCORRECT' ? T.red : T.textDim} T={T} />
          <Row label="Financial Outcome" value={trade.pnl > 0 ? '🟢 Profit' : trade.predictionResult !== 'INCORRECT' ? '🔴 Loss (Fees/Slippage exceeded profit)' : '🔴 Loss'} color={trade.pnl > 0 ? T.green : T.red} T={T} multiline />
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4, lineHeight: 13 }}>Gross P&L minus Total Fees = Result. Slippage is already built into the Entry/Exit prices above, shown here only as an informational estimate of its dollar impact.</Text>
        </Card>

        {trade.tradeEconomics && (() => {
          const e = trade.tradeEconomics;
          const warning = tradeEconomicsWarning(e);
          return (
            <Card theme={T} style={{ marginTop: 14 }}>
              <SectionLabel theme={T}>EXPECTED AT ENTRY (DIAGNOSTIC, NOT ACTUAL)</SectionLabel>
              <Row label="Expected Gross Profit (if TP hit)" value={pFmt(e.expectedGrossProfit)} T={T} />
              <Row label="Expected Loss (if SL hit)" value={pFmt(e.expectedLoss)} T={T} />
              <Row label="Expected Round-trip Fees" value={pFmt(e.expectedRoundTripFees)} T={T} />
              <Row label="Expected Slippage Cost" value={pFmt(e.expectedSlippageCost)} T={T} />
              <Row label="Expected Net Edge" value={`${e.expectedNetEdge >= 0 ? '+' : ''}${pFmt(e.expectedNetEdge)}`} color={e.expectedNetEdge >= 0 ? T.green : T.red} T={T} />
              <Row label="Cost as % of Expected Profit" value={e.costAsPctOfExpectedProfit != null ? `${e.costAsPctOfExpectedProfit.toFixed(1)}%` : 'n/a'} T={T} />
              <Row label="ATR as % of Price" value={`${e.atrPctOfPrice.toFixed(3)}%`} T={T} />
              <Row label="TP Distance as % of Price" value={`${e.tpDistancePctOfPrice.toFixed(3)}%`} T={T} />
              {warning && <Text style={{ color: T.amber, fontSize: 10, fontWeight: '700', marginTop: 8 }}>{warning}</Text>}
            </Card>
          );
        })()}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, color, T, multiline }: any) {
  return (
    <View style={{ flexDirection: multiline ? 'column' : 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: T.border }}>
      <Text style={{ color: T.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: color || T.text, fontWeight: '700', fontSize: 10, marginTop: multiline ? 3 : 0 }}>{value}</Text>
    </View>
  );
}
