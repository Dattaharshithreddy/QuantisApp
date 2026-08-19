// ─────────────────────────────────────────────────────────────────────────────
// OrderAuditScreen  (v1.0.0)
//
// Full event timeline for every live order. Shows the complete lifecycle
// history — every state transition with timestamp and reason — making
// production incident investigation straightforward.
//
// Also surfaces reconciliation log: every recon run, discrepancies found,
// duration, and errors.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { getOrderLog, LiveOrderRecord, LiveOrderState } from '../utils/liveOrderLifecycle';
import { getReconciliationLog } from '../utils/liveReconciliation';
import { SPACING, RADIUS } from '../theme/colors';

// ── Colour mapping for states ─────────────────────────────────────────────────
function stateColor(state: LiveOrderState, T: any): string {
  switch (state) {
    case 'CREATED':          return T.textDim;
    case 'SUBMITTED':        return T.accent;
    case 'ACKNOWLEDGED':     return T.blue ?? T.accent;
    case 'FILLED':           return T.green;
    case 'PARTIALLY_FILLED': return T.amber;
    case 'CLOSED':           return T.textSub ?? T.textDim;
    case 'CANCELLED':        return T.textDim;
    case 'REJECTED':         return T.red;
    case 'FAILED':           return T.red;
    default:                 return T.textDim;
  }
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms/1000).toFixed(1)}s`;
  return `${Math.floor(ms/60000)}m ${Math.floor((ms%60000)/1000)}s`;
}

// ── Order card with full timeline ─────────────────────────────────────────────
function OrderAuditCard({ order, T }: { order: LiveOrderRecord; T: any }) {
  const [expanded, setExpanded] = useState(false);
  const isLong   = order.direction === 'LONG';
  const color    = stateColor(order.state, T);
  const duration = order.filledAt ? order.filledAt - order.createdAt : Date.now() - order.createdAt;

  return (
    <TouchableOpacity
      onPress={() => setExpanded(e => !e)}
      style={{ backgroundColor: T.card, borderRadius: 10, padding: 14, marginBottom: 10,
        borderWidth: 1, borderColor: T.border, borderLeftWidth: 3, borderLeftColor: color }}>

      {/* Header row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ color: T.text, fontSize: 13, fontWeight: '800' }}>{order.symbol}</Text>
          <View style={{ backgroundColor: isLong ? T.green+'20' : T.red+'20',
            borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 }}>
            <Text style={{ color: isLong ? T.green : T.red, fontSize: 8, fontWeight: '700' }}>
              {isLong ? '▲ LONG' : '▼ SHORT'}
            </Text>
          </View>
        </View>
        <View style={{ backgroundColor: color + '20', borderRadius: 4,
          paddingHorizontal: 7, paddingVertical: 3 }}>
          <Text style={{ color, fontSize: 9, fontWeight: '800' }}>{order.state}</Text>
        </View>
      </View>

      {/* Summary row */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ color: T.textDim, fontSize: 9 }}>
          {order.broker} · {order.orderType} · {order.requestedQty} units
        </Text>
        <Text style={{ color: T.textDim, fontSize: 9 }}>{formatTs(order.createdAt)}</Text>
      </View>

      {/* Fill info if available */}
      {order.state === 'FILLED' || order.state === 'CLOSED' ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ color: T.textDim, fontSize: 9 }}>
            Filled: {order.filledQty} @ {order.filledPrice.toFixed(4)}
          </Text>
          <Text style={{ color: T.textDim, fontSize: 9 }}>
            Fill time: {formatDuration(duration)}
          </Text>
        </View>
      ) : null}

      {/* Closed P&L */}
      {order.state === 'CLOSED' && order.realizedPnL != null ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
          <Text style={{ color: T.textDim, fontSize: 9 }}>
            Closed by: {order.closedBy ?? '—'}
            {order.closedPrice ? ` @ ${order.closedPrice.toFixed(4)}` : ''}
          </Text>
          <Text style={{ color: order.realizedPnL >= 0 ? T.green : T.red, fontSize: 9, fontWeight: '700' }}>
            P&L: {order.realizedPnL >= 0 ? '+' : ''}{order.realizedPnL.toFixed(2)}
          </Text>
        </View>
      ) : null}

      {/* Client / broker IDs */}
      <Text style={{ color: T.textDim, fontSize: 8, fontFamily: 'monospace', marginBottom: expanded ? 10 : 0 }}>
        ID: {order.localId}
        {order.brokerOrderId ? ` · Broker: ${order.brokerOrderId}` : ''}
      </Text>

      {/* Expand/collapse */}
      <Text style={{ color: T.accent, fontSize: 9, textAlign: 'right' }}>
        {expanded ? '▲ Hide timeline' : '▼ Show timeline'}
      </Text>

      {/* Full event timeline */}
      {expanded && (
        <View style={{ marginTop: 12, borderTopWidth: 0.5,
          borderTopColor: T.border, paddingTop: 10 }}>
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
            letterSpacing: 0.8, marginBottom: 8 }}>EVENT TIMELINE</Text>
          {order.history.map((h, i) => (
            <View key={i} style={{ flexDirection: 'row', marginBottom: 6, alignItems: 'flex-start' }}>
              {/* Connector line */}
              <View style={{ alignItems: 'center', marginRight: 10, width: 16 }}>
                <View style={{ width: 8, height: 8, borderRadius: 4,
                  backgroundColor: stateColor(h.to, T), marginTop: 1 }} />
                {i < order.history.length - 1 && (
                  <View style={{ width: 1, flex: 1, backgroundColor: T.border, marginTop: 2, minHeight: 14 }} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: stateColor(h.to, T), fontSize: 10, fontWeight: '700' }}>
                    {h.to}
                  </Text>
                  <Text style={{ color: T.textDim, fontSize: 9 }}>
                    {new Date(h.at).toLocaleTimeString()}
                  </Text>
                </View>
                {h.reason ? (
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>{h.reason}</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── Reconciliation log card ────────────────────────────────────────────────────
function ReconCard({ run, T }: { run: any; T: any }) {
  const clean    = run.phantoms.length === 0 && run.ghosts.length === 0 && run.errors.length === 0;
  const color    = run.errors.length > 0 ? T.red : clean ? T.green : T.amber;

  return (
    <View style={{ backgroundColor: T.card, borderRadius: 8, padding: 12, marginBottom: 8,
      borderWidth: 1, borderColor: T.border, borderLeftWidth: 3, borderLeftColor: color }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ color, fontSize: 10, fontWeight: '700' }}>
          {clean ? '✓ Clean' : run.errors.length > 0 ? '✗ Error' : `⚠ ${run.ghosts.length}G ${run.phantoms.length}P`}
        </Text>
        <Text style={{ color: T.textDim, fontSize: 9 }}>
          {formatTs(run.ranAt)} · {run.durationMs}ms
        </Text>
      </View>
      <Text style={{ color: T.textDim, fontSize: 9 }}>
        {run.matched} matched
        {run.ghosts.length > 0 ? ` · Ghosts: ${run.ghosts.join(', ')}` : ''}
        {run.phantoms.length > 0 ? ` · Phantoms: ${run.phantoms.join(', ')}` : ''}
        {run.errors.length > 0 ? ` · Errors: ${run.errors[0]}` : ''}
      </Text>
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────────────────
export default function OrderAuditScreen() {
  const { theme: T } = useTheme();
  const [tab,      setTab]      = useState<'orders' | 'recon'>('orders');
  const [orders,   setOrders]   = useState<LiveOrderRecord[]>([]);
  const [reconLog, setReconLog] = useState<any[]>([]);
  const [loading,  setLoading]  = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [o, r] = await Promise.all([getOrderLog(), getReconciliationLog()]);
    setOrders(o);
    setReconLog(r);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}
>

        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Audit Trail</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>
          Complete event history for every live order and reconciliation run.
        </Text>

        {/* Tab selector */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {(['orders', 'recon'] as const).map(t => (
            <TouchableOpacity key={t} onPress={() => setTab(t)}
              style={{ flex: 1, backgroundColor: tab === t ? T.accent : T.bg3,
                borderRadius: RADIUS.sm, padding: 10, alignItems: 'center' }}>
              <Text style={{ color: tab === t ? '#fff' : T.textDim, fontSize: 11, fontWeight: '700' }}>
                {t === 'orders' ? `Orders (${orders.length})` : `Reconciliation (${reconLog.length})`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'orders' && (
          <>
            {orders.length === 0 && !loading && (
              <View style={{ alignItems: 'center', paddingTop: 40 }}>
                <Text style={{ color: T.textDim, fontSize: 13 }}>No live orders yet</Text>
              </View>
            )}
            {orders.map(o => <OrderAuditCard key={o.localId} order={o} T={T} />)}
          </>
        )}

        {tab === 'recon' && (
          <>
            {reconLog.length === 0 && !loading && (
              <View style={{ alignItems: 'center', paddingTop: 40 }}>
                <Text style={{ color: T.textDim, fontSize: 13 }}>No reconciliation runs yet</Text>
                <Text style={{ color: T.textDim, fontSize: 11, marginTop: 4, textAlign: 'center' }}>
                  Reconciliation runs every 15 seconds while the app is foregrounded and live positions are open.
                </Text>
              </View>
            )}
            {reconLog.map((r, i) => <ReconCard key={i} run={r} T={T} />)}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
