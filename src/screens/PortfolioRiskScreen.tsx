// ─────────────────────────────────────────────────────────────────────────────
// PortfolioRiskScreen  (v1.0.0)
//
// Unified risk dashboard across all four account types.
// Shows total exposure, leverage, VaR, concentration, and per-account
// breakdown with actionable recommendations.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useData }  from '../context/DataContext';
import {
  computePortfolioRisk, PortfolioRiskReport, AccountSnapshot, PositionRisk,
} from '../utils/portfolioRiskManager';
import { SPACING } from '../theme/colors';
import { OnboardingTooltip } from '../components/OnboardingTooltip';
import { TOOLTIP_IDS } from '../utils/onboarding';
import { HelpButton } from '../components/HelpBottomSheet';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtInr(n: number): string {
  if (Math.abs(n) >= 10_00_000) return `₹${(n / 10_00_000).toFixed(2)}L`;
  if (Math.abs(n) >= 1_000)     return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

function riskColor(level: string, T: any): string {
  switch (level) {
    case 'LOW':       return T.green;
    case 'MODERATE':  return T.accent;
    case 'HIGH':      return T.amber;
    case 'VERY_HIGH': return T.red;
    default:          return T.textDim;
  }
}

function GaugeBar({ pct, color, T }: { pct: number; color: string; T: any }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return (
    <View style={{ height: 6, backgroundColor: T.border, borderRadius: 3, marginTop: 6 }}>
      <View style={{ height: 6, width: `${clamped}%`, backgroundColor: color, borderRadius: 3 }} />
    </View>
  );
}

function MetricCard({ label, value, sub, color, T, gauge, gaugePct }: any) {
  return (
    <View style={{ flex: 1, backgroundColor: T.card, borderRadius: 10, padding: 12,
      borderWidth: 1, borderColor: T.border, margin: 3 }}>
      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
        letterSpacing: 0.6, marginBottom: 4 }}>{label}</Text>
      <Text style={{ color: color ?? T.text, fontSize: 18, fontWeight: '800' }}>{value}</Text>
      {sub && <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>{sub}</Text>}
      {gauge && gaugePct != null && (
        <GaugeBar pct={gaugePct} color={color ?? T.accent} T={T} />
      )}
    </View>
  );
}

function AccountCard({ acct, T }: { acct: AccountSnapshot; T: any }) {
  const pnlColor = acct.unrealisedInr >= 0 ? T.green : T.red;
  const balDisplay = acct.currency === 'USDT'
    ? `$${acct.balance.toFixed(0)}`
    : fmtInr(acct.balance);

  return (
    <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
      borderWidth: 1, borderColor: T.border, marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between',
        alignItems: 'flex-start', marginBottom: 8 }}>
        <View>
          <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>{acct.name}</Text>
          <Text style={{ color: T.textDim, fontSize: 9, marginTop: 1 }}>
            {acct.openPositions} position{acct.openPositions !== 1 ? 's' : ''} open
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ color: T.textDim, fontSize: 9 }}>Balance</Text>
          <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>{balDisplay}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <View>
          <Text style={{ color: T.textDim, fontSize: 8 }}>NOTIONAL</Text>
          <Text style={{ color: T.text, fontSize: 11, fontWeight: '600', marginTop: 2 }}>
            {fmtInr(acct.notionalInr)}
          </Text>
        </View>
        <View style={{ alignItems: 'center' }}>
          <Text style={{ color: T.textDim, fontSize: 8 }}>UNREALISED</Text>
          <Text style={{ color: pnlColor, fontSize: 11, fontWeight: '600', marginTop: 2 }}>
            {acct.unrealisedInr >= 0 ? '+' : ''}{fmtInr(acct.unrealisedInr)}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={{ color: T.textDim, fontSize: 8 }}>REALISED</Text>
          <Text style={{ color: acct.realisedPnL >= 0 ? T.green : T.red,
            fontSize: 11, fontWeight: '600', marginTop: 2 }}>
            {acct.realisedPnL >= 0 ? '+' : ''}{fmtInr(
              acct.currency === 'USDT' ? acct.realisedPnL * 84 : acct.realisedPnL
            )}
          </Text>
        </View>
      </View>
    </View>
  );
}

