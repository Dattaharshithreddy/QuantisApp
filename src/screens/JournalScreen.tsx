import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, SectionLabel, StatBox, PrimaryButton, Pill } from '../components/Common';
import { BottomSheet } from '../components/BottomSheet';
import { Trade, getTrades, addTrade, closeTrade, deleteTrade, computeStats, pnlOf } from '../utils/journal';
import { addToDailyPnL } from '../utils/riskManager';
import { ASSETS } from '../api/assets';
import { pFmt } from '../utils/indicators';

const DIRECTIONS = ['LONG', 'SHORT', 'BUY_CE', 'BUY_PE', 'SELL_CE', 'SELL_PE'];
const SETUP_TAGS = ['AI Signal', 'Breakout', 'Reversal', 'Trend Follow', 'Scalp', 'News Play'];

export default function JournalScreen() {
  const { theme: T } = useTheme();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [exitPrice, setExitPrice] = useState('');

  // New trade form
  const [symbol, setSymbol] = useState('NIFTY50');
  const [direction, setDirection] = useState<Trade['direction']>('LONG');
  const [entry, setEntry] = useState('');
  const [qty, setQty] = useState('');
  const [setupTag, setSetupTag] = useState('AI Signal');
  const [notes, setNotes] = useState('');

  const load = useCallback(() => { getTrades().then(setTrades); }, []);
  useEffect(() => { load(); }, [load]);

  const stats = computeStats(trades);

  async function handleAdd() {
    if (!entry || !qty) return;
    const updated = await addTrade({ symbol, direction, entry: parseFloat(entry), exit: null, qty: parseFloat(qty), setupTag, notes, closedAt: null });
    setTrades(updated);
    setShowAdd(false);
    setEntry(''); setQty(''); setNotes('');
  }

  async function handleClose(id: string) {
    if (!exitPrice) return;
    const trade = trades.find(t => t.id === id);
    const updated = await closeTrade(id, parseFloat(exitPrice));
    setTrades(updated);
    if (trade) {
      const pnl = pnlOf({ ...trade, exit: parseFloat(exitPrice) });
      await addToDailyPnL(pnl);
    }
    setClosingId(null); setExitPrice('');
  }

  async function handleDelete(id: string) {
    setTrades(await deleteTrade(id));
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Trade Journal</Text>
          <TouchableOpacity onPress={() => setShowAdd(true)} style={{ backgroundColor: T.accent, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>+ Add Trade</Text>
          </TouchableOpacity>
        </View>

        {/* Stats */}
        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>PERFORMANCE ANALYTICS</SectionLabel>
          <View style={{ flexDirection: 'row' }}>
            <StatBox theme={T} label="WIN RATE" value={`${stats.winRate.toFixed(0)}%`} color={stats.winRate >= 50 ? T.green : T.red} />
            <StatBox theme={T} label="PROFIT FACTOR" value={stats.profitFactor.toFixed(2)} color={stats.profitFactor >= 1.5 ? T.green : T.amber} />
            <StatBox theme={T} label="AVG R:R" value={stats.avgRR.toFixed(2)} />
          </View>
          <View style={{ flexDirection: 'row' }}>
            <StatBox theme={T} label="TOTAL P&L" value={`₹${stats.totalPnL.toFixed(0)}`} color={stats.totalPnL >= 0 ? T.green : T.red} />
            <StatBox theme={T} label="MAX DRAWDOWN" value={`₹${stats.maxDrawdown.toFixed(0)}`} color={T.red} />
            <StatBox theme={T} label="BEST SETUP" value={stats.bestSetup} color={T.teal} />
          </View>
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 6, textAlign: 'center' }}>{stats.closedTrades} closed · {stats.totalTrades - stats.closedTrades} open</Text>
        </Card>

        {/* Trade list */}
        <SectionLabel theme={T}>ALL TRADES</SectionLabel>
        {trades.length === 0 && <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', marginTop: 20 }}>No trades logged yet. Tap "+ Add Trade" to start tracking.</Text>}
        {trades.map(t => {
          const pnl = pnlOf(t);
          const isOpen = t.exit == null;
          return (
            <Card key={t.id} theme={T} style={{ marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{t.symbol}</Text>
                    <Pill label={t.direction} color={['LONG', 'BUY_CE', 'BUY_PE'].includes(t.direction) ? T.green : T.red} active />
                  </View>
                  <Text style={{ color: T.textDim, fontSize: 10, marginTop: 4 }}>{t.setupTag} · Entry ₹{pFmt(t.entry)} · Qty {t.qty}</Text>
                  {t.notes && <Text style={{ color: T.textSub, fontSize: 10, marginTop: 4 }}>{t.notes}</Text>}
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  {isOpen ? (
                    <Pill label="OPEN" color={T.amber} active onPress={() => setClosingId(t.id)} />
                  ) : (
                    <Text style={{ color: pnl >= 0 ? T.green : T.red, fontWeight: '800', fontSize: 14 }}>{pnl >= 0 ? '+' : ''}₹{pnl.toFixed(0)}</Text>
                  )}
                  <TouchableOpacity onPress={() => handleDelete(t.id)} style={{ marginTop: 8 }}>
                    <Text style={{ color: T.textDim, fontSize: 10 }}>Delete</Text>
                  </TouchableOpacity>
                </View>
              </View>
              {closingId === t.id && (
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  <TextInput
                    value={exitPrice} onChangeText={setExitPrice} placeholder="Exit price" placeholderTextColor={T.textDim}
                    keyboardType="numeric" style={{ flex: 1, backgroundColor: T.bg0, borderWidth: 1, borderColor: T.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 8, color: T.text, fontSize: 13 }}
                  />
                  <TouchableOpacity onPress={() => handleClose(t.id)} style={{ backgroundColor: T.green, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6 }}>
                    <Text style={{ color: '#fff', fontWeight: '700', fontSize: 11 }}>Close</Text>
                  </TouchableOpacity>
                </View>
              )}
            </Card>
          );
        })}
      </ScrollView>

      {/* Add Trade Modal */}
      <BottomSheet visible={showAdd} onClose={() => setShowAdd(false)} title="Log New Trade" theme={T}>
        <ScrollView>
          <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>SYMBOL</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {ASSETS.slice(0, 10).map(a => <Pill key={a.symbol} label={a.symbol} color={T.blue} active={symbol === a.symbol} onPress={() => setSymbol(a.symbol)} />)}
            </View>
          </ScrollView>

          <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>DIRECTION</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {DIRECTIONS.map(d => <Pill key={d} label={d} color={T.purple} active={direction === d} onPress={() => setDirection(d as any)} />)}
            </View>
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>ENTRY PRICE</Text>
              <TextInput value={entry} onChangeText={setEntry} keyboardType="numeric" style={inputStyle(T)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>QUANTITY</Text>
              <TextInput value={qty} onChangeText={setQty} keyboardType="numeric" style={inputStyle(T)} />
            </View>
          </View>

          <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>SETUP TAG</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {SETUP_TAGS.map(s => <Pill key={s} label={s} color={T.teal} active={setupTag === s} onPress={() => setSetupTag(s)} />)}
            </View>
          </ScrollView>

          <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>NOTES (optional)</Text>
          <TextInput value={notes} onChangeText={setNotes} multiline style={[inputStyle(T), { height: 60, marginBottom: 16 }]} />

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity onPress={() => setShowAdd(false)} style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: T.bg3, alignItems: 'center' }}>
              <Text style={{ color: T.textSub, fontWeight: '700' }}>Cancel</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }}><PrimaryButton theme={T} label="Save Trade" onPress={handleAdd} /></View>
          </View>
        </ScrollView>
      </BottomSheet>
    </SafeAreaView>
  );
}

function inputStyle(T: any) {
  return { backgroundColor: T.bg0, borderWidth: 1, borderColor: T.border, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, color: T.text, fontSize: 14 };
}
