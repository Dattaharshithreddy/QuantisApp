// ─────────────────────────────────────────────────────────────────────────────
// OnboardingScreen  (v1.0.0)
//
// 10-step onboarding flow. Appears only on first launch.
// Architecture: single screen with step-based rendering — avoids creating
// 10 separate navigation entries and keeps all state in one component.
//
// Steps:
//   1  Welcome
//   2  Choose Experience
//   3  AI Predictions (READY / WAIT / AVOID)
//   4  Paper vs Live Trading
//   5  Risk Management
//   6  Futures
//   7  AI Coach
//   8  First Paper Trade walkthrough
//   9  Broker Setup (conditional — only if 'live' experience selected)
//  10  You're Ready
//
// State: only OnboardingExperience is persisted (via onboarding.ts).
// Completion is written to AsyncStorage on "Start Using QUANTIS".
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useRef, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Animated, Dimensions} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useTheme } from '../context/ThemeContext';
import { markOnboardingComplete, saveExperience, OnboardingExperience} from '../utils/onboarding';
import { RADIUS, SPACING } from '../theme/colors';

const { width: W } = Dimensions.get('window');

// ── Props ──────────────────────────────────────────────────────────────────────
type Props = {
  onComplete: () => void;
};

// ── Step definitions ──────────────────────────────────────────────────────────
// Total steps depends on experience selection — live adds step 9 (broker setup)
const BASE_STEPS = 10;

// ── Shared sub-components ─────────────────────────────────────────────────────

function ProgressBar({ step, total, T }: { step: number; total: number; T: any }) {
  return (
    <View style={{ paddingHorizontal: SPACING.lg, paddingTop: 8, paddingBottom: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between',
        marginBottom: 6 }}>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700' }}>
          Step {step} of {total}
        </Text>
        <Text style={{ color: T.textDim, fontSize: 10 }}>
          {Math.round((step / total) * 100)}%
        </Text>
      </View>
      <View style={{ height: 4, backgroundColor: T.bg3, borderRadius: 2 }}>
        <Animated.View style={{
          height: 4, borderRadius: 2, backgroundColor: T.accent,
          width: `${(step / total) * 100}%`}} />
      </View>
    </View>
  );
}

function StepHeader({ icon, title, subtitle, T }: any) {
  return (
    <View style={{ alignItems: 'center', paddingHorizontal: SPACING.lg,
      paddingTop: SPACING.xl, paddingBottom: SPACING.lg }}>
      <Text style={{ fontSize: 48, marginBottom: SPACING.md }}>{icon}</Text>
      <Text style={{ color: T.text, fontSize: 24, fontWeight: '800',
        textAlign: 'center', letterSpacing: -0.5, marginBottom: 8 }}>
        {title}
      </Text>
      {subtitle && (
        <Text style={{ color: T.textSub, fontSize: 14, textAlign: 'center',
          lineHeight: 22, maxWidth: 300 }}>
          {subtitle}
        </Text>
      )}
    </View>
  );
}

