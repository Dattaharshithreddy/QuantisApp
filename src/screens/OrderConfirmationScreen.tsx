// ─────────────────────────────────────────────────────────────────────────────
// OrderConfirmationScreen  (v2.0.0 — per-trade leverage selector)
//
// Shown before every LIVE MANUAL trade. Displays the complete order details
// so the user sees exactly what they are confirming before real money moves.
// Receives order params via navigation route. Never modifies signal logic.
//
// v2.0: Added interactive leverage selector for all futures products:
//   • Binance USDM Perpetuals (binance_futures)
//   • Angel One NFO Futures (ao_futures) — lot-based, shows lot count
//   • CoinDCX Futures (coindcx_futures) — USDT-M perpetuals
//
// Leverage change recalculates:
//   - Required margin (notional / leverage)
//   - Liquidation price estimate
//   - Max risk in USDT/INR
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme }  from '../context/ThemeContext';
import { useData }   from '../context/DataContext';
import { placeLiveOrder, LiveOrderRequest } from '../utils/liveOrderExecution';
import { addLivePosition, LivePosition }    from '../utils/livePortfolio';
import { RADIUS, SPACING } from '../theme/colors';
import type { MLPrediction } from '../utils/mlSignal';

export type OrderConfirmationParams = {
  request:         LiveOrderRequest;
  prediction:      MLPrediction;
  signalSnapshot:  any;
  marketContext?:  any;
};

// ── Leverage tiers per exchange ───────────────────────────────────────────────
const BN_LEVERAGE_OPTIONS  = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125];
const CDX_LEVERAGE_OPTIONS = [1, 2, 3, 5, 10, 20, 50, 100];
const AO_LOT_MULTIPLIERS   = [1, 2, 3, 4, 5]; // Angel One: lots, not leverage

function getMaxLeverage(assetSrc: string, symbol: string): number {
  if (assetSrc === 'binance_futures') {
    // BTC supports 125x, most alts 50–75x, small caps 20x
    if (symbol.includes('BTC')) return 125;
    if (symbol.includes('ETH')) return 100;
    return 50;
  }
  if (assetSrc === 'coindcx_futures') return 100;
  return 1;
}

