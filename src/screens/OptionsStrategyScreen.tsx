import React, { useState, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Line, Path, Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { useData } from '../context/DataContext';
import { Card, SectionLabel, StatBox, Pill } from '../components/Common';
import { ASSETS } from '../api/assets';
import { pFmt } from '../utils/indicators';
import {
  OptionLeg, STRATEGY_TEMPLATES, calcPayoffCurve, calcNetGreeks, maxProfitLoss, breakevens, blackScholes,
} from '../utils/optionsCalc';

const INDEX_GAPS: Record<string, number> = { NIFTY50: 50, BANKNIFTY: 100, FINNIFTY: 50 };

export default function OptionsStrategyScreen() {
  const { theme: T } = useTheme();
  const { prices } = useData();
  const [symbol, setSymbol] = useState('NIFTY50');
  const [strategyName, setStrategyName] = useState('Long Straddle');
  const [daysToExpiry, setDaysToExpiry] = useState(7);
  const [iv, setIv] = useState(15);

  const spot = prices[symbol]?.price || ASSETS.find(a => a.symbol === symbol)?.base || 24900;
  const gap = INDEX_GAPS[symbol] || Math.round(spot * 0.01 / 10) * 10 || 10;

  const legs: OptionLeg[] = useMemo(() => {
    const template = STRATEGY_TEMPLATES[strategyName](spot, gap);
    return template.map((leg, i) => {
      const T_years = Math.max(daysToExpiry, 0.5) / 365;
      const bs = blackScholes(spot, leg.strike, T_years, 0.07, iv / 100, leg.type);
      return { ...leg, id: `${strategyName}-${i}`, premium: Math.round(bs.price * 100) / 100 };
    });
  }, [strategyName, spot, gap, daysToExpiry, iv]);

  const curve = useMemo(() => calcPayoffCurve(legs, spot), [legs, spot]);
  const { maxProfit, maxLoss } = maxProfitLoss(curve);
  const bePoints = breakevens(curve);
  const greeks = calcNetGreeks(legs, spot, daysToExpiry, iv);

  // Build SVG path for payoff curve
  const W = 340, H = 180, PAD = 30;
  const minP = Math.min(...curve.map(c => c.pnl), 0), maxP = Math.max(...curve.map(c => c.pnl), 0);
  const pRange = maxP - minP || 1;
  const minPrice = curve[0].price, maxPrice = curve[curve.length - 1].price;
  const toX = (price: number) => PAD + ((price - minPrice) / (maxPrice - minPrice)) * (W - PAD * 2);
  const toY = (pnl: number) => H - PAD - ((pnl - minP) / pRange) * (H - PAD * 2);
  const zeroY = toY(0);
  let pathD = '';
  curve.forEach((c, i) => { pathD += (i === 0 ? 'M' : 'L') + `${toX(c.price)},${toY(c.pnl)} `; });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginBottom: 4 }}>Options Strategy Builder</Text>
        <Text style={{ color: T.textDim, fontSize: 11, marginBottom: 16 }}>Multi-leg payoff diagrams with live Greeks</Text>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>UNDERLYING</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {['NIFTY50', 'BANKNIFTY', 'FINNIFTY'].map(s => (
              <Pill key={s} label={s} color={T.blue} active={symbol === s} onPress={() => setSymbol(s)} />
            ))}
          </View>
        </ScrollView>

        <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>STRATEGY</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 14 }}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            {Object.keys(STRATEGY_TEMPLATES).map(s => (
              <Pill key={s} label={s} color={T.purple} active={strategyName === s} onPress={() => setStrategyName(s)} />
            ))}
          </View>
        </ScrollView>

        <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>DAYS TO EXPIRY</Text>
            <View style={{ flexDirection: 'row', gap: 4 }}>
              {[1, 3, 7, 15, 30].map(d => (
                <TouchableOpacity key={d} onPress={() => setDaysToExpiry(d)} style={{ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 4, backgroundColor: daysToExpiry === d ? T.accent : T.bg3 }}>
                  <Text style={{ color: daysToExpiry === d ? '#fff' : T.textSub, fontSize: 10 }}>{d}D</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        <View style={{ marginBottom: 16 }}>
          <Text style={{ color: T.textDim, fontSize: 10, marginBottom: 6 }}>IMPLIED VOLATILITY: {iv}%</Text>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {[10, 15, 20, 25, 30, 40].map(v => (
              <TouchableOpacity key={v} onPress={() => setIv(v)} style={{ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 4, backgroundColor: iv === v ? T.amber : T.bg3 }}>
                <Text style={{ color: iv === v ? '#000' : T.textSub, fontSize: 10 }}>{v}%</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Legs breakdown */}
        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>STRATEGY LEGS — Spot {pFmt(spot)}</SectionLabel>
          {legs.map((leg, i) => (
            <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: T.border }}>
              <Text style={{ color: leg.action === 'BUY' ? T.green : T.red, fontWeight: '700', fontSize: 11 }}>{leg.action} {leg.type} {leg.strike}</Text>
              <Text style={{ color: T.textSub, fontSize: 11 }}>Premium ₹{leg.premium.toFixed(2)}</Text>
            </View>
          ))}
        </Card>

        {/* Payoff diagram */}
        <Card theme={T} style={{ marginBottom: 14 }}>
          <SectionLabel theme={T}>PAYOFF AT EXPIRY</SectionLabel>
          <Svg width={W} height={H}>
            <Line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke={T.textDim} strokeWidth={1} strokeDasharray="3,4" />
            <Line x1={toX(spot)} y1={PAD} x2={toX(spot)} y2={H - PAD} stroke={T.blue} strokeWidth={1} strokeDasharray="2,3" />
            <Path d={pathD} stroke={maxProfit > Math.abs(maxLoss) ? T.green : T.amber} strokeWidth={2} fill="none" />
            <SvgText x={toX(spot)} y={PAD - 6} fontSize={9} fill={T.blue} textAnchor="middle">SPOT</SvgText>
            {bePoints.map((bp, i) => (
              <SvgText key={i} x={toX(bp)} y={H - 4} fontSize={8} fill={T.amber} textAnchor="middle">{bp.toFixed(0)}</SvgText>
            ))}
          </Svg>
          <View style={{ flexDirection: 'row', marginTop: 8 }}>
            <StatBox theme={T} label="MAX PROFIT" value={maxProfit >= 99999 ? 'Unlimited' : `₹${maxProfit.toFixed(0)}`} color={T.green} />
            <StatBox theme={T} label="MAX LOSS" value={`₹${maxLoss.toFixed(0)}`} color={T.red} />
            <StatBox theme={T} label="BREAKEVENS" value={bePoints.map(b => b.toFixed(0)).join(', ') || '—'} />
          </View>
        </Card>

        {/* Net Greeks */}
        <Card theme={T}>
          <SectionLabel theme={T}>NET POSITION GREEKS</SectionLabel>
          <View style={{ flexDirection: 'row' }}>
            <StatBox theme={T} label="DELTA" value={greeks.delta.toFixed(3)} color={greeks.delta >= 0 ? T.green : T.red} />
            <StatBox theme={T} label="GAMMA" value={greeks.gamma.toFixed(4)} />
            <StatBox theme={T} label="THETA/DAY" value={`₹${greeks.theta.toFixed(1)}`} color={greeks.theta >= 0 ? T.green : T.red} />
          </View>
          <View style={{ flexDirection: 'row' }}>
            <StatBox theme={T} label="VEGA" value={greeks.vega.toFixed(2)} />
            <StatBox theme={T} label="NET PREMIUM" value={`₹${greeks.netPremium.toFixed(0)}`} color={greeks.netPremium >= 0 ? T.green : T.red} />
          </View>
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 8, lineHeight: 14 }}>
            Greeks computed via Black-Scholes using the IV you selected above — not live exchange Greeks (those require a separate options-chain feed), but directionally accurate for position planning.
          </Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}