function InfoCard({ icon, title, body, color, T }: any) {
  return (
    <View style={{ backgroundColor: T.card, borderRadius: RADIUS.md, padding: SPACING.md,
      borderWidth: 1, borderColor: T.border, marginBottom: SPACING.sm,
      borderLeftWidth: 3, borderLeftColor: color }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
        <Text style={{ fontSize: 18, marginRight: 8 }}>{icon}</Text>
        <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>{title}</Text>
      </View>
      <Text style={{ color: T.textSub, fontSize: 12, lineHeight: 18, marginLeft: 26 }}>
        {body}
      </Text>
    </View>
  );
}

function SignalBadge({ label, color, T }: { label: string; color: string; T: any }) {
  return (
    <View style={{ backgroundColor: color + '20', borderRadius: RADIUS.sm,
      paddingHorizontal: 14, paddingVertical: 8, borderWidth: 1.5, borderColor: color,
      alignItems: 'center', flex: 1, marginHorizontal: 4 }}>
      <Text style={{ color, fontSize: 13, fontWeight: '800', marginBottom: 2 }}>
        {label}
      </Text>
    </View>
  );
}

function WarnBanner({ text, T }: { text: string; T: any }) {
  return (
    <View style={{ backgroundColor: T.red + '15', borderRadius: RADIUS.sm,
      padding: SPACING.sm, borderWidth: 1, borderColor: T.red + '40',
      marginVertical: SPACING.sm, flexDirection: 'row', alignItems: 'flex-start' }}>
      <Text style={{ fontSize: 16, marginRight: 8, marginTop: 1 }}>⚠️</Text>
      <Text style={{ color: T.text, fontSize: 12, lineHeight: 18, flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

// ── Step content renderers ─────────────────────────────────────────────────────

function Step1Welcome({ T, onNext, onSkip }: any) {
  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, padding: SPACING.lg }}>
      <LinearGradient
        colors={T.accentGradient}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={{ borderRadius: RADIUS.lg, padding: SPACING.xl,
          alignItems: 'center', marginBottom: SPACING.lg }}>
        <Text style={{ fontSize: 64, marginBottom: 12 }}>📊</Text>
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800',
          letterSpacing: -0.5, marginBottom: 6 }}>Welcome to QUANTIS</Text>
        <Text style={{ color: '#ffffffcc', fontSize: 14, textAlign: 'center',
          lineHeight: 22 }}>
          Your AI-powered algorithmic trading terminal
        </Text>
      </LinearGradient>

      <InfoCard icon="🤖" title="AI-Powered Predictions" color={T.accent} T={T}
        body="A 129-feature machine learning model analyses market structure, volatility, volume, multi-timeframe data, and live macro context (Fear & Greed, FII flow, VIX, funding rate, event proximity) to generate BUY or SELL signals with confidence scores." />
      <InfoCard icon="📈" title="Paper & Live Trading" color={T.green} T={T}
        body="Practice with paper trading first — no real money, full features. When ready, connect your broker and trade live with the same AI signals." />
      <InfoCard icon="📊" title="NSE & Crypto Futures" color={T.amber} T={T}
        body="Trade NIFTY, BANKNIFTY, and crypto perpetuals with proper lot sizing, margin tracking, and daily P&L settlement." />
      <InfoCard icon="🧠" title="AI Trading Coach" color={T.purple} T={T}
        body="After 10+ trades, the coach analyses your history and tells you exactly where you lose money and how to improve." />
    </ScrollView>
  );
}

