// ─────────────────────────────────────────────────────────────────────────────
// HealthDashboardScreen  (v1.0.0)
//
// Hidden diagnostics screen for the developer. Shows real-time system state:
// broker connections, WebSocket health, open/ghost/pending positions,
// last reconciliation, and API error counts.
//
// Accessible via: MoreMenu → Audit Trail → long-press header (3 sec).
// Or via: MoreMenu → Health Dashboard (visible in dev builds).
//
// Not shown to end users. Every field is a real live read — no mocked values.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { getLivePortfolio } from '../utils/livePortfolio';
import { getOrderLog } from '../utils/liveOrderLifecycle';
import { getReconciliationLog } from '../utils/liveReconciliation';
import { getLiveTradingCredential } from '../utils/secureCredentials';
import { logger } from '../utils/logger';
import { getCrashSummary, clearCrashReports } from '../utils/crashReporter';
import { SPACING } from '../theme/colors';

type StatusLevel = 'ok' | 'warn' | 'error' | 'unknown';

function StatusRow({ label, value, level, sub, T }: {
  label: string; value: string; level?: StatusLevel; sub?: string; T: any
}) {
  const color = level === 'ok'    ? T.green
              : level === 'warn'  ? T.amber
              : level === 'error' ? T.red
              : T.textDim;
  return (
    <View style={{ paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ color: T.textDim, fontSize: 11 }}>{label}</Text>
        <Text style={{ color, fontSize: 11, fontWeight: '700' }}>{value}</Text>
      </View>
      {sub ? <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>{sub}</Text> : null}
    </View>
  );
}

function Section({ title, children, T }: any) {
  return (
    <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
      borderWidth: 1, borderColor: T.border, marginBottom: 14 }}>
      <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '800',
        letterSpacing: 1, marginBottom: 6 }}>{title}</Text>
      {children}
    </View>
  );
}

function formatAgo(ts: number): string {
  if (!ts) return 'never';
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5)  return 'just now';
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
  return `${Math.floor(sec/3600)}h ago`;
}