function PositionRow({ pos, idx, T }: { pos: PositionRisk; idx: number; T: any }) {
  const isLong = pos.direction === 'LONG';
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center',
      paddingVertical: 8, borderBottomWidth: 0.5, borderBottomColor: T.border + '40' }}>
      <Text style={{ color: T.textDim, fontSize: 10, width: 20 }}>{idx + 1}</Text>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>{pos.symbol}</Text>
          <Text style={{ color: isLong ? T.green : T.red, fontSize: 9 }}>
            {isLong ? '▲' : '▼'}
          </Text>
          {pos.leverage > 1 && (
            <Text style={{ color: T.accent, fontSize: 8 }}>{pos.leverage.toFixed(0)}×</Text>
          )}
        </View>
        <Text style={{ color: T.textDim, fontSize: 8 }}>{pos.account}</Text>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ color: T.text, fontSize: 10, fontWeight: '600' }}>
          {fmtInr(pos.notionalInr)}
        </Text>
        <Text style={{ color: T.textDim, fontSize: 8 }}>{pos.weight.toFixed(1)}%</Text>
      </View>
    </View>
  );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function PortfolioRiskScreen() {
  const { theme: T } = useTheme();
  const { prices }   = useData();
  const [report,  setReport]  = useState<PortfolioRiskReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const lp: Record<string, number> = {};
      Object.entries(prices).forEach(([sym, p]) => {
        if ((p as any)?.price > 0) lp[sym] = (p as any).price;
      });
      const r = await computePortfolioRisk(lp);
      setReport(r);
    } catch (e: any) {
      // Fail gracefully — show empty state
    } finally { setLoading(false); }
  }, [prices]);

  useEffect(() => { load(); }, [load]);

  if (!report && !loading) return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0, justifyContent: 'center', alignItems: 'center' }}>
      <Text style={{ color: T.textDim }}>Unable to load risk data</Text>
    </SafeAreaView>
  );

  const rc = report ? riskColor(report.riskLevel, T) : T.textDim;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>
      <ScrollView contentContainerStyle={{ padding: SPACING.md, paddingBottom: 50 }}