function Step2Experience({ T, onSelect, selected }: any) {
  const options: { id: OnboardingExperience; icon: string; label: string; desc: string }[] = [
    { id: 'learn',    icon: '📚', label: 'Learn Trading',    desc: 'Understand how the AI and signals work' },
    { id: 'paper',    icon: '🧪', label: 'Paper Trading',    desc: 'Practice with virtual money, no risk' },
    { id: 'live',     icon: '🔴', label: 'Live Trading',     desc: 'Trade real money with broker integration' },
    { id: 'futures',  icon: '⚡', label: 'Futures',          desc: 'Leveraged NSE and crypto perpetuals' },
    { id: 'analytics',icon: '🔬', label: 'AI Analytics',    desc: 'Research signals, backtesting, and validation' },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg }}>
      <StepHeader icon="🎯" title="What brings you here?"
        subtitle="This helps us personalise the walkthrough. You can use all features regardless of your choice."
        T={T} />
      {options.map(opt => (
        <TouchableOpacity key={opt.id}
          onPress={() => onSelect(opt.id)}
          accessibilityLabel={opt.label}
          accessibilityRole="radio"
          accessibilityState={{ selected: selected === opt.id }}
          style={{ flexDirection: 'row', alignItems: 'center',
            backgroundColor: selected === opt.id ? T.accent + '20' : T.card,
            borderRadius: RADIUS.md, padding: SPACING.md, marginBottom: SPACING.sm,
            borderWidth: 1.5,
            borderColor: selected === opt.id ? T.accent : T.border }}>
          <Text style={{ fontSize: 26, marginRight: SPACING.md }}>{opt.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.text, fontSize: 14, fontWeight: '700',
              marginBottom: 2 }}>{opt.label}</Text>
            <Text style={{ color: T.textDim, fontSize: 12 }}>{opt.desc}</Text>
          </View>
          {selected === opt.id && (
            <View style={{ width: 20, height: 20, borderRadius: 10,
              backgroundColor: T.accent, justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 12 }}>✓</Text>
            </View>
          )}
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function Step3Predictions({ T }: any) {
  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg }}>
      <StepHeader icon="🤖" title="AI Predictions"
        subtitle="The AI produces a signal on every chart. Here's what each state means."
        T={T} />

      {/* Signal badges */}
      <View style={{ flexDirection: 'row', marginBottom: SPACING.lg }}>
        <SignalBadge label="✓ READY" color={T.green}  T={T} />
        <SignalBadge label="◆ WAIT"  color={T.amber}  T={T} />
        <SignalBadge label="✕ AVOID" color={T.red}    T={T} />
      </View>

      <InfoCard icon="✓" title="READY — All gates passed" color={T.green} T={T}
        body="Regime supports the direction. Confidence is above threshold. Multi-timeframe alignment confirmed. Market context is not adverse. This is the best time to trade." />
      <InfoCard icon="◆" title="WAIT — Conditions are mixed" color={T.amber} T={T}
        body="The prediction direction is present but one or more gates are cautioning. The signal exists, but conditions are not optimal. You can override and trade, but take smaller size." />
      <InfoCard icon="✕" title="AVOID — Multiple gates blocked" color={T.red} T={T}
        body="Several gates are blocking entry. Regime is wrong, confidence is low, or market context is adverse. The risk/reward is unfavourable right now." />

      <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md, padding: SPACING.md,
        marginTop: SPACING.sm }}>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '800',
          letterSpacing: 0.8, marginBottom: 8 }}>KEY METRICS</Text>
        {[
          ['Confidence', '0–100 score. Above 65 is moderate, above 80 is strong.'],
          ['Regime', 'Current market behaviour: BULL_TREND, BEAR_TREND, RANGING, HIGH_VOLATILITY.'],
          ['Strategy', 'SCALPING, INTRADAY, SWING, or POSITION — tuned for your timeframe.'],
          ['Market Context', 'VIX, FII/DII, Fear & Greed, and other macro signals.'],
        ].map(([label, desc]) => (
          <View key={label} style={{ flexDirection: 'row', marginBottom: 8, alignItems: 'flex-start' }}>
            <Text style={{ color: T.accent, fontSize: 11, fontWeight: '700',
              width: 100, flexShrink: 0 }}>{label}</Text>
            <Text style={{ color: T.text, fontSize: 11, lineHeight: 16, flex: 1 }}>
              {desc}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Step4PaperVsLive({ T }: any) {
  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg }}>
      <StepHeader icon="🔄" title="Paper vs Live Trading"
        subtitle="Start with Paper Trading. Move to Live only when you're consistently profitable."
        T={T} />

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: SPACING.lg }}>
        {/* Paper */}
        <View style={{ flex: 1, backgroundColor: T.green + '15', borderRadius: RADIUS.md,
          padding: SPACING.md, borderWidth: 1, borderColor: T.green + '40' }}>
          <Text style={{ color: T.green, fontSize: 18, marginBottom: 6 }}>🧪</Text>
          <Text style={{ color: T.green, fontSize: 14, fontWeight: '800',
            marginBottom: 8 }}>Paper Trading</Text>
          {['No real money', 'Full AI signals', 'Full analytics', 'No broker needed',
            'Reset anytime', 'Learn risk-free'].map(f => (
            <Text key={f} style={{ color: T.text, fontSize: 11, marginBottom: 3 }}>
              ✓ {f}
            </Text>
          ))}
        </View>

        {/* Live */}
        <View style={{ flex: 1, backgroundColor: T.red + '12', borderRadius: RADIUS.md,
          padding: SPACING.md, borderWidth: 1, borderColor: T.red + '40' }}>
          <Text style={{ color: T.red, fontSize: 18, marginBottom: 6 }}>🔴</Text>
          <Text style={{ color: T.red, fontSize: 14, fontWeight: '800',
            marginBottom: 8 }}>Live Trading</Text>
          {['Real money at risk', 'Same AI signals', 'Broker required', 'Order lifecycle tracked',
            'Reconciliation', 'Kill switch'].map(f => (
            <Text key={f} style={{ color: T.text, fontSize: 11, marginBottom: 3 }}>
              • {f}
            </Text>
          ))}
        </View>
      </View>

      <InfoCard icon="📋" title="Shadow Journal" color={T.blue} T={T}
        body="Every time QUANTIS says WAIT or AVOID and you don't trade, the signal is recorded. Later you can see if the AI was right — valuable for understanding when to trust the signal and when to override." />

      <WarnBanner T={T} text="Never start with Live Trading. Spend at least 2–4 weeks in Paper Trading first. Understand when the AI is right and when it isn't before real money is involved." />
    </ScrollView>
  );
}

