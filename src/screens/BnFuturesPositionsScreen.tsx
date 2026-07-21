// BnFuturesPositionsScreen — open Binance perpetual futures with live P&L,
// liquidation price, funding accrued, and close button.
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, ActivityIndicator, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData }  from '../context/DataContext';
import {
  getBnFuturesPortfolio, closeBnFuturesPosition, getFundingLog,
  updateBnFuturesPosition, BnFuturesPortfolioState,
} from '../utils/futures/binance/bnFuturesPortfolio';
import {
  BnFuturesPosition, BN_CONTRACT_SPECS,
  computeBnPnL, computeRoE, isLiquidated,
} from '../utils/futures/binance/bnFuturesTypes';
import { SPACING, RADIUS } from '../theme/colors';

const PRICE_MAP: Record<string, string> = {
  BTCUSDT: 'BTCUSD', ETHUSDT: 'ETHUSD', BNBUSDT: 'BNBUSD',
  SOLUSDT: 'SOLUSD', XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD',
  DOGEUSDT: 'DOGEUSD', AVAXUSDT: 'AVAXUSD', DOTUSDT: 'DOTUSD', MATICUSDT: 'MATICUSD',
};

export default function BnFuturesPositionsScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const { prices }   = useData();
  const [portfolio, setPortfolio]   = useState<BnFuturesPortfolioState | null>(null);
  const [fundingLog, setFundingLog] = useState<any[]>([]);
  const [loading,   setLoading]     = useState(true);
  const [closing,   setClosing]     = useState<string | null>(null);
  const [editing,   setEditing]     = useState<{id: string; field: 'sl'|'tp'; value: string} | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, fl] = await Promise.all([getBnFuturesPortfolio(), getFundingLog()]);
    setPortfolio(p);
    setFundingLog(fl.slice(0, 20));
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const getPrice = (pos: BnFuturesPosition) =>
    prices[PRICE_MAP[pos.symbol]]?.price ?? pos.entryPrice;

  const totalUnrealised = (portfolio?.openPositions ?? []).reduce((s, pos) => {
    return s + computeBnPnL(pos.direction, pos.entryPrice, getPrice(pos), pos.qty);
  }, 0);

  async function handleClose(pos: BnFuturesPosition) {
    const price = getPrice(pos);
    Alert.alert(`Close ${pos.symbol}?`,
      `Close at $${price.toFixed(2)}\nThis cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close', style: 'destructive', onPress: async () => {
          setClosing(pos.id);
          const r = await closeBnFuturesPosition(pos.id, price, 'MANUAL');
          setClosing(null);
          if (r.closed) {
            Alert.alert('Position Closed',
              `P&L: ${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)} USDT`);
            await load();
          }
        }},
      ]
    );
  }

  async function handleUpdateSLTP(posId: string, field: 'sl'|'tp', value: string) {
    const n = parseFloat(value);
    if (isNaN(n) || n <= 0) { Alert.alert('Invalid', 'Enter a valid price.'); return; }
    await updateBnFuturesPosition(posId, field === 'sl' ? { stopLoss: n } : { takeProfit: n });
    setEditing(null);
    await load();
  }

  if (!portfolio) return (
    <SafeAreaView style={{ flex:1, backgroundColor: T.bg0, justifyContent:'center', alignItems:'center' }}>
      <ActivityIndicator color={T.accent} />
    </SafeAreaView>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 50 }}
>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: 16 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>
            Crypto Futures Positions
          </Text>
          <TouchableOpacity onPress={() => navigation.navigate('BnFutures')}
            style={{ backgroundColor: T.accent, borderRadius: 6,
              paddingHorizontal: 12, paddingVertical: 7 }}>
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>+ New</Text>
          </TouchableOpacity>
        </View>

        {/* Account summary */}
        <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
          borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
            {[
              { label: 'BALANCE',         value: `$${portfolio.usdtBalance.toFixed(2)}`, color: T.text },
              { label: 'UNREALISED P&L',  value: `${totalUnrealised >= 0 ? '+' : ''}$${totalUnrealised.toFixed(2)}`, color: totalUnrealised >= 0 ? T.green : T.red },
              { label: 'REALISED P&L',    value: `${portfolio.totalRealizedPnL >= 0 ? '+' : ''}$${portfolio.totalRealizedPnL.toFixed(2)}`, color: portfolio.totalRealizedPnL >= 0 ? T.green : T.red },
            ].map(({ label, value, color }) => (
              <View key={label} style={{ alignItems: 'center' }}>
                <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700' }}>{label}</Text>
                <Text style={{ color, fontSize: 14, fontWeight: '800', marginTop: 3 }}>{value}</Text>
              </View>
            ))}
          </View>
          {portfolio.totalFundingPaid !== 0 && (
            <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', marginTop: 8 }}>
              Funding net: {portfolio.totalFundingPaid >= 0 ? '+' : ''}${portfolio.totalFundingPaid.toFixed(4)} USDT
            </Text>
          )}
        </View>

        {portfolio.openPositions.length === 0 && (
          <View style={{ alignItems: 'center', paddingTop: 40 }}>
            <Text style={{ color: T.textDim, fontSize: 14 }}>No open positions</Text>
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 4 }}>
              Tap "+ New" to open a perpetual futures position.
            </Text>
          </View>
        )}

        {portfolio.openPositions.map(pos => {
          const price     = getPrice(pos);
          const pnl       = computeBnPnL(pos.direction, pos.entryPrice, price, pos.qty);
          const roe       = computeRoE(pnl, pos.isolatedMargin);
          const liqDist   = Math.abs(price - pos.liquidationPrice) / price * 100;
          const isLong    = pos.direction === 'LONG';
          const liqRisk   = liqDist < 5;
          const spec      = BN_CONTRACT_SPECS[pos.symbol];
          const isClosing = closing === pos.id;
          const liqd      = isLiquidated(pos, price);

          return (
            <View key={pos.id} style={{ backgroundColor: T.card, borderRadius: 10,
              padding: 14, marginBottom: 12, borderWidth: 1, borderColor: T.border,
              borderLeftWidth: 3, borderLeftColor: liqd ? T.red : isLong ? T.green : T.red,
              opacity: isClosing ? 0.5 : 1 }}>

              {/* Header */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between',
                alignItems: 'flex-start', marginBottom: 8 }}>
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: T.text, fontSize: 15, fontWeight: '800' }}>
                      {pos.symbol}
                    </Text>
                    <View style={{ backgroundColor: isLong ? T.green+'20' : T.red+'20',
                      borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ color: isLong ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>
                        {isLong ? '▲ LONG' : '▼ SHORT'}
                      </Text>
                    </View>
                    <View style={{ backgroundColor: T.accent+'20', borderRadius: 4,
                      paddingHorizontal: 5, paddingVertical: 2 }}>
                      <Text style={{ color: T.accent, fontSize: 9, fontWeight: '700' }}>
                        {pos.leverage}×
                      </Text>
                    </View>
                    {liqRisk && (
                      <View style={{ backgroundColor: T.red+'20', borderRadius: 4,
                        paddingHorizontal: 5, paddingVertical: 2 }}>
                        <Text style={{ color: T.red, fontSize: 8, fontWeight: '700' }}>
                          ⚠ LIQ RISK
                        </Text>
                      </View>
                    )}
                  </View>
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>
                    {pos.qty} contracts · ${pos.notionalValue.toFixed(0)} notional
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: pnl >= 0 ? T.green : T.red,
                    fontSize: 16, fontWeight: '800' }}>
                    {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                  </Text>
                  <Text style={{ color: pnl >= 0 ? T.green : T.red, fontSize: 10 }}>
                    RoE {roe >= 0 ? '+' : ''}{roe.toFixed(1)}%
                  </Text>
                </View>
              </View>

              {/* Price grid */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 }}>
                {[
                  { label: 'ENTRY',  value: `$${pos.entryPrice.toFixed(2)}`,  color: T.text  },
                  { label: 'MARK',   value: `$${price.toFixed(2)}`,            color: T.text  },
                  { label: 'LIQ',    value: `$${pos.liquidationPrice.toFixed(2)}`, color: liqRisk ? T.red : T.textDim },
                  { label: 'MARGIN', value: `$${pos.isolatedMargin.toFixed(2)}`, color: T.amber },
                ].map(({ label, value, color }) => (
                  <View key={label} style={{ alignItems: 'center' }}>
                    <Text style={{ color: T.textDim, fontSize: 8 }}>{label}</Text>
                    <Text style={{ color, fontSize: 11, fontWeight: '600', marginTop: 2 }}>{value}</Text>
                  </View>
                ))}
              </View>

              {/* SL / TP — tappable to edit */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between',
                marginBottom: 10 }}>
                <TouchableOpacity
                  onPress={() => setEditing({ id: pos.id, field: 'sl', value: pos.stopLoss.toFixed(2) })}>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>SL ✎{' '}
                    {editing?.id === pos.id && editing.field === 'sl' ? (
                      <TextInput value={editing.value}
                        onChangeText={v => setEditing(e => e ? { ...e, value: v } : e)}
                        onSubmitEditing={() => handleUpdateSLTP(pos.id, 'sl', editing.value)}
                        onBlur={() => handleUpdateSLTP(pos.id, 'sl', editing.value)}
                        keyboardType="decimal-pad" autoFocus
                        style={{ color: T.red, fontSize: 9, borderBottomWidth: 1, borderBottomColor: T.red, minWidth: 50 }}
                      />
                    ) : (
                      <Text style={{ color: T.red }}>${pos.stopLoss.toFixed(2)}</Text>
                    )}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setEditing({ id: pos.id, field: 'tp', value: pos.takeProfit.toFixed(2) })}>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>TP ✎{' '}
                    {editing?.id === pos.id && editing.field === 'tp' ? (
                      <TextInput value={editing.value}
                        onChangeText={v => setEditing(e => e ? { ...e, value: v } : e)}
                        onSubmitEditing={() => handleUpdateSLTP(pos.id, 'tp', editing.value)}
                        onBlur={() => handleUpdateSLTP(pos.id, 'tp', editing.value)}
                        keyboardType="decimal-pad" autoFocus
                        style={{ color: T.green, fontSize: 9, borderBottomWidth: 1, borderBottomColor: T.green, minWidth: 50 }}
                      />
                    ) : (
                      <Text style={{ color: T.green }}>${pos.takeProfit.toFixed(2)}</Text>
                    )}
                  </Text>
                </TouchableOpacity>
                {pos.fundingAccrued !== 0 && (
                  <Text style={{ color: T.textDim, fontSize: 9 }}>
                    Funding{' '}
                    <Text style={{ color: pos.fundingAccrued >= 0 ? T.green : T.red }}>
                      {pos.fundingAccrued >= 0 ? '+' : ''}${pos.fundingAccrued.toFixed(4)}
                    </Text>
                  </Text>
                )}
              </View>

              {/* Liq warning */}
              {liqRisk && (
                <View style={{ backgroundColor: T.red+'15', borderRadius: 6,
                  padding: 7, marginBottom: 8 }}>
                  <Text style={{ color: T.red, fontSize: 9, fontWeight: '700' }}>
                    ⚠ Liquidation in {liqDist.toFixed(1)}% — consider reducing position or adding margin
                  </Text>
                </View>
              )}

              {/* Close button */}
              <TouchableOpacity onPress={() => handleClose(pos)} disabled={isClosing}
                style={{ backgroundColor: T.red+'15', borderRadius: RADIUS.sm,
                  padding: 10, alignItems: 'center', borderWidth: 1, borderColor: T.red+'40' }}>
                {isClosing
                  ? <ActivityIndicator color={T.red} size="small" />
                  : <Text style={{ color: T.red, fontWeight: '700', fontSize: 11 }}>
                      Close at Market
                    </Text>
                }
              </TouchableOpacity>
            </View>
          );
        })}

        {/* Recent funding payments */}
        {fundingLog.length > 0 && (
          <>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
              letterSpacing: 0.8, marginTop: 8, marginBottom: 8 }}>
              RECENT FUNDING PAYMENTS
            </Text>
            {fundingLog.slice(0, 5).map((f, i) => (
              <View key={i} style={{ backgroundColor: T.card, borderRadius: 7, padding: 10,
                marginBottom: 6, borderWidth: 1, borderColor: T.border,
                flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: T.textDim, fontSize: 9 }}>
                  {f.symbol} {f.direction} — {new Date(f.paidAt).toLocaleTimeString()}
                </Text>
                <Text style={{ color: f.payment >= 0 ? T.green : T.red,
                  fontSize: 9, fontWeight: '700' }}>
                  {f.payment >= 0 ? '+' : ''}${f.payment.toFixed(4)}
                  {' '}({(f.fundingRate * 100).toFixed(4)}%)
                </Text>
              </View>
            ))}
          </>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}