>

        {/* Header */}
        <OnboardingTooltip id={TOOLTIP_IDS.PORTFOLIO_RISK} T={T}
          title="Portfolio Risk Manager"
          body="This screen shows your combined exposure across paper, live, NSE futures, and Binance futures accounts. Check it before opening new positions.">
          <View />
        </OnboardingTooltip>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: 16 }}>
          <View>
            <Text style={{ color: T.text, fontSize: 22, fontWeight: '800' }}>
              Portfolio Risk
            </Text>
            <Text style={{ color: T.textDim, fontSize: 10, marginTop: 2 }}>
              Across all accounts · INR equivalent
            </Text>
          </View>
          {report && (
            <View style={{ backgroundColor: rc + '20', borderRadius: 8,
              paddingHorizontal: 12, paddingVertical: 6,
              borderWidth: 1.5, borderColor: rc }}>
              <Text style={{ color: rc, fontSize: 11, fontWeight: '800' }}>
                {report.riskLevel.replace('_', ' ')}
              </Text>
            </View>
          )}
        </View>

        {report && (
          <>
            {/* Total capital + notional hero */}
            <View style={{ backgroundColor: T.card, borderRadius: 12, padding: 16,
              borderWidth: 1, borderColor: T.border, marginBottom: 14 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between',
                marginBottom: 12 }}>
                <View>
                  <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700' }}>
                    TOTAL CAPITAL (all accounts)
                  </Text>
                  <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginTop: 3 }}>
                    {fmtInr(report.totalCapitalInr)}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700' }}>
                    TOTAL EXPOSURE
                  </Text>
                  <Text style={{ color: T.text, fontSize: 22, fontWeight: '800', marginTop: 3 }}>
                    {fmtInr(report.totalNotionalInr)}
                  </Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Text style={{ color: T.textDim, fontSize: 10 }}>
                  Unrealised:{' '}
                  <Text style={{ color: report.totalUnrealisedInr >= 0 ? T.green : T.red,
                    fontWeight: '700' }}>
                    {report.totalUnrealisedInr >= 0 ? '+' : ''}{fmtInr(report.totalUnrealisedInr)}
                  </Text>
                </Text>
                <Text style={{ color: T.textDim, fontSize: 10 }}>
                  Realised:{' '}
                  <Text style={{ color: report.totalRealisedInr >= 0 ? T.green : T.red,
                    fontWeight: '700' }}>
                    {report.totalRealisedInr >= 0 ? '+' : ''}{fmtInr(report.totalRealisedInr)}
                  </Text>
                </Text>
              </View>
            </View>

            {/* Risk metrics grid */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 14 }}>
              <MetricCard label="OVERALL LEVERAGE" T={T}
                value={`${report.overallLeverage.toFixed(1)}×`}
                color={report.overallLeverage > 10 ? T.red : report.overallLeverage > 5 ? T.amber : T.green}
                sub={`${report.marginUtilisationPct.toFixed(0)}% margin used`}
                gauge gaugePct={Math.min(100, report.marginUtilisationPct)} />
              <MetricCard label="CONCENTRATION" T={T}
                value={`${report.concentrationPct.toFixed(0)}%`}
                color={report.concentrationPct > 60 ? T.red : report.concentrationPct > 40 ? T.amber : T.green}
                sub={report.largestPosition ? report.largestPosition.symbol : '—'}
                gauge gaugePct={report.concentrationPct} />
              <MetricCard label="VaR₉₅ (1-day) " T={T}
                value={fmtInr(report.var95Inr)}
                color={report.var95Inr > report.totalCapitalInr * 0.05 ? T.red : T.textSub ?? T.textDim}
                sub={`VaR₉₉: ${fmtInr(report.var99Inr)}`} />
              <MetricCard label="MAX DRAWDOWN" T={T}
                value={`${report.maxDrawdownPct.toFixed(1)}%`}
                color={report.maxDrawdownPct > 20 ? T.red : report.maxDrawdownPct > 10 ? T.amber : T.green}
                sub="worst account" />
            </View>

            {/* Risk factors */}
            {report.riskFactors.length > 0 && (
              <View style={{ backgroundColor: T.red + '12', borderRadius: 10, padding: 14,
                borderWidth: 1, borderColor: T.red + '40', marginBottom: 14 }}>
                <Text style={{ color: T.red, fontSize: 10, fontWeight: '800',
                  marginBottom: 8 }}>⚠ ACTIVE RISK FACTORS</Text>
                {report.riskFactors.map((f, i) => (
                  <Text key={i} style={{ color: T.textDim, fontSize: 10, lineHeight: 16 }}>
                    • {f}
                  </Text>
                ))}
              </View>
            )}

            {/* Recommendations */}
            <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
              borderWidth: 1, borderColor: T.border, marginBottom: 14 }}>
              <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
                letterSpacing: 0.8, marginBottom: 8 }}>RECOMMENDATIONS</Text>
              {report.recommendations.map((r, i) => (
                <Text key={i} style={{ color: T.text, fontSize: 10, lineHeight: 16, marginBottom: 4 }}>
                  {i + 1}. {r}
                </Text>
              ))}
            </View>

            {/* Account breakdown */}
            <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
              letterSpacing: 0.8, marginBottom: 8 }}>ACCOUNTS</Text>
            {report.accounts.map(acct => (
              <AccountCard key={acct.name} acct={acct} T={T} />
            ))}

            {/* Position breakdown */}
            {report.positions.length > 0 && (
              <>
                <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700',
                  letterSpacing: 0.8, marginTop: 6, marginBottom: 8 }}>
                  ALL POSITIONS (by notional, INR)
                </Text>
                <View style={{ backgroundColor: T.card, borderRadius: 10, padding: 14,
                  borderWidth: 1, borderColor: T.border }}>
                  {report.positions.map((pos, i) => (
                    <PositionRow key={pos.id} pos={pos} idx={i} T={T} />
                  ))}
                </View>
              </>
            )}

            <Text style={{ color: T.textDim, fontSize: 8, textAlign: 'center',
              marginTop: 14, lineHeight: 13 }}>
              VaR (Value at Risk) = estimated maximum daily loss at 95% confidence. Margin Utilisation = margin locked / total capital × 100%. Leverage = total notional / total capital.{'\n'}
              INR conversion at ₹{report.usdInrRate}/USD (approximate). Pull to refresh.
            </Text>
          </>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}