function Step5Risk({ T }: any) {
  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg }}>
      <StepHeader icon="🛡️" title="Risk Management"
        subtitle="Every trade has predefined risk levels. The AI sets them — you can adjust."
        T={T} />

      <InfoCard icon="🔴" title="Stop Loss" color={T.red} T={T}
        body="The price at which a losing trade is automatically closed. Limits your maximum loss on any single trade. Always set a stop loss before entering." />
      <InfoCard icon="🟢" title="Take Profit" color={T.green} T={T}
        body="The price at which a winning trade is automatically closed to lock in profit. The AI sets this based on technical levels and expected move size." />
      <InfoCard icon="📐" title="Position Size" color={T.accent} T={T}
        body="How many shares or contracts to buy. QUANTIS uses risk-based sizing: by default, if your stop loss is hit, you lose at most 2% of your account. This keeps any single loss small." />
      <InfoCard icon="📊" title="Portfolio Risk Manager" color={T.purple} T={T}
        body="Monitors all open positions across all accounts simultaneously. Shows total exposure, leverage, Value at Risk (VaR), and concentration risk. If leverage is too high, it alerts you." />

      <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md,
        padding: SPACING.md, marginTop: SPACING.sm }}>
        <Text style={{ color: T.text, fontSize: 12, lineHeight: 20 }}>
          <Text style={{ fontWeight: '800' }}>The golden rule: </Text>
          Never risk more than 1–2% of your account on a single trade. If 10 trades lose in a row (even great traders have losing streaks), you are only down 10–20% — recoverable. Risking 10% per trade means one bad streak wipes out your account.
        </Text>
      </View>
    </ScrollView>
  );
}

function Step6Futures({ T }: any) {
  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg }}>
      <StepHeader icon="⚡" title="Futures Trading"
        subtitle="NSE F&O and Binance perpetuals. Higher potential — but significantly higher risk."
        T={T} />

      <WarnBanner T={T} text="Futures are leveraged instruments. Losses can exceed your initial margin. Only trade futures if you fully understand leverage and liquidation. Complete at least 2–3 months of paper equity trading first." />

      <InfoCard icon="📐" title="Leverage" color={T.amber} T={T}
        body="Futures let you control a large position with a small amount of capital. At 10× leverage, ₹1L of margin controls ₹10L of notional exposure. A 1% move in your favour = 10% return on margin. But a 1% move against you = 10% loss." />
      <InfoCard icon="💰" title="Margin" color={T.accent} T={T}
        body="Instead of paying the full value, you deposit a percentage as margin. For NIFTY futures, this is typically 10–12% of notional value. The rest is borrowed leverage." />
      <InfoCard icon="⚠️" title="Liquidation" color={T.red} T={T}
        body="If the market moves against you and your losses consume your margin, the exchange force-closes your position. You lose the entire margin. At 100× leverage, a 1% adverse move can liquidate you." />
      <InfoCard icon="💸" title="Funding Rate (Crypto)" color={T.blue} T={T}
        body="Binance perpetuals charge or credit you every 8 hours. When longs pay (positive funding rate), you pay a small amount to hold your long position. Over days, this adds up." />
      <InfoCard icon="🔧" title="NSE F&O Specifics" color={T.green} T={T}
        body="NSE futures expire on the last Thursday of each month. Daily MTM settlement means your profit or loss is credited/debited to your account every market close, not just when you exit." />
    </ScrollView>
  );
}

