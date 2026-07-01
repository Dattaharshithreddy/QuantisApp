import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { useScannerService } from '../context/ScannerService';
import { Card, SectionLabel, Pill } from '../components/Common';
import { pFmt } from '../utils/indicators';
import { formatTradeQualityScore } from '../utils/tradeQuality';
import { getPortfolio, setMode, PaperPortfolioState } from '../utils/paperPortfolio';
import { getNamedWatchlists, getActiveWatchlistName, setActiveWatchlistName, resolveWatchlistAssets, DEFAULT_WATCHLIST_NAME, NamedWatchlist } from '../utils/multiWatchlist';
import { getRegimeFilterMode, setRegimeFilterMode, RegimeFilterMode } from '../utils/regimeFilter';
import { computeAssetClassExposure } from '../utils/paperRiskControls';
import { computePortfolioValue } from '../utils/paperPortfolio';
import { rankOpportunities, topOpportunities, topLongs, topShorts, highestConfidence, bestRiskReward, mostImproved, recentlyChangedSignals, OpportunitySignal } from '../utils/opportunityRanking';
import { fromOpportunity } from '../utils/tradeQuality';

const REGIME_MODES: RegimeFilterMode[] = ['DISABLED', 'BULL_ONLY', 'TRENDING_ONLY', 'AVOID_LOW_VOL', 'AVOID_RANGING'];

