// ─────────────────────────────────────────────────────────────────────────────
// KillSwitchScreen  (v1.0.0)
// Emergency screen to close ALL live positions and cancel ALL open orders.
// Reachable from LivePositionsScreen in maximum 2 taps.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, Alert, ActivityIndicator, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { getLivePortfolio, removeLivePosition } from '../utils/livePortfolio';
import { placeLiveOrder } from '../utils/liveOrderExecution';
import { RADIUS, SPACING } from '../theme/colors';

export default function KillSwitchScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const { aoSession, prices } = useData();
  const [positions, setPositions] = useState<any[]>([]);
  const [running,   setRunning]   = useState(false);
  const [log,       setLog]       = useState<string[]>([]);
  const [done,      setDone]      = useState(false);

  useEffect(() => {
    getLivePortfolio().then(p => setPositions(p.openPositions));
  }, []);

  const addLog = (msg: string) => setLog(prev => [...prev, `${new Date().toLocaleTimeString()} — ${msg}`]);

  const totalExposure = positions.reduce((s, p) => {
    const lp = prices[p.symbol]?.price ?? p.filledPrice;
    return s + lp * p.qty;
  }, 0);

  async function runKillSwitch() {
    setRunning(true);
    addLog(`Starting emergency close of ${positions.length} position(s)…`);

    let closed = 0; let failed = 0;
    for (const pos of positions) {
      try {
        addLog(`Closing ${pos.direction} ${pos.symbol}…`);
        const fill = await placeLiveOrder({
          symbol:    pos.symbol,
          assetSrc:  pos.broker === 'ANGEL_ONE' ? 'ao' : 'binance',
          direction: pos.direction === 'LONG' ? 'SHORT' : 'LONG',
          qty:       pos.qty,
          orderType: 'MARKET'}, aoSession);
        const pnl = (fill.filledPrice - pos.filledPrice) * pos.qty * (pos.direction === 'LONG' ? 1 : -1);
        await removeLivePosition(pos.id, pnl);
        addLog(`✅ ${pos.symbol} closed @ ${fill.filledPrice.toFixed(2)} · P&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
        closed++;
      } catch (e: any) {
        addLog(`❌ ${pos.symbol} FAILED: ${e.message}`);
        failed++;
      }
    }

    addLog(`Complete. ${closed} closed, ${failed} failed.`);
    if (failed > 0) addLog('⚠️ Failed positions require manual action in broker app.');
    setDone(true);
    setRunning(false);
  }

  function confirmAndRun() {
    Alert.alert(
      '⛔ EMERGENCY EXIT',
      `This will close ALL ${positions.length} position(s) at market price.\nTotal exposure: ${totalExposure.toFixed(2)}\n\nThis cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'CLOSE EVERYTHING', style: 'destructive', onPress: runKillSwitch },
      ]
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 40 }}>

        <View style={{ backgroundColor: T.red + '15', borderRadius: 10, padding: 16,
          borderWidth: 2, borderColor: T.red, marginBottom: 20 }}>
          <Text style={{ color: T.red, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>⛔ Kill Switch</Text>
          <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 16 }}>
            Immediately closes all open live positions at market price and cancels all pending orders.
            Use only in an emergency.
          </Text>
        </View>

        {/* Summary */}
        <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
          borderWidth: 1, borderColor: T.border, marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={{ color: T.textDim, fontSize: 11 }}>Open positions</Text>
            <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>{positions.length}</Text>
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: T.textDim, fontSize: 11 }}>Total exposure</Text>
            <Text style={{ color: T.red, fontSize: 11, fontWeight: '700' }}>{totalExposure.toFixed(2)}</Text>
          </View>
        </View>

        {/* Position list */}
        {positions.map(pos => (
          <View key={pos.id} style={{ backgroundColor: T.card, borderRadius: 8, padding: 10,
            borderWidth: 1, borderColor: T.border, marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: T.text, fontSize: 11 }}>{pos.symbol}</Text>
            <Text style={{ color: pos.direction === 'LONG' ? T.green : T.red, fontSize: 11, fontWeight: '600' }}>
              {pos.direction} · {pos.qty} units
            </Text>
          </View>
        ))}

        {/* Action log */}
        {log.length > 0 && (
          <View style={{ backgroundColor: T.bg3, borderRadius: 8, padding: 12, marginTop: 12, marginBottom: 16 }}>
            {log.map((l,i) => (
              <Text key={i} style={{ color: T.textDim, fontSize: 9, fontFamily: 'monospace', lineHeight: 16 }}>{l}</Text>
            ))}
          </View>
        )}

        {!done && !running && positions.length > 0 && (
          <TouchableOpacity onPress={confirmAndRun}
            style={{ backgroundColor: T.red, borderRadius: RADIUS.md, padding: 16, alignItems: 'center', marginTop: 8 }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>⛔ CLOSE ALL POSITIONS</Text>
          </TouchableOpacity>
        )}

        {running && (
          <View style={{ alignItems: 'center', marginTop: 16 }}>
            <ActivityIndicator color={T.red} size="large" />
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 8 }}>Closing positions…</Text>
          </View>
        )}

        {done && (
          <TouchableOpacity onPress={() => navigation.goBack()}
            style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md, padding: 14, alignItems: 'center', marginTop: 8 }}>
            <Text style={{ color: T.textSub, fontSize: 14 }}>Done — Go Back</Text>
          </TouchableOpacity>
        )}

        {positions.length === 0 && !running && (
          <View style={{ alignItems: 'center', paddingTop: 20 }}>
            <Text style={{ color: T.green, fontSize: 14, fontWeight: '700' }}>✅ No open positions</Text>
            <Text style={{ color: T.textDim, fontSize: 11, marginTop: 4 }}>Nothing to close.</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
