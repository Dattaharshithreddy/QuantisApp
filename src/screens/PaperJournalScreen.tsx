// ─────────────────────────────────────────────────────────────────────────────
// PAPER TRADING JOURNAL  v2.0
// Added: symbol / direction / result / timeframe filters, sort, export (CSV+PDF)
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, IconChip, Skeleton } from '../components/Common';
import { formatTradeQualityScore } from '../utils/tradeQuality';
import { pFmt } from '../utils/indicators';
import { getPaperTrades, PaperTradeRecord } from '../utils/paperTradeJournal';
import { RADIUS } from '../theme/colors';
import { MarketContextCard } from '../components/MarketContextCard';
import { exportPaperJournal, ExportFormat } from '../utils/journalExport';
import { computePaperPortfolioStats } from '../utils/paperAnalytics';
import { getPortfolio } from '../utils/paperPortfolio';

type ResultFilter = 'ALL' | 'WIN' | 'LOSS' | 'BE';
type DirFilter    = 'ALL' | 'LONG' | 'SHORT';

const SORT_OPTIONS = [
  { key: 'newest',   label: '↓ Newest' },
  { key: 'oldest',   label: '↑ Oldest' },
  { key: 'best_pnl', label: '↓ Best P&L' },
  { key: 'worst_pnl',label: '↑ Worst P&L' },
  { key: 'conf',     label: '↓ Confidence' },
];

