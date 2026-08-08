// ─────────────────────────────────────────────────────────────────────────────
// FUTURES HUB SCREEN  (v1.0.0)
//
// Unified futures screen accessible from the bottom navigation bar.
// Two sections selectable via top pills:
//   • Crypto    — Binance USDT perpetuals (BnFuturesScreen content)
//   • NSE F&O   — Angel One NFO contracts (FuturesContractScreen content)
//
// Also shows quick-access cards for open positions in each category.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData }  from '../context/DataContext';
import { SPACING, RADIUS } from '../theme/colors';

// Crypto futures
import {
  BnFuturesSymbol, BN_CONTRACT_SPECS, LEVERAGE_TIERS,
  clampLeverage, computeIsolatedMargin, computeLiquidationPrice,
  computeRoE, maxQtyFromBudget, riskBasedQty,
} from '../utils/futures/binance/bnFuturesTypes';
import { navigationRef } from '../../utils/navigationRef';
import {
  getBnFuturesPortfolio, openBnFuturesPosition,
  BnFuturesPortfolioState,
} from '../utils/futures/binance/bnFuturesPortfolio';

// NSE futures
import {
  getFuturesPortfolio, closeFuturesPosition,
  FuturesPortfolioState,
} from '../utils/futures/futuresPortfolio';
import { computeFuturesPnL, daysToExpiry, formatLotDisplay } from '../utils/futures/futuresTypes';

// ── Crypto contract list ───────────────────────────────────────────────────────
const CRYPTO_SYMBOLS: { value: BnFuturesSymbol; label: string; emoji: string }[] = [
  { value: 'BTCUSDT',   label: 'BTC/USDT',   emoji: '₿'  },
  { value: 'ETHUSDT',   label: 'ETH/USDT',   emoji: 'Ξ'  },
  { value: 'BNBUSDT',   label: 'BNB/USDT',   emoji: '🔶' },
  { value: 'SOLUSDT',   label: 'SOL/USDT',   emoji: '◎'  },
  { value: 'XRPUSDT',   label: 'XRP/USDT',   emoji: '✕'  },
  { value: 'DOGEUSDT',  label: 'DOGE/USDT',  emoji: 'Ð'  },
  { value: 'ADAUSDT',   label: 'ADA/USDT',   emoji: '₳'  },
  { value: 'AVAXUSDT',  label: 'AVAX/USDT',  emoji: '🔺' },
  { value: 'DOTUSDT',   label: 'DOT/USDT',   emoji: '●'  },
  { value: 'MATICUSDT', label: 'MATIC/USDT', emoji: '⬡'  },
];

const PRICE_MAP: Record<BnFuturesSymbol, string> = {
  BTCUSDT:   'BTCUSD', ETHUSDT:   'ETHUSD', BNBUSDT:  'BNBUSD',
  SOLUSDT:   'SOLUSD', XRPUSDT:   'XRPUSD', ADAUSDT:  'ADAUSD',
  DOGEUSDT:  'DOGEUSD',AVAXUSDT:  'AVAXUSD',DOTUSDT:  'DOTUSD',
  MATICUSDT: 'MATICUSD',
};

