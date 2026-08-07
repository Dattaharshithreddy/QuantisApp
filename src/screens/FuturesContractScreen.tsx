// ─────────────────────────────────────────────────────────────────────────────
// FuturesContractScreen  (v1.0.0)
//
// Contract selector. Shown before opening a futures position.
// User picks: underlying → contract month → direction → lot count.
// Displays margin required, notional exposure, expiry days remaining.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { FuturesUnderlying, ContractMonth, LOT_SIZES, daysToExpiry, formatLotDisplay} from '../utils/futures/futuresTypes';
import { getContractsWithTokens } from '../utils/futures/futuresContracts';
import { estimateMarginBreakdown, maxAffordableLots } from '../utils/futures/futuresMarginCalculator';
import { getFuturesPortfolio, openFuturesPosition } from '../utils/futures/futuresPortfolio';
import { SPACING, RADIUS } from '../theme/colors';

const UNDERLYINGS: { label: string; value: FuturesUnderlying; type: 'index' | 'stock' }[] = [
  { label: 'Nifty 50',      value: 'NIFTY',      type: 'index' },
  { label: 'Bank Nifty',    value: 'BANKNIFTY',   type: 'index' },
  { label: 'Fin Nifty',     value: 'FINNIFTY',    type: 'index' },
  { label: 'MidCap Nifty',  value: 'MIDCPNIFTY',  type: 'index' },
  { label: 'Reliance',      value: 'RELIANCE',    type: 'stock' },
  { label: 'TCS',           value: 'TCS',         type: 'stock' },
  { label: 'Infosys',       value: 'INFY',        type: 'stock' },
  { label: 'HDFC Bank',     value: 'HDFCBANK',    type: 'stock' },
  { label: 'ICICI Bank',    value: 'ICICIBANK',   type: 'stock' },
  { label: 'SBI',           value: 'SBIN',        type: 'stock' },
];

const MONTHS: { label: string; value: ContractMonth }[] = [
  { label: 'Current Month', value: 'current' },
  { label: 'Next Month',    value: 'next'    },
  { label: 'Far Month',     value: 'far'     },
];

function Row({ label, value, color, T }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between',
      paddingVertical: 7, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
      <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 11, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}