// ── Sub-components ────────────────────────────────────────────────────────────
function Row({ label, value, valueColor, sub, T }: any) {
  return (
    <View style={{ paddingVertical: 8, borderBottomWidth: 0.5,
      borderBottomColor: T.border + '40' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
        <Text style={{ color: valueColor ?? T.text, fontSize: 11, fontWeight: '600' }}>{value}</Text>
      </View>
      {sub && <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>{sub}</Text>}
    </View>
  );
}

function LeverageChip({ lev, selected, onPress, disabled, T }: any) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled}
      style={{
        marginRight: 6, marginBottom: 6,
        paddingHorizontal: 10, paddingVertical: 5,
        borderRadius: 8, borderWidth: 1.5,
        borderColor:     selected ? T.accent : T.border,
        backgroundColor: selected ? T.accent + '22' : T.bg3,
        opacity: disabled ? 0.3 : 1,
      }}>
      <Text style={{ color: selected ? T.accent : T.textDim,
        fontWeight: '700', fontSize: 11 }}>{lev}×</Text>
    </TouchableOpacity>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────
export default function OrderConfirmationScreen({ route, navigation }: any) {
  const { theme: T }  = useTheme();
  const { aoSession } = useData();
  const params: OrderConfirmationParams = route.params;
  const { request, prediction, signalSnapshot, marketContext } = params;

  const [placing,  setPlacing]  = useState(false);
  // Leverage state — starts from whatever useLiveTrading computed
  const [leverage, setLeverage] = useState<number>(request.leverage ?? 1);
  // Lots state for AO futures
  const [lots, setLots] = useState<number>(request.lots ?? 1);

  const isLong          = request.direction === 'LONG';
  const isFutures       = ['ao_futures', 'binance_futures', 'coindcx_futures'].includes(request.assetSrc);
  const isBnFutures     = request.assetSrc === 'binance_futures';
  const isCdxFutures    = request.assetSrc === 'coindcx_futures';
  const isAoFutures     = request.assetSrc === 'ao_futures';
  const isCdx           = request.assetSrc === 'coindcx' || isCdxFutures;
  const currency        = (request.assetSrc === 'ao' || isAoFutures) ? '₹' : '$';
  const limitPrice      = request.limitPrice ?? prediction.suggestedEntry;
  const maxLev          = getMaxLeverage(request.assetSrc, request.symbol);

  // Recalculate key figures when leverage/lots changes
  const { qty, notional, margin, liqPrice, estimatedFee } = useMemo(() => {
    let q = request.qty;

    // AO futures: qty scales with lot multiplier
    if (isAoFutures && request.lotSize) {
      q = lots * request.lotSize;
    }

    const notional    = limitPrice * q;
    const margin      = isFutures ? notional / leverage : notional;
    const estimatedFee = isCdx
      ? notional * 0.0005   // CoinDCX 0.05% taker
      : isFutures
        ? Math.min(20, notional * 0.0005) + notional * 0.00021   // AO futures
        : notional * 0.001; // Binance spot / AO equity

    // Liquidation price estimate (simplified)
    // LONG liq = entry × (1 - 1/leverage + mmr), SHORT = entry × (1 + 1/leverage - mmr)
    const mmr = 0.005;
    const liqPrice = isFutures && leverage > 1
      ? isLong
        ? limitPrice * (1 - 1 / leverage + mmr)
        : limitPrice * (1 + 1 / leverage - mmr)
      : 0;

    return { qty: q, notional, margin, liqPrice, estimatedFee };
  }, [leverage, lots, limitPrice, request.qty, request.lotSize, isFutures, isAoFutures, isCdx, isLong]);

  const maxRisk = Math.abs(limitPrice - (request.stopLoss ?? prediction.suggestedStopLoss)) * qty;

  // Exchange label for header
  const exchangeLabel = (() => {
    if (request.assetSrc === 'ao')            return 'Angel One · NSE';
    if (request.assetSrc === 'ao_futures')    return `Angel One · NFO Futures · ${lots} lot${lots !== 1 ? 's' : ''}`;
    if (request.assetSrc === 'binance')       return 'Binance · Spot';
    if (request.assetSrc === 'binance_futures') return `Binance · USDM Perps · ${leverage}×`;
    if (request.assetSrc === 'coindcx')       return 'CoinDCX · Spot';
    if (request.assetSrc === 'coindcx_futures') return `CoinDCX · Futures · ${leverage}×`;
    return request.assetSrc;
  })();

  async function handleConfirm() {
    if (placing) return;
    setPlacing(true);
    try {
      // Inject updated leverage/qty into request before placing
      const finalRequest: LiveOrderRequest = {
        ...request,
        qty,
        leverage:  isFutures ? leverage : undefined,
        lots:      isAoFutures ? lots : request.lots,
      };

      const fill = await placeLiveOrder(finalRequest, aoSession);

      const position: LivePosition = {
        id:           `live_${Date.now()}`,
        symbol:       request.symbol,
        timeframe:    prediction.timeframe ?? '15m',
        assetClass:   request.assetSrc,
        direction:    request.direction,
        entryTime:    fill.filledAt,
        entryPrice:   fill.filledPrice,
        qty:          fill.filledQty,
        stopLoss:     request.stopLoss ?? prediction.suggestedStopLoss,
        takeProfit:   request.takeProfit ?? prediction.suggestedTakeProfit,
        signalId:     prediction.signalId,
        aiConfidence: prediction.confidence,
        riskScoreAtEntry: prediction.riskScore,
        tradeQuality: null,
        modelVersion: prediction.modelVersion,
        predictionHorizon: 3,
        entrySnapshot: {
          recentCandles:     [],
          topFeatures:       prediction.topFeatures,
          marketRegime:      prediction.marketRegime ?? 'UNKNOWN',
          orderBookSnapshot: prediction.orderBookSnapshot ?? null,
          marketContext},
        signalSnapshot,
        liveOrderId:   fill.orderId,
        broker:        fill.broker,
        filledPrice:   fill.filledPrice,
        filledAt:      fill.filledAt,
        estimatedFees: fill.fees,
        isLive:        true,
        lots:          fill.lots,
        lotSize:       fill.lotSize,
        marginBlocked: fill.marginBlocked,
        underlying:    fill.underlying,
        expiry:        fill.expiry,
        expiryLabel:   fill.expiryLabel,
      };

      await addLivePosition(position);
      Alert.alert(
        '✅ Order Filled',
        `${isLong ? 'Bought' : 'Sold'} ${fill.filledQty}×${request.symbol}` +
        ` @ ${fill.filledPrice.toFixed(4)}\nOrder ID: ${fill.orderId}`,
        [{ text: 'View Position', onPress: () => navigation.replace('LivePositions') },
         { text: 'Back to Chart', onPress: () => navigation.goBack() }],
      );
    } catch (e: any) {
      Alert.alert('Order Failed', e.message);
    } finally {
      setPlacing(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}>

        {/* ── Warning header ─────────────────────────────────────────── */}
        <View style={{ backgroundColor: T.red + '15', borderRadius: 10,
          padding: 14, borderWidth: 1.5, borderColor: T.red + '50', marginBottom: 20 }}>
          <Text style={{ color: T.red, fontSize: 11, fontWeight: '800',
            letterSpacing: 1, marginBottom: 4 }}>⚠️ LIVE ORDER — REAL MONEY</Text>
          <Text style={{ color: T.text, fontSize: 18, fontWeight: '800' }}>
            {isLong ? '▲ BUY' : '▼ SELL'}  {request.symbol}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>
            {exchangeLabel}
          </Text>
        </View>

        {/* ── Leverage selector (futures only) ───────────────────────── */}
        {isBnFutures && (
          <View style={{ backgroundColor: T.card, borderRadius: 10,
            padding: 14, borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
              letterSpacing: 0.8, marginBottom: 10 }}>LEVERAGE — {leverage}×
              <Text style={{ color: T.textDim, fontWeight: '400' }}>  (max {maxLev}×)</Text>
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {BN_LEVERAGE_OPTIONS.filter(l => l <= maxLev).map(l => (
                <LeverageChip key={l} lev={l} selected={leverage === l}
                  disabled={l > maxLev} T={T}
                  onPress={() => setLeverage(l)} />
              ))}
            </View>
            <Text style={{ color: T.amber, fontSize: 9, marginTop: 8 }}>
              ⚠️ Higher leverage = higher liquidation risk. Adjust position size accordingly.
            </Text>
          </View>
        )}

        {isCdxFutures && (
          <View style={{ backgroundColor: T.card, borderRadius: 10,
            padding: 14, borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
              letterSpacing: 0.8, marginBottom: 10 }}>LEVERAGE — {leverage}×
              <Text style={{ color: T.textDim, fontWeight: '400' }}>  (max 100×)</Text>
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {CDX_LEVERAGE_OPTIONS.map(l => (
                <LeverageChip key={l} lev={l} selected={leverage === l}
                  disabled={false} T={T}
                  onPress={() => setLeverage(l)} />
              ))}
            </View>
            <Text style={{ color: T.amber, fontSize: 9, marginTop: 8 }}>
              ⚠️ Futures wallet must have sufficient USDT margin before confirming.
            </Text>
          </View>
        )}

        {isAoFutures && (
          <View style={{ backgroundColor: T.card, borderRadius: 10,
            padding: 14, borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
              letterSpacing: 0.8, marginBottom: 10 }}>
              LOTS — {lots} lot{lots !== 1 ? 's' : ''}
              {request.lotSize
                ? <Text style={{ color: T.textDim, fontWeight: '400' }}>  ({lots * (request.lotSize ?? 1)} units)</Text>
                : null}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
              {AO_LOT_MULTIPLIERS.map(l => (
                <LeverageChip key={l} lev={`${l}L`} selected={lots === l}
                  disabled={false} T={T}
                  onPress={() => setLots(l)} />
              ))}
            </View>
            <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8 }}>
              Lot size: {request.lotSize ?? '—'} units · Expiry: {request.expiryLabel ?? '—'}
            </Text>
          </View>
        )}

        {/* ── Order details ───────────────────────────────────────────── */}
        <View style={{ backgroundColor: T.card, borderRadius: 10,
          padding: 14, borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 8 }}>ORDER DETAILS</Text>
          <Row label="Direction"
               value={isLong ? 'LONG (Buy)' : 'SHORT (Sell)'}
               valueColor={isLong ? T.green : T.red} T={T} />
          <Row label="Quantity"
               value={isAoFutures
                 ? `${lots} lot${lots !== 1 ? 's' : ''} (${qty} units)`
                 : `${qty} ${isCdx || isBnFutures ? 'contracts' : 'shares'}`}
               T={T} />
          <Row label="Order Type"  value={request.orderType} T={T} />
          <Row label="Entry Price" value={`${currency}${limitPrice.toFixed(isCdx || isBnFutures ? 2 : 2)}`} T={T} />
          <Row label="Notional"    value={`${currency}${notional.toFixed(2)}`} valueColor={T.text} T={T} />
          {isFutures && (
            <Row label="Required Margin"
                 value={`${currency}${margin.toFixed(2)}`}
                 sub={isAoFutures ? 'SPAN + exposure (~12% of notional)' : `At ${leverage}× leverage`}
                 valueColor={T.amber} T={T} />
          )}
          {isFutures && liqPrice > 0 && (
            <Row label="Est. Liq. Price"
                 value={`${currency}${liqPrice.toFixed(2)}`}
                 valueColor={T.red} T={T} />
          )}
          <Row label="Est. Fees"   value={`${currency}${estimatedFee.toFixed(4)}`}
               sub={isAoFutures ? 'Brokerage + STT + exchange + GST' : undefined}
               valueColor={T.textDim} T={T} />
        </View>

        {/* ── Risk levels ─────────────────────────────────────────────── */}
        <View style={{ backgroundColor: T.card, borderRadius: 10,
          padding: 14, borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 8 }}>RISK LEVELS</Text>
          <Row label="Stop Loss"
               value={`${currency}${(request.stopLoss ?? prediction.suggestedStopLoss).toFixed(2)}`}
               valueColor={T.red} T={T} />
          <Row label="Take Profit"
               value={`${currency}${(request.takeProfit ?? prediction.suggestedTakeProfit).toFixed(2)}`}
               valueColor={T.green} T={T} />
          <Row label="Max Risk"
               value={`${currency}${maxRisk.toFixed(2)}`}
               valueColor={T.red} T={T} />
        </View>

        {/* ── AI signal ───────────────────────────────────────────────── */}
        <View style={{ backgroundColor: T.card, borderRadius: 10,
          padding: 14, borderWidth: 1, borderColor: T.border, marginBottom: 24 }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 8 }}>AI SIGNAL</Text>
          <Row label="State"       value={signalSnapshot?.originalState ?? '—'} T={T} />
          <Row label="Confidence"  value={`${prediction.confidence.toFixed(0)}/100`} T={T} />
          <Row label="Signal Type" value={signalSnapshot?.signalType ?? '—'} T={T} />
          <Row label="Regime"      value={signalSnapshot?.regimeLabel ?? prediction.marketRegime ?? '—'} T={T} />
          {signalSnapshot?.overrideUsed && (
            <View style={{ backgroundColor: T.amber + '15', borderRadius: 6,
              padding: 8, marginTop: 8 }}>
              <Text style={{ color: T.amber, fontSize: 9, fontWeight: '700' }}>
                ⚡ Override: {signalSnapshot.blockReason}
              </Text>
            </View>
          )}
        </View>

        {/* ── Confirm button ──────────────────────────────────────────── */}
        <TouchableOpacity onPress={handleConfirm} disabled={placing}
          style={{ backgroundColor: isLong ? T.green : T.red,
            borderRadius: RADIUS.md, padding: 16, alignItems: 'center',
            marginBottom: 12, opacity: placing ? 0.7 : 1 }}>
          {placing
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>
                {isLong ? '▲ Confirm Buy Order' : '▼ Confirm Sell Order'}
                {isFutures ? `  ·  ${isAoFutures ? lots + 'L' : leverage + '×'}` : ''}
              </Text>
          }
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()} disabled={placing}
          style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md,
            padding: 14, alignItems: 'center' }}>
          <Text style={{ color: T.textSub, fontSize: 14, fontWeight: '600' }}>
            Cancel — Do Not Place
          </Text>
        </TouchableOpacity>

        <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center',
          marginTop: 16, lineHeight: 13 }}>
          This order will be placed immediately upon confirmation.{'\n'}
          Fills may occur at a different price than shown (slippage).{'\n'}
          QUANTIS is not responsible for trading losses.
        </Text>

      </ScrollView>
    </SafeAreaView>
  );
}