// ── Shared components ─────────────────────────────────────────────────────────
function SectionPill({ label, active, onPress, T }: any) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        paddingHorizontal: 18, paddingVertical: 8,
        borderRadius: 20,
        backgroundColor: active ? T.accent : T.bg2,
        marginRight: 8,
      }}>
      <Text style={{ color: active ? '#fff' : T.textDim, fontWeight: '700', fontSize: 13 }}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function InfoRow({ label, value, color, T }: any) {
  return (
    <View style={{
      flexDirection: 'row', justifyContent: 'space-between',
      paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: T.border + '40',
    }}>
      <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 11, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}

function Card({ children, T, style }: any) {
  return (
    <View style={[{
      backgroundColor: T.bg2, borderRadius: RADIUS.md,
      padding: 14, marginBottom: 12,
    }, style]}>
      {children}
    </View>
  );
}

// ── Crypto Futures Section ────────────────────────────────────────────────────
function CryptoFuturesSection({ navigation }: any) {
  const { theme: T } = useTheme();
  const { prices }   = useData();

  const [sym,       setSym]       = useState<BnFuturesSymbol>('BTCUSDT');
  const [leverage,  setLeverage]  = useState(10);
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [qty,       setQty]       = useState('');
  const [portfolio, setPortfolio] = useState<BnFuturesPortfolioState | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [placing,   setPlacing]   = useState(false);

  const spec  = BN_CONTRACT_SPECS[sym];
  const price = prices[PRICE_MAP[sym]]?.price ?? 0;
  const tiers = LEVERAGE_TIERS[sym] ?? [];
  const maxLev = clampLeverage(leverage, sym);

  const qtyNum = parseFloat(qty) || 0;
  const margin = price > 0 && qtyNum > 0
    ? computeIsolatedMargin(qtyNum, price, maxLev, 0.0004) : 0; // (qty, entryPrice, leverage, takerFeeRate)
  const liqPrice = price > 0 && qtyNum > 0
    ? computeLiquidationPrice(direction, price, maxLev) : 0; // (direction, entryPrice, leverage)

  const loadPortfolio = useCallback(async () => {
    setPortfolio(await getBnFuturesPortfolio());
  }, []);

  useEffect(() => { loadPortfolio(); }, [loadPortfolio]);

  async function handleOpen() {
    if (!price || qtyNum <= 0) return;
    setPlacing(true);
    try {
      await openBnFuturesPosition({ symbol: sym, direction, qty: qtyNum, leverage: maxLev, entryPrice: price });
      await loadPortfolio();
      setQty('');
    } catch (e: any) {
      // silently handled
    } finally {
      setPlacing(false);
    }
  }

  const openPositions = portfolio?.positions?.filter(p => p.status === 'OPEN') ?? [];

  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}>
      {/* ── Open positions summary ─────────────────────────────────────── */}
      {openPositions.length > 0 && (
        <Card T={T}>
          <Text style={{ color: T.text, fontWeight: '700', fontSize: 13, marginBottom: 10 }}>
            Open Positions ({openPositions.length})
          </Text>
          {openPositions.slice(0, 3).map(p => {
            const livePrice  = prices[PRICE_MAP[p.symbol as BnFuturesSymbol]]?.price ?? p.entryPrice;
            const unrealisedPnL = (livePrice - p.entryPrice) * p.qty * (p.direction === 'LONG' ? 1 : -1);
            const pnl             = unrealisedPnL; // direct P&L in USDT
            const pnlColor   = pnl >= 0 ? T.green : T.red;
            return (
              <TouchableOpacity
                key={p.id}
                onPress={() => navigationRef.navigate('MoreTab', { screen: 'BnFuturesPositions' } as never)}
                style={{ flexDirection: 'row', justifyContent: 'space-between',
                  paddingVertical: 6, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
                <View>
                  <Text style={{ color: T.text, fontWeight: '700', fontSize: 12 }}>
                    {p.symbol} {p.direction} {p.leverage}×
                  </Text>
                  <Text style={{ color: T.textDim, fontSize: 10 }}>
                    Entry ${p.entryPrice.toFixed(2)} · {p.qty} lots
                  </Text>
                </View>
                <Text style={{ color: pnlColor, fontWeight: '800', fontSize: 13 }}>
                  {pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}
                </Text>
              </TouchableOpacity>
            );
          })}
          {openPositions.length > 3 && (
            <TouchableOpacity onPress={() => navigationRef.navigate('MoreTab', { screen: 'BnFuturesPositions' } as never)}>
              <Text style={{ color: T.accent, fontSize: 11, marginTop: 8, textAlign: 'center' }}>
                View all {openPositions.length} positions →
              </Text>
            </TouchableOpacity>
          )}
        </Card>
      )}

      {/* ── Contract selector ─────────────────────────────────────────── */}
      <Card T={T}>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 8, letterSpacing: 1 }}>
          CONTRACT
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          {CRYPTO_SYMBOLS.map(s => (
            <TouchableOpacity
              key={s.value}
              onPress={() => setSym(s.value)}
              style={{
                marginRight: 8, paddingHorizontal: 12, paddingVertical: 6,
                borderRadius: 12, borderWidth: 1.5,
                borderColor: sym === s.value ? T.accent : T.border,
                backgroundColor: sym === s.value ? T.accent + '20' : T.bg3,
              }}>
              <Text style={{ color: sym === s.value ? T.accent : T.text, fontWeight: '700', fontSize: 12 }}>
                {s.emoji} {s.label}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <View style={{ marginTop: 12 }}>
          <InfoRow label="Mark Price"  value={price > 0 ? `$${price.toFixed(2)}` : '—'}  T={T} />
          <InfoRow label="Min Qty"     value={`${spec?.minQty ?? 1} contract`}            T={T} />
          <InfoRow label="Tick Size"   value={`$${spec?.tickSize ?? 0.1}`}                T={T} />
          <InfoRow label="Maker Fee"   value="0.02%"  T={T} />
          <InfoRow label="Taker Fee"   value="0.05%"  T={T} />
        </View>
      </Card>

      {/* ── Direction + Leverage ─────────────────────────────────────── */}
      <Card T={T}>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 8, letterSpacing: 1 }}>
          DIRECTION
        </Text>
        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 14 }}>
          {(['LONG','SHORT'] as const).map(d => (
            <TouchableOpacity
              key={d}
              onPress={() => setDirection(d)}
              style={{
                flex: 1, paddingVertical: 10, borderRadius: RADIUS.sm, alignItems: 'center',
                backgroundColor: direction === d
                  ? (d === 'LONG' ? T.green : T.red)
                  : T.bg3,
              }}>
              <Text style={{
                color: direction === d ? '#fff' : T.textDim,
                fontWeight: '800', fontSize: 13,
              }}>
                {d === 'LONG' ? '▲ LONG' : '▼ SHORT'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 8, letterSpacing: 1 }}>
          LEVERAGE — {maxLev}×
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
          {[1,2,3,5,10,20,50,100].map(lv => {
            const allowed = clampLeverage(lv, sym) === lv;
            return (
              <TouchableOpacity
                key={lv}
                onPress={() => allowed && setLeverage(lv)}
                style={{
                  marginRight: 6, paddingHorizontal: 10, paddingVertical: 5,
                  borderRadius: 8, borderWidth: 1,
                  borderColor: leverage === lv ? T.accent : T.border,
                  backgroundColor: leverage === lv ? T.accent + '20' : T.bg3,
                  opacity: allowed ? 1 : 0.35,
                }}>
                <Text style={{ color: leverage === lv ? T.accent : T.textDim, fontWeight: '700', fontSize: 11 }}>
                  {lv}×
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </Card>

      {/* ── Quantity + order preview ─────────────────────────────────── */}
      <Card T={T}>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 8, letterSpacing: 1 }}>
          QUANTITY (contracts)
        </Text>
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          backgroundColor: T.bg3, borderRadius: RADIUS.sm,
          paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
        }}>
          <Text style={{ color: T.text, fontSize: 22, flex: 1, fontWeight: '700' }}>
            {qty || '0'}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 11 }}>contracts</Text>
        </View>
        {/* Number pad */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {['1','2','3','4','5','6','7','8','9','.',  '0','⌫'].map(k => (
            <TouchableOpacity
              key={k}
              onPress={() => {
                if (k === '⌫') { setQty(q => q.slice(0, -1)); return; }
                if (k === '.' && qty.includes('.')) return;
                setQty(q => (q + k).replace(/^0+(\d)/, '$1'));
              }}
              style={{
                width: '30%', paddingVertical: 12, borderRadius: RADIUS.sm,
                backgroundColor: k === '⌫' ? T.red + '22' : T.bg3,
                alignItems: 'center',
              }}>
              <Text style={{ color: k === '⌫' ? T.red : T.text, fontSize: 18, fontWeight: '700' }}>{k}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {qtyNum > 0 && price > 0 && (
          <View style={{ marginTop: 12 }}>
            <InfoRow label="Notional Value" value={`$${(price * qtyNum).toFixed(0)}`}    T={T} />
            <InfoRow label="Required Margin" value={`$${margin.toFixed(2)}`}             T={T} />
            <InfoRow label="Est. Liq Price"  value={`$${liqPrice.toFixed(2)}`}
              color={direction === 'LONG' ? T.red : T.green} T={T} />
          </View>
        )}

        <TouchableOpacity
          onPress={handleOpen}
          disabled={placing || qtyNum <= 0 || price <= 0}
          style={{
            marginTop: 14, paddingVertical: 14, borderRadius: RADIUS.sm,
            alignItems: 'center',
            backgroundColor: direction === 'LONG' ? T.green : T.red,
            opacity: (placing || qtyNum <= 0 || price <= 0) ? 0.5 : 1,
          }}>
          {placing
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontWeight: '800', fontSize: 14 }}>
                {direction === 'LONG' ? '▲ Open Long' : '▼ Open Short'} · {maxLev}×
              </Text>
          }
        </TouchableOpacity>
      </Card>
    </ScrollView>
  );
}

