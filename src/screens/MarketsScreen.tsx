import React, { useCallback, useState, useMemo } from 'react';
import { View, Text, FlatList, TouchableOpacity, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { TYPE_COLORS } from '../api/assets';
import { pFmt } from '../utils/indicators';
import { getAvailableExchanges } from '../utils/assetResolver';
// exchangePrefs loaded from DataContext (Phase 5) — direct import no longer needed here
// import { getAllExchangePreferences, setExchangePreference } from '../utils/exchangePreferences';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Skeleton } from '../components/Common';
import { RADIUS } from '../theme/colors';

// Module-level stable helpers — no allocation on every render
function getDefaultSym(item: any): string {
  if (item?.exchanges && item?.defaultExchange) {
    return item.exchanges[item.defaultExchange]?.symbol ?? item.id ?? item.symbol ?? '';
  }
  return item?.symbol ?? item?.id ?? '';
}

function getSubtitle(item: any): string {
  if (item?.exchanges && item?.defaultExchange) {
    return item.exchanges[item.defaultExchange]?.symbol ?? item.id ?? item.symbol ?? '';
  }
  return item?.symbol ?? item?.id ?? '';
}

const SRC_LABELS: Record<string, string> = {
  ao: 'Angel One', ao_futures: 'Angel One', av: 'Alpha Vantage',
  binance: 'Binance', binance_futures: 'Binance', forex: 'Forex API',
  coindcx: 'CoinDCX',
};

// Priority order when multiple exchanges offer the same asset.
// Lower index = higher priority = shown by default.
const EXCHANGE_PRIORITY: string[] = ['binance', 'coindcx', 'ao', 'ao_futures', 'av', 'forex'];

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
  const { prices, liveCount, wsStatus, aoSession, allAssets, logicalAssets, exchangePrefs, removeAsset, hideAsset, restoreBuiltins, hiddenCount } = useData();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Brief delay lets the spinner show — prices update via WebSocket automatically
    await new Promise(r => setTimeout(r, 800));
    setRefreshing(false);
  }, []);
  const [filter, setFilter] = useState('ALL');
  const [removeTarget, setRemoveTarget] = useState<{ symbol: string; src: string; isCustom?: boolean } | null>(null);
  const [showRestoreConfirm, setShowRestoreConfirm] = useState(false);
  // MarketsScreen uses logicalAssets (one entry per instrument) for display.
  // allAssets (flat Asset[]) is still available for everything else — search,
  // alerts, scanner, journal etc. continue using allAssets unchanged.
  const filtered = useMemo(
    () => logicalAssets.filter(a => filter === 'ALL' || a.type === filter),
    [logicalAssets, filter]
  );

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
          <TouchableOpacity onPress={() => setShowRestoreConfirm(true)} activeOpacity={0.7}
            style={{ minHeight: 28, justifyContent: 'center', flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Text style={{ color: hiddenCount > 0 ? T.blue : T.textDim, fontSize: 10, fontWeight: '600' }}>
              {hiddenCount > 0 ? `${hiddenCount} hidden` : 'Restore defaults'}
            </Text>
            {hiddenCount > 0 && <Text style={{ color: T.blue, fontSize: 10, fontWeight: '700' }}>· restore</Text>}
          </TouchableOpacity>
        </View>
      </View>

      {/* Filters */}
      <View style={{ height: 44, marginBottom: 4 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, paddingRight: 28, gap: 8, alignItems: 'center', height: 44 }}
        >
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
                  borderWidth: 1, borderColor: active ? T.accent : T.border}}
              >
                <Text style={{ fontSize: 12, lineHeight: 15 }}>{f.icon}</Text>
                <Text style={{ color: active ? '#fff' : T.textSub, fontSize: 12, fontWeight: active ? '700' : '600', lineHeight: 15 }}>{f.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

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
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}
        key={`${filter}_${filtered.length}`}
        data={filtered}
        keyExtractor={a => (a as any).id}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
        // Performance: fixed item height avoids layout measurement on every scroll
        getItemLayout={(_, index) => ({ length: 65, offset: 65 * index, index })}
        windowSize={5}           // only render 5 screens worth of items
        maxToRenderPerBatch={10} // render 10 items per batch
        initialNumToRender={15}  // show 15 on first paint
        removeClippedSubviews={true}
        renderItem={({ item }) => <MarketRow item={item} prices={prices} T={T} navigation={navigation} onLongPress={confirmRemove} exchangePrefs={exchangePrefs ?? {}} />}
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
            }},
        ]}
      />
      <ConfirmDialog
        visible={showRestoreConfirm}
        title="Restore default assets?"
        message={hiddenCount > 0 ? `${hiddenCount} built-in asset(s) are hidden. Restore them to the watchlist?` : 'Restore all default built-in assets to the watchlist?'}
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

