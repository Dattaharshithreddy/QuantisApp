import React, { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Theme, RADIUS } from '../theme/colors';
import { OrderBookSnapshot, bestBid, bestAsk, bidAskSpread, spreadPct, totalBidVolume, totalAskVolume, orderBookImbalance, buySellPressurePct, isEmptyDepth } from '../utils/orderBook';
import { formatPriceWithPrecision } from '../utils/pricePrecision';

function Row({ label, value, T, color }: { label: string; value: string; T: Theme; color?: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
      <Text style={{ color: T.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: color ?? T.textSub, fontSize: 10, fontWeight: '700' }}>{value}</Text>
    </View>
  );
}

// PHASE 3C: liquidity depth bars added behind each level - a background
// fill proportional to that level's qty relative to the largest qty in
// its column (bid or ask side, independently), the same visual pattern
// real institutional order books (Binance, TradingView depth view) use
// to make size differences instantly scannable instead of reading every
// number. This is a PURELY presentational ratio computed for rendering
// width only - it does not change, recompute, or replace any of the real
// imported calculation functions (bestBid/bestAsk/bidAskSpread/
// totalBidVolume/totalAskVolume/orderBookImbalance/buySellPressurePct)
// which are used completely unchanged below for every displayed number.
export function OrderBookCard({
  snapshot, unavailableReason, pricePrecision, theme: T,
}: {
  // null/undefined snapshot + a real, specific unavailableReason is the
  // only honest way to say "no data" - there is no fallback that renders
  // fake percentages or zero-filled rows.
  snapshot: OrderBookSnapshot | null | undefined;
  unavailableReason: string | null;
  pricePrecision: number;
  theme: Theme;
}) {
  const [depthLevels, setDepthLevels] = useState<5 | 10>(5);
  const fmt = (v: number) => formatPriceWithPrecision(v, pricePrecision);

  if (unavailableReason || !snapshot || isEmptyDepth(snapshot)) {
    return (
      <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 16 }}>
        {unavailableReason ?? 'Waiting for order book data — should appear within a few seconds.'}
      </Text>
    );
  }

  const bid = bestBid(snapshot), ask = bestAsk(snapshot);
  const spread = bidAskSpread(snapshot), spreadPercent = spreadPct(snapshot);
  const bidVol = totalBidVolume(snapshot, depthLevels), askVol = totalAskVolume(snapshot, depthLevels);
  const imbalance = orderBookImbalance(snapshot, depthLevels);
  const { buyPct, sellPct } = buySellPressurePct(snapshot, depthLevels);

  const bidLevels = snapshot.buy.slice(0, depthLevels);
  const askLevels = snapshot.sell.slice(0, depthLevels);
  // Presentation-only ratio (see comment above) - max qty per side, used
  // purely to size the background depth bars.
  const maxBidQty = Math.max(...bidLevels.map(d => d.qty), 1);
  const maxAskQty = Math.max(...askLevels.map(d => d.qty), 1);

  return (
    <View>
      {/* Best Bid / Ask / Spread — premium pill row */}
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <View style={{ flex: 1, backgroundColor: T.green + '12', borderRadius: RADIUS.sm, padding: 8, alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>BEST BID</Text>
          <Text style={{ color: T.green, fontSize: 13, fontWeight: '800', marginTop: 2 }}>{bid ? fmt(bid.price) : 'n/a'}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 8, alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>SPREAD</Text>
          <Text style={{ color: T.text, fontSize: 13, fontWeight: '800', marginTop: 2 }}>{spread != null ? fmt(spread) : 'n/a'}</Text>
          {spreadPercent != null && <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>{spreadPercent.toFixed(3)}%</Text>}
        </View>
        <View style={{ flex: 1, backgroundColor: T.red + '12', borderRadius: RADIUS.sm, padding: 8, alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.3 }}>BEST ASK</Text>
          <Text style={{ color: T.red, fontSize: 13, fontWeight: '800', marginTop: 2 }}>{ask ? fmt(ask.price) : 'n/a'}</Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 6, marginBottom: 10 }}>
        <TouchableOpacity onPress={() => setDepthLevels(5)} activeOpacity={0.75} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: RADIUS.sm, backgroundColor: depthLevels === 5 ? T.accent : T.bg3 }}>
          <Text style={{ color: depthLevels === 5 ? '#fff' : T.textSub, fontSize: 10, fontWeight: '700' }}>Top 5</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setDepthLevels(10)} activeOpacity={0.75} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: RADIUS.sm, backgroundColor: depthLevels === 10 ? T.accent : T.bg3 }}>
          <Text style={{ color: depthLevels === 10 ? '#fff' : T.textSub, fontSize: 10, fontWeight: '700' }}>Top 10</Text>
        </TouchableOpacity>
      </View>

      {/* Buy/sell pressure meter */}
      <View style={{ flexDirection: 'row', height: 7, borderRadius: 4, overflow: 'hidden', marginBottom: 5 }}>
        <View style={{ width: `${buyPct}%`, backgroundColor: T.green }} />
        <View style={{ width: `${sellPct}%`, backgroundColor: T.red }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 14 }}>
        <Text style={{ color: T.green, fontSize: 10, fontWeight: '700' }}>BUY {buyPct.toFixed(0)}%</Text>
        <Text style={{ color: T.red, fontSize: 10, fontWeight: '700' }}>SELL {sellPct.toFixed(0)}%</Text>
      </View>

      {/* Depth ladder with liquidity bars behind each level */}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', marginBottom: 5, letterSpacing: 0.3 }}>BID QTY · PRICE</Text>
          {bidLevels.map((d, i) => (
            <View key={i} style={{ marginBottom: 2, borderRadius: 4, overflow: 'hidden' }}>
              <View style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${(d.qty / maxBidQty) * 100}%`, backgroundColor: T.green + '14' }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, paddingHorizontal: 4 }}>
                <Text style={{ color: T.textDim, fontSize: 10 }}>{d.qty}{d.orders != null ? ` (${d.orders})` : ''}</Text>
                <Text style={{ color: T.green, fontSize: 10, fontWeight: '700' }}>{fmt(d.price)}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', marginBottom: 5, letterSpacing: 0.3 }}>PRICE · ASK QTY</Text>
          {askLevels.map((d, i) => (
            <View key={i} style={{ marginBottom: 2, borderRadius: 4, overflow: 'hidden' }}>
              <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(d.qty / maxAskQty) * 100}%`, backgroundColor: T.red + '14' }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, paddingHorizontal: 4 }}>
                <Text style={{ color: T.red, fontSize: 10, fontWeight: '700' }}>{fmt(d.price)}</Text>
                <Text style={{ color: T.textDim, fontSize: 10 }}>{d.qty}{d.orders != null ? ` (${d.orders})` : ''}</Text>
              </View>
            </View>
          ))}
        </View>
      </View>

      <View style={{ marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: T.border }}>
        <Row label={`Total Bid Volume (top ${depthLevels})`} value={bidVol.toLocaleString()} T={T} color={T.green} />
        <Row label={`Total Ask Volume (top ${depthLevels})`} value={askVol.toLocaleString()} T={T} color={T.red} />
        <Row label="Order Book Imbalance" value={`${imbalance >= 0 ? '+' : ''}${(imbalance * 100).toFixed(1)}%`} T={T} color={imbalance > 0 ? T.green : imbalance < 0 ? T.red : T.textSub} />
        <Row label="Source" value={snapshot.source === 'binance' ? 'Binance Spot' : 'Angel One'} T={T} />
        <Row label="As Of" value={new Date(snapshot.timestamp).toLocaleTimeString()} T={T} />
      </View>
    </View>
  );
}