function Step7Coach({ T }: any) {
  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg }}>
      <StepHeader icon="🧠" title="Your AI Trading Coach"
        subtitle="After 10+ trades, the coach analyses your history and gives you personalised feedback."
        T={T} />

      <InfoCard icon="📊" title="Performance Analytics" color={T.accent} T={T}
        body="Win rate, profit factor, average P&L, and return on equity calculated from your actual trade history — not hypothetical scenarios." />
      <InfoCard icon="🔍" title="Mistake Detection" color={T.red} T={T}
        body="'You lose money when overriding AVOID in HIGH_VOLATILITY.' The coach identifies specific conditions where your trading breaks down, using real data from your shadow journal and override history." />
      <InfoCard icon="📈" title="Confidence Calibration" color={T.green} T={T}
        body="Does a 90% confidence signal actually win 90% of the time for you? The coach checks whether the AI's confidence scores are well-calibrated for your trading style." />
      <InfoCard icon="🎯" title="Strategy Analysis" color={T.amber} T={T}
        body="Compares your performance across SCALPING, INTRADAY, SWING, and POSITION strategies. Shows which strategy profile suits your trading personality best." />
      <InfoCard icon="💡" title="Recommendations" color={T.purple} T={T}
        body="'Your SWING trades in BULL_TREND outperform your SCALPING by 23%.' The coach gives actionable, data-backed suggestions — not generic advice." />

      <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md,
        padding: SPACING.md, marginTop: SPACING.sm }}>
        <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 18 }}>
          The coach unlocks after 10 completed trades. The more you trade,
          the more specific and accurate the insights become. All analysis
          is based on YOUR data — nothing is fabricated.
        </Text>
      </View>
    </ScrollView>
  );
}

function Step8FirstTrade({ T }: any) {
  const steps = [
    { n: '1', icon: '📊', title: 'Open the Chart',
      body: 'Tap "Chart" in the bottom tab bar. The chart loads live market data automatically.' },
    { n: '2', icon: '▶️', title: 'Run a Prediction',
      body: 'Scroll down to the AI Prediction panel and tap "Run Prediction". The model analyses current market conditions and returns a signal in under 5 seconds.' },
    { n: '3', icon: '✓', title: 'Read the Signal',
      body: 'You will see READY, WAIT, or AVOID with a confidence score and regime label. If it says READY, you can open a trade.' },
    { n: '4', icon: '🧪', title: 'Open a Paper Trade',
      body: 'Make sure the PAPER/LIVE toggle shows "PAPER" (the default). Tap "▲ Open Long" or "▼ Open Short". The position is recorded instantly.' },
    { n: '5', icon: '📋', title: 'Find Your Position',
      body: 'Go to More → Paper Trading. Your open position shows entry price, current P&L, stop loss, and take profit.' },
    { n: '6', icon: '🔒', title: 'Close the Position',
      body: 'Tap "Close Position" in the paper trading screen. The realised P&L is recorded. Your signal snapshot (what the AI said when you opened) is saved for review.' },
  ];

  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg }}>
      <StepHeader icon="🚀" title="Your First Paper Trade"
        subtitle="Follow these 6 steps to complete your first trade. Takes about 2 minutes."
        T={T} />

      {steps.map(s => (
        <View key={s.n} style={{ flexDirection: 'row', marginBottom: SPACING.md,
          backgroundColor: T.card, borderRadius: RADIUS.md, padding: SPACING.md,
          borderWidth: 1, borderColor: T.border }}>
          <View style={{ width: 32, height: 32, borderRadius: 16,
            backgroundColor: T.accent, justifyContent: 'center', alignItems: 'center',
            marginRight: SPACING.md, flexShrink: 0, marginTop: 2 }}>
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800' }}>{s.n}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, marginBottom: 4 }}>{s.icon}{'  '}
              <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>
                {s.title}
              </Text>
            </Text>
            <Text style={{ color: T.textSub, fontSize: 12, lineHeight: 18 }}>
              {s.body}
            </Text>
          </View>
        </View>
      ))}

      <View style={{ backgroundColor: T.green + '15', borderRadius: RADIUS.md,
        padding: SPACING.md, borderWidth: 1, borderColor: T.green + '40',
        marginTop: SPACING.sm }}>
        <Text style={{ color: T.green, fontWeight: '800', marginBottom: 4 }}>
          💡 After your first trade
        </Text>
        <Text style={{ color: T.text, fontSize: 12, lineHeight: 18 }}>
          Check More → AI Trading Coach after 10 trades. Check More → Shadow Journal to see every signal QUANTIS generated, whether you traded it or not.
        </Text>
      </View>
    </ScrollView>
  );
}

