// ─────────────────────────────────────────────────────────────────────────────
// OPTIONS STRATEGY BUILDER  v2.0
// Features: 13 strategies, NSE expiry calendar, custom leg builder,
// live spot from DataContext, real BS pricing + Greeks, payoff SVG.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Line, Path, Text as SvgText, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, StatBox } from '../components/Common';
import { ASSETS } from '../api/assets';
import { pFmt } from '../utils/indicators';
import { OptionLeg, STRATEGY_TEMPLATES, STRATEGY_META, TAG_COLORS, calcPayoffCurve, calcNetGreeks, maxProfitLoss, breakevens, blackScholes, getNSEExpiries} from '../utils/optionsCalc';

// ── Constants ─────────────────────────────────────────────────────────────────

const INDEX_GAPS: Record<string, number> = {
  NIFTY50: 50, BANKNIFTY: 100, FINNIFTY: 50,
};
const LOT_SIZES: Record<string, number> = {
  NIFTY50: 75, BANKNIFTY: 30, FINNIFTY: 65,
};

// Strategy groups for the horizontal scrollable tab bar
const STRATEGY_GROUPS: { label: string; strategies: string[] }[] = [
  { label: 'Volatility', strategies: ['Long Straddle', 'Short Straddle', 'Long Strangle', 'Short Strangle'] },
  { label: 'Bullish',    strategies: ['Bull Call Spread', 'Bull Put Spread', 'Covered Call'] },
  { label: 'Bearish',    strategies: ['Bear Put Spread', 'Bear Call Spread'] },
  { label: 'Neutral',    strategies: ['Iron Condor', 'Iron Butterfly', 'Long Butterfly'] },
  { label: 'Protected',  strategies: ['Protective Put'] },
];

const ALL_STRATEGIES = STRATEGY_GROUPS.flatMap(g => g.strategies);

// ── Helpers ───────────────────────────────────────────────────────────────────

function atm(spot: number, gap: number) { return Math.round(spot / gap) * gap; }

// ── Main Screen ───────────────────────────────────────────────────────────────

