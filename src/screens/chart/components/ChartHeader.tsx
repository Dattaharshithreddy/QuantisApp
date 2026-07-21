// ── ChartHeader — symbol pill row + price card. No state, no hooks. ───────────
import React from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
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
  onSymbol:  (s: string) => void;
  onSearch:  () => void;
  T: any;
};

export function ChartHeader({ symbol, asset, allAssets, dataSrc, cp, priceColor, isPos, onSymbol, onSearch, T }: Props) {
  return (
    <>
      {/* Symbol selector */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }} contentContainerStyle={{ paddingRight: 20 }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TouchableOpacity onPress={onSearch} activeOpacity={0.7} style={{
            flexDirection: 'row', alignItems: 'center', gap: 4,
            paddingHorizontal: 13, paddingVertical: 7, borderRadius: RADIUS.pill,
            backgroundColor: T.purple + '18', borderWidth: 1, borderColor: T.purple + '40',
          }}>
            <Text style={{ fontSize: 11 }}>🔍</Text>
            <Text style={{ color: T.purple, fontSize: 11, fontWeight: '700' }}>Search symbol</Text>
          </TouchableOpacity>
          {allAssets.slice(0, 12).map(a => (
            <Pill key={a.symbol + a.src} label={a.symbol} color={T.blue} active={a.symbol === symbol} onPress={() => onSymbol(a.symbol)} />
          ))}
        </View>
      </ScrollView>

      {/* Price card */}
      <View style={{
        flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
        backgroundColor: T.card, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: T.cardBorder,
        paddingVertical: 14, paddingHorizontal: SPACING.lg, marginBottom: 14, ...T.elev1,
      }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <Text style={{ color: T.text, fontSize: 21, fontWeight: '800', letterSpacing: -0.3 }}>{symbol}</Text>
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 3,
              paddingHorizontal: 7, paddingVertical: 3, borderRadius: RADIUS.sm,
              backgroundColor: dataSrc === 'live' ? T.green + '18' : T.amber + '18',
            }}>
              <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: dataSrc === 'live' ? (cp?.status === 'stale' ? T.amber : T.green) : T.amber }} />
              <Text style={{ color: dataSrc === 'live' ? (cp?.status === 'stale' ? T.amber : T.green) : T.amber, fontSize: 9, fontWeight: '800', letterSpacing: 0.4 }}>
                {dataSrc === 'live' ? (cp?.status === 'stale' ? 'STALE' : 'LIVE') : 'NO DATA'}
              </Text>
            </View>
          </View>
          <Text style={{ color: T.textDim, fontSize: 12, fontWeight: '500' }}>{asset.name}</Text>
        </View>
        {cp && (
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: priceColor, fontSize: 24, fontWeight: '800', letterSpacing: -0.4 }}>{pFmt(cp.price)}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 }}>
              <Text style={{ color: priceColor, fontSize: 12, fontWeight: '700' }}>{isPos ? '▲' : '▼'} {Math.abs(cp.chg).toFixed(2)}%</Text>
            </View>
          </View>
        )}
      </View>
    </>
  );
}
