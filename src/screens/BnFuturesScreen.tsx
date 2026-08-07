// ─────────────────────────────────────────────────────────────────────────────
// BnFuturesScreen  (v1.0.0)
//
// Binance USDT-Margined perpetual futures paper trading.
// User selects symbol → leverage → direction → qty → reviews margin and
// liquidation price before opening.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  Alert, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData }  from '../context/DataContext';
import {
  BnFuturesSymbol, BN_CONTRACT_SPECS, LEVERAGE_TIERS,
  clampLeverage, computeIsolatedMargin, computeLiquidationPrice,
  computeRoE, maxQtyFromBudget, riskBasedQty,
} from '../utils/futures/binance/bnFuturesTypes';
import {
  getBnFuturesPortfolio, openBnFuturesPosition,
  BnFuturesPortfolioState,
} from '../utils/futures/binance/bnFuturesPortfolio';
import { SPACING, RADIUS } from '../theme/colors';

const SYMBOLS: { value: BnFuturesSymbol; label: string; emoji: string }[] = [
  { value: 'BTCUSDT',   label: 'BTC/USDT',  emoji: '₿'  },
  { value: 'ETHUSDT',   label: 'ETH/USDT',  emoji: 'Ξ'  },
  { value: 'BNBUSDT',   label: 'BNB/USDT',  emoji: '🔶' },
  { value: 'SOLUSDT',   label: 'SOL/USDT',  emoji: '◎'  },
  { value: 'XRPUSDT',   label: 'XRP/USDT',  emoji: '✕'  },
  { value: 'ADAUSDT',   label: 'ADA/USDT',  emoji: '₳'  },
  { value: 'DOGEUSDT',  label: 'DOGE/USDT', emoji: 'Ð'  },
  { value: 'AVAXUSDT',  label: 'AVAX/USDT', emoji: '🔺' },
  { value: 'DOTUSDT',   label: 'DOT/USDT',  emoji: '●'  },
  { value: 'MATICUSDT', label: 'MATIC/USDT',emoji: '⬡'  },
];

// Map internal QUANTIS symbol to Binance futures symbol
const PRICE_MAP: Record<BnFuturesSymbol, string> = {
  BTCUSDT:   'BTCUSD',
  ETHUSDT:   'ETHUSD',
  BNBUSDT:   'BNBUSD',
  SOLUSDT:   'SOLUSD',
  XRPUSDT:   'XRPUSD',
  ADAUSDT:   'ADAUSD',
  DOGEUSDT:  'DOGEUSD',
  AVAXUSDT:  'AVAXUSD',
  DOTUSDT:   'DOTUSD',
  MATICUSDT: 'MATICUSD',
};

function InfoRow({ label, value, color, T }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between',
      paddingVertical: 7, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
      <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 11, fontWeight: '600' }}>{value}</Text>
    </View>
  );
}

