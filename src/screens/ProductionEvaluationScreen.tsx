import { FEATURE_COUNT } from '../utils/modelConstants';
import React, { useState, useMemo, useCallback, useRef, memo, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, InteractionManager } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { useEvalTasks, EvalTask, ComboSpec, notifyRunningInBackground } from '../context/EvalTaskContext';
import { Card, SectionLabel, Pill } from '../components/Common';
import { MultiSymbolSelector } from '../components/MultiSymbolSelector';
import { generateRecommendations } from '../utils/productionEvaluation';
import { RADIUS } from '../theme/colors';
import type { StrategyEvalResult, StrategyEvalEntry } from '../utils/strategyEvaluation';
import { STRATEGY_ORDER } from '../utils/strategy/strategyProfiles';
import type { RegimeEvalResult, RegimeBreakdown } from '../utils/regimeEvaluation';
import { REGIME_DISPLAY_NAMES, REGIME_EMOJI } from '../utils/regimeEvaluation';

const TIMEFRAMES = ['5m', '15m', '30m', '1h', '4h', '1D'];
function formatMs(ms: number): string { if (ms < 1000) return '0s'; const s = Math.round(ms / 1000); const m = Math.floor(s / 60); return m > 0 ? `${m}m ${s % 60}s` : `${s}s`; }

function MetricRow({ label, value, color, T }: { label: string; value: string; color?: string; T: any }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
      <Text style={{ color: T.textDim, fontSize: 10 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 10, fontWeight: '700' }}>{value}</Text>
    </View>
  );
}

function FeatureBar({ name, value, max, positive, T }: { name: string; value: number; max: number; positive: boolean; T: any }) {
  const pct = max > 0 ? Math.min(1, Math.abs(value) / max) : 0;
  const col = positive ? T.green : T.textDim;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 6 }}>
      <Text style={{ color: T.textDim, fontSize: 9, width: 110 }} numberOfLines={1}>{name}</Text>
      <View style={{ flex: 1, height: 6, backgroundColor: T.bg3, borderRadius: 3, overflow: 'hidden' }}>
        <View style={{ width: `${pct * 100}%`, height: 6, backgroundColor: col, borderRadius: 3 }} />
      </View>
      <Text style={{ color: col, fontSize: 9, fontWeight: '700', width: 36, textAlign: 'right' }}>{value.toFixed(2)}</Text>
    </View>
  );
}

function HorizonTable({ horizons, bestHorizon, T }: { horizons: any[]; bestHorizon: any; T: any }) {
  return (
    <View style={{ borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: T.border, marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', backgroundColor: T.bg3, paddingHorizontal: 8, paddingVertical: 5 }}>
        {['Horizon', 'Return', 'Trades', 'WR %'].map(h => (
          <Text key={h} style={{ flex: 1, color: T.textDim, fontSize: 9, fontWeight: '700', textAlign: 'center' }}>{h}</Text>
        ))}
      </View>
      {horizons.map(h => {
        const isBest = bestHorizon?.horizon === h.horizon;
        return (
          <View key={h.horizon} style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 5, backgroundColor: isBest ? T.green + '12' : 'transparent', borderTopWidth: 0.5, borderTopColor: T.border + '40' }}>
            <Text style={{ flex: 1, color: isBest ? T.green : T.text, fontSize: 10, fontWeight: isBest ? '700' : '400', textAlign: 'center' }}>{h.horizon}b {isBest ? '★' : ''}</Text>
            <Text style={{ flex: 1, color: h.metrics.totalReturnPct >= 0 ? T.green : T.red, fontSize: 10, fontWeight: '700', textAlign: 'center' }}>{h.metrics.totalReturnPct >= 0 ? '+' : ''}{h.metrics.totalReturnPct.toFixed(1)}%</Text>
            <Text style={{ flex: 1, color: T.textSub, fontSize: 10, textAlign: 'center' }}>{h.metrics.numTrades}</Text>
            <Text style={{ flex: 1, color: T.textSub, fontSize: 10, textAlign: 'center' }}>{h.metrics.winRate.toFixed(1)}</Text>
          </View>
        );
      })}
    </View>
  );
}

function ModelComparisonTable({ models, ensembleHelps, T }: { models: any[]; ensembleHelps: any; T: any }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: T.border }}>
        <View style={{ flexDirection: 'row', backgroundColor: T.bg3, paddingHorizontal: 8, paddingVertical: 5 }}>
          {['Model', 'Return', 'PF', 'WR%'].map(h => (
            <Text key={h} style={{ flex: 1, color: T.textDim, fontSize: 9, fontWeight: '700', textAlign: 'center' }}>{h}</Text>
          ))}
        </View>
        {models.map((m: any) => (
          <View key={m.modelName} style={{ flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 5, borderTopWidth: 0.5, borderTopColor: T.border + '40' }}>
            <Text style={{ flex: 1, color: T.text, fontSize: 10, textAlign: 'center' }}>{m.modelName}</Text>
            <Text style={{ flex: 1, color: m.metrics.totalReturnPct >= 0 ? T.green : T.red, fontSize: 10, fontWeight: '700', textAlign: 'center' }}>{m.metrics.totalReturnPct >= 0 ? '+' : ''}{m.metrics.totalReturnPct.toFixed(1)}%</Text>
            <Text style={{ flex: 1, color: T.textSub, fontSize: 10, textAlign: 'center' }}>{m.metrics.profitFactor === Infinity ? '∞' : m.metrics.profitFactor.toFixed(2)}</Text>
            <Text style={{ flex: 1, color: T.textSub, fontSize: 10, textAlign: 'center' }}>{m.metrics.winRate.toFixed(1)}</Text>
          </View>
        ))}
      </View>
      <Text style={{ color: ensembleHelps.helps ? T.green : T.amber, fontSize: 9, marginTop: 5, fontStyle: 'italic' }}>{ensembleHelps.reasoning}</Text>
    </View>
  );
}

function BaselineCards({ baselines, modelReturn, T }: { baselines: any[]; modelReturn: number; T: any }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
      {baselines.map((b: any) => {
        const beats = modelReturn > b.metrics.totalReturnPct;
        return (
          <View key={b.name} style={{ backgroundColor: T.bg3, borderRadius: 8, padding: 8, minWidth: 90, flex: 1, borderLeftWidth: 3, borderLeftColor: beats ? T.green + '80' : T.red + '80' }}>
            <Text style={{ color: T.textDim, fontSize: 8, marginBottom: 2 }}>{b.name}</Text>
            <Text style={{ color: beats ? T.green : T.red, fontSize: 11, fontWeight: '700' }}>{b.metrics.totalReturnPct >= 0 ? '+' : ''}{b.metrics.totalReturnPct.toFixed(1)}%</Text>
            <Text style={{ color: T.textDim, fontSize: 8 }}>{b.metrics.numTrades}tr · {b.metrics.winRate.toFixed(0)}%wr</Text>
          </View>
        );
      })}
    </View>
  );
}