// ── NSE Futures Section ───────────────────────────────────────────────────────
function NseFuturesSection({ navigation }: any) {
  const { theme: T } = useTheme();
  const { prices }   = useData();
  const [portfolio,  setPortfolio]  = useState<FuturesPortfolioState | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setPortfolio(await getFuturesPortfolio());
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const openPositions = portfolio?.positions?.filter(p => p.status === 'OPEN') ?? [];
  const capital       = portfolio?.capital ?? 0;
  const usedMargin    = portfolio?.usedMargin ?? 0;
  const totalPnL      = openPositions.reduce((s, p) => {
    const livePrice = prices[p.symbol]?.price ?? p.entryPrice;
    return s + computeFuturesPnL(p, livePrice);
  }, 0);

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color={T.accent} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={T.accent} />}
    >
      {/* ── Portfolio summary ─────────────────────────────────────────── */}
      <Card T={T}>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 10, letterSpacing: 1 }}>
          PAPER PORTFOLIO
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Capital</Text>
            <Text style={{ color: T.text, fontWeight: '800', fontSize: 16 }}>
              ₹{(capital / 100000).toFixed(1)}L
            </Text>
          </View>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Used Margin</Text>
            <Text style={{ color: T.text, fontWeight: '800', fontSize: 16 }}>
              ₹{(usedMargin / 100000).toFixed(1)}L
            </Text>
          </View>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Day P&L</Text>
            <Text style={{ color: totalPnL >= 0 ? T.green : T.red, fontWeight: '800', fontSize: 16 }}>
              {totalPnL >= 0 ? '+' : ''}₹{totalPnL.toFixed(0)}
            </Text>
          </View>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Open</Text>
            <Text style={{ color: T.text, fontWeight: '800', fontSize: 16 }}>
              {openPositions.length}
            </Text>
          </View>
        </View>
      </Card>

      {/* ── Open positions ─────────────────────────────────────────────── */}
      {openPositions.length === 0 ? (
        <Card T={T}>
          <Text style={{ color: T.textDim, textAlign: 'center', fontSize: 13, paddingVertical: 20 }}>
            No open NSE futures positions.{'\n'}
            Open contracts from the Futures Contract screen.
          </Text>
          <TouchableOpacity
            onPress={() => navigationRef.navigate('MoreTab', { screen: 'FuturesContract' } as never)}
            style={{
              backgroundColor: T.accent, borderRadius: RADIUS.sm,
              paddingVertical: 12, alignItems: 'center', marginTop: 8,
            }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>Open Futures Contract →</Text>
          </TouchableOpacity>
        </Card>
      ) : (
        <>
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 8, letterSpacing: 1 }}>
            OPEN POSITIONS
          </Text>
          {openPositions.map(p => {
            const livePrice = prices[p.symbol]?.price ?? p.entryPrice;
            const pnl       = computeFuturesPnL(p, livePrice);
            const pnlColor  = pnl >= 0 ? T.green : T.red;
            const dte       = daysToExpiry(p.expiry);
            return (
              <Card key={p.id} T={T} style={{ paddingVertical: 10 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                  <View>
                    <Text style={{ color: T.text, fontWeight: '800', fontSize: 14 }}>
                      {p.symbol} {p.direction}
                    </Text>
                    <Text style={{ color: T.textDim, fontSize: 10 }}>
                      {formatLotDisplay(p.lots, p.lotSize)} · Expiry {p.expiry} ({dte}d)
                    </Text>
                  </View>
                  <Text style={{ color: pnlColor, fontWeight: '800', fontSize: 16 }}>
                    {pnl >= 0 ? '+' : ''}₹{pnl.toFixed(0)}
                  </Text>
                </View>
                <InfoRow label="Entry"      value={`₹${p.entryPrice.toFixed(2)}`}  T={T} />
                <InfoRow label="LTP"        value={`₹${livePrice.toFixed(2)}`}     T={T} />
                <InfoRow label="SL / TP"    value={`₹${p.stopLoss?.toFixed(0) ?? '—'} / ₹${p.target?.toFixed(0) ?? '—'}`} T={T} />
                <InfoRow label="Margin"     value={`₹${p.marginRequired?.toFixed(0) ?? '—'}`} T={T} />
              </Card>
            );
          })}
          <TouchableOpacity
            onPress={() => navigationRef.navigate('MoreTab', { screen: 'FuturesPositions' } as never)}
            style={{
              backgroundColor: T.accent, borderRadius: RADIUS.sm,
              paddingVertical: 12, alignItems: 'center', marginTop: 4,
            }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>Manage All Positions →</Text>
          </TouchableOpacity>
        </>
      )}
    </ScrollView>
  );
}

// ── Main FuturesHubScreen ─────────────────────────────────────────────────────
export default function FuturesHubScreen({ navigation }: any) {
  const { theme: T }  = useTheme();
  const [tab, setTab] = useState<'crypto' | 'nse'>('crypto');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg1 }}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <View style={{
        paddingHorizontal: SPACING.md, paddingTop: 8, paddingBottom: 12,
        borderBottomWidth: 1, borderBottomColor: T.border,
      }}>
        <Text style={{ color: T.text, fontSize: 26, fontWeight: '800', marginBottom: 12 }}>
          Futures
        </Text>
        <View style={{ flexDirection: 'row' }}>
          <SectionPill label="⚡ Crypto Perps"   active={tab === 'crypto'} onPress={() => setTab('crypto')} T={T} />
          <SectionPill label="📋 NSE F&O"        active={tab === 'nse'}    onPress={() => setTab('nse')}    T={T} />
        </View>
      </View>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      {tab === 'crypto'
        ? <CryptoFuturesSection navigation={navigation} />
        : <NseFuturesSection    navigation={navigation} />
      }
    </SafeAreaView>
  );
}