// FIX (Phase 1 architectural change): this screen previously OWNED the
// polling interval itself (a useRef + setInterval tied to this screen's
// mount lifecycle) — meaning the scanner only ever ran while this exact
// screen was open, and navigating away silently stopped it. The interval
// now lives in ScannerServiceProvider (mounted once at the App root,
// survives navigation, restores on launch) — this screen is purely a VIEW
// into that global state via useScannerService(), with zero interval logic
// of its own. Having TWO independent intervals (one here, one in the
// service) would itself be a real bug — duplicate scans, doubled API
// usage — so this screen deliberately owns none.
export default function ScannerDashboardScreen() {
  const { theme: T } = useTheme();
  const { allAssets, prices, aoSession, avKey } = useData();
  const { enabled, status, toggleEnabled, scanNow } = useScannerService();
  const [portfolio, setPortfolio] = useState<PaperPortfolioState | null>(null);
  const [scanning, setScanning] = useState(false);
  const [activeWatchlist, setActiveWatchlistState] = useState(DEFAULT_WATCHLIST_NAME);
  const [namedLists, setNamedLists] = useState<NamedWatchlist[]>([]);
  const [regimeMode, setRegimeMode] = useState<RegimeFilterMode>('DISABLED');
  const [ranking, setRanking] = useState<OpportunitySignal[] | null>(null);
  const [rankingLoading, setRankingLoading] = useState(false);
  const [rankingView, setRankingView] = useState<'top' | 'longs' | 'shorts' | 'confidence' | 'riskReward' | 'improved' | 'changed'>('top');

  const load = useCallback(async () => {
    setPortfolio(await getPortfolio());
    setNamedLists(await getNamedWatchlists());
    setActiveWatchlistState(await getActiveWatchlistName());
    setRegimeMode(await getRegimeFilterMode());
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { load(); }, [status]); // refresh portfolio view whenever a scan cycle completes

  async function handleScanNow() {
    setScanning(true);
    await scanNow();
    await load();
    setScanning(false);
  }

  async function rankNow() {
    setRankingLoading(true);
    try {
      // A fresh, local stats object — this is a separate operation from
      // the regular scan cycle's own stats tracking, deliberately not
      // mixed into it (see opportunityRanking.ts's architectural note).
      const localStats = { symbolsScanned: 0, cacheHits: 0, cacheMisses: 0, failedRequests: 0, lastError: null, avgScanDurationMs: 0, totalScanDurationMs: 0, scanCyclesRun: 0 };
      const result = await rankOpportunities(scanAssets, aoSession, avKey, localStats);
      setRanking(result);
    } catch (e: any) {
      console.warn('Ranking failed:', e.message);
    }
    setRankingLoading(false);
  }

  async function toggleAutoMode() {
    if (!portfolio) return;
    const next = portfolio.mode === 'AUTO' ? 'MANUAL' : 'AUTO';
    setPortfolio(await setMode(next));
  }

  async function changeRegimeMode(mode: RegimeFilterMode) {
    await setRegimeFilterMode(mode);
    setRegimeMode(mode);
  }

  const scanAssets = resolveWatchlistAssets(allAssets, activeWatchlist, namedLists);
  const livePrices: Record<string, number> = {};
  Object.entries(prices).forEach(([sym, p]) => { livePrices[sym] = p.price; });
  const exposure = portfolio ? computeAssetClassExposure(portfolio, computePortfolioValue(portfolio, livePrices).portfolioValue) : [];

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Scanner Health Dashboard</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>Persists across navigation and app restart — this is the real engine, not just a screen.</Text>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>Scanner: {enabled ? '🟢 RUNNING' : '⚪ STOPPED'}</Text>
              <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>Trading: {portfolio?.mode === 'AUTO' ? '🟢 AUTO' : '⚪ MANUAL'} · {scanAssets.length} symbols in "{activeWatchlist}"</Text>
            </View>
            <TouchableOpacity onPress={toggleEnabled} style={{ backgroundColor: enabled ? T.green : T.bg3, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }}>
              <Text style={{ color: enabled ? '#fff' : T.textSub, fontWeight: '700', fontSize: 11 }}>{enabled ? 'STOP' : 'START'}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 }}>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Last scan: {status?.lastScanTime ? new Date(status.lastScanTime).toLocaleTimeString() : 'never'}</Text>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Next: {status?.nextScanTime ? new Date(status.nextScanTime).toLocaleTimeString() : '—'}</Text>
          </View>
          <TouchableOpacity onPress={handleScanNow} disabled={scanning} style={{ backgroundColor: T.accent, padding: 10, borderRadius: 8, alignItems: 'center', marginTop: 10, opacity: scanning ? 0.6 : 1 }}>
            {scanning ? <ActivityIndicator color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>Scan Now</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={toggleAutoMode} style={{ marginTop: 8, alignItems: 'center' }}>
            <Text style={{ color: T.accent, fontSize: 10 }}>Toggle AUTO/MANUAL trading</Text>
          </TouchableOpacity>
          {status && status.currentlyScanning.length > 0 && (
            <Text style={{ color: T.purple, fontSize: 10, marginTop: 8 }}>Scanning: {status.currentlyScanning.join(', ')}</Text>
          )}
        </Card>

        {status?.stats && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>SCANNER STATISTICS</SectionLabel>
            <Row label="Symbols Scanned (lifetime)" value={String(status.stats.symbolsScanned)} T={T} />
            <Row label="Cache Hit Rate" value={`${status.stats.cacheHits + status.stats.cacheMisses > 0 ? ((status.stats.cacheHits / (status.stats.cacheHits + status.stats.cacheMisses)) * 100).toFixed(0) : 0}%`} T={T} />
            <Row label="Avg Scan Duration" value={`${(status.stats.avgScanDurationMs / 1000).toFixed(1)}s`} T={T} />
            <Row label="Failed Requests" value={String(status.stats.failedRequests)} color={status.stats.failedRequests > 0 ? T.amber : T.green} T={T} />
            <Row label="Scan Cycles Run" value={String(status.stats.scanCyclesRun)} T={T} />
            {status.stats.lastError && <Text style={{ color: T.red, fontSize: 9, marginTop: 6 }}>Last error: {status.stats.lastError}</Text>}
          </Card>
        )}

        {exposure.length > 0 && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>ASSET-CLASS EXPOSURE</SectionLabel>
            {exposure.map(e => <Row key={e.assetClass} label={`${e.assetClass} (${e.positionCount} position${e.positionCount === 1 ? '' : 's'})`} value={`${e.exposurePct.toFixed(1)}%`} T={T} />)}
          </Card>
        )}

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>WATCHLIST</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              <Pill label={DEFAULT_WATCHLIST_NAME} color={T.blue} active={activeWatchlist === DEFAULT_WATCHLIST_NAME} onPress={async () => { await setActiveWatchlistName(DEFAULT_WATCHLIST_NAME); setActiveWatchlistState(DEFAULT_WATCHLIST_NAME); }} />
              {namedLists.map(l => (
                <Pill key={l.name} label={l.name} color={T.purple} active={activeWatchlist === l.name} onPress={async () => { await setActiveWatchlistName(l.name); setActiveWatchlistState(l.name); }} />
              ))}
            </View>
          </ScrollView>
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>REGIME FILTER</SectionLabel>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {REGIME_MODES.map(m => <Pill key={m} label={m.replace(/_/g, ' ')} color={T.amber} active={regimeMode === m} onPress={() => changeRegimeMode(m)} />)}
            </View>
          </ScrollView>
        </Card>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <SectionLabel theme={T}>OPPORTUNITY RANKING</SectionLabel>
            <TouchableOpacity onPress={rankNow} disabled={rankingLoading} style={{ backgroundColor: T.purple, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6 }}>
              {rankingLoading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>RANK NOW</Text>}
            </TouchableOpacity>
          </View>
          <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 10, lineHeight: 13 }}>
            Evaluates all 6 timeframes per symbol — heavier than a regular scan, so it runs on-demand here rather than every scan cycle.
          </Text>
          {ranking && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {[
                  ['top', 'Top'], ['longs', 'Longs'], ['shorts', 'Shorts'], ['confidence', 'Confidence'],
                  ['riskReward', 'R:R'], ['improved', 'Improved'], ['changed', 'Changed'],
                ].map(([key, label]) => (
                  <Pill key={key} label={label} color={T.blue} active={rankingView === key} onPress={() => setRankingView(key as any)} />
                ))}
              </View>
            </ScrollView>
          )}
          {ranking && (() => {
            const view = rankingView === 'top' ? topOpportunities(ranking)
              : rankingView === 'longs' ? topLongs(ranking)
              : rankingView === 'shorts' ? topShorts(ranking)
              : rankingView === 'confidence' ? highestConfidence(ranking)
              : rankingView === 'riskReward' ? bestRiskReward(ranking)
              : rankingView === 'improved' ? mostImproved(ranking)
              : recentlyChangedSignals(ranking);
            if (!view.length) return <Text style={{ color: T.textDim, fontSize: 10 }}>No symbols in this view.</Text>;
            return view.map(o => {
              const { quality } = fromOpportunity(o);
              return (
                <View key={o.symbol} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.border }}>
                  <View>
                    <Text style={{ color: T.text, fontWeight: '700', fontSize: 12 }}>{o.symbol}</Text>
                    <Text style={{ color: o.consensus.overallDirection === 'BUY' ? T.green : o.consensus.overallDirection === 'SELL' ? T.red : T.textDim, fontSize: 9 }}>
                      {o.consensus.overallDirection} · {o.consensus.agreementPct.toFixed(0)}% agree · {o.consensus.conflictingTimeframes.length ? `conflicts: ${o.consensus.conflictingTimeframes.join(',')}` : 'no conflicts'}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: T.text, fontWeight: '700', fontSize: 12 }}>{formatTradeQualityScore(quality.score)} {quality.stars} {quality.grade}</Text>
                    <Text style={{ color: quality.riskBadge === 'Low' ? T.green : quality.riskBadge === 'Medium' ? T.amber : T.red, fontSize: 9 }}>{quality.riskBadge} risk · R:R {o.riskRewardRatio.toFixed(1)} {o.signalChanged ? '· 🔄 changed' : ''}</Text>
                  </View>
                </View>
              );
            });
          })()}
        </Card>

        <SectionLabel theme={T}>LIVE SIGNALS</SectionLabel>
        {scanAssets.map(a => {
          const result = status?.lastResults[a.symbol];
          const openPos = portfolio?.openPositions.find(p => p.symbol === a.symbol);
          return (
            <Card key={a.symbol + a.src} theme={T} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: T.text, fontWeight: '700', fontSize: 12 }}>{a.symbol}</Text>
                <Text style={{ color: T.textDim, fontSize: 11 }}>{pFmt(prices[a.symbol]?.price)}</Text>
              </View>
              {result ? (
                <Text style={{ color: result.action === 'BUY' ? T.green : result.action === 'SELL' ? T.red : T.textDim, fontSize: 10, marginTop: 4 }}>
                  {result.action} · confidence {result.confidence.toFixed(0)} · risk {result.riskScore.toFixed(0)}
                </Text>
              ) : <Text style={{ color: T.textDim, fontSize: 10, marginTop: 4 }}>Not scanned yet</Text>}
              {openPos && <Text style={{ color: T.purple, fontSize: 9, marginTop: 2 }}>📍 Open {openPos.direction} position</Text>}
            </Card>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ label, value, color, T }: any) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: T.border }}>
      <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: color || T.text, fontWeight: '700', fontSize: 11 }}>{value}</Text>
    </View>
  );
}
