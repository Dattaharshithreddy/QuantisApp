// FuturesPositionsScreen — open futures positions with live P&L and MTM
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, ActivityIndicator, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData }  from '../context/DataContext';
import {
  getFuturesPortfolio, closeFuturesPosition, runMtmSettlement,
  updateFuturesPosition, FuturesPortfolioState,
} from '../utils/futures/futuresPortfolio';
import { computeFuturesPnL, daysToExpiry, formatLotDisplay } from '../utils/futures/futuresTypes';
import { SPACING, RADIUS } from '../theme/colors';

function PnLText({ pnl, T, size = 16 }: { pnl: number; T: any; size?: number }) {
  const color = pnl > 0 ? T.green : pnl < 0 ? T.red : T.textDim;
  return (
    <Text style={{ color, fontSize: size, fontWeight: '800' }}>
      {pnl >= 0 ? '+' : ''}₹{pnl.toFixed(0)}
    </Text>
  );
}

export default function FuturesPositionsScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const { prices }   = useData();
  const [portfolio, setPortfolio] = useState<FuturesPortfolioState | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [closing,   setClosing]   = useState<string | null>(null);
  const [editing,   setEditing]   = useState<{id: string; field: 'sl'|'tp'; value: string} | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setPortfolio(await getFuturesPortfolio());
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-settle MTM at 3:30pm IST (simplified: check once per load)
  useEffect(() => {
    const now    = new Date();
    const cutoff = new Date(); cutoff.setHours(15, 30, 0, 0);
    if (now >= cutoff && portfolio?.openPositions.length) {
      const settlePrices: Record<string, number> = {};
      for (const pos of portfolio.openPositions) {
        const lp = prices[pos.underlying]?.price;
        if (lp) settlePrices[pos.underlying] = lp;
      }
      if (Object.keys(settlePrices).length > 0) {
        runMtmSettlement(settlePrices).then(load).catch(() => {});
      }
    }
  }, [portfolio, prices]);

  async function handleClose(positionId: string, symbol: string) {
    const pos      = portfolio?.openPositions.find(p => p.id === positionId);
    const livePrice = pos ? (prices[pos.underlying]?.price ?? 0) : 0;
    if (!livePrice) { Alert.alert('Cannot Close', 'Live price not available.'); return; }

    Alert.alert(`Close ${symbol} Futures?`,
      `Close at ₹${livePrice.toFixed(2)} (market price).\nThis cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close Position', style: 'destructive', onPress: async () => {
          setClosing(positionId);
          const result = await closeFuturesPosition(positionId, livePrice, 'MANUAL');
          setClosing(null);
          if (result.closed) {
            Alert.alert('Position Closed',
              `Total P&L: ${result.totalPnL >= 0 ? '+' : ''}₹${result.totalPnL.toFixed(0)}\n` +
              `(MTM settled: ₹${(result.totalPnL - result.cashPnL).toFixed(0)} | Today: ₹${result.cashPnL.toFixed(0)})`
            );
            await load();
          }
        }},
      ]
    );
  }

  async function handleUpdateSLTP(posId: string, field: 'sl'|'tp', value: string) {
    const n = parseFloat(value);
    if (isNaN(n) || n <= 0) { Alert.alert('Invalid', 'Enter a valid price.'); return; }
    await updateFuturesPosition(posId, field === 'sl' ? { stopLoss: n } : { takeProfit: n });
    setEditing(null);
    await load();
  }

  if (!portfolio) return <SafeAreaView style={{ flex:1, backgroundColor: T.bg0, justifyContent:'center', alignItems:'center' }}>
    <ActivityIndicator color={T.accent} /></SafeAreaView>;

  const totalUnrealizedPnL = portfolio.openPositions.reduce((sum, pos) => {
    const lp = prices[pos.underlying]?.price ?? pos.entryPrice;
    return sum + computeFuturesPnL(pos.direction, pos.entryPrice, lp, pos.lots, pos.lotSize);
  }, 0);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 50 }}
>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: 16 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Futures Positions</Text>
          <TouchableOpacity onPress={() => navigation.navigate('FuturesContract')}
            style={{ backgroundColor: T.accent, borderRadius: 6,
              paddingHorizontal: 12, paddingVertical: 7 }}>
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>+ New Position</Text>
          </TouchableOpacity>
        </View>

        {/* Account summary */}
        <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
          borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>
                AVAILABLE MARGIN
              </Text>
              <Text style={{ color: T.text, fontSize: 16, fontWeight: '800' }}>
                ₹{portfolio.cashBalance.toFixed(0)}
              </Text>
            </View>
            <View style={{ width: 1, backgroundColor: T.border }} />
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>
                UNREALISED P&L
              </Text>
              <PnLText pnl={totalUnrealizedPnL} T={T} />
            </View>
            <View style={{ width: 1, backgroundColor: T.border }} />
            <View style={{ alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>
                REALISED P&L
              </Text>
              <PnLText pnl={portfolio.totalRealizedPnL} T={T} size={14} />
            </View>
          </View>
        </View>

        {/* No positions */}
        {portfolio.openPositions.length === 0 && (
          <View style={{ alignItems: 'center', paddingTop: 40 }}>
            <Text style={{ color: T.textDim, fontSize: 14 }}>No open futures positions</Text>
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 4, textAlign: 'center' }}>
              Tap "+ New Position" to open a futures contract.
            </Text>
          </View>
        )}

        {/* Position cards */}
        {portfolio.openPositions.map(pos => {
          const livePrice = prices[pos.underlying]?.price ?? pos.entryPrice;
          const unrealisedPnL = computeFuturesPnL(pos.direction, pos.entryPrice, livePrice, pos.lots, pos.lotSize);
          const todayPnL     = computeFuturesPnL(pos.direction, pos.lastMtmPrice, livePrice, pos.lots, pos.lotSize);
          const days         = daysToExpiry(pos.expiry);
          const isLong       = pos.direction === 'LONG';
          const isClosing    = closing === pos.id;

          return (
            <View key={pos.id} style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
              marginBottom: 12, borderWidth: 1, borderColor: T.border,
              borderLeftWidth: 3, borderLeftColor: isLong ? T.green : T.red,
              opacity: isClosing ? 0.5 : 1 }}>

              {/* Header */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between',
                alignItems: 'flex-start', marginBottom: 8 }}>
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: T.text, fontSize: 15, fontWeight: '800' }}>
                      {pos.underlying}
                    </Text>
                    <View style={{ backgroundColor: isLong ? T.green + '20' : T.red + '20',
                      borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ color: isLong ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>
                        {isLong ? '▲ LONG' : '▼ SHORT'}
                      </Text>
                    </View>
                    {days <= 5 && (
                      <View style={{ backgroundColor: T.amber + '20', borderRadius: 4,
                        paddingHorizontal: 5, paddingVertical: 2 }}>
                        <Text style={{ color: T.amber, fontSize: 8, fontWeight: '700' }}>
                          ⚠ {days}d
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>
                    {pos.contractSymbol} · {formatLotDisplay(pos.lots, pos.underlying)}
                  </Text>
                </View>
                <PnLText pnl={unrealisedPnL} T={T} />
              </View>

              {/* Price grid */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
                <View>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>ENTRY</Text>
                  <Text style={{ color: T.text, fontSize: 12, fontWeight: '600' }}>
                    ₹{pos.entryPrice.toFixed(2)}
                  </Text>
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>LTP</Text>
                  <Text style={{ color: T.text, fontSize: 12, fontWeight: '600' }}>
                    ₹{livePrice.toFixed(2)}
                  </Text>
                </View>
                {/* Tappable SL */}
                <TouchableOpacity style={{ alignItems: 'center' }}
                  onPress={() => setEditing({ id: pos.id, field: 'sl', value: String(pos.stopLoss.toFixed(0)) })}>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>SL ✎</Text>
                  {editing?.id === pos.id && editing.field === 'sl' ? (
                    <TextInput
                      value={editing.value}
                      onChangeText={v => setEditing(e => e ? { ...e, value: v } : e)}
                      onSubmitEditing={() => handleUpdateSLTP(pos.id, 'sl', editing.value)}
                      onBlur={() => handleUpdateSLTP(pos.id, 'sl', editing.value)}
                      keyboardType="number-pad" autoFocus
                      style={{ color: T.red, fontSize: 12, fontWeight: '700',
                        borderBottomWidth: 1, borderBottomColor: T.red, minWidth: 60, textAlign: 'center' }}
                    />
                  ) : (
                    <Text style={{ color: T.red, fontSize: 12 }}>₹{pos.stopLoss.toFixed(0)}</Text>
                  )}
                </TouchableOpacity>
                {/* Tappable TP */}
                <TouchableOpacity style={{ alignItems: 'flex-end' }}
                  onPress={() => setEditing({ id: pos.id, field: 'tp', value: String(pos.takeProfit.toFixed(0)) })}>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>TP ✎</Text>
                  {editing?.id === pos.id && editing.field === 'tp' ? (
                    <TextInput
                      value={editing.value}
                      onChangeText={v => setEditing(e => e ? { ...e, value: v } : e)}
                      onSubmitEditing={() => handleUpdateSLTP(pos.id, 'tp', editing.value)}
                      onBlur={() => handleUpdateSLTP(pos.id, 'tp', editing.value)}
                      keyboardType="number-pad" autoFocus
                      style={{ color: T.green, fontSize: 12, fontWeight: '700',
                        borderBottomWidth: 1, borderBottomColor: T.green, minWidth: 60, textAlign: 'center' }}
                    />
                  ) : (
                    <Text style={{ color: T.green, fontSize: 12 }}>₹{pos.takeProfit.toFixed(0)}</Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* MTM row */}
              <View style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 8,
                flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
                <View>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>MTM SETTLED</Text>
                  <PnLText pnl={pos.mtmSettledPnL} T={T} size={11} />
                </View>
                <View style={{ alignItems: 'center' }}>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>TODAY</Text>
                  <PnLText pnl={todayPnL} T={T} size={11} />
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: T.textDim, fontSize: 8 }}>MARGIN BLOCKED</Text>
                  <Text style={{ color: T.text, fontSize: 11, fontWeight: '600' }}>
                    ₹{pos.marginBlocked.toFixed(0)}
                  </Text>
                </View>
              </View>

              {/* Close button */}
              <TouchableOpacity onPress={() => handleClose(pos.id, pos.underlying)}
                disabled={isClosing}
                style={{ backgroundColor: T.red + '15', borderRadius: RADIUS.sm,
                  padding: 10, alignItems: 'center', borderWidth: 1, borderColor: T.red + '40' }}>
                {isClosing
                  ? <ActivityIndicator color={T.red} size="small" />
                  : <Text style={{ color: T.red, fontWeight: '700', fontSize: 11 }}>
                      Close Position (Market)
                    </Text>
                }
              </TouchableOpacity>
            </View>
          );
        })}

        {/* MTM log link */}
        <TouchableOpacity onPress={() => navigation.navigate('FuturesMtmLog')}
          style={{ padding: 12, alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 10 }}>
            MTM Settlements · Realised P&L history →
          </Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}
