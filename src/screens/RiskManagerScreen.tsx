import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { Card, SectionLabel, MetricBox } from '../components/Common';
import { RADIUS, SPACING } from '../theme/colors';
import {
  RiskSettings, getRiskSettings, saveRiskSettings, calcPositionSize, calcKelly,
  getTodayPnL, isDailyLossLimitHit, DailyPnL, getPaperMode, setPaperMode,
} from '../utils/riskManager';
import { getTrades, computeStats } from '../utils/journal';
import { getPaperRiskExtras, savePaperRiskExtras, PaperRiskExtras } from '../utils/paperRiskControls';

// Shared toggle — same visual language as the PaperTradingScreen and Settings toggles
function Toggle({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  return (
    <TouchableOpacity onPress={onToggle} activeOpacity={0.8}
      style={{ width: 44, height: 24, borderRadius: 12, backgroundColor: value ? '#3b7dff' : '#565c70', padding: 2, justifyContent: 'center' }}>
      <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', marginLeft: value ? 20 : 0 }} />
    </TouchableOpacity>
  );
}

// Reusable settings row with a toggle (eliminates 3 near-identical TouchableOpacity blocks)
function ToggleRow({ label, sub, value, onToggle, T }: { label: string; sub?: string; value: boolean; onToggle: () => void; T: any }) {
  return (
    <TouchableOpacity onPress={onToggle} activeOpacity={0.8}
      style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        backgroundColor: value ? T.accent + '12' : T.bg3,
        borderWidth: 1, borderColor: value ? T.accent + '40' : T.cardBorder,
        borderRadius: RADIUS.sm, padding: 12, minHeight: 48,
      }}>
      <View style={{ flex: 1, marginRight: 10 }}>
        <Text style={{ color: T.text, fontWeight: '700', fontSize: 13 }}>{label}</Text>
        {sub && <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2, lineHeight: 14 }}>{sub}</Text>}
      </View>
      <Toggle value={value} onToggle={onToggle} />
    </TouchableOpacity>
  );
}