function FeaturesToRemove({ features }: { features: string[] }) {
  const { theme: T } = useTheme();
  const [expanded, setExpanded] = useState(false);
  if (!features.length) return <Text style={{ color: T.textDim, fontSize: 10 }}>None flagged</Text>;
  const visible = expanded ? features : features.slice(0, 10);
  return (
    <View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
        {visible.map((f: string) => (
          <View key={f} style={{ backgroundColor: T.amber + '22', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
            <Text style={{ color: T.amber, fontSize: 9 }}>{f}</Text>
          </View>
        ))}
      </View>
      {features.length > 10 && (
        <TouchableOpacity onPress={() => setExpanded(!expanded)} style={{ marginTop: 6 }}>
          <Text style={{ color: T.accent, fontSize: 10 }}>{expanded ? 'Show less ↑' : `+ ${features.length - 10} more`}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function StepList({ task }: { task: EvalTask }) {
  const { theme: T } = useTheme();
  return (
    <View style={{ marginTop: 6 }}>
      {task.steps.map(step => {
        const icon = step.status === 'done' ? '✓' : step.status === 'active' ? '⟳' : step.status === 'error' ? '✗' : '·';
        const color = step.status === 'done' ? T.green : step.status === 'active' ? T.accent : step.status === 'error' ? T.red : T.textDim;
        return (
          <View key={step.key} style={{ flexDirection: 'row', gap: 6, marginBottom: 3, alignItems: 'flex-start' }}>
            <Text style={{ color, fontSize: 11, fontWeight: '700', width: 14 }}>{icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: step.status === 'pending' ? T.textDim : T.text, fontSize: 10 }}>{step.label}</Text>
              {step.detail ? <Text style={{ color: T.textDim, fontSize: 9 }}>{step.detail}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function TaskProgressCard({ task }: { task: EvalTask }) {
  const { theme: T } = useTheme();
  const { cancelTask } = useEvalTasks();
  // Step-based progress: each combo has fetch + eval steps.
  // This gives real intermediate progress (e.g. 50% when fetch done on 1 combo).
  const doneSteps = task.steps.filter(s => s.status === 'done' || s.status === 'error').length;
  const activeSteps = task.steps.filter(s => s.status === 'active').length;
  const totalSteps = task.steps.length;
  // Count active steps as half-done for smoother progress
  const pct = totalSteps > 0
    ? Math.min(99, Math.round(((doneSteps + activeSteps * 0.5) / totalSteps) * 100))
    : task.total > 0 ? Math.round((task.completed / task.total) * 100) : 0;
  const statusColor = task.status === 'completed' ? T.green : task.status === 'failed' ? T.red : task.status === 'cancelled' ? T.textDim : task.status === 'interrupted' ? T.amber : T.accent;
  const statusLabel = task.status === 'completed' ? '✓ Completed' : task.status === 'failed' ? '✗ Failed' : task.status === 'cancelled' ? '⚪ Cancelled' : task.status === 'interrupted' ? '⚠ Interrupted' : `Running… ${pct}%`;
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => { if (task.status !== 'running') return; const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, [task.status]);
  const elapsedMs = task.status === 'running' && task.startedAt ? now - task.startedAt : task.elapsedMs;
  const handleCancel = useCallback(() => {
    Alert.alert(`Cancel ${task.type === 'evaluation' ? 'Production Evaluation' : 'Optimizer'}?`, 'Progress will be lost.',
      [{ text: 'Keep Running', style: 'cancel' }, { text: 'Cancel Task', style: 'destructive', onPress: () => cancelTask(task.id) }]);
  }, [task.id, task.type, cancelTask]);
  return (
    <Card theme={T} style={{ marginTop: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <Text style={{ color: statusColor, fontSize: 12, fontWeight: '700' }}>{statusLabel}</Text>
        {task.status === 'running' && <TouchableOpacity onPress={handleCancel}><Text style={{ color: T.textDim, fontSize: 11 }}>Cancel</Text></TouchableOpacity>}
      </View>
      <View style={{ height: 5, backgroundColor: T.bg3, borderRadius: 3, overflow: 'hidden', marginBottom: 6 }}>
        <View style={{ height: 5, width: `${pct}%`, backgroundColor: statusColor, borderRadius: 3 }} />
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
        <Text style={{ color: T.textDim, fontSize: 10 }}>{task.completed}/{task.total}</Text>
        <Text style={{ color: T.textDim, fontSize: 10 }}>Elapsed: {formatMs(elapsedMs)}</Text>
        <Text style={{ color: T.textDim, fontSize: 10 }}>ETA: {(() => {
          if (task.etaMs != null && task.completed > 0) return `~${formatMs(task.etaMs)}`;
          // Estimate from step progress when no combo has completed yet
          if (pct > 0 && pct < 100 && task.startedAt) {
            const elapsed = Date.now() - task.startedAt;
            const remaining = Math.round(elapsed * (100 - pct) / pct);
            return `~${formatMs(remaining)}`;
          }
          return '—';
        })()}</Text>
      </View>
      <StepList task={task} />
      {task.skipped.length > 0 && <View style={{ marginTop: 8 }}>{task.skipped.map((s, i) => <Text key={i} style={{ color: T.amber, fontSize: 9 }}>{s}</Text>)}</View>}
      {task.error && <Text style={{ color: T.red, fontSize: 10, marginTop: 6 }}>{task.error}</Text>}
    </Card>
  );
}

// Custom comparator: only re-render when the result's data content actually changes.
// During a running evaluation, setTasks fires every tick with a new object reference
// but identical result data — this prevents those spurious re-renders.
// Each ProductionEvalResult is created once inside evaluateProductionModel() and
// never mutated after being pushed into evalResults[]. Reference equality is
// therefore both safe and complete — any change produces a new object reference,
// and identical results share the same reference across setTasks ticks.
function evalResultEqual(prev: { r: any }, next: { r: any }) {
  return prev.r === next.r;
}
const EvalResultCard = memo(function EvalResultCard({ r }: { r: any }) {
  const { theme: T } = useTheme();
  const [featExpanded, setFeatExpanded] = useState(false);
  const topFeatures = useMemo(() => r.featureContribution?.entries.slice(0, 5) ?? [], [r.featureContribution?.entries]);
  const bottomFeatures = useMemo(() => r.featureContribution?.entries.slice(-3) ?? [], [r.featureContribution?.entries]);
  const maxDrop = useMemo(() => Math.max(...(r.featureContribution?.entries ?? []).map((e: any) => Math.abs(e.baselineAccDrop)), 1), [r.featureContribution?.entries]);
  return (
    <Card theme={T} style={{ marginTop: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <View>
          <Text style={{ color: T.text, fontSize: 14, fontWeight: '800' }}>{r.symbol} · {r.timeframe}</Text>
          <Text style={{ color: T.textDim, fontSize: 10 }}>{r.candleCount} bars</Text>
        </View>
        <View style={{ backgroundColor: r.beatsAllBaselines ? T.green + '22' : T.red + '22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 }}>
          <Text style={{ color: r.beatsAllBaselines ? T.green : T.red, fontSize: 10, fontWeight: '800' }}>{r.beatsAllBaselines ? '✓ Beats all' : '✗ Below baselines'}</Text>
        </View>
      </View>
      <View style={{ backgroundColor: T.bg3, borderRadius: 10, padding: 12, marginBottom: 10 }}>
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>STEP 1 · CURRENT CONFIG (Horizon=3, LONG + SHORT)</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.textDim, fontSize: 9 }}>Return</Text>
            <Text style={{ color: r.primaryMetrics.totalReturnPct >= 0 ? T.green : T.red, fontSize: 18, fontWeight: '800' }}>{r.primaryMetrics.totalReturnPct >= 0 ? '+' : ''}{r.primaryMetrics.totalReturnPct.toFixed(2)}%</Text>
          </View>
          <View style={{ flex: 1 }}>
            <MetricRow label="Trades" value={String(r.primaryMetrics.numTrades)} T={T} />
            <MetricRow label="Win Rate" value={`${r.primaryMetrics.winRate.toFixed(1)}%`} color={r.primaryMetrics.winRate >= 50 ? T.green : T.red} T={T} />
            <MetricRow label="Profit Factor" value={r.primaryMetrics.profitFactor === Infinity ? '∞' : r.primaryMetrics.profitFactor?.toFixed(2) ?? '—'} T={T} />
            <MetricRow label="Max DD" value={`${r.primaryMetrics.maxDrawdownPct?.toFixed(1) ?? '—'}%`} color={T.red} T={T} />
          </View>
        </View>
      </View>
      <View style={{ marginBottom: 10 }}>
        <View style={{ backgroundColor: T.amber + '18', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 6, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: T.amber, fontSize: 9, fontWeight: '800' }}>STEP 2 · HORIZON COMPARISON</Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>LONG only</Text>
        </View>
        <HorizonTable horizons={r.horizons} bestHorizon={r.bestHorizon} T={T} />
        {r.bestHorizon && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: T.green + '10', borderRadius: 8, padding: 8 }}>
            <View style={{ backgroundColor: T.green, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 }}>
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{r.bestHorizon.horizon}b</Text>
            </View>
            <View>
              <Text style={{ color: T.green, fontSize: 10, fontWeight: '700' }}>Best horizon</Text>
              <Text style={{ color: T.textDim, fontSize: 9 }}>{r.bestHorizon.metrics.totalReturnPct >= 0 ? '+' : ''}{r.bestHorizon.metrics.totalReturnPct.toFixed(1)}% · {r.bestHorizon.metrics.numTrades} trades</Text>
            </View>
          </View>
        )}
      </View>
      <View style={{ marginBottom: 10 }}>
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>STEP 3 · MODEL COMPARISON</Text>
        <ModelComparisonTable models={r.modelComparison} ensembleHelps={r.ensembleHelps} T={T} />
      </View>
      {r.strategyEval && (
        <StrategyEvalSection result={r.strategyEval} T={T} />
      )}
      {r.regimeEval && (
        <RegimeEvalSection result={r.regimeEval} T={T} />
      )}
      {r.featureContribution && (
        <View style={{ marginBottom: 10 }}>
          <TouchableOpacity onPress={() => setFeatExpanded(!featExpanded)} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 }}>FEATURE IMPORTANCE</Text>
            <Text style={{ color: T.accent, fontSize: 9 }}>{featExpanded ? 'Collapse ↑' : 'Expand ↓'}</Text>
          </TouchableOpacity>
          <Text style={{ color: T.green, fontSize: 9, marginBottom: 4 }}>Top contributors</Text>
          {topFeatures.map((e: any) => <FeatureBar key={e.name} name={e.name} value={e.baselineAccDrop} max={maxDrop} positive={true} T={T} />)}
          {featExpanded && (<>
            <Text style={{ color: T.textDim, fontSize: 9, marginTop: 4, marginBottom: 4 }}>Low impact</Text>
            {bottomFeatures.map((e: any) => <FeatureBar key={e.name} name={e.name} value={e.baselineAccDrop} max={maxDrop} positive={false} T={T} />)}
          </>)}
        </View>
      )}
      <View>
        <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>BASELINES</Text>
        <BaselineCards baselines={r.baselines} modelReturn={r.primaryMetrics.totalReturnPct} T={T} />
      </View>
    </Card>
  );
}, evalResultEqual)

const OptimResultCard = memo(function OptimResultCard({ c }: { c: any }) {
  const { theme: T } = useTheme();
  return (
    <Card theme={T} style={{ marginTop: 10 }}>
      <SectionLabel theme={T}>{c.symbol} · {c.timeframe} — OPTIMIZED PARAMETERS</SectionLabel>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10 }}>
        <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: 8, padding: 8 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>BASELINE</Text>
          <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>{c.defaultExecEvidence?.returnPct?.toFixed(2) ?? '—'}%</Text>
          <MetricRow label="PF" value={c.defaultExecEvidence?.profitFactor === Infinity ? '∞' : c.defaultExecEvidence?.profitFactor?.toFixed(2) ?? '—'} T={T} />
          <MetricRow label="WR" value={`${c.defaultExecEvidence?.winRate?.toFixed(1) ?? '—'}%`} T={T} />
        </View>
        <View style={{ flex: 1, backgroundColor: T.green + '10', borderRadius: 8, padding: 8 }}>
          <Text style={{ color: T.green, fontSize: 9, fontWeight: '700', marginBottom: 4 }}>OPTIMIZED</Text>
          <Text style={{ color: T.green, fontSize: 13, fontWeight: '700' }}>{c.bestExecEvidence?.returnPct?.toFixed(2) ?? '—'}%</Text>
          <MetricRow label="PF" value={c.bestExecEvidence?.profitFactor === Infinity ? '∞' : c.bestExecEvidence?.profitFactor?.toFixed(2) ?? '—'} T={T} />
          <MetricRow label="WR" value={`${c.bestExecEvidence?.winRate?.toFixed(1) ?? '—'}%`} T={T} />
        </View>
      </View>
      <View style={{ backgroundColor: c.generalizationPassed ? T.green + '10' : T.amber + '10', borderRadius: 8, padding: 8, marginBottom: 10 }}>
        <Text style={{ color: c.generalizationPassed ? T.green : T.amber, fontSize: 10, fontWeight: '700' }}>{c.generalizationPassed ? '✓ Generalization passed' : '⚠ Using defaults'}</Text>
        <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>{c.generalizationNote}</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: c.paramChanges?.length ? 10 : 0 }}>
        {[
          { label: `${c.bestHorizon}b horizon`, color: T.accent },
          { label: `thresh ${c.bestThreshold}`, color: T.accent },
          ...(c.bestExecParams ? [
            { label: `SL ${c.bestExecParams.atrStopMultiplier}×ATR`, color: T.red },
            { label: `TP ${c.bestExecParams.atrTargetMultiplier}×ATR`, color: T.green },
            { label: `RR ${(c.bestExecParams.atrTargetMultiplier / c.bestExecParams.atrStopMultiplier).toFixed(2)}`, color: T.text },
          ] : []),
        ].map(tag => (
          <View key={tag.label} style={{ backgroundColor: T.bg3, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 }}>
            <Text style={{ color: tag.color, fontSize: 10, fontWeight: '700' }}>{tag.label}</Text>
          </View>
        ))}
      </View>
      {c.paramChanges?.length > 0 && (
        <View>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 }}>WHY EACH PARAMETER CHANGED</Text>
          {c.paramChanges.map((ch: any, i: number) => (
            <View key={i} style={{ marginBottom: 6, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: T.accent + '60' }}>
              <Text style={{ color: T.text, fontSize: 10, fontWeight: '700' }}>{ch.param}: {ch.from} → {ch.to}</Text>
              <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 13 }}>{ch.reason}</Text>
            </View>
          ))}
        </View>
      )}
    </Card>
  );
});

// ── Strategy evaluation UI components ────────────────────────────────────────

function StrategyComparisonTable({ result, T }: { result: StrategyEvalResult; T: any }) {
  const { comparison } = result;
  const highlights: Record<string, string[]> = {};
  if (comparison.bestOverall)         (highlights[comparison.bestOverall.strategyId]         ||= []).push('★ Best Overall');
  if (comparison.highestProfitFactor) (highlights[comparison.highestProfitFactor.strategyId] ||= []).push('↑ PF');
  if (comparison.highestWinRate)      (highlights[comparison.highestWinRate.strategyId]       ||= []).push('↑ WR');
  if (comparison.lowestDrawdown)      (highlights[comparison.lowestDrawdown.strategyId]       ||= []).push('↓ DD');
  if (comparison.bestRiskAdjusted)    (highlights[comparison.bestRiskAdjusted.strategyId]     ||= []).push('↑ Sharpe');
  if (comparison.highestExpectancy)   (highlights[comparison.highestExpectancy.strategyId]    ||= []).push('↑ EXP');

  return (
    <View style={{ marginBottom: 10 }}>
      {/* Comparison table */}
      <View style={{ borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: T.border }}>
        <View style={{ flexDirection: 'row', backgroundColor: T.bg3, paddingHorizontal: 6, paddingVertical: 5 }}>
          {['Strategy', 'Return', 'PF', 'WR%', 'Trades'].map(h => (
            <Text key={h} style={{ flex: 1, color: T.textDim, fontSize: 9, fontWeight: '700', textAlign: 'center' }}>{h}</Text>
          ))}
        </View>
        {comparison.rankings.map((e: StrategyEvalEntry) => {
          const isBest = comparison.bestOverall?.strategyId === e.strategyId;
          const tags = highlights[e.strategyId] ?? [];
          return (
            <View key={e.strategyId}
              style={{ borderTopWidth: 0.5, borderTopColor: T.border + '40', backgroundColor: isBest ? T.green + '10' : 'transparent' }}>
              <View style={{ flexDirection: 'row', paddingHorizontal: 6, paddingVertical: 5 }}>
                <Text style={{ flex: 1, color: isBest ? T.green : T.text, fontSize: 10, fontWeight: isBest ? '700' : '400', textAlign: 'center' }}>
                  {e.strategyIcon} {e.strategyName}
                </Text>
                <Text style={{ flex: 1, color: e.metrics.totalReturnPct >= 0 ? T.green : T.red, fontSize: 10, fontWeight: '700', textAlign: 'center' }}>
                  {e.metrics.totalReturnPct >= 0 ? '+' : ''}{e.metrics.totalReturnPct.toFixed(1)}%
                </Text>
                <Text style={{ flex: 1, color: T.textSub, fontSize: 10, textAlign: 'center' }}>
                  {e.metrics.profitFactor === Infinity ? '∞' : e.metrics.profitFactor.toFixed(2)}
                </Text>
                <Text style={{ flex: 1, color: e.metrics.winRate >= 50 ? T.green : T.red, fontSize: 10, textAlign: 'center' }}>
                  {e.metrics.winRate.toFixed(1)}
                </Text>
                <Text style={{ flex: 1, color: T.textSub, fontSize: 10, textAlign: 'center' }}>{e.metrics.numTrades}</Text>
              </View>
              {tags.length > 0 && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 6, paddingBottom: 4, gap: 4 }}>
                  {tags.map(tag => (
                    <View key={tag} style={{ backgroundColor: T.green + '25', borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1 }}>
                      <Text style={{ color: T.green, fontSize: 8, fontWeight: '700' }}>{tag}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })}
      </View>

      {/* Recommendations */}
      {comparison.recommendations.length > 0 && (
        <View style={{ marginTop: 8 }}>
          {comparison.recommendations.map((rec, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 5, marginBottom: 4 }}>
              <Text style={{ color: T.accent, fontSize: 10 }}>•</Text>
              <Text style={{ color: T.textSub, fontSize: 10, flex: 1, lineHeight: 14 }}>{rec}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function HorizonByStrategyTable({ result, T }: { result: StrategyEvalResult; T: any }) {
  return (
    <View>
      {result.entries.map(e => (
        <View key={e.strategyId} style={{ marginBottom: 10 }}>
          <Text style={{ color: T.textSub, fontSize: 10, fontWeight: '700', marginBottom: 4 }}>
            {e.strategyIcon} {e.strategyName}
          </Text>
          <View style={{ borderRadius: 6, overflow: 'hidden', borderWidth: 1, borderColor: T.border }}>
            <View style={{ flexDirection: 'row', backgroundColor: T.bg3, paddingHorizontal: 6, paddingVertical: 4 }}>
              {['H', 'Return', 'WR%', 'PF'].map(h => (
                <Text key={h} style={{ flex: 1, color: T.textDim, fontSize: 9, fontWeight: '700', textAlign: 'center' }}>{h}</Text>
              ))}
            </View>
            {e.horizons.map(h => {
              const isBest = e.bestHorizon?.horizon === h.horizon;
              return (
                <View key={h.horizon} style={{ flexDirection: 'row', paddingHorizontal: 6, paddingVertical: 4, borderTopWidth: 0.5, borderTopColor: T.border + '40', backgroundColor: isBest ? T.green + '10' : 'transparent' }}>
                  <Text style={{ flex: 1, color: isBest ? T.green : T.text, fontSize: 10, fontWeight: isBest ? '700' : '400', textAlign: 'center' }}>
                    H{h.horizon}{isBest ? ' ★' : ''}
                  </Text>
                  <Text style={{ flex: 1, color: h.metrics.totalReturnPct >= 0 ? T.green : T.red, fontSize: 10, textAlign: 'center' }}>
                    {h.metrics.totalReturnPct >= 0 ? '+' : ''}{h.metrics.totalReturnPct.toFixed(1)}%
                  </Text>
                  <Text style={{ flex: 1, color: T.textSub, fontSize: 10, textAlign: 'center' }}>
                    {h.metrics.winRate.toFixed(1)}
                  </Text>
                  <Text style={{ flex: 1, color: T.textSub, fontSize: 10, textAlign: 'center' }}>
                    {h.metrics.profitFactor === Infinity ? '∞' : h.metrics.profitFactor.toFixed(2)}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

function StrategyEvalSection({ result, T }: { result: StrategyEvalResult; T: any }) {
  const [expanded, setExpanded] = useState(true);
  const [horizonExpanded, setHorizonExpanded] = useState(false);
  const modeLabel = result.mode === 'ALL' ? `All ${result.evaluated.length} Strategies` : result.evaluated[0] ?? 'Selected';
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ backgroundColor: T.purple + '18', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: T.purple, fontSize: 9, fontWeight: '800' }}>STEP 4 · STRATEGY EVALUATION</Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>{modeLabel}</Text>
        </View>
        <TouchableOpacity onPress={() => setExpanded(!expanded)}>
          <Text style={{ color: T.accent, fontSize: 9 }}>{expanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>
      </View>
      {expanded && (
        <>
          <StrategyComparisonTable result={result} T={T} />
          <TouchableOpacity onPress={() => setHorizonExpanded(!horizonExpanded)}
            style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6, marginTop: 4 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 }}>HORIZON × STRATEGY BREAKDOWN</Text>
            <Text style={{ color: T.accent, fontSize: 9 }}>{horizonExpanded ? 'Collapse ↑' : 'Expand ↓'}</Text>
          </TouchableOpacity>
          {horizonExpanded && <HorizonByStrategyTable result={result} T={T} />}
        </>
      )}
    </View>
  );
}

// ── Regime evaluation UI components ──────────────────────────────────────────

function RegimeMetricsRows({ metrics, T }: { metrics: any; T: any }) {
  const pfColor = metrics.profitFactor > 1.5 ? T.green : metrics.profitFactor >= 1 ? T.textSub : T.red;
  const wrColor = metrics.winRate >= 55 ? T.green : metrics.winRate >= 45 ? T.textSub : T.red;
  return (
    <View style={{ gap: 1 }}>
      <MetricRow label="Win Rate"      value={`${metrics.winRate.toFixed(1)}%`}     color={wrColor} T={T} />
      <MetricRow label="Profit Factor" value={metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)} color={pfColor} T={T} />
      <MetricRow label="Return"        value={`${metrics.totalReturnPct >= 0 ? '+' : ''}${metrics.totalReturnPct.toFixed(2)}%`} color={metrics.totalReturnPct >= 0 ? T.green : T.red} T={T} />
      <MetricRow label="Avg Return"    value={`${metrics.avgTrade >= 0 ? '+' : ''}${metrics.avgTrade.toFixed(2)}`} T={T} />
      <MetricRow label="Expectancy"    value={`${metrics.expectancy >= 0 ? '+' : ''}${metrics.expectancy.toFixed(2)}`} T={T} />
      <MetricRow label="Max DD"        value={`${metrics.maxDrawdownPct.toFixed(1)}%`} color={T.red} T={T} />
      <MetricRow label="Sharpe"        value={metrics.sharpeRatio.toFixed(2)} T={T} />
      <MetricRow label="Avg Hold"      value={`${metrics.avgHoldingBars.toFixed(1)} bars`} T={T} />
    </View>
  );
}

function RegimeDrillDown({ breakdown, T }: { breakdown: RegimeBreakdown; T: any }) {
  const [tab, setTab] = React.useState<'model' | 'horizon' | 'strategy'>('model');
  const modelTabs: Array<'model' | 'horizon' | 'strategy'> = ['model', 'horizon', 'strategy'];
  const tabLabels = { model: 'Model', horizon: 'Horizon', strategy: 'Strategy' };

  const renderRow = (label: string, metrics: any, highlight?: boolean) => {
    const pfColor = metrics.profitFactor > 1.5 ? T.green : metrics.profitFactor >= 1 ? T.textSub : T.red;
    return (
      <View key={label} style={{ flexDirection: 'row', paddingVertical: 4, borderTopWidth: 0.5, borderTopColor: T.border + '40', backgroundColor: highlight ? T.green + '10' : 'transparent' }}>
        <Text style={{ flex: 2, color: highlight ? T.green : T.text, fontSize: 9, paddingLeft: 4 }}>{highlight ? '★ ' : ''}{label}</Text>
        <Text style={{ flex: 1, color: metrics.totalReturnPct >= 0 ? T.green : T.red, fontSize: 9, textAlign: 'center' }}>{metrics.totalReturnPct >= 0 ? '+' : ''}{metrics.totalReturnPct.toFixed(1)}%</Text>
        <Text style={{ flex: 1, color: pfColor, fontSize: 9, textAlign: 'center' }}>{metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}</Text>
        <Text style={{ flex: 1, color: metrics.winRate >= 50 ? T.green : T.red, fontSize: 9, textAlign: 'center' }}>{metrics.winRate.toFixed(1)}</Text>
        <Text style={{ flex: 1, color: T.textDim, fontSize: 9, textAlign: 'center' }}>{metrics.numTrades}</Text>
      </View>
    );
  };

  return (
    <View style={{ marginTop: 8 }}>
      <View style={{ flexDirection: 'row', gap: 4, marginBottom: 6 }}>
        {modelTabs.map(t => (
          <TouchableOpacity key={t} onPress={() => setTab(t)}
            style={{ flex: 1, backgroundColor: tab === t ? T.purple + '33' : T.bg3, borderRadius: 5, padding: 5, alignItems: 'center' }}>
            <Text style={{ color: tab === t ? T.purple : T.textDim, fontSize: 9, fontWeight: '700' }}>{tabLabels[t]}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ borderRadius: 6, overflow: 'hidden', borderWidth: 1, borderColor: T.border }}>
        <View style={{ flexDirection: 'row', backgroundColor: T.bg3, paddingVertical: 4 }}>
          {['Name', 'Return', 'PF', 'WR%', 'Tr'].map(h => (
            <Text key={h} style={{ flex: h === 'Name' ? 2 : 1, color: T.textDim, fontSize: 8, fontWeight: '700', textAlign: 'center' }}>{h}</Text>
          ))}
        </View>
        {tab === 'model' && breakdown.byModel.filter(m => m.metrics.numTrades > 0).map((m, i, arr) => {
          const best = arr.reduce((b, e) => e.metrics.profitFactor > b.metrics.profitFactor ? e : b);
          return renderRow(m.modelName, m.metrics, m.modelName === best.modelName && best.metrics.numTrades >= 3);
        })}
        {tab === 'horizon' && breakdown.byHorizon.filter(h => h.metrics.numTrades > 0).map((h, i, arr) => {
          const best = arr.reduce((b, e) => e.metrics.profitFactor > b.metrics.profitFactor ? e : b);
          return renderRow(`H${h.horizon}`, h.metrics, h.horizon === best.horizon && best.metrics.numTrades >= 3);
        })}
        {tab === 'strategy' && breakdown.byStrategy.filter(s => s.metrics.numTrades > 0).map((s, i, arr) => {
          const best = arr.reduce((b, e) => e.metrics.profitFactor > b.metrics.profitFactor ? e : b);
          return renderRow(`${s.strategyIcon} ${s.strategyName}`, s.metrics, s.strategyId === best.strategyId && best.metrics.numTrades >= 3);
        })}
        {tab === 'model'    && breakdown.byModel.filter(m => m.metrics.numTrades > 0).length === 0 && (
          <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', padding: 8 }}>No trades in this regime</Text>
        )}
        {tab === 'horizon'  && breakdown.byHorizon.filter(h => h.metrics.numTrades > 0).length === 0 && (
          <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', padding: 8 }}>No trades in this regime</Text>
        )}
        {tab === 'strategy' && breakdown.byStrategy.filter(s => s.metrics.numTrades > 0).length === 0 && (
          <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', padding: 8 }}>No trades in this regime</Text>
        )}
      </View>
    </View>
  );
}

function RegimeCard({ breakdown, isBest, isWorst, T }: { breakdown: RegimeBreakdown; isBest: boolean; isWorst: boolean; T: any }) {
  const [expanded, setExpanded] = React.useState(false);
  const noTrades = breakdown.metrics.numTrades === 0;
  const borderColor = isBest ? T.green : isWorst ? T.red : T.border;
  return (
    <View style={{ borderRadius: 8, borderWidth: isBest || isWorst ? 1.5 : 0.5, borderColor, backgroundColor: T.bg3, padding: 10, marginBottom: 6 }}>
      <TouchableOpacity onPress={() => !noTrades && setExpanded(!expanded)}
        style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 16 }}>{breakdown.emoji}</Text>
          <View>
            <Text style={{ color: isBest ? T.green : isWorst ? T.red : T.text, fontSize: 11, fontWeight: '700' }}>
              {breakdown.displayName}
              {isBest ? ' ★' : isWorst ? ' ✗' : ''}
            </Text>
            <Text style={{ color: T.textDim, fontSize: 9 }}>
              {noTrades ? 'No trades' : `${breakdown.metrics.numTrades} trades · ${breakdown.barCount} bars`}
            </Text>
          </View>
        </View>
        {!noTrades && (
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: breakdown.metrics.totalReturnPct >= 0 ? T.green : T.red, fontSize: 13, fontWeight: '800' }}>
              {breakdown.metrics.totalReturnPct >= 0 ? '+' : ''}{breakdown.metrics.totalReturnPct.toFixed(1)}%
            </Text>
            <Text style={{ color: T.textDim, fontSize: 9 }}>{expanded ? '▲' : '▼'}</Text>
          </View>
        )}
      </TouchableOpacity>
      {expanded && !noTrades && (
        <View style={{ marginTop: 8 }}>
          <RegimeMetricsRows metrics={breakdown.metrics} T={T} />
          <RegimeDrillDown breakdown={breakdown} T={T} />
        </View>
      )}
    </View>
  );
}

function RegimeComparisonTable({ result, T }: { result: RegimeEvalResult; T: any }) {
  const { comparison } = result;
  const withTrades = result.breakdowns.filter(b => b.metrics.numTrades > 0);
  return (
    <View style={{ marginBottom: 8 }}>
      <View style={{ borderRadius: 8, overflow: 'hidden', borderWidth: 1, borderColor: T.border, marginBottom: 8 }}>
        <View style={{ flexDirection: 'row', backgroundColor: T.bg3, paddingHorizontal: 6, paddingVertical: 5 }}>
          {['Regime', 'Return', 'PF', 'WR%', 'Tr'].map(h => (
            <Text key={h} style={{ flex: h === 'Regime' ? 2 : 1, color: T.textDim, fontSize: 8, fontWeight: '700', textAlign: 'center' }}>{h}</Text>
          ))}
        </View>
        {withTrades.map(b => {
          const isBest  = comparison.bestOverall?.regime === b.regime;
          const isWorst = comparison.worstOverall?.regime === b.regime && comparison.worstOverall !== comparison.bestOverall;
          return (
            <View key={b.regime} style={{ flexDirection: 'row', paddingHorizontal: 6, paddingVertical: 5, borderTopWidth: 0.5, borderTopColor: T.border + '40', backgroundColor: isBest ? T.green + '10' : isWorst ? T.red + '08' : 'transparent' }}>
              <Text style={{ flex: 2, color: isBest ? T.green : isWorst ? T.red : T.text, fontSize: 9, fontWeight: isBest ? '700' : '400' }}>{b.emoji} {b.displayName}</Text>
              <Text style={{ flex: 1, color: b.metrics.totalReturnPct >= 0 ? T.green : T.red, fontSize: 9, fontWeight: '700', textAlign: 'center' }}>{b.metrics.totalReturnPct >= 0 ? '+' : ''}{b.metrics.totalReturnPct.toFixed(1)}%</Text>
              <Text style={{ flex: 1, color: T.textSub, fontSize: 9, textAlign: 'center' }}>{b.metrics.profitFactor === Infinity ? '∞' : b.metrics.profitFactor.toFixed(2)}</Text>
              <Text style={{ flex: 1, color: b.metrics.winRate >= 50 ? T.green : T.red, fontSize: 9, textAlign: 'center' }}>{b.metrics.winRate.toFixed(1)}</Text>
              <Text style={{ flex: 1, color: T.textDim, fontSize: 9, textAlign: 'center' }}>{b.metrics.numTrades}</Text>
            </View>
          );
        })}
        {withTrades.length === 0 && (
          <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', padding: 12 }}>No trades to show by regime</Text>
        )}
      </View>

      {comparison.recommendations.map((rec, i) => (
        <View key={i} style={{ flexDirection: 'row', gap: 5, marginBottom: 4 }}>
          <Text style={{ color: T.purple, fontSize: 10 }}>•</Text>
          <Text style={{ color: T.textSub, fontSize: 10, flex: 1, lineHeight: 14 }}>{rec}</Text>
        </View>
      ))}
    </View>
  );
}

function RegimeEvalSection({ result, T }: { result: RegimeEvalResult; T: any }) {
  const [expanded, setExpanded] = React.useState(true);
  const [cardsExpanded, setCardsExpanded] = React.useState(false);
  const withTrades = result.breakdowns.filter(b => b.metrics.numTrades > 0);
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={{ backgroundColor: T.amber + '18', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: T.amber, fontSize: 9, fontWeight: '800' }}>STEP 5 · MARKET REGIME EVALUATION</Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>{withTrades.length} active regimes</Text>
        </View>
        <TouchableOpacity onPress={() => setExpanded(!expanded)}>
          <Text style={{ color: T.accent, fontSize: 9 }}>{expanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>
      </View>
      {expanded && (
        <>
          <RegimeComparisonTable result={result} T={T} />
          <TouchableOpacity onPress={() => setCardsExpanded(!cardsExpanded)}
            style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6, marginTop: 4 }}>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5 }}>DETAILED REGIME CARDS</Text>
            <Text style={{ color: T.accent, fontSize: 9 }}>{cardsExpanded ? 'Collapse ↑' : 'Expand ↓'}</Text>
          </TouchableOpacity>
          {cardsExpanded && withTrades.map(b => (
            <RegimeCard
              key={b.regime}
              breakdown={b}
              isBest={result.comparison.bestOverall?.regime === b.regime}
              isWorst={result.comparison.worstOverall?.regime === b.regime && result.comparison.worstOverall !== result.comparison.bestOverall}
              T={T}
            />
          ))}
        </>
      )}
    </View>
  );
}

function toggleValue(arr: string[], val: string): string[] { return arr.includes(val) ? arr.filter(v => v !== val) : [...arr, val]; }

export default function ProductionEvaluationScreen() {
  const { theme: T } = useTheme();
  const { allAssets, aoSession, avKey } = useData();
  const { tasks, startEvaluation, startOptimization, cancelTask } = useEvalTasks();
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>([]);
  const [selectedTf, setSelectedTf] = useState<string[]>(['1h']);
  const [strategyMode, setStrategyMode] = useState<'ALL' | 'SELECTED'>('ALL');
  // Defer rendering heavy result sections until after initial paint
  const [resultsVisible, setResultsVisible] = useState(false);
  useEffect(() => {
    const handle = InteractionManager.runAfterInteractions(() => setResultsVisible(true));
    return () => handle.cancel();
  }, []);

  const combos: ComboSpec[] = useMemo(() => {
    const assets = allAssets.filter(a => selectedSymbols.includes(a.symbol));
    return assets.flatMap(a => selectedTf.map(tf => ({ asset: a, tf })));
  }, [allAssets, selectedSymbols, selectedTf]);

  const evalId = combos.length ? `evaluation__${combos.map(c => `${c.asset.symbol}_${c.tf}`).sort().join('|')}` : null;
  const optimId = combos.length ? `optimization__${combos.map(c => `${c.asset.symbol}_${c.tf}`).sort().join('|')}` : null;
  const evalTask = evalId ? tasks[evalId] : null;
  const optimTask = optimId ? tasks[optimId] : null;
  // For progress display: find any actively running eval/optim task,
  // even if the user changed symbol/TF selection after starting.
  const anyRunningEval = useMemo(() =>
    Object.values(tasks).find(t => t.type === 'evaluation' && t.status === 'running') ?? evalTask,
    [tasks, evalTask]);
  const anyRunningOptim = useMemo(() =>
    Object.values(tasks).find(t => t.type === 'optimization' && t.status === 'running') ?? optimTask,
    [tasks, optimTask]);
  const evalRunning = !!(anyRunningEval?.status === 'running');
  const optimRunning = !!(anyRunningOptim?.status === 'running');

  const runningRef = useRef({ eval: false, optim: false });
  runningRef.current = { eval: evalRunning, optim: optimRunning };

  useFocusEffect(useCallback(() => {
    return () => {
      if (runningRef.current.eval) notifyRunningInBackground('evaluation');
      else if (runningRef.current.optim) notifyRunningInBackground('optimization');
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []));

  // Recommendations: only generated when evaluation is fully complete.
  // If computed from partial results (while still running), it would show
  // "not ready" based on incomplete data — misleading during computation.
  const recommendations = useMemo(
    () => evalTask?.status === 'completed' && evalTask.evalResults.length
      ? generateRecommendations(evalTask.evalResults)
      : null,
    [evalTask?.status, evalTask?.evalResults]
  );

  const handleToggleTf = useCallback((val: string) => setSelectedTf(prev => toggleValue(prev, val)), []);
  const handleRunEval = useCallback(() => {
    if (!combos.length) return;
    if (evalRunning) { Alert.alert('Already Running', 'Production Evaluation is already running.'); return; }
    startEvaluation(combos, { aoSession, avKey }, strategyMode);
  }, [combos, evalRunning, startEvaluation, aoSession, avKey, strategyMode]);
  const handleRunOptim = useCallback(() => {
    if (!combos.length) return;
    if (optimRunning) { Alert.alert('Already Running', 'Optimizer is already running.'); return; }
    startOptimization(combos, { aoSession, avKey });
  }, [combos, optimRunning, startOptimization, aoSession, avKey]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 2 }}>Model Evaluation</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16, lineHeight: 16 }}>
          {FEATURE_COUNT}-feature pipeline · regime breakdown · horizon sweep · threshold scan · feature importance · baseline comparison
        </Text>
        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>SYMBOLS</Text>
        <MultiSymbolSelector allAssets={allAssets} selected={selectedSymbols} onChange={setSelectedSymbols} theme={T} />
        <Text style={{ color: T.textDim, fontSize: 10, marginTop: 14, marginBottom: 6 }}>TIMEFRAMES</Text>
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
          {TIMEFRAMES.map(t => <Pill key={t} label={t} color={T.purple} active={selectedTf.includes(t)} onPress={() => handleToggleTf(t)} />)}
        </View>
        <Text style={{ color: T.textDim, fontSize: 10, marginTop: 4, marginBottom: 6 }}>STRATEGY EVALUATION MODE</Text>
        <View style={{ flexDirection: 'row', gap: 6, marginBottom: 14 }}>
          <TouchableOpacity
            onPress={() => setStrategyMode('ALL')}
            style={{ flex: 1, backgroundColor: strategyMode === 'ALL' ? T.purple : T.bg3, borderRadius: 8, padding: 10, alignItems: 'center' }}>
            <Text style={{ color: strategyMode === 'ALL' ? '#fff' : T.textDim, fontSize: 11, fontWeight: '700' }}>All Strategies</Text>
            <Text style={{ color: strategyMode === 'ALL' ? '#ffffffaa' : T.textDim, fontSize: 9, marginTop: 2 }}>
              {STRATEGY_ORDER.map(p => p.icon + ' ' + p.name).join(' · ')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setStrategyMode('SELECTED')}
            style={{ flex: 1, backgroundColor: strategyMode === 'SELECTED' ? T.purple : T.bg3, borderRadius: 8, padding: 10, alignItems: 'center' }}>
            <Text style={{ color: strategyMode === 'SELECTED' ? '#fff' : T.textDim, fontSize: 11, fontWeight: '700' }}>Selected Only</Text>
            <Text style={{ color: strategyMode === 'SELECTED' ? '#ffffffaa' : T.textDim, fontSize: 9, marginTop: 2 }}>Faster — active strategy only</Text>
          </TouchableOpacity>
        </View>
        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 10 }}>
          {selectedSymbols.length} symbol{selectedSymbols.length !== 1 ? 's' : ''} × {selectedTf.length} tf = {combos.length} test{combos.length !== 1 ? 's' : ''}
        </Text>
        <View style={{ backgroundColor: T.bg3, borderRadius: 10, padding: 12, marginBottom: 12 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>3 SEPARATE SIMULATIONS</Text>
          {[
            ['STEP 1', 'Current config (Horizon=3)', 'LONG + SHORT, same as live paper trading'],
            ['STEP 2', 'Horizon comparison', 'Retrains 5× with different horizons. LONG only for consistent ranking.'],
            ['STEP 3', 'Execution optimizer', 'Takes best horizon from Step 2 and optimises SL/TP/holding.'],
          ].map(([step, title, desc], i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 8, marginBottom: i < 2 ? 8 : 0 }}>
              <View style={{ backgroundColor: T.accent + '30', borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, alignSelf: 'flex-start' }}>
                <Text style={{ color: T.accent, fontSize: 8, fontWeight: '800' }}>{step}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.text, fontSize: 10, fontWeight: '700' }}>{title}</Text>
                <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 13, marginTop: 1 }}>{desc}</Text>
              </View>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
        <TouchableOpacity onPress={handleRunEval} disabled={!combos.length} activeOpacity={0.65}
          style={{ flex: 1, backgroundColor: evalRunning ? T.accent + 'aa' : T.accent, padding: 14, borderRadius: RADIUS.md, alignItems: 'center', opacity: !combos.length ? 0.4 : 1 }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>
            {evalRunning
              ? (() => { const t = anyRunningEval; if (!t) return 'Running… 0%'; const ds = t.steps.filter((s:any) => s.status==='done'||s.status==='error').length; const as2 = t.steps.filter((s:any) => s.status==='active').length; const ts = t.steps.length; const p = ts > 0 ? Math.min(99, Math.round(((ds + as2*0.5)/ts)*100)) : t.total > 0 ? Math.round((t.completed/t.total)*100) : 0; return `Running… ${p}%`; })()
              : `RUN EVALUATION (${combos.length} combination${combos.length !== 1 ? 's' : ''})`}
          </Text>
        </TouchableOpacity>
        {evalRunning && anyRunningEval && (
          <TouchableOpacity onPress={() => cancelTask(anyRunningEval.id)} activeOpacity={0.7}
            style={{ backgroundColor: T.red + 'cc', paddingHorizontal: 16, borderRadius: RADIUS.md, justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>✕</Text>
          </TouchableOpacity>
        )}
        </View>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
        <TouchableOpacity onPress={handleRunOptim} disabled={!combos.length} activeOpacity={0.65}
          style={{ flex: 1, backgroundColor: optimRunning ? T.purple + 'aa' : T.purple, padding: 14, borderRadius: RADIUS.md, alignItems: 'center', opacity: !combos.length ? 0.4 : 1 }}>
          <Text style={{ color: '#fff', fontWeight: '700' }}>
            {optimRunning
              ? (() => { const t = anyRunningOptim; if (!t) return 'Optimizing… 0%'; const ds = t.steps.filter((s:any) => s.status==='done'||s.status==='error').length; const as2 = t.steps.filter((s:any) => s.status==='active').length; const ts = t.steps.length; const p = ts > 0 ? Math.min(99, Math.round(((ds + as2*0.5)/ts)*100)) : t.total > 0 ? Math.round((t.completed/t.total)*100) : 0; return `Optimizing… ${p}%`; })()
              : 'OPTIMIZE HORIZON & THRESHOLD'}
          </Text>
        </TouchableOpacity>
        {optimRunning && anyRunningOptim && (
          <TouchableOpacity onPress={() => cancelTask(anyRunningOptim.id)} activeOpacity={0.7}
            style={{ backgroundColor: T.red + 'cc', paddingHorizontal: 16, borderRadius: RADIUS.md, justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>✕</Text>
          </TouchableOpacity>
        )}
        </View>
        <Text style={{ color: T.textDim, fontSize: 9, marginTop: 6, lineHeight: 13 }}>Tasks run in the background — navigate away freely.</Text>
        {evalTask && <TaskProgressCard task={evalTask} />}
        {evalTask?.status === 'running' && evalTask.evalResults.length > 0 && (
          <Card theme={T} style={{ marginTop: 14 }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>
              RECOMMENDATIONS
            </Text>
            <Text style={{ color: T.amber, fontSize: 11, fontStyle: 'italic' }}>
              Computing… recommendations will appear when all evaluations complete.
            </Text>
          </Card>
        )}
        {optimTask && optimId !== evalId && <TaskProgressCard task={optimTask} />}
        {resultsVisible && (optimTask?.optResults ?? []).map((c: any) => <OptimResultCard key={`${c.symbol}-${c.timeframe}`} c={c} />)}
        {resultsVisible && (evalTask?.evalResults ?? []).map((r: any) => <EvalResultCard key={r.symbol + r.timeframe} r={r} />)}
        {resultsVisible && recommendations && evalTask?.status === 'completed' && (
          <Card theme={T} style={{ marginTop: 14, borderColor: recommendations.readyForPaperTrading ? T.green + '50' : T.amber + '50' }}>
            <SectionLabel theme={T}>RECOMMENDATIONS</SectionLabel>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: 8, padding: 8 }}>
                <Text style={{ color: T.textDim, fontSize: 9 }}>Recommended horizon</Text>
                <Text style={{ color: T.text, fontSize: 14, fontWeight: '800', marginTop: 2 }}>{recommendations.recommendedHorizon ?? '—'}</Text>
              </View>
              <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: 8, padding: 8 }}>
                <Text style={{ color: T.textDim, fontSize: 9 }}>Recommended threshold</Text>
                <Text style={{ color: T.text, fontSize: 14, fontWeight: '800', marginTop: 2 }}>{recommendations.recommendedThreshold ?? '—'}</Text>
              </View>
            </View>
            <View style={{ backgroundColor: recommendations.readyForPaperTrading ? T.green + '15' : T.red + '15', borderRadius: 10, padding: 12, marginBottom: 12 }}>
              <Text style={{ color: recommendations.readyForPaperTrading ? T.green : T.red, fontWeight: '800', fontSize: 13 }}>
                {recommendations.readyForPaperTrading ? '✓ Cautiously consistent with paper trading readiness' : '✗ Not yet ready for paper trading'}
              </Text>
            </View>
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>REASONING</Text>
            {recommendations.reasoning.map((r: string, i: number) => (
              <View key={i} style={{ flexDirection: 'row', gap: 6, marginBottom: 5 }}>
                <Text style={{ color: T.accent, fontSize: 10 }}>•</Text>
                <Text style={{ color: T.textSub, fontSize: 10, flex: 1, lineHeight: 15 }}>{r}</Text>
              </View>
            ))}
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginTop: 8, marginBottom: 6 }}>FEATURES TO CONSIDER REMOVING</Text>
            <FeaturesToRemove features={recommendations.featuresToConsiderRemoving} />
          </Card>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