export default function PaperJournalScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const [trades,   setTrades]   = useState<PaperTradeRecord[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // ── Filters ──────────────────────────────────────────────────────────────
  const [fSymbol,  setFSymbol]  = useState('ALL');
  const [fDir,     setFDir]     = useState<DirFilter>('ALL');
  const [fResult,  setFResult]  = useState<ResultFilter>('ALL');
  const [fTF,      setFTF]      = useState('ALL');
  const [sortIdx,  setSortIdx]  = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [showExportPanel, setShowExportPanel] = useState(false);

  useEffect(() => {
    getPaperTrades().then(t => { setTrades(t); setLoading(false); });
  }, []);

  // ── Derived filter options ────────────────────────────────────────────────
  const symbols    = useMemo(() => ['ALL', ...[...new Set(trades.map(t => t.symbol))].sort()],    [trades]);
  const timeframes = useMemo(() => ['ALL', ...[...new Set(trades.map(t => t.timeframe))].sort()], [trades]);

  // ── Apply filters + sort ──────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let r = trades;
    if (fSymbol !== 'ALL') r = r.filter(t => t.symbol    === fSymbol);
    if (fDir    !== 'ALL') r = r.filter(t => t.direction  === fDir);
    if (fTF     !== 'ALL') r = r.filter(t => t.timeframe  === fTF);
    if (fResult !== 'ALL') r = r.filter(t => {
      const res = t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'BE';
      return res === fResult;
    });
    const key = SORT_OPTIONS[sortIdx].key;
    const s   = [...r];
    switch (key) {
      case 'newest':    return s.sort((a, b) => b.exitTime - a.exitTime);
      case 'oldest':    return s.sort((a, b) => a.exitTime - b.exitTime);
      case 'best_pnl':  return s.sort((a, b) => b.pnl - a.pnl);
      case 'worst_pnl': return s.sort((a, b) => a.pnl - b.pnl);
      case 'conf':      return s.sort((a, b) => b.aiConfidence - a.aiConfidence);
      default:          return s;
    }
  }, [trades, fSymbol, fDir, fResult, fTF, sortIdx]);

  const hasFilter = fSymbol !== 'ALL' || fDir !== 'ALL' || fResult !== 'ALL' || fTF !== 'ALL';
  const clearFilters = () => { setFSymbol('ALL'); setFDir('ALL'); setFResult('ALL'); setFTF('ALL'); };

  // ── Summary stats ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const wins   = filtered.filter(t => t.pnl > 0);
    const losses = filtered.filter(t => t.pnl < 0);
    const totalPnl = filtered.reduce((s, t) => s + t.pnl, 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    return {
      total: filtered.length,
      wins:  wins.length,
      losses: losses.length,
      winRate: filtered.length > 0 ? (wins.length / filtered.length * 100) : 0,
      totalPnl,
      pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0};
  }, [filtered]);

  // ── Export ────────────────────────────────────────────────────────────────
  const handleExport = useCallback(async (format: ExportFormat) => {
    if (filtered.length === 0) {
      Alert.alert('Nothing to export', 'No trades match the current filters.');
      return;
    }
    setExporting(true);
    setShowExportPanel(false);
    try {
      // FIX: unified export — PDF includes full analytics, not just trade list.
      // Load analytics stats fresh so the report is always current.
      let stats = null;
      if (format === 'PDF') {
        try {
          const [portfolio, s] = await Promise.all([
            getPortfolio(),
            computePaperPortfolioStats(100000),
          ]);
          stats = s;
        } catch { /* analytics load failure is non-fatal — PDF still exports without analytics */ }
      }
      const filters = {
        symbol:    fSymbol !== 'ALL' ? fSymbol : undefined,
        direction: fDir    !== 'ALL' ? fDir    : undefined,
        result:    fResult !== 'ALL' ? fResult : undefined,
        tf:        fTF     !== 'ALL' ? fTF     : undefined,
      };
      await exportPaperJournal(filtered, format, filters, stats);
    } catch (e: any) {
      Alert.alert('Export failed', e.message ?? 'Unknown error');
    } finally {
      setExporting(false);
    }
  }, [filtered, fSymbol, fDir, fResult, fTF]);

  // ── Row render ────────────────────────────────────────────────────────────
  const renderTrade = (t: PaperTradeRecord) => {
    const statusLabel = t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'BREAKEVEN';
    const statusColor = t.pnl > 0 ? T.green : t.pnl < 0 ? T.red : T.textDim;
    const isLong      = t.direction === 'LONG';
    const dirColor    = isLong ? T.green : T.red;
    const isExpanded  = expanded === t.id;

    return (
      <Card key={t.id} theme={T} style={{ marginBottom: 10 }}>
        {/* ── Trade header row ─────────────────────────────────────────── */}
        <TouchableOpacity onPress={() => setExpanded(isExpanded ? null : t.id)} activeOpacity={0.85}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ width: 3, height: 36, borderRadius: 2, backgroundColor: dirColor }} />
              <View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={{ color: dirColor, fontSize: 9, fontWeight: '800' }}>{isLong ? '▲' : '▼'} {t.direction}</Text>
                  <Text style={{ color: T.text, fontWeight: '800', fontSize: 15 }}>{t.symbol}</Text>
                  <Text style={{ color: T.textDim, fontSize: 10 }}>{t.timeframe}</Text>
                </View>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>
                  {new Date(t.exitTime).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'2-digit' })}
                  {' · '}{Math.round(t.holdingMs / 60000)}m hold
                </Text>
              </View>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <View style={{ backgroundColor: statusColor + '18', borderRadius: RADIUS.sm, paddingHorizontal: 8, paddingVertical: 3 }}>
                <Text style={{ color: statusColor, fontSize: 10, fontWeight: '800' }}>{statusLabel}</Text>
              </View>
              <Text style={{ color: statusColor, fontWeight: '800', fontSize: 14 }}>
                {t.pnl >= 0 ? '+' : ''}₹{pFmt(t.pnl)}
              </Text>
              <Text style={{ color: T.textDim, fontSize: 9 }}>
                {t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(2)}%
              </Text>
            </View>
          </View>
        </TouchableOpacity>

        {/* ── Expanded detail ───────────────────────────────────────────── */}
        {isExpanded && (
          <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.border }}>
            {/* Core metrics */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              <IconChip icon="📍" text={`Entry ₹${pFmt(t.entryPrice)}`} color={T.textSub} theme={T} />
              <IconChip icon="🏁" text={`Exit ₹${pFmt(t.exitPrice)}`} color={T.textSub} theme={T} />
              <IconChip icon="🧠" text={`AI ${t.aiConfidence.toFixed(0)}%`} color={T.textSub} theme={T} />
              <IconChip icon="📊" text={`v${t.modelVersion}`} color={T.textSub} theme={T} />
              {t.tradeQuality && (
                <IconChip icon="⭐" text={`${formatTradeQualityScore(t.tradeQuality.score)} ${t.tradeQuality.stars ?? ''}`} color={T.textSub} theme={T} />
              )}
              <IconChip icon="🌍" text={t.marketRegime ?? '—'} color={T.textSub} theme={T} />
            </View>

            {/* P&L breakdown */}
            <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.sm, padding: 10, marginBottom: 10, borderWidth: 1, borderColor: T.border }}>
              {[
                ['Gross P&L',            `${t.grossPnl >= 0 ? '+' : ''}₹${pFmt(t.grossPnl)}`, t.grossPnl >= 0 ? T.green : T.red],
                ['Fees',                 `-₹${pFmt(t.totalFees)}`, T.red],
                ['Net P&L',              `${t.pnl >= 0 ? '+' : ''}₹${pFmt(t.pnl)}`, t.pnl >= 0 ? T.green : T.red],
                // FIX (Audit item #3): display peak-profit metrics from frozen trade record.
                // peakProfit and maxProfitWithdrawn were added in v6.9.3; older records fall
                // back to maxUnrealizedProfit and 0 via the ?? guard in extractPeakProfitMetrics.
                ...(t.maxUnrealizedProfit != null ? [
                  ['Peak Profit (MFE)',  `₹${pFmt(Math.max(0, t.maxUnrealizedProfit))}`, T.green],
                  ['Max Drawdown (MAE)', `₹${pFmt(t.maxDrawdownDuringTrade ?? 0)}`, T.red],
                  ...(t.peakProfit != null ? [
                    ['Max Profit Given Back', `₹${pFmt(t.maxProfitWithdrawn ?? 0)}`, T.amber],
                  ] : []),
                ] : []),
              ].map(([label, val, col]) => (
                <View key={label as string} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 }}>
                  <Text style={{ color: T.textDim, fontSize: 10 }}>{label}</Text>
                  <Text style={{ color: col as string, fontWeight: '700', fontSize: 10 }}>{val}</Text>
                </View>
              ))}
            </View>

            {/* Prediction outcome */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, marginBottom: 6 }}>
              <Text style={{ color: T.textDim, fontSize: 10 }}>Prediction Outcome</Text>
              <Text style={{ color: t.predictionResult === 'CORRECT' ? T.green : t.predictionResult === 'INCORRECT' ? T.red : T.textDim, fontWeight: '700', fontSize: 10 }}>
                {t.predictionResult === 'CORRECT' ? '✅ Correct' : t.predictionResult === 'INCORRECT' ? '❌ Incorrect' : '➖ Neutral'}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, marginBottom: 10 }}>
              <Text style={{ color: T.textDim, fontSize: 10 }}>Exit Reason</Text>
              <Text style={{ color: T.text, fontWeight: '700', fontSize: 10 }}>{t.exitReason}</Text>
            </View>

            {/* Market Context */}
            {t.marketContext && (
              <View style={{ marginBottom: 10 }}>
                <MarketContextCard snapshot={t.marketContext} T={T} compact />
              </View>
            )}

            {/* Action buttons */}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              <TouchableOpacity
                onPress={() => navigation.navigate('Chart', { symbol: t.symbol, initialTf: t.timeframe, reviewTrade: t })}
                style={{ flex: 1, backgroundColor: T.accent + '20', borderRadius: RADIUS.sm, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: T.accent + '50' }}>
                <Text style={{ color: T.accent, fontSize: 11, fontWeight: '700' }}>📈 Review on Chart</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => navigation.navigate('PaperReplay', { trade: t })}
                style={{ flex: 1, backgroundColor: T.bg3, borderRadius: RADIUS.sm, paddingVertical: 8, alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
                <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>📊 Full Replay</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </Card>
    );
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardDismissMode="on-drag">

        {/* ── Header ──────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <View>
            <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Paper Journal</Text>
            <Text style={{ color: T.textDim, fontSize: 10, marginTop: 1 }}>
              {filtered.length} of {trades.length} trade{trades.length !== 1 ? 's' : ''}
              {hasFilter ? ' (filtered)' : ''}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TouchableOpacity onPress={() => setShowFilters(f => !f)}
              style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: RADIUS.pill, backgroundColor: showFilters || hasFilter ? T.accent + '22' : T.bg1, borderWidth: 1, borderColor: hasFilter ? T.accent : T.border }}>
              <Text style={{ color: hasFilter ? T.accent : T.textDim, fontSize: 11, fontWeight: '700' }}>
                {hasFilter ? '⚡ Filtered' : '🔽 Filter'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => navigation.navigate('PaperAnalytics')}
              style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: RADIUS.pill, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border }}>
              <Text style={{ color: T.accent, fontSize: 11, fontWeight: '700' }}>Analytics →</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Stats summary ────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
          {[
            { label: 'Trades',      value: String(stats.total),                      color: T.text },
            { label: 'Win Rate',    value: `${stats.winRate.toFixed(1)}%`,            color: stats.winRate >= 50 ? T.green : T.amber },
            { label: 'P. Factor',   value: stats.pf === Infinity ? '∞' : stats.pf.toFixed(2), color: stats.pf >= 1.5 ? T.green : stats.pf >= 1 ? T.amber : T.red },
            { label: 'Total P&L',   value: `${stats.totalPnl >= 0 ? '+' : ''}₹${pFmt(stats.totalPnl)}`, color: stats.totalPnl >= 0 ? T.green : T.red },
          ].map(s => (
            <View key={s.label} style={{ flex: 1, backgroundColor: T.bg1, borderRadius: RADIUS.md, padding: 10, alignItems: 'center', borderWidth: 1, borderColor: T.border }}>
              <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', marginBottom: 3 }}>{s.label}</Text>
              <Text style={{ color: s.color, fontSize: 13, fontWeight: '800' }}>{s.value}</Text>
            </View>
          ))}
        </View>

        {/* ── Filter panel ─────────────────────────────────────────────── */}
        {showFilters && (
          <View style={{ backgroundColor: T.bg1, borderRadius: RADIUS.md, padding: 12, marginBottom: 14, borderWidth: 1, borderColor: T.border }}>
            {/* Sort */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700' }}>SORT</Text>
              <TouchableOpacity onPress={() => setSortIdx(i => (i + 1) % SORT_OPTIONS.length)}
                style={{ backgroundColor: T.bg0, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, borderWidth: 1, borderColor: T.border }}>
                <Text style={{ color: T.text, fontSize: 10, fontWeight: '700' }}>{SORT_OPTIONS[sortIdx].label}</Text>
              </TouchableOpacity>
            </View>

            {/* Symbol */}
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>SYMBOL</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', gap: 5 }}>
                {symbols.map(s => (
                  <TouchableOpacity key={s} onPress={() => setFSymbol(s)}
                    style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: fSymbol === s ? T.accent + '22' : T.bg0, borderWidth: 1, borderColor: fSymbol === s ? T.accent : T.border }}>
                    <Text style={{ color: fSymbol === s ? T.accent : T.textDim, fontSize: 10, fontWeight: '700' }}>{s}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            {/* Direction + Result */}
            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>DIRECTION</Text>
                <View style={{ flexDirection: 'row', gap: 5 }}>
                  {(['ALL','LONG','SHORT'] as DirFilter[]).map(d => (
                    <TouchableOpacity key={d} onPress={() => setFDir(d)}
                      style={{ flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: 'center', backgroundColor: fDir === d ? T.accent + '22' : T.bg0, borderWidth: 1, borderColor: fDir === d ? T.accent : T.border }}>
                      <Text style={{ color: fDir === d ? T.accent : T.textDim, fontSize: 10, fontWeight: '700' }}>
                        {d === 'LONG' ? '▲' : d === 'SHORT' ? '▼' : ''} {d}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>RESULT</Text>
                <View style={{ flexDirection: 'row', gap: 5 }}>
                  {(['ALL','WIN','LOSS','BE'] as ResultFilter[]).map(r => (
                    <TouchableOpacity key={r} onPress={() => setFResult(r)}
                      style={{ flex: 1, paddingVertical: 6, borderRadius: 6, alignItems: 'center', backgroundColor: fResult === r ? T.accent + '22' : T.bg0, borderWidth: 1, borderColor: fResult === r ? T.accent : T.border }}>
                      <Text style={{ color: fResult === r ? T.accent : T.textDim, fontSize: 10, fontWeight: '700' }}>{r}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            </View>

            {/* Timeframe */}
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>TIMEFRAME</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', gap: 5 }}>
                {timeframes.map(tf => (
                  <TouchableOpacity key={tf} onPress={() => setFTF(tf)}
                    style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, backgroundColor: fTF === tf ? T.accent + '22' : T.bg0, borderWidth: 1, borderColor: fTF === tf ? T.accent : T.border }}>
                    <Text style={{ color: fTF === tf ? T.accent : T.textDim, fontSize: 10, fontWeight: '700' }}>{tf}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>

            {hasFilter && (
              <TouchableOpacity onPress={clearFilters}
                style={{ alignSelf: 'center', paddingHorizontal: 14, paddingVertical: 6, borderRadius: RADIUS.pill, backgroundColor: T.red + '20', borderWidth: 1, borderColor: T.red + '50' }}>
                <Text style={{ color: T.red, fontSize: 10, fontWeight: '700' }}>✕ Clear all filters</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Export panel ─────────────────────────────────────────────── */}
        <View style={{ marginBottom: 14 }}>
          <TouchableOpacity onPress={() => setShowExportPanel(e => !e)}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 10, borderRadius: RADIUS.md, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border }}>
            <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>
              {exporting ? '⏳ Exporting…' : '⬆️ Export Journal'}
            </Text>
            <Text style={{ color: T.textDim, fontSize: 10 }}>
              ({filtered.length} trade{filtered.length !== 1 ? 's' : ''}{hasFilter ? ', filtered' : ''})
            </Text>
          </TouchableOpacity>

          {showExportPanel && !exporting && (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <TouchableOpacity onPress={() => handleExport('CSV')}
                style={{ flex: 1, padding: 12, borderRadius: RADIUS.md, alignItems: 'center', backgroundColor: T.green + '18', borderWidth: 1, borderColor: T.green + '50' }}>
                <Text style={{ fontSize: 20, marginBottom: 4 }}>📄</Text>
                <Text style={{ color: T.green, fontWeight: '800', fontSize: 12 }}>📊 CSV</Text>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2, textAlign: 'center' }}>Spreadsheet-ready{'\n'}Excel / Google Sheets</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleExport('PDF')}
                style={{ flex: 1, padding: 12, borderRadius: RADIUS.md, alignItems: 'center', backgroundColor: T.accent + '18', borderWidth: 1, borderColor: T.accent + '50' }}>
                <Text style={{ fontSize: 20, marginBottom: 4 }}>🌐</Text>
                <Text style={{ color: T.accent, fontWeight: '800', fontSize: 12 }}>📄 PDF</Text>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2, textAlign: 'center' }}>Full report: Journal{'\n'}+ Analytics + AI + Regime</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* ── Trade list ───────────────────────────────────────────────── */}
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <View key={i} style={{ marginBottom: 10 }}>
              <Skeleton width="100%" height={72} radius={10} theme={T} />
            </View>
          ))
        ) : filtered.length === 0 ? (
          <View style={{ alignItems: 'center', paddingVertical: 48 }}>
            <Text style={{ fontSize: 36, marginBottom: 12 }}>📭</Text>
            <Text style={{ color: T.text, fontWeight: '700', fontSize: 15, marginBottom: 6 }}>
              {hasFilter ? 'No trades match filters' : 'No paper trades yet'}
            </Text>
            <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center' }}>
              {hasFilter ? 'Clear filters to see all trades' : 'Paper trades appear here after you close a position'}
            </Text>
            {hasFilter && (
              <TouchableOpacity onPress={clearFilters}
                style={{ marginTop: 14, paddingHorizontal: 20, paddingVertical: 8, borderRadius: RADIUS.pill, backgroundColor: T.accent + '20', borderWidth: 1, borderColor: T.accent + '50' }}>
                <Text style={{ color: T.accent, fontWeight: '700', fontSize: 12 }}>Clear filters</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          filtered.map(renderTrade)
        )}

      </ScrollView>
    </SafeAreaView>
  );
}