export default function RiskManagerScreen() {
  const { theme: T } = useTheme();
  const [settings, setSettings] = useState<RiskSettings>({
    accountSize: 100000, riskPerTradePct: 1, maxDailyLossPct: 3,
    maxFuturesLots: 5, defaultFuturesLeverage: 10,
  });
  const [entry, setEntry] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [todayPnL, setTodayPnL] = useState<DailyPnL>({ date: '', realizedPnL: 0, tradesCount: 0 });
  const [winRate, setWinRate] = useState(0);
  const [avgRR, setAvgRR] = useState(0);
  const [paperMode, setPaperModeState] = useState(false);
  const [riskExtras, setRiskExtras] = useState<PaperRiskExtras | null>(null);

  useEffect(() => { getPaperRiskExtras().then(setRiskExtras); }, []);

  function updateRiskExtras(patch: Partial<PaperRiskExtras>) {
    if (!riskExtras) return;
    const next = { ...riskExtras, ...patch };
    setRiskExtras(next);
    savePaperRiskExtras(next);
  }

  useEffect(() => { getPaperMode().then(setPaperModeState); }, []);

  async function togglePaperMode() {
    const next = !paperMode;
    setPaperModeState(next);
    await setPaperMode(next);
  }

  useEffect(() => {
    getRiskSettings().then(setSettings);
    getTodayPnL().then(setTodayPnL);
    getTrades().then(trades => {
      const stats = computeStats(trades);
      setWinRate(stats.winRate);
      setAvgRR(stats.avgRR);
    });
  }, []);

  function update(field: keyof RiskSettings, val: string) {
    const num = parseFloat(val) || 0;
    const next = { ...settings, [field]: num };
    setSettings(next);
    saveRiskSettings(next);
  }

  // All calculations identical to before — only their display changed
  const entryNum = parseFloat(entry) || 0;
  const stopNum = parseFloat(stopLoss) || 0;
  const sizing = calcPositionSize(settings.accountSize, settings.riskPerTradePct, entryNum, stopNum);
  const kelly = calcKelly(winRate || 50, avgRR || 1.5, 1);
  const lossLimitHit = isDailyLossLimitHit(todayPnL, settings);
  const lossLimit = settings.accountSize * (settings.maxDailyLossPct / 100);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.3, marginBottom: 2 }}>Risk Manager</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16, fontStyle: 'italic' }}>Capital preservation comes before profit</Text>

        {/* Paper/Live trading toggle */}
        <ToggleRow
          label={paperMode ? '📝 Paper Trading Mode' : 'Live Trading Mode'}
          sub={paperMode ? 'Practice mode — no real capital at risk' : 'Tap to switch to risk-free paper trading'}
          value={paperMode}
          onToggle={togglePaperMode}
          T={{ ...T, accent: T.amber }}
        />
        <View style={{ marginBottom: 14 }} />

        {/* Today's status — MetricBox grid with status banner */}
        <Card theme={T} style={{ marginBottom: 14, borderColor: lossLimitHit ? T.red + '60' : T.cardBorder }}>
          <SectionLabel theme={T}>TODAY'S TRADING STATUS</SectionLabel>
          {lossLimitHit ? (
            <View style={{ backgroundColor: T.red + '18', padding: 12, borderRadius: RADIUS.sm, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text style={{ fontSize: 18 }}>🛑</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.red, fontWeight: '800', fontSize: 13 }}>Daily Loss Limit Hit</Text>
                <Text style={{ color: T.textSub, fontSize: 10, marginTop: 2 }}>Stop trading for today. Discipline protects your capital.</Text>
              </View>
            </View>
          ) : (
            <View style={{ backgroundColor: T.green + '12', padding: 10, borderRadius: RADIUS.sm, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ color: T.green, fontSize: 12, fontWeight: '800' }}>✓ Within limits</Text>
              <Text style={{ color: T.textDim, fontSize: 10 }}>— clear to trade</Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <MetricBox label="TODAY'S P&L" value={`₹${todayPnL.realizedPnL.toFixed(0)}`} valueColor={todayPnL.realizedPnL >= 0 ? T.green : T.red} bg={todayPnL.realizedPnL >= 0 ? T.green + '10' : T.red + '10'} theme={T} />
            <MetricBox label="TRADES TODAY" value={String(todayPnL.tradesCount)} theme={T} />
            <MetricBox label="LOSS LIMIT" value={`₹${lossLimit.toFixed(0)}`} valueColor={T.amber} bg={T.amber + '10'} theme={T} />
          </View>
        </Card>

        {/* Position Size Calculator */}
        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>POSITION SIZE CALCULATOR</SectionLabel>
          <View style={{ marginBottom: 10 }}>
            <Text style={labelStyle}>ACCOUNT SIZE (₹)</Text>
            <TextInput value={String(settings.accountSize)} onChangeText={v => update('accountSize', v)} keyboardType="numeric" style={inputStyle(T)} />
          </View>
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={labelStyle}>RISK PER TRADE (%)</Text>
              <TextInput value={String(settings.riskPerTradePct)} onChangeText={v => update('riskPerTradePct', v)} keyboardType="numeric" style={inputStyle(T)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={labelStyle}>MAX DAILY LOSS (%)</Text>
              <TextInput value={String(settings.maxDailyLossPct)} onChangeText={v => update('maxDailyLossPct', v)} keyboardType="numeric" style={inputStyle(T)} />
            </View>
            <Text style={{ color: T.textDim, fontSize: 10, marginTop: 4 }}>
              Daily loss limit: ₹{lossLimit.toFixed(0)} — trading pauses for the day if hit
            </Text>
          </View>

          {/* Futures settings */}
          <View style={{ marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: T.border }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 0.8, marginBottom: 10 }}>
              FUTURES & DERIVATIVES
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.text, fontSize: 13, fontWeight: '600' }}>Max Lots Per Order</Text>
                <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>
                  NSE futures — max lots per single trade
                </Text>
              </View>
              <TextInput value={String(settings.maxFuturesLots ?? 5)} onChangeText={v => update('maxFuturesLots', v)} keyboardType="numeric" style={[inputStyle(T), { width: 70, textAlign: 'center' }]} />
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: T.text, fontSize: 13, fontWeight: '600' }}>Default Leverage</Text>
                <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>
                  Binance perps — 1×–125× (start low)
                </Text>
              </View>
              <TextInput value={String(settings.defaultFuturesLeverage ?? 10)} onChangeText={v => update('defaultFuturesLeverage', v)} keyboardType="numeric" style={[inputStyle(T), { width: 70, textAlign: 'center' }]} />
            </View>
          </View>

          <View style={{ height: 1, backgroundColor: T.border, marginVertical: 12 }} />
          <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.5, marginBottom: 8 }}>ENTRY & STOP LOSS</Text>

          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={labelStyle}>ENTRY PRICE</Text>
              <TextInput value={entry} onChangeText={setEntry} keyboardType="numeric" placeholder="e.g. 24900" placeholderTextColor={T.textDim} style={inputStyle(T)} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={labelStyle}>STOP LOSS PRICE</Text>
              <TextInput value={stopLoss} onChangeText={setStopLoss} keyboardType="numeric" placeholder="e.g. 24800" placeholderTextColor={T.textDim} style={inputStyle(T)} />
            </View>
          </View>

          {entryNum > 0 && stopNum > 0 && (
            <View style={{ backgroundColor: T.accent + '10', padding: 14, borderRadius: RADIUS.sm, borderWidth: 1, borderColor: T.accent + '25' }}>
              <ResultRow label="Risk Amount" value={`₹${sizing.riskAmount.toFixed(0)}`} valueColor={T.red} T={T} />
              <ResultRow label="Risk per Unit" value={`₹${sizing.perUnitRisk.toFixed(2)}`} T={T} />
              <ResultRow label="Position Value" value={`₹${sizing.positionValue.toFixed(0)}`} T={T} />
              <View style={{ height: 1, backgroundColor: T.border, marginVertical: 8 }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>QUANTITY TO BUY</Text>
                <Text style={{ color: T.accent, fontSize: 26, fontWeight: '800' }}>{sizing.qty}</Text>
              </View>
            </View>
          )}
        </Card>

        {/* Paper Trading Cooldown */}
        {riskExtras && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>PAPER TRADING COOLDOWN</SectionLabel>
            <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 12, lineHeight: 15 }}>
              After this many consecutive losing paper trades (across all symbols), new positions are blocked until a non-losing trade closes.
            </Text>
            <ToggleRow
              label="Enable Cooldown"
              value={riskExtras.cooldownAfterLosses > 0}
              onToggle={() => updateRiskExtras({ cooldownAfterLosses: riskExtras.cooldownAfterLosses > 0 ? 0 : 3 })}
              T={T}
            />
            {riskExtras.cooldownAfterLosses > 0 && (
              <View style={{ marginTop: 12 }}>
                <Text style={labelStyle}>CONSECUTIVE LOSS LIMIT</Text>
                <TextInput
                  value={String(riskExtras.cooldownAfterLosses)}
                  onChangeText={v => updateRiskExtras({ cooldownAfterLosses: Math.max(1, parseInt(v, 10) || 1) })}
                  keyboardType="numeric" style={inputStyle(T)}
                />
              </View>
            )}
          </Card>
        )}

        {/* Position & Exposure Limits */}
        {riskExtras && (
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>POSITION & EXPOSURE LIMITS</SectionLabel>
            <View style={{ marginBottom: 10 }}>
              <Text style={labelStyle}>MAX OPEN POSITIONS</Text>
              <TextInput
                value={String(riskExtras.maxOpenPositions)}
                onChangeText={v => updateRiskExtras({ maxOpenPositions: Math.max(1, parseInt(v, 10) || 1) })}
                keyboardType="numeric" style={inputStyle(T)}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={labelStyle}>MAX EXPOSURE / SYMBOL (%)</Text>
                <TextInput
                  value={String(riskExtras.maxExposurePerSymbolPct)}
                  onChangeText={v => updateRiskExtras({ maxExposurePerSymbolPct: Math.max(1, parseFloat(v) || 1) })}
                  keyboardType="numeric" style={inputStyle(T)}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={labelStyle}>MAX EXPOSURE / ASSET CLASS (%)</Text>
                <TextInput
                  value={String(riskExtras.maxExposurePerAssetClassPct)}
                  onChangeText={v => updateRiskExtras({ maxExposurePerAssetClassPct: Math.max(1, parseFloat(v) || 1) })}
                  keyboardType="numeric" style={inputStyle(T)}
                />
              </View>
            </View>
            <ToggleRow
              label="Daily Loss Limit Blocks New Trades"
              sub="When on, hitting your Max Daily Loss (%) above also stops new paper entries for the rest of the day."
              value={riskExtras.pauseOnDailyLossLimit}
              onToggle={() => updateRiskExtras({ pauseOnDailyLossLimit: !riskExtras.pauseOnDailyLossLimit })}
              T={T}
            />
          </Card>
        )}

        {/* Kelly Criterion */}
        <Card theme={T}>
          <SectionLabel theme={T}>KELLY CRITERION</SectionLabel>
          <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 17, marginBottom: 12 }}>
            Based on your journal — win rate {winRate.toFixed(0)}% and average R:R {avgRR.toFixed(2)} — the mathematically optimal risk per trade is:
          </Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <MetricBox label="FULL KELLY" value={`${kelly.toFixed(1)}%`} valueColor={T.green} bg={T.green + '10'} theme={T} />
            <MetricBox label="HALF KELLY" value={`${(kelly / 2).toFixed(1)}%`} valueColor={T.amber} theme={T} />
            <MetricBox label="QUARTER KELLY" value={`${(kelly / 4).toFixed(1)}%`} valueColor={T.blue} theme={T} />
          </View>
          <Text style={{ color: T.textDim, fontSize: 9, lineHeight: 14 }}>
            Most professional traders use ¼ to ½ Kelly to reduce volatility. Full Kelly is the mathematical ceiling, not a recommendation.
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

function ResultRow({ label, value, valueColor, T }: { label: string; value: string; valueColor?: string; T: any }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
      <Text style={{ color: T.textSub, fontSize: 11 }}>{label}</Text>
      <Text style={{ color: valueColor || T.text, fontWeight: '700', fontSize: 13 }}>{value}</Text>
    </View>
  );
}

const labelStyle = { color: '#565c70', fontSize: 10, fontWeight: '700' as const, letterSpacing: 0.4, marginBottom: 5 };

function inputStyle(T: any) {
  return {
    backgroundColor: T.bg0, borderWidth: 1, borderColor: T.border, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 11, color: T.text, fontSize: 14, minHeight: 44,
  };
}