export default function HealthDashboardScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const { aoSession, wsStatus, prices } = useData();

  const [loading,        setLoading]        = useState(true);
  const [openPositions,  setOpenPositions]  = useState(0);
  const [totalRealizedPnL, setTotalRealizedPnL] = useState(0);
  const [pendingOrders,  setPendingOrders]  = useState(0);
  const [lastReconAt,    setLastReconAt]    = useState(0);
  const [lastReconGhosts, setLastReconGhosts] = useState(0);
  const [lastReconErrors, setLastReconErrors] = useState(0);
  const [reconRunCount,  setReconRunCount]  = useState(0);
  const [bnConnected,    setBnConnected]    = useState(false);
  const [logErrors,      setLogErrors]      = useState(0);
  const [priceCount,     setPriceCount]     = useState(0);
  const [crashCount,     setCrashCount]     = useState(0);
  const [lastCrashAt,    setLastCrashAt]    = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [portfolio, orderLog, reconLog] = await Promise.all([
        getLivePortfolio(),
        getOrderLog(),
        getReconciliationLog(),
      ]);

      setOpenPositions(portfolio.openPositions.length);
      setTotalRealizedPnL(portfolio.totalRealizedPnL);

      const pending = orderLog.filter(o =>
        !['CLOSED','CANCELLED','REJECTED','FAILED'].includes(o.state)
      ).length;
      setPendingOrders(pending);

      if (reconLog.length > 0) {
        const last = reconLog[0];
        setLastReconAt(last.ranAt);
        setLastReconGhosts(last.ghosts?.length ?? 0);
        setLastReconErrors(last.errors?.length ?? 0);
      }
      setReconRunCount(reconLog.length);

      // Check Binance connection
      const bnKey = await getLiveTradingCredential('binanceApiKey');
      setBnConnected(!!bnKey);

      // Count error logs
      const logs = logger.getRecent(200) ?? [];
      const errs = logs.filter((l: any) => l.level === 'error').length;
      setLogErrors(errs);

      setPriceCount(Object.keys(prices).length);

      // Crash reports
      const crash = await getCrashSummary();
      setCrashCount(crash.count);
      setLastCrashAt(crash.last?.capturedAt ?? null);
    } finally {
      setLoading(false);
    }
  }, [prices]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 5s
  useEffect(() => {
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const wsLevel: StatusLevel = wsStatus === 'live' ? 'ok' : wsStatus === 'connecting' ? 'warn' : 'error';
  const aoLevel: StatusLevel = aoSession?.jwtToken ? 'ok' : 'error';
  const bnLevel: StatusLevel = bnConnected ? 'ok' : 'warn';
  const reconLevel: StatusLevel = lastReconErrors > 0 ? 'error'
    : lastReconGhosts > 0 ? 'warn' : lastReconAt > 0 ? 'ok' : 'unknown';
  const posLevel: StatusLevel = pendingOrders > 0 ? 'warn' : 'ok';

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}
>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: 6 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Health Dashboard</Text>
          <View style={{ backgroundColor: T.red+'20', borderRadius: 5,
            paddingHorizontal: 8, paddingVertical: 4, borderWidth: 1, borderColor: T.red }}>
            <Text style={{ color: T.red, fontSize: 9, fontWeight: '800' }}>DEV ONLY</Text>
          </View>
        </View>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>
          Live system state. Auto-refreshes every 5 seconds.
        </Text>

        {/* Broker Connections */}
        <Section title="BROKER CONNECTIONS" T={T}>
          <StatusRow label="Angel One SmartAPI" level={aoLevel}
            value={aoLevel === 'ok' ? '✅ Connected' : '❌ Not connected'}
            sub={aoSession?.clientCode ? `Client: ${aoSession.clientCode}` : undefined} T={T} />
          <StatusRow label="Binance API Keys" level={bnLevel}
            value={bnLevel === 'ok' ? '✅ Configured' : '⚠ Not configured'}
            sub={bnLevel !== 'ok' ? 'Add keys in Broker Connection screen' : undefined} T={T} />
        </Section>

        {/* Data Feed */}
        <Section title="DATA FEED" T={T}>
          <StatusRow label="WebSocket"
            level={wsLevel}
            value={wsStatus === 'live' ? '✅ Live' : wsStatus === 'connecting' ? '⚠ Connecting' : wsStatus === 'reconnecting' ? '⚠ Reconnecting' : '❌ Error'}
            T={T} />
          <StatusRow label="Live Prices"
            level={priceCount > 0 ? 'ok' : 'warn'}
            value={`${priceCount} symbols`} T={T} />
        </Section>

        {/* Live Positions */}
        <Section title="LIVE POSITIONS" T={T}>
          <StatusRow label="Open Positions"
            level={openPositions > 0 ? 'warn' : 'ok'}
            value={String(openPositions)} T={T} />
          <StatusRow label="Pending Orders (not FILLED)"
            level={posLevel}
            value={pendingOrders > 0 ? `⚠ ${pendingOrders}` : '0'}
            sub={pendingOrders > 0 ? 'Check Audit Trail for details' : undefined} T={T} />
          <StatusRow label="Realised P&L (all time)"
            level={totalRealizedPnL >= 0 ? 'ok' : 'warn'}
            value={`${totalRealizedPnL >= 0 ? '+' : ''}${totalRealizedPnL.toFixed(2)}`} T={T} />
        </Section>

        {/* Reconciliation */}
        <Section title="RECONCILIATION" T={T}>
          <StatusRow label="Last Run" level={reconLevel}
            value={lastReconAt > 0 ? formatAgo(lastReconAt) : 'Never'}
            sub={lastReconAt > 0 ? new Date(lastReconAt).toLocaleTimeString() : undefined} T={T} />
          <StatusRow label="Ghost Positions (last run)"
            level={lastReconGhosts > 0 ? 'error' : 'ok'}
            value={lastReconGhosts > 0 ? `⚠ ${lastReconGhosts} detected` : '0 (clean)'}
            sub={lastReconGhosts > 0 ? 'Positions closed externally — check Audit Trail' : undefined} T={T} />
          <StatusRow label="Errors (last run)"
            level={lastReconErrors > 0 ? 'error' : 'ok'}
            value={lastReconErrors > 0 ? `❌ ${lastReconErrors}` : '0'} T={T} />
          <StatusRow label="Total Runs" level="unknown"
            value={String(reconRunCount)} T={T} />
        </Section>

        {/* Error Log */}
        <Section title="ERROR LOG" T={T}>
          <StatusRow label="Errors in logger"
            level={logErrors > 0 ? 'warn' : 'ok'}
            value={logErrors > 0 ? `${logErrors} error(s)` : 'Clean'}
            sub={logErrors > 0 ? 'Check device console for details' : undefined} T={T} />
        </Section>

        {/* Crash Reports */}
        <Section title="CRASH REPORTS" T={T}>
          <StatusRow label="Total crashes captured"
            level={crashCount > 0 ? 'error' : 'ok'}
            value={crashCount > 0 ? `⚠ ${crashCount} crash(es)` : '0 (clean)'}
            sub={lastCrashAt ? `Last: ${new Date(lastCrashAt).toLocaleString()}` : undefined} T={T} />
          {crashCount > 0 && (
            <TouchableOpacity onPress={async () => {
              await clearCrashReports(); setCrashCount(0); setLastCrashAt(null);
            }} style={{ marginTop: 8, padding: 8, backgroundColor: T.red + '15',
              borderRadius: 6, alignItems: 'center', borderWidth: 1, borderColor: T.red + '40' }}>
              <Text style={{ color: T.red, fontSize: 10, fontWeight: '700' }}>
                Clear Crash Log
              </Text>
            </TouchableOpacity>
          )}
        </Section>

        <TouchableOpacity onPress={load}
          style={{ backgroundColor: T.accent, borderRadius: 8, padding: 12, alignItems: 'center' }}>
          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>Refresh Now</Text>
        </TouchableOpacity>

        <Text style={{ color: T.textDim, fontSize: 9, textAlign: 'center', marginTop: 14, lineHeight: 13 }}>
          This screen is for developer diagnostics only.{'\n'}
          Not shown to end users. Data is live — no mocked values.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
