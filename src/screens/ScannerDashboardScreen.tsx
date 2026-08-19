import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, ActivityIndicator, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { useScannerService } from '../context/ScannerService';
import { useEvalTasks, notifyRunningInBackground } from '../context/EvalTaskContext';
import { Card, SectionLabel, Pill } from '../components/Common';
import { pFmt } from '../utils/indicators';
import { formatTradeQualityScore, fromOpportunity } from '../utils/tradeQuality';
import { PaperPortfolioState, computePortfolioValue, getPortfolio, setMode } from '../utils/paperPortfolio';
import { getNamedWatchlists, getActiveWatchlistName, setActiveWatchlistName, resolveWatchlistAssets, DEFAULT_WATCHLIST_NAME, NamedWatchlist } from '../utils/multiWatchlist';
import { getRegimeFilterMode, setRegimeFilterMode, RegimeFilterMode } from '../utils/regimeFilter';
import { computeAssetClassExposure } from '../utils/paperRiskControls';
import { rankOpportunities, topOpportunities, topLongs, topShorts, highestConfidence, bestRiskReward, mostImproved, recentlyChangedSignals, OpportunitySignal } from '../utils/opportunityRanking';
import { RADIUS } from '../theme/colors';

const REGIME_MODES: RegimeFilterMode[] = ['DISABLED', 'BULL_ONLY', 'TRENDING_ONLY', 'AVOID_LOW_VOL', 'AVOID_RANGING'];