export default function OptionsStrategyScreen() {
  const { theme: T } = useTheme();
  const { prices } = useData();

  // ── State ──────────────────────────────────────────────────────────────────
  const [symbol, setSymbol]             = useState<string>('NIFTY50');
  const [groupIdx, setGroupIdx]         = useState<number>(0);
  const [strategyName, setStrategyName] = useState<string>('Long Straddle');
  const [selectedExpiryIdx, setExpiry]  = useState<number>(0);
  const [iv, setIv]                     = useState<number>(15);
  const [lots, setLots]                 = useState<number>(1);
  const [showCustom, setShowCustom]     = useState<boolean>(false);
  const [customLegs, setCustomLegs]     = useState<OptionLeg[]>([]);

  // Custom leg form
  const [cType,   setCType]   = useState<'CE' | 'PE'>('CE');
  const [cAction, setCAction] = useState<'BUY' | 'SELL'>('BUY');
  const [cStrike, setCStrike] = useState<string>('');

  // ── Derived values ─────────────────────────────────────────────────────────
  const spot  = prices[symbol]?.price || ASSETS.find(a => a.symbol === symbol)?.base || 24900;
  const gap   = INDEX_GAPS[symbol] ?? (Math.round(spot * 0.01 / 10) * 10 || 10);
  const lotSz = LOT_SIZES[symbol] ?? 1;

  const expiries = useMemo(() => getNSEExpiries(new Date(), 8), []);
  const dte = expiries[selectedExpiryIdx]?.daysAway ?? 7;

  // Template legs
  const templateLegs: OptionLeg[] = useMemo(() => {
    if (showCustom) return [];
    const template = STRATEGY_TEMPLATES[strategyName]?.(spot, gap) ?? [];
    return template.map((leg, i) => {
      const T_y = Math.max(dte, 0.5) / 365;
      const bs  = blackScholes(spot, leg.strike, T_y, 0.07, iv / 100, leg.type);
      return { ...leg, id: `tpl-${i}`, premium: Math.round(bs.price * 100) / 100, qty: lots * lotSz };
    });
  }, [strategyName, spot, gap, dte, iv, lots, lotSz, showCustom]);

  // Custom legs — reprice on spot/iv/dte/lots change
  const pricedCustomLegs: OptionLeg[] = useMemo(() => {
    if (!showCustom) return [];
    return customLegs.map(leg => {
      const T_y = Math.max(dte, 0.5) / 365;
      const bs  = blackScholes(spot, leg.strike, T_y, 0.07, iv / 100, leg.type);
      return { ...leg, premium: Math.round(bs.price * 100) / 100, qty: lots * lotSz };
    });
  }, [customLegs, spot, dte, iv, lots, lotSz, showCustom]);

  const legs = showCustom ? pricedCustomLegs : templateLegs;

  // Payoff + Greeks
  const curve             = useMemo(() => legs.length > 0 ? calcPayoffCurve(legs, spot) : [], [legs, spot]);
  const { maxProfit, maxLoss } = useMemo(() => legs.length > 0 ? maxProfitLoss(curve) : { maxProfit: 0, maxLoss: 0 }, [curve, legs]);
  const bePoints          = useMemo(() => legs.length > 0 ? breakevens(curve) : [], [curve, legs]);
  const greeks            = useMemo(() => legs.length > 0 ? calcNetGreeks(legs, spot, dte, iv) : null, [legs, spot, dte, iv]);

  const meta   = STRATEGY_META[strategyName];
  const tagCol = meta ? (TAG_COLORS[meta.tag] ?? T.accent) : T.accent;

  // ── SVG payoff diagram ─────────────────────────────────────────────────────
  const W = 320, H = 180, PAD = 32;
  const svgData = useMemo(() => {
    if (curve.length === 0) return null;
    const minP     = Math.min(...curve.map(c => c.pnl), 0);
    const maxP     = Math.max(...curve.map(c => c.pnl), 0);
    const pRange   = maxP - minP || 1;
    const minPrice = curve[0].price, maxPrice = curve[curve.length - 1].price;
    const toX = (p: number) => PAD + ((p - minPrice) / (maxPrice - minPrice)) * (W - PAD * 2);
    const toY = (pnl: number) => H - PAD - ((pnl - minP) / pRange) * (H - PAD * 2);
    let pathD = '';
    curve.forEach((c, i) => { pathD += (i === 0 ? 'M' : 'L') + `${toX(c.price).toFixed(1)},${toY(c.pnl).toFixed(1)} `; });
    return { toX, toY, pathD, zeroY: toY(0), minPrice, maxPrice };
  }, [curve]);

  // ── Custom leg builder actions ─────────────────────────────────────────────
  const addCustomLeg = useCallback(() => {
    const s = parseFloat(cStrike);
    if (isNaN(s) || s <= 0) { Alert.alert('Invalid Strike', 'Enter a positive strike price.'); return; }
    const id = `custom-${Date.now()}`;
    setCustomLegs(prev => [...prev, { id, type: cType, action: cAction, strike: s, premium: 0, qty: lots * lotSz }]);
    setCStrike('');
  }, [cStrike, cType, cAction, lots, lotSz]);

  const removeCustomLeg = useCallback((id: string) => {
    setCustomLegs(prev => prev.filter(l => l.id !== id));
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }} keyboardDismissMode="on-drag">

        {/* Header */}
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 2 }}>
          Options Strategy Builder
        </Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 18 }}>
          BS pricing · live spot · NSE expiry calendar · 13 strategies
        </Text>

        {/* ── Underlying ──────────────────────────────────────────────────── */}
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 6 }}>UNDERLYING</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {['NIFTY50', 'BANKNIFTY', 'FINNIFTY'].map(s => (
            <TouchableOpacity key={s} onPress={() => { setSymbol(s); setExpiry(0); }}
              style={{
                paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8,
                backgroundColor: symbol === s ? T.blue + '22' : T.bg1,
                borderWidth: 1, borderColor: symbol === s ? T.blue : T.border}}>
              <Text style={{ color: symbol === s ? T.blue : T.textDim, fontWeight: '700', fontSize: 12 }}>{s}</Text>
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>
                {prices[s]?.price ? `₹${pFmt(prices[s].price)}` : '—'} · lot {LOT_SIZES[s]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── NSE Expiry Calendar ──────────────────────────────────────────── */}
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 6 }}>
          NSE EXPIRY — SELECT THURSDAY
        </Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {expiries.map((e, i) => (
              <TouchableOpacity key={i} onPress={() => setExpiry(i)}
                style={{
                  paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, alignItems: 'center',
                  backgroundColor: selectedExpiryIdx === i ? T.accent + '22' : T.bg1,
                  borderWidth: 1.5,
                  borderColor: selectedExpiryIdx === i ? T.accent : e.isMonthly ? T.amber + '60' : T.border}}>
                <Text style={{
                  color: selectedExpiryIdx === i ? T.accent : T.text,
                  fontSize: 11, fontWeight: '700'}}>{e.label}</Text>
                <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>{e.daysAway}D</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        {/* ── IV + Lots ────────────────────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', gap: 12, marginBottom: 18 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 6 }}>
              IMPLIED VOLATILITY: {iv}%
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
              {[10, 12, 15, 18, 20, 25, 30, 40].map(v => (
                <TouchableOpacity key={v} onPress={() => setIv(v)}
                  style={{
                    paddingHorizontal: 8, paddingVertical: 5, borderRadius: 4,
                    backgroundColor: iv === v ? T.amber + '30' : T.bg1,
                    borderWidth: 1, borderColor: iv === v ? T.amber : T.border}}>
                  <Text style={{ color: iv === v ? T.amber : T.textSub, fontSize: 10, fontWeight: '700' }}>{v}%</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
          <View style={{ alignItems: 'center' }}>
            <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 6 }}>LOTS</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <TouchableOpacity onPress={() => setLots(l => Math.max(1, l - 1))}
                style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: T.text, fontSize: 18, fontWeight: '700', lineHeight: 20 }}>−</Text>
              </TouchableOpacity>
              <Text style={{ color: T.text, fontWeight: '800', fontSize: 16, minWidth: 24, textAlign: 'center' }}>{lots}</Text>
              <TouchableOpacity onPress={() => setLots(l => Math.min(50, l + 1))}
                style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: T.bg1, borderWidth: 1, borderColor: T.border, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: T.text, fontSize: 18, fontWeight: '700', lineHeight: 20 }}>+</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ color: T.textDim, fontSize: 9, marginTop: 3 }}>{lots * lotSz} units</Text>
          </View>
        </View>

        {/* ── Strategy selector ────────────────────────────────────────────── */}
        {!showCustom && (<>
          {/* Group tabs */}
          <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 6 }}>STRATEGY TYPE</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {STRATEGY_GROUPS.map((g, i) => (
                <TouchableOpacity key={g.label} onPress={() => { setGroupIdx(i); setStrategyName(g.strategies[0]); }}
                  style={{
                    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
                    backgroundColor: groupIdx === i ? T.purple + '22' : T.bg1,
                    borderWidth: 1, borderColor: groupIdx === i ? T.purple : T.border}}>
                  <Text style={{ color: groupIdx === i ? T.purple : T.textDim, fontSize: 11, fontWeight: '700' }}>{g.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>

          {/* Strategy pills within group */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {STRATEGY_GROUPS[groupIdx].strategies.map(s => {
                const m = STRATEGY_META[s];
                const col = m ? TAG_COLORS[m.tag] : T.accent;
                return (
                  <TouchableOpacity key={s} onPress={() => setStrategyName(s)}
                    style={{
                      paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6,
                      backgroundColor: strategyName === s ? col + '22' : T.bg1,
                      borderWidth: 1, borderColor: strategyName === s ? col : T.border}}>
                    <Text style={{ color: strategyName === s ? col : T.textDim, fontSize: 11, fontWeight: '600' }}>{s}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>

          {/* Strategy description card */}
          {meta && (
            <View style={{
              backgroundColor: T.bg1, borderRadius: 10, padding: 12, marginBottom: 16,
              borderLeftWidth: 3, borderLeftColor: tagCol}}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <View style={{ backgroundColor: tagCol + '22', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 }}>
                  <Text style={{ color: tagCol, fontSize: 9, fontWeight: '800' }}>{meta.tag}</Text>
                </View>
                <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>{strategyName}</Text>
              </View>
              <Text style={{ color: T.textSub, fontSize: 11, lineHeight: 17, marginBottom: 6 }}>{meta.description}</Text>
              <Text style={{ color: T.textDim, fontSize: 10, fontStyle: 'italic' }}>
                📈 Outlook: {meta.outlook}
              </Text>
            </View>
          )}
        </>)}

        {/* ── Custom / Template toggle ─────────────────────────────────────── */}
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          <TouchableOpacity onPress={() => setShowCustom(false)}
            style={{
              flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center',
              backgroundColor: !showCustom ? T.accent : T.bg1,
              borderWidth: 1, borderColor: !showCustom ? T.accent : T.border}}>
            <Text style={{ color: !showCustom ? '#fff' : T.textDim, fontWeight: '700', fontSize: 12 }}>
              📋 Template Strategy
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setShowCustom(true)}
            style={{
              flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center',
              backgroundColor: showCustom ? T.accent : T.bg1,
              borderWidth: 1, borderColor: showCustom ? T.accent : T.border}}>
            <Text style={{ color: showCustom ? '#fff' : T.textDim, fontWeight: '700', fontSize: 12 }}>
              🔧 Custom Legs
            </Text>
          </TouchableOpacity>
        </View>

        {/* ── Custom leg builder ───────────────────────────────────────────── */}
        {showCustom && (
          <Card theme={T} style={{ marginBottom: 16 }}>
            <SectionLabel theme={T}>BUILD YOUR STRATEGY</SectionLabel>

            {/* Existing custom legs */}
            {pricedCustomLegs.length === 0 && (
              <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 12 }}>
                Add legs below. Premiums are priced via Black-Scholes at your IV/DTE settings.
              </Text>
            )}
            {pricedCustomLegs.map(leg => (
              <View key={leg.id} style={{
                flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: T.border}}>
                <Text style={{ color: leg.action === 'BUY' ? T.green : T.red, fontWeight: '700', fontSize: 12 }}>
                  {leg.action} {leg.type} {leg.strike}
                </Text>
                <Text style={{ color: T.textSub, fontSize: 11 }}>₹{leg.premium.toFixed(2)}/unit</Text>
                <TouchableOpacity onPress={() => removeCustomLeg(leg.id)}
                  style={{ backgroundColor: T.red + '20', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Text style={{ color: T.red, fontSize: 11, fontWeight: '700' }}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}

            {/* Add leg form */}
            <View style={{ marginTop: 12 }}>
              <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700', marginBottom: 6 }}>ADD LEG</Text>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                {(['CE', 'PE'] as const).map(t => (
                  <TouchableOpacity key={t} onPress={() => setCType(t)}
                    style={{
                      flex: 1, paddingVertical: 7, borderRadius: 6, alignItems: 'center',
                      backgroundColor: cType === t ? (t === 'CE' ? T.green + '22' : T.red + '22') : T.bg0,
                      borderWidth: 1, borderColor: cType === t ? (t === 'CE' ? T.green : T.red) : T.border}}>
                    <Text style={{ color: cType === t ? (t === 'CE' ? T.green : T.red) : T.textDim, fontWeight: '700', fontSize: 12 }}>{t}</Text>
                  </TouchableOpacity>
                ))}
                {(['BUY', 'SELL'] as const).map(a => (
                  <TouchableOpacity key={a} onPress={() => setCAction(a)}
                    style={{
                      flex: 1, paddingVertical: 7, borderRadius: 6, alignItems: 'center',
                      backgroundColor: cAction === a ? (a === 'BUY' ? T.green + '22' : T.red + '22') : T.bg0,
                      borderWidth: 1, borderColor: cAction === a ? (a === 'BUY' ? T.green : T.red) : T.border}}>
                    <Text style={{ color: cAction === a ? (a === 'BUY' ? T.green : T.red) : T.textDim, fontWeight: '700', fontSize: 12 }}>{a}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput
                  value={cStrike}
                  onChangeText={setCStrike}
                  placeholder={`Strike (e.g. ${atm(spot, gap)})`}
                  placeholderTextColor={T.textDim}
                  keyboardType="numeric"
                  style={{
                    flex: 1, backgroundColor: T.bg0, borderWidth: 1, borderColor: T.border,
                    borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
                    color: T.text, fontSize: 14}}
                />
                <TouchableOpacity onPress={addCustomLeg}
                  style={{ backgroundColor: T.accent, borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' }}>
                  <Text style={{ color: '#fff', fontWeight: '800', fontSize: 13 }}>+ Add</Text>
                </TouchableOpacity>
              </View>
              {/* Quick strike chips */}
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
                <View style={{ flexDirection: 'row', gap: 4 }}>
                  {[-3, -2, -1, 0, 1, 2, 3].map(offset => {
                    const s = atm(spot, gap) + offset * gap;
                    const label = offset === 0 ? `ATM ${s}` : `${offset > 0 ? '+' : ''}${offset} ${s}`;
                    return (
                      <TouchableOpacity key={offset} onPress={() => setCStrike(String(s))}
                        style={{
                          paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4,
                          backgroundColor: offset === 0 ? T.accent + '22' : T.bg1,
                          borderWidth: 1, borderColor: offset === 0 ? T.accent : T.border}}>
                        <Text style={{ color: offset === 0 ? T.accent : T.textDim, fontSize: 9, fontWeight: '600' }}>{label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </ScrollView>
            </View>
          </Card>
        )}

        {legs.length === 0 && (
          <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center', marginVertical: 24 }}>
            Add at least one leg to see the payoff diagram.
          </Text>
        )}

        {legs.length > 0 && (<>
          {/* ── Legs breakdown ────────────────────────────────────────────── */}
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>
              LEGS — Spot {pFmt(spot)} · {lots} lot{lots > 1 ? 's' : ''} × {lotSz} = {lots * lotSz} units · DTE {dte}d
            </SectionLabel>
            {legs.map((leg, i) => {
              const totalCost = leg.premium * lots * lotSz;
              return (
                <View key={leg.id} style={{
                  flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                  paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: T.border}}>
                  <View>
                    <Text style={{ color: leg.action === 'BUY' ? T.green : T.red, fontWeight: '700', fontSize: 12 }}>
                      {leg.action} {leg.type} {leg.strike}
                    </Text>
                    {leg.qty !== lots * lotSz && (
                      <Text style={{ color: T.textDim, fontSize: 9 }}>qty {leg.qty}</Text>
                    )}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: T.text, fontSize: 12, fontWeight: '600' }}>
                      ₹{leg.premium.toFixed(2)}/unit
                    </Text>
                    <Text style={{ color: T.textDim, fontSize: 9 }}>
                      ₹{totalCost.toFixed(0)} total {leg.action === 'BUY' ? '(paid)' : '(received)'}
                    </Text>
                  </View>
                </View>
              );
            })}
          </Card>

          {/* ── Payoff diagram ────────────────────────────────────────────── */}
          <Card theme={T} style={{ marginBottom: 14 }}>
            <SectionLabel theme={T}>PAYOFF AT EXPIRY</SectionLabel>
            {svgData && (
              <>
                <Svg width={W} height={H}>
                  {/* Zero line */}
                  <Line x1={PAD} y1={svgData.zeroY} x2={W - PAD} y2={svgData.zeroY}
                    stroke={T.textDim} strokeWidth={1} strokeDasharray="4,4" />
                  {/* Spot line */}
                  <Line x1={svgData.toX(spot)} y1={PAD} x2={svgData.toX(spot)} y2={H - PAD}
                    stroke={T.blue} strokeWidth={1} strokeDasharray="3,3" />
                  {/* Payoff curve */}
                  <Path d={svgData.pathD}
                    stroke={maxProfit > 0 && Math.abs(maxProfit) >= Math.abs(maxLoss) ? T.green : T.amber}
                    strokeWidth={2.5} fill="none" />
                  {/* Labels */}
                  <SvgText x={svgData.toX(spot)} y={PAD - 5} fontSize={9} fill={T.blue} textAnchor="middle">
                    {pFmt(spot)}
                  </SvgText>
                  {bePoints.slice(0, 3).map((bp, i) => (
                    <SvgText key={i} x={svgData.toX(bp)} y={H - 4} fontSize={8} fill={T.amber} textAnchor="middle">
                      {bp.toFixed(0)}
                    </SvgText>
                  ))}
                  {/* Min/Max P&L labels */}
                  <SvgText x={W - PAD + 2} y={PAD + 2} fontSize={8} fill={T.green} textAnchor="start">
                    ₹{maxProfit >= 100000 ? '∞' : Math.round(maxProfit)}
                  </SvgText>
                  <SvgText x={W - PAD + 2} y={H - PAD - 2} fontSize={8} fill={T.red} textAnchor="start">
                    ₹{Math.round(maxLoss)}
                  </SvgText>
                </Svg>
                <View style={{ flexDirection: 'row', marginTop: 6 }}>
                  <StatBox theme={T} label="MAX PROFIT" value={maxProfit >= 100000 ? 'Unlimited' : `₹${Math.round(maxProfit).toLocaleString('en-IN')}`} color={T.green} />
                  <StatBox theme={T} label="MAX LOSS"   value={`₹${Math.round(Math.abs(maxLoss)).toLocaleString('en-IN')}`} color={T.red} />
                  <StatBox theme={T} label="BREAKEVENS" value={bePoints.length > 0 ? bePoints.map(b => b.toFixed(0)).join(', ') : '—'} />
                </View>
                {/* Risk:Reward */}
                {maxLoss < 0 && maxProfit > 0 && maxProfit < 100000 && (
                  <View style={{ marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: T.textDim, fontSize: 10 }}>Risk:Reward</Text>
                    <Text style={{ color: T.text, fontWeight: '700', fontSize: 12 }}>
                      1 : {(maxProfit / Math.abs(maxLoss)).toFixed(2)}
                    </Text>
                  </View>
                )}
              </>
            )}
          </Card>

          {/* ── Net Greeks ────────────────────────────────────────────────── */}
          {greeks && (
            <Card theme={T} style={{ marginBottom: 14 }}>
              <SectionLabel theme={T}>NET POSITION GREEKS</SectionLabel>
              <View style={{ flexDirection: 'row', marginBottom: 4 }}>
                <StatBox theme={T} label="DELTA"     value={greeks.delta.toFixed(3)} color={greeks.delta >= 0 ? T.green : T.red} />
                <StatBox theme={T} label="GAMMA"     value={greeks.gamma.toFixed(4)} />
                <StatBox theme={T} label="THETA/DAY" value={`₹${greeks.theta.toFixed(1)}`} color={greeks.theta >= 0 ? T.green : T.red} />
              </View>
              <View style={{ flexDirection: 'row' }}>
                <StatBox theme={T} label="VEGA"        value={greeks.vega.toFixed(2)} />
                <StatBox theme={T} label="NET PREMIUM" value={`₹${Math.round(greeks.netPremium).toLocaleString('en-IN')}`} color={greeks.netPremium >= 0 ? T.green : T.red} />
                <StatBox theme={T} label="DIRECTION"
                  value={Math.abs(greeks.delta) < 0.1 ? 'Neutral' : greeks.delta > 0 ? 'Bullish' : 'Bearish'}
                  color={Math.abs(greeks.delta) < 0.1 ? T.textDim : greeks.delta > 0 ? T.green : T.red} />
              </View>
              <Text style={{ color: T.textDim, fontSize: 9, marginTop: 10, lineHeight: 14 }}>
                Greeks computed via Black-Scholes at {iv}% IV, {dte}d to expiry, risk-free rate 7%.
                These are analytical estimates — not live exchange Greeks.
              </Text>
            </Card>
          )}

          {/* ── Strategy notes ────────────────────────────────────────────── */}
          {!showCustom && meta && (
            <Card theme={T}>
              <SectionLabel theme={T}>TRADE NOTES</SectionLabel>
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 2 }}>MAX PROFIT</Text>
                  <Text style={{ color: T.green, fontSize: 11 }}>{meta.maxProfitNote}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', marginBottom: 2 }}>MAX LOSS</Text>
                  <Text style={{ color: T.red, fontSize: 11 }}>{meta.maxLossNote}</Text>
                </View>
              </View>
            </Card>
          )}
        </>)}

      </ScrollView>
    </SafeAreaView>
  );
}