export default function BnFuturesScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const { prices }   = useData();

  const [symbol,    setSymbol]    = useState<BnFuturesSymbol>('BTCUSDT');
  const [leverage,  setLeverage]  = useState(10);
  const [direction, setDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [qtyInput,  setQtyInput]  = useState('0.01');
  const [portfolio, setPortfolio] = useState<BnFuturesPortfolioState | null>(null);
  const [opening,   setOpening]   = useState(false);

  const spec      = BN_CONTRACT_SPECS[symbol];
  const priceKey  = PRICE_MAP[symbol];
  const livePrice = prices[priceKey]?.price ?? 0;
  const qty       = parseFloat(qtyInput) || 0;
  const lev       = clampLeverage(leverage, symbol);

  // Derived values
  const notional   = qty * livePrice;
  const margin     = livePrice > 0 && qty > 0
    ? computeIsolatedMargin(qty, livePrice, lev, spec.takerFeeRate) : 0;
  const liqPrice   = livePrice > 0
    ? computeLiquidationPrice(direction, livePrice, lev) : 0;
  const liqDist    = livePrice > 0
    ? Math.abs(livePrice - liqPrice) / livePrice * 100 : 0;
  const maxQty     = portfolio && livePrice > 0
    ? maxQtyFromBudget(portfolio.usdtBalance * 0.8, livePrice, lev, spec) : 0;
  const defaultSL  = direction === 'LONG'
    ? livePrice * (1 - 1 / lev * 0.5)   // 50% of liq distance
    : livePrice * (1 + 1 / lev * 0.5);
  const defaultTP  = direction === 'LONG'
    ? livePrice * (1 + 1 / lev * 0.8)
    : livePrice * (1 - 1 / lev * 0.8);

  useEffect(() => {
    getBnFuturesPortfolio().then(setPortfolio);
  }, [symbol]);

  async function handleOpen() {
    if (!livePrice) {
      Alert.alert('No Price', 'Live price not available for this symbol.'); return;
    }
    if (qty < spec.minQty) {
      Alert.alert('Invalid Qty', `Minimum order size is ${spec.minQty} contracts.`); return;
    }
    if (!portfolio || margin > portfolio.usdtBalance) {
      Alert.alert('Insufficient Balance',
        `Need $${margin.toFixed(2)} USDT, have $${(portfolio?.usdtBalance ?? 0).toFixed(2)} USDT.`
      ); return;
    }

    Alert.alert(
      `Open ${direction} ${spec.name} Futures`,
      `Symbol:    ${symbol}\n` +
      `Qty:       ${qty} contracts\n` +
      `Entry:     $${livePrice.toFixed(2)}\n` +
      `Leverage:  ${lev}×\n` +
      `Notional:  $${notional.toFixed(0)}\n` +
      `Margin:    $${margin.toFixed(2)}\n` +
      `Liq Price: $${liqPrice.toFixed(2)} (${liqDist.toFixed(1)}% away)\n\n` +
      `PAPER TRADING — No real money.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: `Open ${direction}`, style: direction === 'LONG' ? 'default' : 'destructive',
          onPress: async () => {
            setOpening(true);
            const result = await openBnFuturesPosition({
              symbol, direction, qty, entryPrice: livePrice,
              leverage: lev, stopLoss: defaultSL, takeProfit: defaultTP});
            setOpening(false);
            if (result.opened) {
              const p = await getBnFuturesPortfolio();
              setPortfolio(p);
              navigation.navigate('BnFuturesPositions');
            } else {
              Alert.alert('Cannot Open', result.reason);
            }
          }},
      ]
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 60 }}>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: 4 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>
            Crypto Futures
          </Text>
          <View style={{ backgroundColor: T.amber + '20', borderRadius: 5,
            paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: T.amber + '50' }}>
            <Text style={{ color: T.amber, fontSize: 9, fontWeight: '800' }}>PAPER</Text>
          </View>
        </View>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>
          Binance USDT-M perpetual futures. No expiry. Isolated margin.
          Funding rate applied every 8 hours.
        </Text>

        {/* Balance */}
        {portfolio && (
          <View style={{ backgroundColor: T.card, borderRadius: 8, padding: 12,
            borderWidth: 1, borderColor: T.border, marginBottom: 16,
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700' }}>AVAILABLE BALANCE</Text>
              <Text style={{ color: T.text, fontSize: 18, fontWeight: '800', marginTop: 2 }}>
                ${portfolio.usdtBalance.toFixed(2)} USDT
              </Text>
            </View>
            <TouchableOpacity onPress={() => navigation.navigate('BnFuturesPositions')}
              style={{ backgroundColor: T.accent + '20', borderRadius: 6,
                paddingHorizontal: 10, paddingVertical: 6 }}>
              <Text style={{ color: T.accent, fontSize: 10, fontWeight: '700' }}>
                Positions →
              </Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Symbol */}
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800',
          letterSpacing: 1, marginBottom: 8 }}>SYMBOL</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {SYMBOLS.map(s => (
              <TouchableOpacity key={s.value} onPress={() => setSymbol(s.value)}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS.sm,
                  backgroundColor: symbol === s.value ? T.accent : T.bg3,
                  borderWidth: 1, borderColor: symbol === s.value ? T.accent : T.border,
                  alignItems: 'center', minWidth: 72 }}>
                <Text style={{ fontSize: 14 }}>{s.emoji}</Text>
                <Text style={{ color: symbol === s.value ? '#fff' : T.textDim,
                  fontSize: 9, fontWeight: '700', marginTop: 2 }}>{s.label}</Text>
                {livePrice > 0 && symbol === s.value && (
                  <Text style={{ color: '#ffffffaa', fontSize: 8 }}>
                    ${livePrice.toFixed(0)}
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

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
                {d === 'LONG' ? '▲ Long (Buy)' : '▼ Short (Sell)'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Leverage */}
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800',
          letterSpacing: 1, marginBottom: 8 }}>
          LEVERAGE — {lev}×
          <Text style={{ color: T.textDim, fontWeight: '400' }}>
            {' '}(max {spec.maxLeverage}×)
          </Text>
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {LEVERAGE_TIERS.filter(t => t <= spec.maxLeverage).map(t => (
              <TouchableOpacity key={t} onPress={() => setLeverage(t)}
                style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: RADIUS.sm,
                  backgroundColor: lev === t ? T.accent : T.bg3,
                  borderWidth: 1, borderColor: lev === t ? T.accent : T.border }}>
                <Text style={{ color: lev === t ? '#fff' : T.textDim,
                  fontSize: 11, fontWeight: '700' }}>{t}×</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        {/* Qty */}
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800',
          letterSpacing: 1, marginBottom: 8 }}>
          QUANTITY (contracts){maxQty > 0 && ` — max affordable: ${maxQty.toFixed(3)}`}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <TouchableOpacity
            onPress={() => setQtyInput(v => String(Math.max(spec.minQty, (parseFloat(v) || 0) - spec.qtyStep).toFixed(3)))}
            style={{ backgroundColor: T.bg3, borderRadius: 6, width: 36, height: 36,
              justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
            <Text style={{ color: T.text, fontSize: 18 }}>−</Text>
          </TouchableOpacity>
          <TextInput
            value={qtyInput} onChangeText={setQtyInput} keyboardType="decimal-pad"
            style={{ flex: 1, backgroundColor: T.bg3, color: T.text, borderRadius: 6,
              paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, fontWeight: '700',
              textAlign: 'center', borderWidth: 1, borderColor: T.border }}
          />
          <TouchableOpacity
            onPress={() => setQtyInput(v => String(((parseFloat(v) || 0) + spec.qtyStep).toFixed(3)))}
            style={{ backgroundColor: T.bg3, borderRadius: 6, width: 36, height: 36,
              justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
            <Text style={{ color: T.text, fontSize: 18 }}>+</Text>
          </TouchableOpacity>
        </View>
        <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 16 }}>
          Step: {spec.qtyStep} · Min: {spec.minQty}
        </Text>

        {/* Order summary */}
        {livePrice > 0 && qty >= spec.minQty && (
          <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
            borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
              letterSpacing: 0.8, marginBottom: 8 }}>ORDER SUMMARY</Text>
            <InfoRow label="Entry Price"    value={`$${livePrice.toFixed(2)}`}      T={T} />
            <InfoRow label="Quantity"       value={`${qty} ${symbol.replace('USDT','')}`} T={T} />
            <InfoRow label="Notional Value" value={`$${notional.toFixed(0)}`}        T={T} />
            <InfoRow label="Leverage"       value={`${lev}×`}                        T={T} />
            <InfoRow label="Isolated Margin" value={`$${margin.toFixed(2)}`}
              color={T.amber} T={T} />
            <InfoRow label="Liquidation Price"
              value={`$${liqPrice.toFixed(2)} (${liqDist.toFixed(1)}% away)`}
              color={liqDist < 5 ? T.red : liqDist < 15 ? T.amber : T.green} T={T} />
            <InfoRow label="Default Stop Loss"   value={`$${defaultSL.toFixed(2)}`}  color={T.red}   T={T} />
            <InfoRow label="Default Take Profit" value={`$${defaultTP.toFixed(2)}`}  color={T.green} T={T} />
            <InfoRow label="Fee (taker)"
              value={`$${(notional * spec.takerFeeRate).toFixed(3)}`}
              color={T.textDim} T={T} />
          </View>
        )}

        {/* Leverage warning */}
        {lev >= 20 && (
          <View style={{ backgroundColor: T.red + '15', borderRadius: 8, padding: 10,
            borderWidth: 1, borderColor: T.red + '40', marginBottom: 16 }}>
            <Text style={{ color: T.red, fontSize: 10, fontWeight: '700', marginBottom: 4 }}>
              ⚠️ HIGH LEVERAGE WARNING — {lev}×
            </Text>
            <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 14 }}>
              At {lev}× leverage, a {(100 / lev).toFixed(1)}% adverse move liquidates your position.
              Liquidation price is ${liqPrice.toFixed(2)}, which is {liqDist.toFixed(1)}% from current price.
              High leverage is for experienced traders only.
            </Text>
          </View>
        )}

        {/* Open button */}
        <TouchableOpacity onPress={handleOpen}
          disabled={opening || !livePrice || qty < spec.minQty}
          style={{ backgroundColor: direction === 'LONG' ? T.green : T.red,
            borderRadius: RADIUS.md, padding: 16, alignItems: 'center',
            opacity: (opening || !livePrice || qty < spec.minQty) ? 0.6 : 1 }}>
          {opening
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>
                {direction === 'LONG' ? '▲' : '▼'}
                {' Open '}{direction}{' — '}{qty} {symbol.replace('USDT','')} {lev}×
              </Text>
          }
        </TouchableOpacity>

      </ScrollView>
    </SafeAreaView>
  );
}
