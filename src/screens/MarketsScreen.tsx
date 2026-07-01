import React, { useState, useMemo } from 'react';
import { View, Text, FlatList, TouchableOpacity, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { TYPE_COLORS } from '../api/assets';
import { pFmt } from '../utils/indicators';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Common';
import { RADIUS, SPACING } from '../theme/colors';

const SRC_LABELS: Record<string, string> = { ao: 'Angel One', av: 'Alpha Vantage', binance: 'Binance', forex: 'Forex API' };

const FILTERS: { key: string; label: string; icon: string }[] = [
  { key: 'ALL', label: 'All', icon: '⊞' },
  { key: 'INDEX', label: 'Index', icon: '📊' },
  { key: 'STOCK', label: 'Stocks', icon: '📈' },
  { key: 'FOREX', label: 'Forex', icon: '💱' },
  { key: 'CRYPTO', label: 'Crypto', icon: '🪙' },
  { key: 'COMMODITY', label: 'Comdty', icon: '🛢️' },
];

export default function MarketsScreen({ navigation }: any) {
  const { theme: T, themeName, toggleTheme } = useTheme();
  const { prices, liveCount, wsStatus, aoSession, allAssets, removeAsset, hideAsset, restoreBuiltins, hiddenCount } = useData();
  const [filter, setFilter] = useState('ALL');
  const [removeTarget, setRemoveTarget] = useState<{ symbol: string; src: string; isCustom?: boolean } | null>(null);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);

  // TASK 1/10 (performance polish): previously ran allAssets.filter(...)
  // independently per pill on every render. One memoized pass instead.
  const filtered = useMemo(() => allAssets.filter(a => filter === 'ALL' || a.type === filter), [allAssets, filter]);

  // FIXED: previously only assets added via Symbol Search ("custom") could be
  // removed — the original predefined assets had no remove path at all since
  // they're hardcoded in code, not stored data. Now ANY asset can be removed:
  // custom ones are deleted outright, built-in ones are hidden (same visible
  // result), and "Restore defaults" below brings hidden built-ins back.
  function confirmRemove(symbol: string, src: string, isCustom?: boolean) {
    setRemoveTarget({ symbol, src, isCustom });
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      {/* Header */}
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <View>
            <Text style={{ color: T.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3 }}>Markets</Text>
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2, fontWeight: '500' }}>{liveCount}/{allAssets.length} feeds live</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => navigation.navigate('SymbolSearch', { returnTo: 'Markets' })} activeOpacity={0.8} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, minHeight: 38, backgroundColor: T.accent, borderRadius: RADIUS.sm }}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>+ Add Symbol</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={toggleTheme} activeOpacity={0.8} style={{ width: 38, height: 38, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg3, borderRadius: RADIUS.pill }}>
              <Text style={{ fontSize: 16 }}>{themeName === 'dark' ? '☀️' : '🌙'}</Text>
            </TouchableOpacity>
          </View>
        </View>
        {/* Status row */}
        <View style={{ flexDirection: 'row', gap: 12, marginTop: 10, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: wsStatus === 'live' ? T.green : T.amber }} />
            <Text style={{ color: T.textSub, fontSize: 10 }}>Binance {wsStatus}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: aoSession?.jwtToken ? T.orange : T.textDim }} />
            <Text style={{ color: T.textSub, fontSize: 10 }}>{aoSession?.jwtToken ? 'Angel One connected' : 'Angel One disconnected'}</Text>
          </View>
          {hiddenCount > 0 && (
            <TouchableOpacity onPress={() => setShowRestoreConfirm(true)} activeOpacity={0.7} style={{ minHeight: 28, justifyContent: 'center' }}>
              <Text style={{ color: T.blue, fontSize: 10, textDecorationLine: 'underline', fontWeight: '600' }}>{hiddenCount} hidden — restore</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Filters */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ height: 34, flexGrow: 0, marginBottom: 12 }} contentContainerStyle={{ paddingHorizontal: 16, paddingRight: 28, alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {FILTERS.map(f => {
            const active = filter === f.key;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilter(f.key)}
                style={{
                  flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
                  paddingHorizontal: 12, height: 32, borderRadius: 8,
                  backgroundColor: active ? T.accent : T.bg3,
                  borderWidth: 1, borderColor: active ? T.accent : T.border,
                }}
              >
                <Text style={{ fontSize: 12, lineHeight: 15 }}>{f.icon}</Text>
                <Text style={{ color: active ? '#fff' : T.textSub, fontSize: 12, fontWeight: active ? '700' : '600', lineHeight: 15 }}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>

      {/* List */}
      {Object.keys(prices).length === 0 ? (
        <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
          {[0, 1, 2, 3, 4].map(i => (
            <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: T.border }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Skeleton width={4} height={32} radius={2} theme={T} />
                <View>
                  <Skeleton width={70} height={13} theme={T} style={{ marginBottom: 6 }} />
                  <Skeleton width={100} height={10} theme={T} />
                </View>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Skeleton width={60} height={13} theme={T} style={{ marginBottom: 6 }} />
                <Skeleton width={40} height={10} theme={T} />
              </View>
            </View>
          ))}
        </View>
      ) : (
      <FlatList
        key={`${filter}_${filtered.length}`}
        data={filtered}
        keyExtractor={a => a.symbol + a.src}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
        renderItem={({ item }) => {
          const p = prices[item.symbol];
          const pos = (p?.chg || 0) >= 0;
          const color = p?.status === 'stale' ? T.textDim : pos ? T.green : T.red;
          const statusDot = p?.status === 'live' ? T.green : p?.status === 'stale' ? T.amber : T.textDim;
          const statusLabel = p?.status === 'live' ? 'Live' : p?.status === 'stale' ? 'Stale' : 'No data';
          return (
            <TouchableOpacity
              onPress={() => navigation.navigate('Chart', { symbol: item.symbol })}
              onLongPress={() => confirmRemove(item.symbol, item.src, item.custom)}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: T.border, minHeight: 64,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
                <View style={{ width: 4, height: 36, borderRadius: 2, backgroundColor: TYPE_COLORS[item.type] }} />
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <Text style={{ color: T.text, fontWeight: '800', fontSize: 15 }}>{item.symbol}</Text>
                    <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.sm, paddingHorizontal: 6, paddingVertical: 1 }}>
                      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700' }}>{SRC_LABELS[item.src] ?? item.src}</Text>
                    </View>
                  </View>
                  <Text style={{ color: T.textDim, fontSize: 11 }} numberOfLines={1}>{item.name} · hold to remove</Text>
                </View>
              </View>
              <View style={{ alignItems: 'flex-end', marginLeft: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                  <Text style={{ color, fontWeight: '800', fontSize: 15 }}>{p ? pFmt(p.price) : 'No data'}</Text>
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusDot }} />
                </View>
                <Text style={{ color, fontSize: 11, fontWeight: '700', marginTop: 1 }}>
                  {p && p.chg != null ? (p.status === 'stale' ? statusLabel : `${pos ? '▲ +' : '▼ '}${p.chg.toFixed(2)}%`) : ''}
                </Text>
              </View>
            </TouchableOpacity>
          );
        }}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', marginTop: 50, paddingHorizontal: 30 }}>
            <Text style={{ fontSize: 32, marginBottom: 10 }}>🔍</Text>
            <Text style={{ color: T.text, fontSize: 14, fontWeight: '700', marginBottom: 4 }}>No Assets Found</Text>
            <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', marginBottom: 14, lineHeight: 17 }}>No assets match this filter.</Text>
            {filter !== 'ALL' && (
              <TouchableOpacity onPress={() => setFilter('ALL')} activeOpacity={0.75} style={{ backgroundColor: T.bg3, paddingHorizontal: 16, minHeight: 38, justifyContent: 'center', borderRadius: RADIUS.sm }}>
                <Text style={{ color: T.blue, fontSize: 12, fontWeight: '700' }}>Show all assets</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />
      )}

      <ConfirmDialog
        visible={!!removeTarget}
        title="Remove from watchlist?"
        message={removeTarget?.symbol}
        theme={T}
        onRequestClose={() => setRemoveTarget(null)}
        actions={[
          { label: 'Cancel', onPress: () => setRemoveTarget(null) },
          {
            label: 'Remove', destructive: true,
            onPress: () => {
              if (removeTarget) (removeTarget.isCustom ? removeAsset(removeTarget.symbol, removeTarget.src) : hideAsset(removeTarget.symbol, removeTarget.src));
              setRemoveTarget(null);
            },
          },
        ]}
      />
      <ConfirmDialog
        visible={showRestoreConfirm}
        title="Restore hidden assets?"
        message={`${hiddenCount} built-in asset(s) are hidden.`}
        theme={T}
        onRequestClose={() => setShowRestoreConfirm(false)}
        actions={[
          { label: 'Cancel', onPress: () => setShowRestoreConfirm(false) },
          { label: 'Restore all', primary: true, onPress: () => { restoreBuiltins(); setShowRestoreConfirm(false); } },
        ]}
      />
    </SafeAreaView>
  );
}
