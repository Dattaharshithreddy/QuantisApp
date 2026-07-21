// ─────────────────────────────────────────────────────────────────────────────
// OrderConfirmationScreen  (v1.0.0)
//
// Shown before every LIVE MANUAL trade. Displays the complete order details
// so the user sees exactly what they are confirming before real money moves.
// Receives order params via navigation route. Never modifies signal logic.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { placeLiveOrder, LiveOrderRequest } from '../utils/liveOrderExecution';
import { addLivePosition, LivePosition } from '../utils/livePortfolio';
import { RADIUS, SPACING } from '../theme/colors';
import type { MLPrediction } from '../utils/mlSignal';

export type OrderConfirmationParams = {
  request:    LiveOrderRequest;
  prediction: MLPrediction;
  signalSnapshot: any;
  marketContext?: any;
};

function Row({ label, value, valueColor, T }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between',
      paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
      <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: valueColor ?? T.text, fontSize: 11, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}

export default function OrderConfirmationScreen({ route, navigation }: any) {
  const { theme: T } = useTheme();
  const { aoSession } = useData();
  const params: OrderConfirmationParams = route.params;
  const { request, prediction, signalSnapshot, marketContext } = params;
  const [placing, setPlacing] = useState(false);

  const isLong       = request.direction === 'LONG';
  const isFutures    = request.assetSrc === 'ao_futures' || request.assetSrc === 'binance_futures';
  const isBnFutures  = request.assetSrc === 'binance_futures';
  const limitPrice   = request.limitPrice ?? prediction.suggestedEntry;
  const totalValue   = limitPrice * request.qty;
  const estimatedFee = request.assetSrc === 'binance'
    ? totalValue * 0.001
    : Math.min(20, totalValue * 0.0005) + (isFutures ? totalValue * 0.00021 : 0);  // +STT+exchange for NFO

  async function handleConfirm() {
    if (placing) return;
    setPlacing(true);
    try {
      const fill = await placeLiveOrder(request, aoSession);

      // Build live position — mirrors PaperPosition structure exactly
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
          marketContext,
        },
        signalSnapshot,
        // Live-specific fields
        liveOrderId:   fill.orderId,
        broker:        fill.broker,
        filledPrice:   fill.filledPrice,
        filledAt:      fill.filledAt,
        estimatedFees: fill.fees,
        isLive:        true,
        // Futures-specific fields (undefined for equity/spot)
        lots:          fill.lots,
        lotSize:       fill.lotSize,
        marginBlocked: fill.marginBlocked,
        underlying:    fill.underlying,
        expiry:        fill.expiry,
        expiryLabel:   fill.expiryLabel,
      };

      await addLivePosition(position);

      navigation.replace('LivePositions');
      Alert.alert(
        '✅ Order Filled',
        `${isLong ? 'Bought' : 'Sold'} ${fill.filledQty}×${request.symbol} @ ${fill.filledPrice.toFixed(4)}\nOrder ID: ${fill.orderId}`,
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

        {/* Header */}
        <View style={{ backgroundColor: T.red + '15', borderRadius: 10, padding: 14,
          borderWidth: 1.5, borderColor: T.red + '50', marginBottom: 20 }}>
          <Text style={{ color: T.red, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 4 }}>
            ⚠️ LIVE ORDER — REAL MONEY
          </Text>
          <Text style={{ color: T.text, fontSize: 18, fontWeight: '800' }}>
            {isLong ? '▲ BUY' : '▼ SELL'}  {request.symbol}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>
            {request.assetSrc === 'ao' ? 'Angel One · NSE' :
           request.assetSrc === 'ao_futures' ? 'Angel One · NFO Futures' :
           request.assetSrc === 'binance_futures' ? `Binance · USDM Perps × ${request.leverage ?? 10}L` :
           'Binance · Spot'}
          </Text>
        </View>

        {/* Order details */}
        <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
          borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 8 }}>ORDER DETAILS</Text>
          <Row label="Direction"    value={isLong ? 'LONG (Buy)' : 'SHORT (Sell)'}
               valueColor={isLong ? T.green : T.red} T={T} />
          <Row label="Quantity"     value={isFutures
            ? `${request.lots ?? 1} lot${(request.lots ?? 1) !== 1 ? 's' : ''} (${request.qty} units)`
            : `${request.qty} ${request.assetSrc === 'binance' ? 'units' : 'shares'}`} T={T} />
          <Row label="Order Type"   value={request.orderType} T={T} />
          <Row label="Price"        value={limitPrice.toFixed(request.assetSrc === 'binance' ? 4 : 2)}  T={T} />
          <Row label="Total Notional" value={`${request.assetSrc === 'binance' ? '$' : '₹'}${totalValue.toFixed(2)}`}
               valueColor={T.text} T={T} />
          {isFutures && (
            <Row label="Margin Required" value={`≈ ₹${(totalValue * 0.12).toFixed(0)}`}
                 sub="SPAN + exposure (~12% of notional)" valueColor={T.amber} T={T} />
          )}
          <Row label="Est. Fees"    value={`${request.assetSrc === 'binance' ? '$' : '₹'}${estimatedFee.toFixed(2)}`}
               sub={isFutures ? 'Brokerage + STT + exchange charges + GST' : undefined}
               valueColor={T.textDim} T={T} />
        </View>

        {/* Risk levels */}
        <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
          borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 8 }}>RISK LEVELS</Text>
          <Row label="Stop Loss"   value={(request.stopLoss ?? prediction.suggestedStopLoss).toFixed(2)}
               valueColor={T.red} T={T} />
          <Row label="Take Profit" value={(request.takeProfit ?? prediction.suggestedTakeProfit).toFixed(2)}
               valueColor={T.green} T={T} />
          <Row label="Max Risk"    value={`${request.assetSrc === 'ao' ? '₹' : '$'}${(Math.abs(limitPrice - (request.stopLoss ?? prediction.suggestedStopLoss)) * request.qty).toFixed(2)}`}
               valueColor={T.red} T={T} />
        </View>

        {/* AI signal summary */}
        <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
          borderWidth: 1, borderColor: T.border, marginBottom: 24 }}>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 8 }}>AI SIGNAL</Text>
          <Row label="State"      value={signalSnapshot?.originalState ?? '—'} T={T} />
          <Row label="Confidence" value={`${prediction.confidence.toFixed(0)}/100`} T={T} />
          <Row label="Signal Type" value={signalSnapshot?.signalType ?? '—'} T={T} />
          <Row label="Regime"     value={signalSnapshot?.regimeLabel ?? prediction.marketRegime ?? '—'} T={T} />
          {signalSnapshot?.overrideUsed && (
            <View style={{ backgroundColor: T.amber + '15', borderRadius: 6, padding: 8, marginTop: 8 }}>
              <Text style={{ color: T.amber, fontSize: 9, fontWeight: '700' }}>
                ⚡ Override: {signalSnapshot.blockReason}
              </Text>
            </View>
          )}
        </View>

        {/* Buttons */}
        <TouchableOpacity onPress={handleConfirm} disabled={placing}
          style={{ backgroundColor: isLong ? T.green : T.red, borderRadius: RADIUS.md,
            padding: 16, alignItems: 'center', marginBottom: 12, opacity: placing ? 0.7 : 1 }}>
          {placing
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>
                {isLong ? '▲ Confirm Buy Order' : '▼ Confirm Sell Order'}
              </Text>
          }
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()} disabled={placing}
          style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md,
            padding: 14, alignItems: 'center' }}>
          <Text style={{ color: T.textSub, fontSize: 14, fontWeight: '600' }}>Cancel — Do Not Place</Text>
        </TouchableOpacity>

        <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', marginTop: 16, lineHeight: 13 }}>
          This order will be placed immediately upon confirmation.{'\n'}
          Fills may occur at a different price than shown (slippage).{'\n'}
          QUANTIS is not responsible for trading losses.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