function Step9BrokerSetup({ T, onNext }: any) {
  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg }}>
      <StepHeader icon="🔌" title="Connect Your Broker"
        subtitle="Required for live trading. You can skip this and connect later in Settings."
        T={T} />

      <InfoCard icon="🇮🇳" title="Angel One (NSE/BSE)" color={T.orange} T={T}
        body="Connect your Angel One SmartAPI account to trade Indian equities and F&O live. You'll need your API Key, Client Code, Password, and TOTP secret." />
      <InfoCard icon="₿" title="Binance (Crypto)" color={T.amber} T={T}
        body="Connect your Binance account to trade crypto spot and perpetual futures live. You'll need an API Key and Secret from your Binance account settings." />

      <View style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md,
        padding: SPACING.md, marginTop: SPACING.sm, marginBottom: SPACING.md }}>
        <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '800',
          letterSpacing: 0.8, marginBottom: 8 }}>HOW TO CONNECT</Text>
        {[
          'Go to More → Broker Connection (after setup)',
          'For Angel One: enter your SmartAPI credentials',
          'For Binance: enter your API key (restrict to "Enable Spot & Margin Trading")',
          'Tap Connect — the app verifies the connection',
          'Your API keys are stored in encrypted SecureStore, never in plain storage',
        ].map((step, i) => (
          <Text key={i} style={{ color: T.text, fontSize: 12, lineHeight: 20,
            marginBottom: 4 }}>
            {i + 1}. {step}
          </Text>
        ))}
      </View>

      <WarnBanner T={T} text="Before going live, spend at least 2–4 weeks paper trading to verify the AI works well for your instruments and risk tolerance. Live trading with real money should be approached cautiously." />
    </ScrollView>
  );
}

function Step10Ready({ T, onComplete, onRestart }: any) {
  return (
    <ScrollView contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }}>
      <LinearGradient
        colors={T.accentGradient}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
        style={{ borderRadius: RADIUS.lg, padding: SPACING.xl,
          alignItems: 'center', width: '100%', marginBottom: SPACING.lg }}>
        <Text style={{ fontSize: 60, marginBottom: 12 }}>🎉</Text>
        <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800',
          textAlign: 'center', marginBottom: 8 }}>You're Ready!</Text>
        <Text style={{ color: '#ffffffcc', fontSize: 14, textAlign: 'center',
          lineHeight: 22 }}>
          All features are now unlocked. Start with Paper Trading to build confidence before going live.
        </Text>
      </LinearGradient>

      <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '800',
        letterSpacing: 0.8, marginBottom: 12, alignSelf: 'flex-start' }}>
        FEATURES UNLOCKED
      </Text>

      {[
        ['🤖', 'AI Signal Engine',       '129-feature ML prediction on any chart'],
        ['🧪', 'Paper Trading',           'Full trading simulation, no risk'],
        ['📊', 'NSE & Crypto Futures',    'Leveraged instruments with margin tracking'],
        ['🧠', 'AI Trading Coach',        'Personalised analysis after 10+ trades'],
        ['🛡️', 'Portfolio Risk Manager', 'Unified risk view across all accounts'],
        ['📡', 'Broker Integration',      'Angel One + Binance live trading'],
        ['🔍', 'Audit Trail',             'Every order, every reconciliation, forever'],
        ['🩺', 'Health Dashboard',        'System diagnostics and crash reporting'],
      ].map(([icon, title, desc]) => (
        <View key={title} style={{ flexDirection: 'row', alignItems: 'center',
          width: '100%', marginBottom: SPACING.sm }}>
          <Text style={{ fontSize: 20, width: 32 }}>{icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: T.text, fontSize: 12, fontWeight: '700' }}>{title}</Text>
            <Text style={{ color: T.textDim, fontSize: 10, marginTop: 1 }}>{desc}</Text>
          </View>
          <Text style={{ color: T.green, fontSize: 14 }}>✓</Text>
        </View>
      ))}

      <TouchableOpacity onPress={onRestart}
        style={{ marginTop: SPACING.lg, padding: SPACING.sm }}>
        <Text style={{ color: T.textDim, fontSize: 12, textDecorationLine: 'underline' }}>
          Restart Tutorial
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ── Main OnboardingScreen ─────────────────────────────────────────────────────

