import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, PrimaryButton, Pill } from '../components/Common';
import { BottomSheet } from '../components/BottomSheet';
import { PriceAlert, getAlerts, addAlert, deleteAlert, requestNotifPermission } from '../utils/alerts';
import { pFmt } from '../utils/indicators';

export default function AlertsScreen({ route, navigation }: any) {
  const { theme: T } = useTheme();
  const { prices, allAssets } = useData();
  const [alerts, setAlerts] = useState<PriceAlert[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [symbol, setSymbol] = useState('NIFTY50');
  const [condition, setCondition] = useState<'ABOVE' | 'BELOW'>('ABOVE');
  const [target, setTarget] = useState('');

  useEffect(() => {
    getAlerts().then(setAlerts);
    requestNotifPermission();
  }, []);

  // FIXED: previously the symbol picker here was a fixed list of 12 hardcoded
  // pills with no way to type or search for anything else — "not able to add
  // whatever I like" was a real, accurate bug report. This now shows every
  // asset you're tracking (built-in + anything from Symbol Search), and after
  // picking a new symbol via Search, jumps straight back here with the form
  // pre-filled and ready.
  useEffect(() => {
    const incoming = route?.params?.symbol;
    if (incoming) {
      setSymbol(incoming);
      setShowAdd(true);
    }
  }, [route?.params?.symbol]);

  // Refresh list every 5s to reflect triggered status live
  useEffect(() => {
    const t = setInterval(() => getAlerts().then(setAlerts), 5000);
    return () => clearInterval(t);
  }, []);

  async function handleAdd() {
    if (!target) return;
    const updated = await addAlert({ symbol, condition, targetPrice: parseFloat(target) });
    setAlerts(updated);
    setShowAdd(false); setTarget('');
  }
  async function handleDelete(id: string) { setAlerts(await deleteAlert(id)); }

  const active = alerts.filter(a => !a.triggered);
  const triggered = alerts.filter(a => a.triggered);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>Price Alerts</Text>
          <TouchableOpacity onPress={() => setShowAdd(true)} style={{ backgroundColor: T.accent, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 6 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>+ New Alert</Text>
          </TouchableOpacity>
        </View>

        <SectionLabel theme={T}>ACTIVE ({active.length})</SectionLabel>
        {active.length === 0 && <Text style={{ color: T.textDim, fontSize: 12, marginBottom: 16 }}>No active alerts. Tap "+ New Alert" to set one.</Text>}
        {active.map(a => {
          const cp = prices[a.symbol];
          return (
            <Card key={a.id} theme={T} style={{ marginBottom: 8 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <View>
                  <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>{a.symbol}</Text>
                  <Text style={{ color: T.textDim, fontSize: 11, marginTop: 2 }}>
                    Alert when {a.condition === 'ABOVE' ? '≥' : '≤'} {pFmt(a.targetPrice)} · now {cp ? pFmt(cp.price) : '—'}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => handleDelete(a.id)}>
                  <Text style={{ color: T.red, fontSize: 12, fontWeight: '700' }}>Remove</Text>
                </TouchableOpacity>
              </View>
            </Card>
          );
        })}

        {triggered.length > 0 && (
          <>
            <SectionLabel theme={T}>TRIGGERED ({triggered.length})</SectionLabel>
            {triggered.map(a => (
              <Card key={a.id} theme={T} style={{ marginBottom: 8, opacity: 0.6 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ color: T.textSub, fontSize: 13 }}>🔔 {a.symbol} hit {a.condition === 'ABOVE' ? '≥' : '≤'} {pFmt(a.targetPrice)}</Text>
                  <TouchableOpacity onPress={() => handleDelete(a.id)}><Text style={{ color: T.textDim, fontSize: 11 }}>Clear</Text></TouchableOpacity>
                </View>
              </Card>
            ))}
          </>
        )}
      </ScrollView>

      <BottomSheet visible={showAdd} onClose={() => setShowAdd(false)} title="New Price Alert" theme={T}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <Text style={{ color: T.textDim, fontSize: 10 }}>SYMBOL — currently set to {symbol}</Text>
          <TouchableOpacity onPress={() => { setShowAdd(false); navigation.navigate('SymbolSearch', { returnTo: 'Alerts' }); }}>
            <Text style={{ color: T.accent, fontSize: 11, fontWeight: '700' }}>🔍 Search any symbol</Text>
          </TouchableOpacity>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {allAssets.map(a => <Pill key={a.symbol + a.src} label={a.symbol} color={T.blue} active={symbol === a.symbol} onPress={() => setSymbol(a.symbol)} />)}
          </View>
        </ScrollView>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>CONDITION</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
          <Pill label="PRICE ABOVE" color={T.green} active={condition === 'ABOVE'} onPress={() => setCondition('ABOVE')} />
          <Pill label="PRICE BELOW" color={T.red} active={condition === 'BELOW'} onPress={() => setCondition('BELOW')} />
        </View>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>TARGET PRICE</Text>
        <TextInput value={target} onChangeText={setTarget} keyboardType="numeric" placeholder="e.g. 25000" placeholderTextColor={T.textDim}
          style={{ backgroundColor: T.bg0, borderWidth: 1, borderColor: T.border, borderRadius: 6, paddingHorizontal: 12, paddingVertical: 10, color: T.text, fontSize: 14, marginBottom: 18 }} />

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <TouchableOpacity onPress={() => setShowAdd(false)} style={{ flex: 1, padding: 12, borderRadius: 8, backgroundColor: T.bg3, alignItems: 'center' }}>
            <Text style={{ color: T.textSub, fontWeight: '700' }}>Cancel</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}><PrimaryButton theme={T} label="Set Alert" onPress={handleAdd} /></View>
        </View>
      </BottomSheet>
    </SafeAreaView>
  );
}
