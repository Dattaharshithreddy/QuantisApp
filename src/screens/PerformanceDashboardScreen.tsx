// ─────────────────────────────────────────────────────────────────────────────
// PerformanceDashboardScreen  (v1.0.0)
//
// System latency dashboard — not trading performance, system performance.
// Shows mean/p50/p95 for each measured operation so bottlenecks are visible.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import {
  getAllMetricStats, clearMetrics, MetricStats, MetricLabel,
} from '../utils/performanceMetrics';
import { SPACING } from '../theme/colors';

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatMs(ms: number): string {
  if (ms === 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function latencyColor(ms: number, T: any): string {
  if (ms === 0)   return T.textDim;
  if (ms < 100)   return T.green;
  if (ms < 500)   return T.amber;
  if (ms < 2000)  return T.orange ?? T.amber;
  return T.red;
}

const LABEL_DISPLAY: Record<MetricLabel, { name: string; desc: string; target: number }> = {
  prediction:       { name: 'ML Prediction',     desc: 'Feature engineering → BUY/SELL/HOLD',   target: 200  },
  signal_gates:     { name: 'Signal Gates',       desc: 'evaluateSignalGates() execution',         target: 20   },
  order_submission: { name: 'Order Submission',   desc: 'placeLiveOrder() → broker response',      target: 1000 },
  broker_ack:       { name: 'Broker ACK',         desc: 'Submitted → acknowledged by broker',      target: 500  },
  fill_time:        { name: 'Fill Time',           desc: 'Acknowledged → order fully filled',       target: 2000 },
  reconciliation:   { name: 'Reconciliation',     desc: 'Full broker position sync',               target: 3000 },
  paper_trade:      { name: 'Paper Trade',         desc: 'Paper order open (no broker)',            target: 50   },
  candle_load:      { name: 'Candle Load',         desc: 'Cache miss → data fetched → rendered',   target: 2000 },
  market_context:   { name: 'Market Context',      desc: 'fetchUnifiedMarketContext()',             target: 1500 },
};

// ── Latency bar ───────────────────────────────────────────────────────────────
function LatencyBar({ ms, target, T }: { ms: number; target: number; T: any }) {
  const pct = Math.min(100, (ms / (target * 3)) * 100);
  const color = latencyColor(ms, T);
  return (
    <View style={{ height: 4, backgroundColor: T.border, borderRadius: 2, marginTop: 6 }}>
      <View style={{ height: 4, width: `${pct}%`, backgroundColor: color, borderRadius: 2 }} />
    </View>
  );
}

// ── Metric Card ───────────────────────────────────────────────────────────────
function MetricCard({ stats, T }: { stats: MetricStats; T: any }) {
  const info     = LABEL_DISPLAY[stats.label];
  const overTarget = stats.p95Ms > info.target;
  const meanColor = latencyColor(stats.meanMs, T);

  return (
    <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
      marginBottom: 10, borderWidth: 1, borderColor: T.border,
      borderLeftWidth: 3,
      borderLeftColor: overTarget ? T.amber : T.green }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between',
        alignItems: 'flex-start', marginBottom: 4 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>
            {info.name}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>
            {info.desc}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ color: meanColor, fontSize: 18, fontWeight: '800' }}>
            {formatMs(stats.meanMs)}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>mean</Text>
        </View>
      </View>

      <LatencyBar ms={stats.meanMs} target={info.target} T={T} />

      <View style={{ flexDirection: 'row', justifyContent: 'space-between',
        marginTop: 10 }}>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: latencyColor(stats.p50Ms, T), fontSize: 11, fontWeight: '600' }}>
            {formatMs(stats.p50Ms)}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>p50</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: latencyColor(stats.p95Ms, T), fontSize: 11, fontWeight: '600' }}>
            {formatMs(stats.p95Ms)}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>p95</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: latencyColor(stats.p99Ms, T), fontSize: 11, fontWeight: '600' }}>
            {formatMs(stats.p99Ms)}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>p99</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 11 }}>{formatMs(stats.minMs)}</Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>min</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: latencyColor(stats.maxMs, T), fontSize: 11 }}>
            {formatMs(stats.maxMs)}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>max</Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 11 }}>{stats.count}</Text>
          <Text style={{ color: T.textDim, fontSize: 8 }}>samples</Text>
        </View>
      </View>

      {overTarget && (
        <View style={{ backgroundColor: T.amber + '15', borderRadius: 6,
          padding: 6, marginTop: 8 }}>
          <Text style={{ color: T.amber, fontSize: 9 }}>
            ⚠ p95 ({formatMs(stats.p95Ms)}) exceeds target ({formatMs(info.target)})
          </Text>
        </View>
      )}
    </View>
  );
}

// ── Main Screen ───────────────────────────────────────────────────────────────
export default function PerformanceDashboardScreen() {
  const { theme: T }  = useTheme();
  const [stats,   setStats]   = useState<MetricStats[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const s = await getAllMetricStats();
    setStats(s);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleClear() {
    Alert.alert('Clear Metrics', 'Reset all performance measurements?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => {
        await clearMetrics();
        await load();
      }},
    ]);
  }

  const warnings = stats.filter(s => {
    const info = LABEL_DISPLAY[s.label];
    return s.p95Ms > info.target;
  });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}
>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: 4 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>
            Performance
          </Text>
          {stats.length > 0 && (
            <TouchableOpacity onPress={handleClear}
              style={{ backgroundColor: T.bg3, borderRadius: 6,
                paddingHorizontal: 10, paddingVertical: 6 }}>
              <Text style={{ color: T.textDim, fontSize: 10 }}>Clear</Text>
            </TouchableOpacity>
          )}
        </View>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16, lineHeight: 16 }}>
          System latency for key operations. Green = within target · Amber = above target · Red = investigate.
        </Text>

        {warnings.length > 0 && (
          <View style={{ backgroundColor: T.amber + '15', borderRadius: 10,
            padding: 12, marginBottom: 14, borderWidth: 1, borderColor: T.amber + '40' }}>
            <Text style={{ color: T.amber, fontSize: 10, fontWeight: '700', marginBottom: 4 }}>
              ⚠ {warnings.length} operation{warnings.length !== 1 ? 's' : ''} above target
            </Text>
            <Text style={{ color: T.textDim, fontSize: 9 }}>
              {warnings.map(s => LABEL_DISPLAY[s.label].name).join(', ')}
            </Text>
          </View>
        )}

        {!loading && stats.length === 0 && (
          <View style={{ alignItems: 'center', paddingTop: 40 }}>
            <Text style={{ color: T.textDim, fontSize: 14 }}>No measurements yet</Text>
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 6,
              textAlign: 'center', lineHeight: 16, paddingHorizontal: 20 }}>
              Performance data is collected automatically as you use the app.
              Use the chart screen, run predictions, and place paper trades to
              populate this dashboard.
            </Text>
          </View>
        )}

        {stats.map(s => <MetricCard key={s.label} stats={s} T={T} />)}
      </ScrollView>
    </SafeAreaView>
  );
}
