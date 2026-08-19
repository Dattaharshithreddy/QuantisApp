// ── ChartHeader — symbol pill row + price card. No state, no hooks. ───────────
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, Pressable } from 'react-native';
import { pFmt } from '../../../utils/indicators';
import { Pill } from '../../../components/Common';
import { RADIUS, SPACING } from '../../../theme/colors';

type Asset = { symbol: string; name: string; src: string; type: string };
type Props = {
  symbol:    string;
  asset:     Asset;
  allAssets: Asset[];
  dataSrc:   'live' | 'none';
  cp:        any;
  priceColor:string;
  isPos:     boolean;
  livePrice?: number;  // last candle close from aggTrade — in sync with chart
  onSymbol:  (assetId: string, exchange: string) => void;
  onSearch:  () => void;
  T: any;
};

export const ChartHeader = React.memo(function ChartHeader({ symbol, asset, allAssets, dataSrc, cp, priceColor, isPos, livePrice, onSymbol, onSearch, T }: Props) {
  return (
    <>
      {/* Symbol selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ paddingRight: 20 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Pressable onPress={onSearch} hitSlop={8} android_ripple={{color:'rgba(255,255,255,0.15)'}} style={{
            flexDirection: 'row', alignItems: 'center', gap: 4,
            paddingHorizontal: 13, paddingVertical: 7, borderRadius: RADIUS.pill,
            backgroundColor: T.purple + '18', borderWidth: 1, borderColor: T.purple + '40'}}>
            <Text style={{ fontSize: 11 }}>🔍</Text>
            <Text style={{ color: T.purple, fontSize: 11, fontWeight: '700' }}>Search symbol</Text>
          </Pressable>
          {allAssets.slice(0, 12).map(a => {
            // Use assetId as the label (e.g. 'BTC', 'BANKNIFTY') — cleaner than internal symbol
            // Fall back to symbol for custom assets that have no assetId
            const label   = (a as any).assetId ?? a.symbol;
            const assetId = (a as any).assetId ?? a.symbol;
            const exch    = a.src ?? '';
            // Active when the current assetId matches OR the variant.symbol matches
            const isActive = (a as any).assetId
              ? (a as any).assetId === ((asset as any).assetId ?? symbol)
              : a.symbol === symbol;
            return (
              <Pill key={a.symbol + a.src} label={label} color={T.blue}
                    active={isActive}
                    onPress={() => onSymbol(assetId, exch)} />
            );
          })}
        </View>
      </ScrollView>

      {/* Price card */}
      <View style={{
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        backgroundColor: T.card, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: T.cardBorder,
        paddingVertical: 14, paddingHorizontal: SPACING.lg, marginBottom: 14, ...T.elev1}}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <Text style={{ color: T.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.3 }}>
              {/* Show clean display name: assetId for built-ins, cleaned name for futures */}
              {(asset as any)?.src === 'coindcx_futures'
                ? (() => {
                    const s = (asset as any)?.cdxSym ?? symbol;
                    const base = s.startsWith('B-')
                      ? s.slice(2).replace('_USDT','').replace('_','')
                      : s.replace('USDT','');
                    return base + '/USDT Perp';
                  })()
                : (asset as any)?.assetId ?? symbol}
            </Text>
            {(() => {
              // LIVE = websocket source OR snapshot with real price data
              // UPDATING = snapshot but no meaningful price yet (base seed price)
              // Never use time comparison — ChartHeader only re-renders on price change,
              // so Date.now() in render gives stale results after first render.
              const hasRealPrice = cp?.price > 0 && cp?.chg !== undefined;
              const isLive     = dataSrc === 'live' && (
                cp?.source === 'websocket' ||
                (cp?.source === 'snapshot' && hasRealPrice)
              );
              const isUpdating = dataSrc === 'live' && !isLive;
              const isLoading  = dataSrc === 'live' && !isLive && (!cp?.source || cp?.source === 'cache' || cp?.status === 'stale');
              const dotColor   = isLive ? T.green : isUpdating ? '#3b82f6' : T.amber;
              const bgColor    = isLive ? T.green + '18' : isUpdating ? '#3b82f620' : T.amber + '18';
              const label      = isLive ? '● LIVE' : isUpdating ? '● UPDATING' : isLoading ? '● LOADING' : '○ NO DATA';
              return (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 3,
                  paddingHorizontal: 7, paddingVertical: 3, borderRadius: RADIUS.sm,
                  backgroundColor: bgColor}}>
                  <Text style={{ color: dotColor, fontSize: 9, fontWeight: '800', letterSpacing: 0.4 }}>
                    {label}
                  </Text>
                </View>
              );
            })()}
          </View>
          <Text style={{ color: T.textDim, fontSize: 12, fontWeight: '500' }}>{asset.name}</Text>
        </View>
        {cp && (
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: priceColor, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }}>{pFmt(livePrice ?? cp?.price)}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 }}>
              <Text style={{ color: priceColor, fontSize: 12, fontWeight: '700' }}>{isPos ? '▲' : '▼'} {isNaN(cp.chg) ? '0.00' : Math.abs(cp.chg).toFixed(2)}%</Text>
            </View>
          </View>
        )}
      </View>
    </>
  );
});
