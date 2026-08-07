// ─────────────────────────────────────────────────────────────────────────────
// LivePositionsScreen  (v1.0.0)
// Shows all open real positions with live P&L, modify SL/TP, and close button.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { getLivePortfolio, removeLivePosition, LivePosition } from '../utils/livePortfolio';
import { SPACING, RADIUS } from '../theme/colors';

function PnLBadge({ pnl, pct, T }: { pnl: number; pct: number; T: any }) {
  const color = pnl >= 0 ? T.green : T.red;
  return (
    <View style={{ alignItems: 'flex-end' }}>
      <Text style={{ color, fontSize: 16, fontWeight: '800' }}>
        {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
      </Text>
      <Text style={{ color, fontSize: 10 }}>
        {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
      </Text>
    </View>
  );
}

function PositionCard({ pos, livePrice, onClose, T }: {
  pos: LivePosition; livePrice: number; onClose: () => void; T: any;
}) {
  const isLong  = pos.direction === 'LONG';
  const pnl     = (livePrice - pos.filledPrice) * pos.qty * (isLong ? 1 : -1);
  const pnlPct  = ((livePrice - pos.filledPrice) / pos.filledPrice) * 100 * (isLong ? 1 : -1);

  return (
    <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14, marginBottom: 12,
      borderWidth: 1, borderColor: T.border, borderLeftWidth: 3,
      borderLeftColor: isLong ? T.green : T.red }}>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
        <View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ color: T.text, fontSize: 14, fontWeight: '800' }}>{pos.symbol}</Text>
            <View style={{ backgroundColor: isLong ? T.green + '20' : T.red + '20',
              borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
              <Text style={{ color: isLong ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>
                {isLong ? '▲ LONG' : '▼ SHORT'}
              </Text>
            </View>
            <View style={{ backgroundColor: T.purple + '20', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
              <Text style={{ color: T.purple, fontSize: 8, fontWeight: '700' }}>LIVE</Text>
            </View>
          </View>
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>
            {pos.broker === 'ANGEL_ONE' ? 'Angel One · NSE' :
             pos.broker === 'ANGEL_ONE_FUTURES' ? `Angel One · NFO${pos.expiryLabel ? ' · ' + pos.expiryLabel : ''}` :
             pos.broker === 'BINANCE_FUTURES' ? 'Binance · USDM Perps' :
             'Binance · Spot'}
            {' · '}{pos.qty} units @ {pos.filledPrice.toFixed(2)}
          </Text>
        </View>
        <PnLBadge pnl={pnl} pct={pnlPct} T={T} />
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
        <View>
          <Text style={{ color: T.textDim, fontSize: 9 }}>CURRENT</Text>
          <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>{livePrice.toFixed(2)}</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 9 }}>STOP LOSS</Text>
          <Text style={{ color: T.red, fontSize: 13, fontWeight: '600' }}>{pos.stopLoss.toFixed(2)}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ color: T.textDim, fontSize: 9 }}>TAKE PROFIT</Text>
          <Text style={{ color: T.green, fontSize: 13, fontWeight: '600' }}>{pos.takeProfit.toFixed(2)}</Text>
        </View>
      </View>

      <Text style={{ color: T.textDim, fontSize: 8, marginBottom: 8 }}>
        Order ID: {pos.liveOrderId}
      </Text>

      <TouchableOpacity onPress={onClose}
        style={{ backgroundColor: T.red + '15', borderRadius: RADIUS.sm, padding: 10,
          alignItems: 'center', borderWidth: 1, borderColor: T.red + '40' }}>
        <Text style={{ color: T.red, fontWeight: '700', fontSize: 11 }}>Close Position (Market)</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function LivePositionsScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const { aoSession, prices } = useData();
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const [loading, setLoading]     = useState(true);
  const [closing, setClosing]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const p = await getLivePortfolio();
    setPositions(p.openPositions);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const closePosition = useCallback(async (pos: LivePosition) => {
    Alert.alert(
      'Close Position',
      `Close ${pos.direction} ${pos.symbol}?\n\nThis places a market order at the current price.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close Now', style: 'destructive', onPress: async () => {
          setClosing(pos.id);
          try {
            // Place closing order (opposite direction)
            const { placeLiveOrder } = await import('../utils/liveOrderExecution');
            const fill = await placeLiveOrder({
              symbol:    pos.symbol,
              assetSrc:  pos.broker === 'ANGEL_ONE' ? 'ao' :
                         pos.broker === 'ANGEL_ONE_FUTURES' ? 'ao_futures' :
                         pos.broker === 'BINANCE_FUTURES' ? 'binance_futures' : 'binance',
              direction: pos.direction === 'LONG' ? 'SHORT' : 'LONG',
              qty:       pos.qty,
              orderType: 'MARKET'}, aoSession);

            const pnl = (fill.filledPrice - pos.filledPrice) * pos.qty * (pos.direction === 'LONG' ? 1 : -1);
            await removeLivePosition(pos.id, pnl);
            await load();
            Alert.alert('Position Closed', `P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}\nFill price: ${fill.filledPrice.toFixed(2)}`);
          } catch (e: any) {
            Alert.alert('Close Failed', e.message);
          } finally { setClosing(null); }
        }},
      ]
    );
  }, [aoSession, load]);

  const totalPnL = positions.reduce((sum, pos) => {
    const lp = prices[pos.symbol]?.price ?? pos.filledPrice;
    const pnl = (lp - pos.filledPrice) * pos.qty * (pos.direction === 'LONG' ? 1 : -1);
    return sum + pnl;
  }, 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}
>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Live Positions</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ backgroundColor: T.red + '20', borderRadius: 5, paddingHorizontal: 8, paddingVertical: 4,
              borderWidth: 1, borderColor: T.red }}>
              <Text style={{ color: T.red, fontSize: 10, fontWeight: '800' }}>● LIVE</Text>
            </View>
            <TouchableOpacity onPress={() => navigation.navigate('KillSwitch')}
              style={{ backgroundColor: T.red, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 }}>
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '800' }}>⛔ Kill Switch</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Total P&L summary */}
        {positions.length > 0 && (
          <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
            borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>UNREALISED P&L</Text>
            <Text style={{ color: totalPnL >= 0 ? T.green : T.red, fontSize: 22, fontWeight: '800' }}>
              {totalPnL >= 0 ? '+' : ''}{totalPnL.toFixed(2)}
            </Text>
            <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>
              {positions.length} open position{positions.length !== 1 ? 's' : ''}
            </Text>
          </View>
        )}

        {loading && <ActivityIndicator color={T.accent} style={{ marginTop: 40 }} />}

        {!loading && positions.length === 0 && (
          <View style={{ alignItems: 'center', paddingTop: 60 }}>
            <Text style={{ color: T.textDim, fontSize: 14, marginBottom: 8 }}>No open live positions</Text>
            <Text style={{ color: T.textDim, fontSize: 11 }}>
              Trades opened in LIVE mode will appear here.
            </Text>
          </View>
        )}

        {positions.map(pos => {
          const livePrice = prices[pos.symbol]?.price ?? pos.filledPrice;
          return (
            <View key={pos.id} style={{ opacity: closing === pos.id ? 0.5 : 1 }}>
              {closing === pos.id && (
                <ActivityIndicator color={T.accent} style={{ position: 'absolute', top: 20, right: 20, zIndex: 10 }} />
              )}
              <PositionCard
                pos={pos} livePrice={livePrice}
                onClose={() => closePosition(pos)} T={T}
              />
            </View>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}
