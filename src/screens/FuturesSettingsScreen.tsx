// ─────────────────────────────────────────────────────────────────────────────
// FuturesSettingsScreen  (v1.0.0)
//
// Futures paper account settings. Allows resetting paper capital and
// viewing account performance for both NSE and Binance futures accounts.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { KVStore } from '../services/storage';
import { useTheme } from '../context/ThemeContext';
import {
  getFuturesPortfolio, resetFuturesPortfolio, saveFuturesPortfolio,
} from '../utils/futures/futuresPortfolio';
import {
  getBnFuturesPortfolio, resetBnFuturesPortfolio, saveBnFuturesPortfolio,
} from '../utils/futures/binance/bnFuturesPortfolio';
import { SPACING, RADIUS } from '../theme/colors';

function AccountCard({
  title, balance, initialCapital, realizedPnL, currency, positions,
  onReset, onSetCapital, T,
}: any) {
  const [editingCapital, setEditingCapital] = useState(false);
  const [capitalInput,   setCapitalInput]   = useState(String(initialCapital));
  const pnlPct = initialCapital > 0
    ? ((balance + realizedPnL - initialCapital) / initialCapital) * 100 : 0;

  return (
    <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
      borderWidth: 1, borderColor: T.border, marginBottom: 16 }}>
      <Text style={{ color: T.text, fontSize: 14, fontWeight: '800', marginBottom: 12 }}>
        {title}
      </Text>

      {/* Stats */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginBottom: 14 }}>
        {[
          { label: 'BALANCE',     value: `${currency}${balance.toFixed(0)}`,       color: T.text },
          { label: 'REALISED',    value: `${realizedPnL >= 0 ? '+' : ''}${currency}${realizedPnL.toFixed(0)}`,
            color: realizedPnL >= 0 ? T.green : T.red },
          { label: 'TOTAL RETURN', value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`,
            color: pnlPct >= 0 ? T.green : T.red },
          { label: 'OPEN',        value: String(positions), color: T.text },
        ].map(({ label, value, color }) => (
          <View key={label} style={{ alignItems: 'center' }}>
            <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700' }}>{label}</Text>
            <Text style={{ color, fontSize: 13, fontWeight: '800', marginTop: 2 }}>{value}</Text>
          </View>
        ))}
      </View>

      {/* Starting capital */}
      <View style={{ borderTopWidth: 0.5, borderTopColor: T.border, paddingTop: 12, marginBottom: 10 }}>
        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>
          Starting Capital
        </Text>
        {editingCapital ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              value={capitalInput} onChangeText={setCapitalInput}
              keyboardType="number-pad" autoFocus
              style={{ flex: 1, backgroundColor: T.bg3, color: T.text,
                borderRadius: 6, paddingHorizontal: 12, paddingVertical: 8,
                fontSize: 14, borderWidth: 1, borderColor: T.accent }}
            />
            <TouchableOpacity
              onPress={() => {
                const n = parseFloat(capitalInput);
                if (!isNaN(n) && n > 0) { onSetCapital(n); setEditingCapital(false); }
                else Alert.alert('Invalid', 'Enter a positive number.');
              }}
              style={{ backgroundColor: T.accent, borderRadius: 6,
                paddingHorizontal: 14, justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>Set</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEditingCapital(false)}
              style={{ backgroundColor: T.bg3, borderRadius: 6,
                paddingHorizontal: 10, justifyContent: 'center',
                borderWidth: 1, borderColor: T.border }}>
              <Text style={{ color: T.textDim, fontSize: 12 }}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity onPress={() => { setCapitalInput(String(initialCapital)); setEditingCapital(true); }}
            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              backgroundColor: T.bg3, borderRadius: 6, paddingHorizontal: 12,
              paddingVertical: 10, borderWidth: 1, borderColor: T.border }}>
            <Text style={{ color: T.text, fontSize: 14, fontWeight: '600' }}>
              {currency}{initialCapital.toLocaleString()}
            </Text>
            <Text style={{ color: T.accent, fontSize: 11 }}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Reset */}
      <TouchableOpacity onPress={onReset}
        style={{ backgroundColor: T.red + '15', borderRadius: RADIUS.sm, padding: 10,
          alignItems: 'center', borderWidth: 1, borderColor: T.red + '40' }}>
        <Text style={{ color: T.red, fontWeight: '700', fontSize: 11 }}>
          Reset Paper Account
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export default function FuturesSettingsScreen({ navigation }: any) {
  const { theme: T } = useTheme();
  const [nseState, setNseState] = useState<any>(null);
  const [bnState,  setBnState]  = useState<any>(null);

  const load = useCallback(async () => {
    const [n, b] = await Promise.all([getFuturesPortfolio(), getBnFuturesPortfolio()]);
    setNseState(n); setBnState(b);
  }, []);

  useEffect(() => { load(); }, [load]);

  const resetNSE = () => {
    Alert.alert('Reset NSE Futures Account',
      'All open positions and trade history will be cleared. Cannot be undone.',
      [{ text: 'Cancel', style: 'cancel' },
       { text: 'Reset', style: 'destructive', onPress: async () => {
         await resetFuturesPortfolio(); await load();
       }}]);
  };

  const resetBN = () => {
    Alert.alert('Reset Crypto Futures Account',
      'All open positions and funding history will be cleared. Cannot be undone.',
      [{ text: 'Cancel', style: 'cancel' },
       { text: 'Reset', style: 'destructive', onPress: async () => {
         await resetBnFuturesPortfolio(); await load();
       }}]);
  };

  const setNseCapital = async (n: number) => {
    if (!nseState) return;
    const updated = { ...nseState, cashBalance: n, initialCapital: n, totalRealizedPnL: 0 };
    await saveFuturesPortfolio(updated); await load();
  };

  const setBnCapital = async (n: number) => {
    if (!bnState) return;
    const updated = { ...bnState, usdtBalance: n, initialCapital: n, totalRealizedPnL: 0 };
    await saveBnFuturesPortfolio(updated); await load();
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 50 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>
          Futures Settings
        </Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 20, lineHeight: 16 }}>
          Configure paper capital for each futures account. Resetting clears all
          open positions and trade history — no real money is affected.
        </Text>

        {nseState && (
          <AccountCard
            title="🇮🇳 NSE Futures (F&O)"
            balance={nseState.cashBalance}
            initialCapital={nseState.initialCapital}
            realizedPnL={nseState.totalRealizedPnL}
            currency="₹"
            positions={nseState.openPositions.length}
            onReset={resetNSE}
            onSetCapital={setNseCapital}
            T={T}
          />
        )}

        {bnState && (
          <AccountCard
            title="₿ Binance Crypto Futures (USDM)"
            balance={bnState.usdtBalance}
            initialCapital={bnState.initialCapital}
            realizedPnL={bnState.totalRealizedPnL}
            currency="$"
            positions={bnState.openPositions.length}
            onReset={resetBN}
            onSetCapital={setBnCapital}
            T={T}
          />
        )}

        <View style={{ backgroundColor: T.bg3, borderRadius: 8, padding: 12, marginTop: 4 }}>
          <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 14 }}>
            <Text style={{ fontWeight: '700', color: T.text }}>Note: </Text>
            Starting capital only affects how performance % is calculated.
            Setting a new capital amount resets realised P&L to zero but
            preserves your current balance. Use Reset to start completely fresh.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