function formatMs(ms: number): string {
  if (ms < 1000) return '0s';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export default function ScannerDashboardScreen() {
  const { theme: T } = useTheme();
  const { allAssets, prices, aoSession, avKey } = useData();
  const { enabled, status, toggleEnabled } = useScannerService();
  const { tasks, startScanner, cancelTask } = useEvalTasks();
  const [portfolio, setPortfolio] = useState<PaperPortfolioState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); try { await load(); } finally { setRefreshing(false); } }, [load]);
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
  // Reload only when scan start/stop state changes, not on every status tick.
  // status.lastScanTime changes when a scan completes; enabled changes on toggle.
  const lastScanTime = status?.lastScanTime;
  useEffect(() => { load(); }, [lastScanTime, enabled, load]);

  // P1 #5: memoize expensive derived state — without this, resolveWatchlistAssets,
  // computePortfolioValue, computeAssetClassExposure, scannerId string construction,
  // and opportunity ranking all rerun on every EvalTaskContext update.
  const scanAssets = useMemo(
    () => resolveWatchlistAssets(allAssets, activeWatchlist, namedLists),
    [allAssets, activeWatchlist, namedLists]
  );
  const livePrices = useMemo(() => {
    const lp: Record<string, number> = {};
    Object.entries(prices).forEach(([sym, p]) => { lp[sym] = p.price; });
    return lp;
  }, [prices]);
  const exposure = useMemo(
    () => portfolio ? computeAssetClassExposure(portfolio, computePortfolioValue(portfolio, livePrices).portfolioValue) : [],
    [portfolio, livePrices]
  );

  // P1 #5: memoize scannerId — string construction + sort was running on every render
  const scannerId = useMemo(
    () => scanAssets.length ? `scanner__${scanAssets.map(a => a.symbol).sort().join('|')}` : null,
    [scanAssets]
  );
  const scanTask = scannerId ? tasks[scannerId] : null;
  const scanRunning = scanTask?.status === 'running';
  const scanPct = scanTask && scanTask.total > 0
    ? Math.round((scanTask.completed / scanTask.total) * 100)
    : 0;

  // P1 #4: local elapsed clock — only ticks when scanner is running.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!scanRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [scanRunning]);
  const scanElapsedMs = scanRunning && scanTask?.startedAt ? now - scanTask.startedAt : scanTask?.elapsedMs ?? 0;

  const scanRunningRef = useRef(false);
  scanRunningRef.current = scanRunning;

  useFocusEffect(useCallback(() => {
    return () => {
      if (scanRunningRef.current) notifyRunningInBackground('scanner');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])); // empty deps — cleanup fires only on real blur

  function handleScanNow() {
    if (scanRunning) {
      Alert.alert('Already Running', 'A scan is already in progress for this watchlist.');
      return;
    }
    startScanner(scanAssets, { aoSession, avKey });
  }

  function handleCancelScan() {
    if (!scannerId) return;
    Alert.alert(
      'Cancel Scanner?',
      'Progress will be lost.',
      [
        { text: 'Keep Running', style: 'cancel' },
        { text: 'Cancel Scan', style: 'destructive', onPress: () => cancelTask(scannerId) },
      ]
    );
  }

  async function toggleAutoMode() {
    if (!portfolio) return;
    const next = portfolio.mode === 'AUTO' ? 'MANUAL' : 'AUTO';
    // If user is enabling AUTO but the scanner isn't running,
    // prompt to start it — otherwise AUTO silently does nothing.
    if (next === 'AUTO' && !enabled) {
      Alert.alert(
        'Start Scanner?',
        'AUTO mode requires the Scanner to be running.\nWould you like to start the Scanner now?',
        [
          { text: 'Later', style: 'cancel', onPress: async () => {
              // Still switch to AUTO — user may start scanner manually later
              setPortfolio(await setMode(next));
            }
          },
          { text: 'Start Scanner', onPress: async () => {
              setPortfolio(await setMode(next));
              await toggleEnabled();
            }
          },
        ]
      );
      return;
    }
    setPortfolio(await setMode(next));
  }

  async function changeRegimeMode(mode: RegimeFilterMode) {
    await setRegimeFilterMode(mode);
    setRegimeMode(mode);
  }

  async function rankNow() {
    setRankingLoading(true);
    try {
      const localStats = { symbolsScanned: 0, cacheHits: 0, cacheMisses: 0, failedRequests: 0, lastError: null, avgScanDurationMs: 0, totalScanDurationMs: 0, scanCyclesRun: 0 };
      const result = await rankOpportunities(scanAssets, aoSession, avKey, localStats);
      setRanking(result);
    } catch (e: any) {
      console.warn('Ranking failed:', e.message);
    }
    setRankingLoading(false);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={T.accent} />}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Scanner Health Dashboard</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>Persists across navigation and app restart — this is the real engine, not just a screen.</Text>

        <Card theme={T} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>Scanner: {enabled ? '🟢 RUNNING' : '⚪ STOPPED'}</Text>
              <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>Trading: {portfolio?.mode === 'AUTO' ? '🟢 AUTO' : '⚪ MANUAL'} · {scanAssets.length} symbols in "{activeWatchlist}"</Text>
            </View>
            <TouchableOpacity onPress={toggleEnabled} activeOpacity={0.7} style={{ backgroundColor: enabled ? T.green : T.bg3, paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADIUS.sm }}>
              <Text style={{ color: enabled ? '#fff' : T.textSub, fontWeight: '700', fontSize: 11 }}>{enabled ? 'STOP' : 'START'}</Text>
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 }}>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Last scan: {status?.lastScanTime ? new Date(status.lastScanTime).toLocaleTimeString() : 'never'}</Text>
            <Text style={{ color: T.textDim, fontSize: 10 }}>Next: {status?.nextScanTime ? new Date(status.nextScanTime).toLocaleTimeString() : '—'}</Text>
          </View>

          {/* Scan Now button — instant feedback via background task */}
          <TouchableOpacity
            onPress={handleScanNow}
            disabled={!scanAssets.length}
            activeOpacity={0.65}
            style={{ backgroundColor: scanRunning ? T.accent + 'aa' : T.accent, padding: 10, borderRadius: RADIUS.sm, alignItems: 'center', marginTop: 10, opacity: !scanAssets.length ? 0.4 : 1 }}
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
              {scanRunning ? `Scanning… ${scanPct}%` : 'Scan Now'}
            </Text>
          </TouchableOpacity>

          {scanRunning && (
            <TouchableOpacity onPress={handleCancelScan} style={{ marginTop: 6, alignItems: 'center' }}>
              <Text style={{ color: T.textDim, fontSize: 10 }}>Cancel scan</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={toggleAutoMode} style={{ marginTop: 8, alignItems: 'center' }}>
            <Text style={{ color: T.accent, fontSize: 10 }}>Toggle AUTO/MANUAL trading</Text>
          </TouchableOpacity>
          {status && status.currentlyScanning.length > 0 && (
            <Text style={{ color: T.purple, fontSize: 10, marginTop: 8 }}>Auto-scanning: {status.currentlyScanning.join(', ')}</Text>
          )}
        </Card>

        {/* Live scan task progress card */}
        {scanTask && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <Text style={{ color: scanTask.status === 'completed' ? T.green : scanTask.status === 'failed' ? T.red : scanTask.status === 'cancelled' ? T.textDim : scanTask.status === 'interrupted' ? T.amber : T.accent, fontSize: 12, fontWeight: '700' }}>
                {scanTask.status === 'completed' ? `✓ Scan complete — ${scanTask.scanSignalCount ?? 0} signals found` : scanTask.status === 'failed' ? '✗ Scan failed' : scanTask.status === 'cancelled' ? '⚪ Scan cancelled' : scanTask.status === 'interrupted' ? '⚠ Interrupted — app was closed' : `Scanning… ${scanPct}%`}
              </Text>
              <Text style={{ color: T.textDim, fontSize: 10 }}>
                {formatMs(scanElapsedMs)}
                {scanTask.etaMs != null && scanTask.status === 'running' ? ` · ~${formatMs(scanTask.etaMs)} left` : ''}
              </Text>
            </View>
            <View style={{ height: 4, backgroundColor: T.bg3, borderRadius: 2, overflow: 'hidden', marginBottom: 8 }}>
              <View style={{ height: 4, width: `${scanPct}%`, backgroundColor: scanTask.status === 'completed' ? T.green : T.accent, borderRadius: 2 }} />
            </View>
            {scanTask.steps.slice(0, 8).map(step => {
              const icon = step.status === 'done' ? '✓' : step.status === 'active' ? '⟳' : step.status === 'error' ? '✗' : '·';
              const color = step.status === 'done' ? T.green : step.status === 'active' ? T.accent : step.status === 'error' ? T.red : T.textDim;
              return (
                <View key={step.key} style={{ flexDirection: 'row', gap: 6, marginBottom: 2 }}>
                  <Text style={{ color, fontSize: 10, fontWeight: '700', width: 12 }}>{icon}</Text>
                  <Text style={{ color: step.status === 'pending' ? T.textDim : T.text, fontSize: 10, flex: 1 }}>{step.label}{step.detail ? ` — ${step.detail}` : ''}</Text>
                </View>
              );
            })}
            {scanTask.steps.length > 8 && (
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>…and {scanTask.steps.length - 8} more symbols</Text>
            )}
            {scanTask.error && <Text style={{ color: T.red, fontSize: 9, marginTop: 4 }}>{scanTask.error}</Text>}
          </Card>
        )}

        {/* Scanner timeframe transparency */}
        <Card theme={T} style={{ marginBottom: 14, borderColor: T.amber + '40', borderWidth: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6, gap: 6 }}>
            <Text style={{ color: T.amber, fontSize: 10, fontWeight: '800' }}>ℹ SCANNER TIMEFRAME</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <View style={{ backgroundColor: T.amber + '20', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 }}>
              <Text style={{ color: T.amber, fontWeight: '800', fontSize: 13 }}>15m</Text>
            </View>
            <Text style={{ color: T.text, fontSize: 11, flex: 1 }}>The scanner always evaluates signals on the 15-minute timeframe.</Text>
          </View>
          <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 13 }}>
            {portfolio?.mode === 'AUTO'
              ? 'AUTO mode: paper trades are opened and managed using the 15m model. This is independent of the timeframe selected on the Chart screen — changing the Chart timeframe does not affect scanner behavior.'
              : 'MANUAL mode: scanner signals are generated using the 15m model. The Chart screen timeframe is independent — the scanner does not follow it.'}
          </Text>
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
            <TouchableOpacity onPress={rankNow} disabled={rankingLoading} activeOpacity={0.7} style={{ backgroundColor: T.purple, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 6 }}>
              {rankingLoading ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>RANK NOW</Text>}
            </TouchableOpacity>
          </View>
          <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 10, lineHeight: 13 }}>
            Evaluates all 6 timeframes per symbol — heavier than a regular scan, so it runs on-demand here rather than every scan cycle.
          </Text>
          {ranking && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {[['top','Top'],['longs','Longs'],['shorts','Shorts'],['confidence','Confidence'],['riskReward','R:R'],['improved','Improved'],['changed','Changed']].map(([key, label]) => (
                  <Pill key={key} label={label} color={T.blue} active={rankingView === key} onPress={() => setRankingView(key as any)} />
                ))}
              </View>
            </ScrollView>
          )}
          {ranking && (() => {
            const view = rankingView === 'top' ? topOpportunities(ranking) : rankingView === 'longs' ? topLongs(ranking) : rankingView === 'shorts' ? topShorts(ranking) : rankingView === 'confidence' ? highestConfidence(ranking) : rankingView === 'riskReward' ? bestRiskReward(ranking) : rankingView === 'improved' ? mostImproved(ranking) : recentlyChangedSignals(ranking);
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