export default function OnboardingScreen({ onComplete }: Props) {
  const { theme: T }  = useTheme();
  const [step,        setStep]       = useState(1);
  const [experience,  setExperience] = useState<OnboardingExperience | null>(null);
  const [saving,      setSaving]     = useState(false);

  // Steps: base 10, but step 9 (broker) only shown if experience === 'live'
  const totalSteps = experience === 'live' ? 10 : 9;

  // Map logical step to display step (skip broker setup at step 9 if not live)
  function getContentStep(s: number): number {
    // Steps 1–8 are always the same
    if (s <= 8) return s;
    // Step 9 in live flow = broker setup (index 9)
    // Step 9 in other flows = ready screen (index 10)
    if (experience === 'live') return s;  // 9 = broker, 10 = ready
    return s + 1;  // skip broker — 9 becomes the ready screen
  }

  function canGoNext(): boolean {
    if (step === 2 && !experience) return false;
    return true;
  }

  async function handleNext() {
    if (!canGoNext()) return;
    if (step === 2 && experience) await saveExperience(experience);
    if (step === totalSteps) {
      await handleFinish();
      return;
    }
    setStep(s => s + 1);
  }

  function handleBack() {
    setStep(s => Math.max(1, s - 1));
  }

  async function handleSkip() {
    await markOnboardingComplete();
    onComplete();
  }

  async function handleFinish() {
    if (saving) return;
    setSaving(true);
    await markOnboardingComplete();
    onComplete();
  }

  async function handleRestart() {
    setStep(1);
    setExperience(null);
  }

  function renderStep() {
    const contentStep = getContentStep(step);
    switch (contentStep) {
      case 1:  return <Step1Welcome T={T} onNext={handleNext} onSkip={handleSkip} />;
      case 2:  return <Step2Experience T={T} onSelect={setExperience} selected={experience} />;
      case 3:  return <Step3Predictions T={T} />;
      case 4:  return <Step4PaperVsLive T={T} />;
      case 5:  return <Step5Risk T={T} />;
      case 6:  return <Step6Futures T={T} />;
      case 7:  return <Step7Coach T={T} />;
      case 8:  return <Step8FirstTrade T={T} />;
      case 9:  return <Step9BrokerSetup T={T} onNext={handleNext} />;
      case 10: return <Step10Ready T={T} onComplete={handleFinish} onRestart={handleRestart} />;
      default: return null;
    }
  }

  const isLastStep = step === totalSteps;
  const isFirstStep = step === 1;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}
      accessibilityLabel="Onboarding tutorial">
      {/* Progress bar */}
      <ProgressBar step={step} total={totalSteps} T={T} />

      {/* Step content */}
      <View style={{ flex: 1 }}>
        {renderStep()}
      </View>

      {/* Navigation footer */}
      <View style={{ padding: SPACING.lg, paddingBottom: SPACING.xl,
        borderTopWidth: 1, borderTopColor: T.border,
        flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>

        {/* Back */}
        {!isFirstStep ? (
          <TouchableOpacity onPress={handleBack}
            accessibilityLabel="Go back"
            accessibilityRole="button"
            style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md,
              paddingVertical: 14, paddingHorizontal: 20,
              borderWidth: 1, borderColor: T.border, minHeight: 48 }}>
            <Text style={{ color: T.text, fontWeight: '700', fontSize: 14 }}>← Back</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity onPress={handleSkip}
            accessibilityLabel="Skip tutorial"
            accessibilityRole="button"
            style={{ backgroundColor: T.bg3, borderRadius: RADIUS.md,
              paddingVertical: 14, paddingHorizontal: 16,
              borderWidth: 1, borderColor: T.border, minHeight: 48 }}>
            <Text style={{ color: T.textDim, fontWeight: '700', fontSize: 13 }}>Skip</Text>
          </TouchableOpacity>
        )}

        {/* Next / Finish */}
        <TouchableOpacity
          onPress={isLastStep ? handleFinish : handleNext}
          disabled={!canGoNext() || saving}
          accessibilityLabel={isLastStep ? 'Start using QUANTIS' : 'Next step'}
          accessibilityRole="button"
          style={{ flex: 1, backgroundColor: canGoNext() ? T.accent : T.bg3,
            borderRadius: RADIUS.md, paddingVertical: 14, alignItems: 'center',
            opacity: (!canGoNext() || saving) ? 0.6 : 1, minHeight: 48 }}>
          <Text style={{ color: canGoNext() ? '#fff' : T.textDim,
            fontWeight: '800', fontSize: 14 }}>
            {isLastStep ? (saving ? 'Starting…' : '🚀 Start Using QUANTIS') : 'Next →'}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
