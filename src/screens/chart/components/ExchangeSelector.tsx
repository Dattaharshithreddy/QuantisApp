// ─────────────────────────────────────────────────────────────────────────────
// EXCHANGE SELECTOR  (v1.0.0)
//
// TradingView-style exchange picker shown in ChartScreen when the current
// asset has more than one exchange variant.
//
// Example for Bitcoin:
//
//   ● Binance    ○ CoinDCX    ○ Binance Futures
//
// Tapping a pill calls onSelect(exchange) which triggers useChartData to
// reload candles, WebSocket, and indicators for the new exchange.
// The ML model for the new exchange is automatically used since it's keyed
// by variant.symbol (e.g. 'BTCUSDT' for CoinDCX).
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import type { LogicalAsset } from '../../../api/assets';

const SRC_LABELS: Record<string, string> = {
  ao:              'Angel One',
  ao_futures:      'Angel One Fut',
  binance:         'Binance',
  binance_futures: 'Binance Perp',
  coindcx:         'CoinDCX',
  coindcx_futures: 'CDX Perps',
  av:              'Alpha Vantage',
  forex:           'Forex',
};

type Props = {
  asset:           LogicalAsset;
  currentExchange: string;
  T:               any;        // theme
  onSelect:        (exchange: string) => void;
};

export const ExchangeSelector = React.memo(function ExchangeSelector({
  asset, currentExchange, T, onSelect,
}: Props) {
  const exchanges = Object.keys(asset.exchanges);
  if (exchanges.length <= 1) return null;

  return (
    <View style={{
      paddingHorizontal: 16, paddingVertical: 6,
      borderBottomWidth: 1, borderBottomColor: T.border,
    }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, alignItems: 'center' }}
      >
        {exchanges.map(ex => {
          const active = ex === currentExchange ||
            (!currentExchange && ex === asset.defaultExchange);
          const variant = asset.exchanges[ex];
          return (
            <TouchableOpacity
              key={ex}
              onPress={() => !active && onSelect(ex)}
              activeOpacity={active ? 1 : 0.7}
              style={{
                flexDirection:   'row',
                alignItems:      'center',
                gap:             5,
                paddingHorizontal: 10,
                paddingVertical:  5,
                borderRadius:    16,
                borderWidth:     1.5,
                borderColor:     active ? T.accent : T.border,
                backgroundColor: active ? T.accent + '18' : T.bg2,
              }}
            >
              {/* Active indicator dot */}
              <View style={{
                width:           6,
                height:          6,
                borderRadius:    3,
                backgroundColor: active ? T.accent : T.border,
              }} />
              <Text style={{
                color:      active ? T.accent : T.textSub,
                fontSize:   11,
                fontWeight: active ? '800' : '600',
              }}>
                {SRC_LABELS[ex] ?? ex}
              </Text>
              {/* Show the internal symbol so the user knows which data they're seeing */}
              <Text style={{
                color:    T.textDim,
                fontSize: 9,
                fontWeight: '500',
              }}>
                {variant.symbol}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
});