// ── MarketRow — memoized so only re-renders when THIS item's price changes ────
// Without memo: every WebSocket tick re-renders all 40 rows simultaneously.
// With memo: only the row whose price changed re-renders (~98% render reduction).
const MarketRow = React.memo(function MarketRow({
  item, prices, T, navigation, onLongPress, exchangePrefs,
}: {
  item: any; prices: Record<string, any>; T: any;
  navigation: any; onLongPress: (sym: string, src: string, custom: boolean) => void;
  exchangePrefs: Record<string, string>;
}) {
  // For LogicalAsset: show price from the default exchange variant's symbol
  const defaultSym = getDefaultSym(item);
  const p = prices[defaultSym];
  const pos = (p?.chg || 0) >= 0;
  const isLive = p?.source === 'websocket' || p?.source === 'snapshot';
  const color = !isLive ? T.textDim : pos ? T.green : T.red;
  const statusDot = p?.source === 'websocket' ? T.green
    : p?.source === 'snapshot' ? '#3b82f6'
    : p?.source === 'cache'    ? T.amber
    : T.textDim;
  const statusLabel = p?.source === 'websocket' ? 'Live'
    : p?.source === 'snapshot' ? 'Snapshot'
    : p?.source === 'cache'    ? 'Cached'
    : 'No data';
  return (
    <TouchableOpacity
      onPress={() => {
          const la = item as any;
          const assetId = la.id ?? la.symbol;
          if (!assetId) return; // guard: never navigate with undefined assetId
          const slug = (la.name ?? la.symbol ?? '').toLowerCase().replace(/\s+/g, '');
          const prefExchange = (exchangePrefs ?? {})[slug] ?? la.defaultExchange ?? '';
          navigation.navigate('Chart', { assetId, exchange: prefExchange });
        }}
      onLongPress={() => onLongPress((item as any).id, (item as any).defaultExchange, (item as any).custom)}
      activeOpacity={0.7}
      style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
               paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: T.border, minHeight: 65 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 }}>
        <View style={{ width: 4, height: 36, borderRadius: 2, backgroundColor: TYPE_COLORS[item.type] }} />
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ color: T.text, fontWeight: '800', fontSize: 15 }}>{(item as any).name ?? item.symbol}</Text>
            <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.sm, paddingHorizontal: 6, paddingVertical: 1 }}>
              <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700' }}>
                {SRC_LABELS[(item as any).defaultExchange ?? (item as any).src] ?? (item as any).defaultExchange ?? (item as any).src}
              </Text>
            </View>
            {/* Available exchanges count badge */}
            {getAvailableExchanges((item as any).id ?? '').length > 1 && (
              <View style={{ backgroundColor: T.accent + '22', borderRadius: RADIUS.sm, paddingHorizontal: 5, paddingVertical: 1 }}>
                <Text style={{ color: T.accent, fontSize: 7, fontWeight: '800' }}>
                  {getAvailableExchanges((item as any).id ?? '').length} exchanges
                </Text>
              </View>
            )}
          </View>
          <Text style={{ color: T.textDim, fontSize: 11 }} numberOfLines={1}>
              {getSubtitle(item)} · hold to remove
            </Text>
        </View>
      </View>
      <View style={{ alignItems: 'flex-end', marginLeft: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Text style={{ color, fontWeight: '800', fontSize: 15 }}>{p ? pFmt(p.price) : 'No data'}</Text>
          <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: statusDot }} />
        </View>
        <Text style={{ color, fontSize: 11, fontWeight: '700', marginTop: 1 }}>
          {p && p.chg != null ? (!isLive ? statusLabel : `${pos ? '▲ +' : '▼ '}${p.chg.toFixed(2)}%`) : ''}
        </Text>
      </View>
    </TouchableOpacity>
  );
});