export default function FuturesContractScreen({ navigation }: any) {
  const { theme: T }  = useTheme();
  const { prices }    = useData();

  const [underlying, setUnderlying]   = useState<FuturesUnderlying>('NIFTY');
  const [month,      setMonth]         = useState<ContractMonth>('current');
  const [direction,  setDirection]     = useState<'LONG' | 'SHORT'>('LONG');
  const [lots,       setLots]          = useState(1);
  const [contracts,  setContracts]     = useState<any>(null);
  const [portfolio,  setPortfolio]     = useState<any>(null);
  const [loading,    setLoading]       = useState(false);
  const [opening,    setOpening]       = useState(false);

  const livePrice = prices[underlying]?.price ?? prices['NIFTY50']?.price ?? 0;

  const load = useCallback(async () => {
    setLoading(true);
    const [c, p] = await Promise.all([
      getContractsWithTokens(underlying),
      getFuturesPortfolio(),
    ]);
    setContracts(c);
    setPortfolio(p);
    setLoading(false);
  }, [underlying]);

  useEffect(() => { load(); }, [load]);

  const contract = contracts?.[month];
  const lotSize  = LOT_SIZES[underlying];
  const entryPx  = livePrice || contract?.expiry ? 0 : 0;
  const margin   = contract && livePrice ? estimateMarginBreakdown(underlying, livePrice, lots) : null;
  const maxLots  = portfolio && livePrice
    ? maxAffordableLots(underlying, livePrice, portfolio.cashBalance) : 0;
  const days     = contract ? daysToExpiry(contract.expiry) : 0;

  async function handleOpen() {
    if (!contract || !livePrice) {
      Alert.alert('Cannot Open', 'Live price not available. Ensure data feed is connected.'); return;
    }
    if (lots < 1) { Alert.alert('Invalid Lots', 'Minimum 1 lot.'); return; }
    if (days <= 0) { Alert.alert('Contract Expired', 'Select a different contract month.'); return; }

    setOpening(true);
    const sl = direction === 'LONG'
      ? livePrice * 0.97   // default 3% SL
      : livePrice * 1.03;
    const tp = direction === 'LONG'
      ? livePrice * 1.05   // default 5% TP
      : livePrice * 0.95;

    const result = await openFuturesPosition({
      underlying,
      contractSymbol: contract.symbol,
      direction,
      lots,
      entryPrice:   livePrice,
      stopLoss:     sl,
      takeProfit:   tp,
      expiry:       contract.expiry,
      expiryLabel:  contract.expiryLabel});
    setOpening(false);

    if (result.opened) {
      Alert.alert('✅ Position Opened',
        `${direction} ${underlying} — ${lots} lot${lots !== 1 ? 's' : ''}\n` +
        `Entry: ₹${livePrice.toFixed(2)} | Margin: ₹${margin?.totalMargin.toFixed(0)}\n` +
        `Expiry: ${contract.expiryLabel} (${days} days)`,
        [{ text: 'View Positions', onPress: () => navigation.navigate('FuturesPositions') },
         { text: 'OK' }]
      );
      await load();
    } else {
      Alert.alert('Cannot Open', result.reason);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 50 }}>

        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Futures</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>
          NSE F&O — Paper trading. Select contract and review margin before opening.
        </Text>

        {/* Underlying selector */}
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginBottom: 8 }}>
          UNDERLYING
        </Text>
        <View style={{ flexWrap: 'wrap', flexDirection: 'row', gap: 6, marginBottom: 16 }}>
          {UNDERLYINGS.map(u => (
            <TouchableOpacity key={u.value} onPress={() => setUnderlying(u.value)}
              style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: RADIUS.sm,
                backgroundColor: underlying === u.value ? T.accent : T.bg3,
                borderWidth: 1, borderColor: underlying === u.value ? T.accent : T.border }}>
              <Text style={{ color: underlying === u.value ? '#fff' : T.textDim,
                fontSize: 10, fontWeight: '700' }}>{u.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Contract month */}
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800', letterSpacing: 1, marginBottom: 8 }}>
          CONTRACT MONTH
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {MONTHS.map(m => {
            const c   = contracts?.[m.value];
            const d   = c ? daysToExpiry(c.expiry) : 0;
            const exp = c?.expiryLabel ?? '—';
            return (
              <TouchableOpacity key={m.value} onPress={() => setMonth(m.value)}
                style={{ flex: 1, backgroundColor: month === m.value ? T.accent : T.bg3,
                  borderRadius: RADIUS.sm, padding: 10, alignItems: 'center',
                  borderWidth: 1, borderColor: month === m.value ? T.accent : T.border }}>
                <Text style={{ color: month === m.value ? '#fff' : T.textSub,
                  fontSize: 10, fontWeight: '700' }}>{m.label}</Text>
                <Text style={{ color: month === m.value ? '#ffffffbb' : T.textDim,
                  fontSize: 9, marginTop: 2 }}>{exp}</Text>
                {d <= 7 && d > 0 && (
                  <Text style={{ color: T.amber, fontSize: 8, marginTop: 1 }}>⚠ {d}d left</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Contract details */}
        {contract && (
          <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
            borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
              letterSpacing: 0.8, marginBottom: 8 }}>CONTRACT DETAILS</Text>
            <Row label="Symbol"       value={contract.symbol}                   T={T} />
            <Row label="Lot Size"     value={`${lotSize} units`}                T={T} />
            <Row label="Expiry"       value={`${contract.expiryLabel} (${days} days)`}
              color={days <= 7 ? T.amber : T.text} T={T} />
            <Row label="Live Price"   value={livePrice ? `₹${livePrice.toFixed(2)}` : 'Loading…'} T={T} />
            <Row label="Token"        value={contract.aoToken || 'Offline (scrip not fetched)'} T={T} />
          </View>
        )}

        {/* Direction */}
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800',
          letterSpacing: 1, marginBottom: 8 }}>DIRECTION</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {(['LONG', 'SHORT'] as const).map(d => (
            <TouchableOpacity key={d} onPress={() => setDirection(d)}
              style={{ flex: 1, backgroundColor: direction === d
                ? (d === 'LONG' ? T.green : T.red) : T.bg3,
                borderRadius: RADIUS.sm, padding: 12, alignItems: 'center',
                borderWidth: 1, borderColor: direction === d
                  ? (d === 'LONG' ? T.green : T.red) : T.border }}>
              <Text style={{ color: direction === d ? '#fff' : T.textDim,
                fontSize: 12, fontWeight: '800' }}>
                {d === 'LONG' ? '▲ LONG (Buy)' : '▼ SHORT (Sell)'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Lots */}
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800',
          letterSpacing: 1, marginBottom: 8 }}>
          LOTS  {maxLots > 0 && <Text style={{ color: T.textDim }}>(max affordable: {maxLots})</Text>}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <TouchableOpacity onPress={() => setLots(l => Math.max(1, l - 1))}
            style={{ backgroundColor: T.bg3, borderRadius: 6, width: 36, height: 36,
              justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
            <Text style={{ color: T.text, fontSize: 18, fontWeight: '700' }}>−</Text>
          </TouchableOpacity>
          <TextInput
            value={String(lots)}
            onChangeText={v => { const n = parseInt(v); if (!isNaN(n) && n >= 1) setLots(n); }}
            keyboardType="number-pad"
            style={{ flex: 1, backgroundColor: T.bg3, color: T.text, borderRadius: 6,
              paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, fontWeight: '700',
              textAlign: 'center', borderWidth: 1, borderColor: T.border }}
          />
          <TouchableOpacity onPress={() => setLots(l => l + 1)}
            style={{ backgroundColor: T.bg3, borderRadius: 6, width: 36, height: 36,
              justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
            <Text style={{ color: T.text, fontSize: 18, fontWeight: '700' }}>+</Text>
          </TouchableOpacity>
        </View>

        {/* Lots display */}
        {livePrice > 0 && (
          <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 16 }}>
            {formatLotDisplay(lots, underlying)} · Notional ₹{(lots * lotSize * livePrice).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </Text>
        )}

        {/* Margin summary */}
        {margin && (
          <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
            borderWidth: 1, borderColor: T.border, marginBottom: 20 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
              letterSpacing: 0.8, marginBottom: 8 }}>MARGIN REQUIRED (estimated)</Text>
            <Row label="SPAN Margin"       value={`₹${margin.spanMargin.toFixed(0)}`}    T={T} />
            <Row label="Exposure Margin"   value={`₹${margin.exposureMargin.toFixed(0)}`} T={T} />
            <Row label="Est. Brokerage"    value={`₹${margin.estimatedBrokerage.toFixed(0)}`}
              color={T.textDim} T={T} />
            <Row label="Total Required"    value={`₹${margin.totalRequired.toFixed(0)}`}
              color={T.amber} T={T} />
            {portfolio && (
              <Row label="Available Balance" value={`₹${portfolio.cashBalance.toFixed(0)}`}
                color={portfolio.cashBalance >= margin.totalRequired ? T.green : T.red} T={T} />
            )}
          </View>
        )}

        {/* Warning banner */}
        <View style={{ backgroundColor: T.amber + '15', borderRadius: 8, padding: 10,
          borderWidth: 1, borderColor: T.amber + '40', marginBottom: 16 }}>
          <Text style={{ color: T.amber, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>
            ⚠ PAPER TRADING ONLY
          </Text>
          <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 14 }}>
            Futures are leveraged instruments. A 1-lot Nifty position has ~₹8–12L notional exposure.
            SL/TP are set at ±3%/5% by default — adjust in the position management screen after opening.
            Margin figures are estimates — actual margin varies.
          </Text>
        </View>

        {/* Open button */}
        <TouchableOpacity onPress={handleOpen} disabled={opening || !livePrice}
          style={{ backgroundColor: direction === 'LONG' ? T.green : T.red,
            borderRadius: RADIUS.md, padding: 16, alignItems: 'center',
            opacity: (opening || !livePrice) ? 0.6 : 1 }}>
          {opening
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>
                {direction === 'LONG' ? '▲ Open Long' : '▼ Open Short'}
                {' — '}{lots} lot{lots !== 1 ? 's' : ''}
              </Text>
          }
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.navigate('FuturesPositions')}
          style={{ marginTop: 10, padding: 12, alignItems: 'center' }}>
          <Text style={{ color: T.accent, fontSize: 11 }}>View Open Positions →</Text>
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}
