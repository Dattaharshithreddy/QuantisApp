// ─────────────────────────────────────────────────────────────────────────────
// FAQ SCREEN  v1.0
// Accessible via More → Help & FAQ
// Standalone screen — not embedded in Settings.
// Features: category tabs, live search, expandable accordion, disclaimer.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { RADIUS, SPACING } from '../theme/colors';

// ── Data ──────────────────────────────────────────────────────────────────────

type Category = 'All' | 'How it works' | 'Paper Trading' | 'Brokers & Data' | 'Signals & Strategy' | 'Risk & Safety' | 'AI Copilot';

type FAQItem = {
  icon: string;
  q: string;
  a: string;
  category: Category;
};

const FAQ_ITEMS: FAQItem[] = [
  // ── How it works ────────────────────────────────────────────────────────────
  {
    icon: '🧠',
    category: 'How it works',
    q: 'How does QUANTIS make predictions?',
    a: 'QUANTIS trains a two-model ensemble (MLP neural network + logistic regression) directly on your device using 129 features — 116 OHLCV-derived technical indicators plus 13 macro context features (Fear & Greed, FII/DII flow, VIX, PCR, funding rate, event proximity) — extracted from recent candles. Both models vote — when they agree and confidence exceeds the threshold, an actionable BUY or SELL signal is generated. No internet is required for the ML engine itself.'},
  {
    icon: '⏱️',
    category: 'How it works',
    q: 'How often should I retrain the model?',
    a: 'The app monitors new candles automatically and suggests retraining when drift is detected. As a rule of thumb: retrain after 30–50 new candles, or any time market regime shifts significantly (e.g. after a major macro event). Tap "Predict" on the chart screen — the engine retrains if needed.'},
  {
    icon: '📊',
    category: 'How it works',
    q: 'What does the confidence score mean?',
    a: 'Confidence (0–100%) measures how strongly the ensemble agrees on direction, weighted by feature quality, market structure, SMC order block alignment, MTF confirmation, and regime stability.\n\n• Above 70% — high conviction\n• 50–70% — moderate; proceed cautiously\n• Below 50% — low; system shows WAIT or AVOID'},
  {
    icon: '🔀',
    category: 'How it works',
    q: 'What is Trade Readiness: READY / WAIT / AVOID?',
    a: 'Trade Readiness is the final signal state after all gates pass.\n\n• READY — all conditions met; the setup qualifies.\n• WAIT — a higher timeframe is misaligned, or a gate is borderline; watch and wait for improvement.\n• AVOID — a hard blocker triggered (CHoCH against direction, regime mismatch, strategy filter).'},
  {
    icon: '🌐',
    category: 'How it works',
    q: 'What does Multi-Timeframe (MTF) analysis do?',
    a: 'MTF analysis checks whether higher timeframes (H1, H4, D) agree with your entry timeframe signal. A 15-min BUY that fights a Daily downtrend is flagged as conflicting. The system shows which timeframe is blocking and why, so you understand the full picture before entering.'},
  {
    icon: '📐',
    category: 'How it works',
    q: 'What is SMC / Smart Money Concepts?',
    a: 'SMC looks for institutional order blocks (OBs), Fair Value Gaps (FVGs), Break of Structure (BOS), and Change of Character (CHoCH). These zones represent where smart money is likely positioned. QUANTIS uses them to confirm or block signals — entering from a bullish OB with a BUY signal carries more weight than entering in open space.'},
  {
    icon: '🛡️',
    category: 'How it works',
    q: 'What is the Regime Filter?',
    a: 'The Regime Engine classifies the current market into one of 11 states (TREND_BULL, TREND_BEAR, RANGING, BREAKOUT, MEAN_REVERSION, etc.). Some strategies only work in trending regimes — the filter blocks entries when the regime is incompatible with your active strategy profile.'},

  // ── Paper Trading ────────────────────────────────────────────────────────────
  {
    icon: '📝',
    category: 'Paper Trading',
    q: 'What is Paper Trading?',
    a: 'Paper trading simulates real trades using a virtual portfolio — no real money is involved. Every signal can be paper-traded so you can validate the model\'s performance before committing capital. P&L, win rate, and drawdown are tracked in the Journal.'},
  {
    icon: '🔵',
    category: 'Paper Trading',
    q: 'What is a Shadow Trade?',
    a: 'A Shadow Trade is recorded automatically every time a signal is generated but blocked by a gate (regime mismatch, low confidence, strategy filter, duplicate position). It lets you see what would have happened if you had overridden the system — useful for evaluating whether a gate is calibrated correctly.'},
  {
    icon: '✋',
    category: 'Paper Trading',
    q: 'What does "Override" mean on the Trade button?',
    a: 'When Trade Readiness is WAIT or AVOID, an Override button appears. Tapping it shows a confirmation alert explaining exactly which gates are blocking and why. If you confirm, the trade is opened and recorded as a conscious override.\n\nOverride outcomes are tracked separately in your override log so you can measure whether your human judgment adds alpha over the model.'},
  {
    icon: '📊',
    category: 'Paper Trading',
    q: 'What happens after I open an override trade?',
    a: 'After a successful override:\n\n• The Trade button is replaced by "📊 Manage Position →"\n• Tapping it navigates to your Paper Trading portfolio\n• The override is logged for your Trading Coach to review\n• You receive a push notification confirming the override was recorded'},
  {
    icon: '🎯',
    category: 'Paper Trading',
    q: 'How is Stop Loss / Take Profit calculated?',
    a: 'SL and TP are calculated using Average True Range (ATR) — a volatility-based measure of typical price swing. The ATR multiplier is configurable per strategy. This means SL/TP automatically adapts to market volatility: tighter in calm conditions, wider during volatile sessions.'},

  // ── Brokers & Data ───────────────────────────────────────────────────────────
  {
    icon: '🏦',
    category: 'Brokers & Data',
    q: 'Which brokers does QUANTIS support?',
    a: '• AngelOne — Indian equities, F&O, indices (live trading supported)\n• Binance — Crypto spot and perpetual futures (live trading supported)\n• AlphaVantage — US equities (data only, no live execution)\n\nAll three can be connected simultaneously.'},
  {
    icon: '🔑',
    category: 'Brokers & Data',
    q: 'Is my API key stored securely?',
    a: 'Yes. API keys are stored using expo-secure-store (iOS Keychain / Android Keystore) — the same hardware-backed storage used by banking apps. Keys are never sent to any QUANTIS server; they communicate only with the respective broker APIs directly from your device.'},
  {
    icon: '📡',
    category: 'Brokers & Data',
    q: 'Does QUANTIS work offline?',
    a: 'Partially:\n\n✅ Works offline: ML prediction engine, chart analysis, cached candle data, portfolio data\n\n❌ Requires internet: Live price feeds, broker connections, AI Copilot, Economic Calendar'},
  {
    icon: '📅',
    category: 'Brokers & Data',
    q: 'What is the Market Intelligence Calendar?',
    a: 'The Market Intelligence Calendar shows upcoming macro events (RBI MPC, FOMC, US CPI, OPEC, etc.) with:\n\n• Impact ratings (CRITICAL / HIGH / MEDIUM / LOW)\n• Countdown timers\n• Historical volatility statistics\n• Educational trading guidance\n• Watchlist awareness — highlights events affecting your open positions'},

  // ── Signals & Strategy ───────────────────────────────────────────────────────
  {
    icon: '⚙️',
    category: 'Signals & Strategy',
    q: 'What are Strategy Profiles?',
    a: 'Strategy Profiles are named filter sets that control when the AI is allowed to signal a trade. Each profile defines:\n\n• Allowed market regimes\n• Minimum confidence thresholds\n• MTF requirements\n• SMC conditions\n• Risk parameters\n\nSwitch profiles to match your current trading style (Conservative, Momentum, Scalp, etc.).'},
  {
    icon: '📈',
    category: 'Signals & Strategy',
    q: 'Why does the signal say SELL on a 15m chart?',
    a: 'The prediction reflects what the model sees on that specific timeframe. A 15m SELL signal can coexist with a Daily uptrend — the Trade Readiness system will flag the conflict and set state to WAIT or AVOID, protecting you from entering against the dominant trend.'},
  {
    icon: '🔄',
    category: 'Signals & Strategy',
    q: 'What does "re-predict" mean?',
    a: 'Re-predicting re-runs the ML inference (and retrains if enough new candles have arrived since the last training). It refreshes the signal, confidence score, Trade Readiness, and all overlay computations. Use it whenever market conditions change significantly.'},

  // ── Risk & Safety ────────────────────────────────────────────────────────────
  {
    icon: '⚠️',
    category: 'Risk & Safety',
    q: 'Is QUANTIS financial advice?',
    a: 'No. QUANTIS is an educational algorithmic trading research platform. All predictions, signals, trade readiness scores, and AI outputs are for educational and research purposes only. They do not constitute financial advice.\n\nAlgorithmic trading involves significant risk of loss. Never trade with money you cannot afford to lose.'},
  {
    icon: '💀',
    category: 'Risk & Safety',
    q: 'What is the Kill Switch?',
    a: 'The Kill Switch (More → Kill Switch) is an emergency halt that:\n\n• Immediately closes all paper positions\n• Cancels pending orders\n• Disables automated trading\n\nUse it during extreme market events or if the model behaves unexpectedly. No confirmation dialog — immediate effect.'},
  {
    icon: '📉',
    category: 'Risk & Safety',
    q: 'What is the Portfolio Risk Manager?',
    a: 'The Portfolio Risk Manager (More → Risk) aggregates all your accounts into one dashboard:\n\n• Total notional exposure\n• Margin utilisation\n• Overall leverage\n• Parametric VaR at 95% and 99%\n• Concentration risk\n• Risk level: LOW / MODERATE / HIGH / VERY HIGH\n\nWith actionable recommendations for each risk level.'},

  // ── AI Copilot ───────────────────────────────────────────────────────────────
  {
    icon: '🤖',
    category: 'AI Copilot',
    q: 'What is the AI Copilot?',
    a: 'The AI Copilot sends a structured snapshot of your current chart analysis — candles, indicators, SMC levels, regime, MTF signals, ML prediction — to Claude Sonnet via the Anthropic API. It returns an institutional-grade written analysis covering the setup, key levels, and risk considerations.'},
  {
    icon: '🔐',
    category: 'AI Copilot',
    q: 'How is my Anthropic API key used?',
    a: 'Your Anthropic API key is stored locally on device (Keychain/Keystore) and used only to call the Anthropic API directly from your device. QUANTIS servers never see your key. Usage is billed directly to your Anthropic account at standard API rates.'},
  {
    icon: '💬',
    category: 'AI Copilot',
    q: 'What is the difference between Chat and Analyze?',
    a: '• ANALYZE — sends the full chart snapshot to Claude and returns a structured market analysis for the current symbol and timeframe.\n\n• CHAT — opens a free-form conversation with Claude where you can ask follow-up questions about the analysis, trading concepts, or any topic.'},
];

const CATEGORIES: Category[] = [
  'All', 'How it works', 'Paper Trading', 'Brokers & Data',
  'Signals & Strategy', 'Risk & Safety', 'AI Copilot',
];

// ── Main Screen ────────────────────────────────────────────────────────────────

export default function FAQScreen() {
  const { theme: T } = useTheme();
  const [activeCategory, setActiveCategory] = useState<Category>('All');
  const [searchText, setSearchText] = useState('');
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  const filtered = useMemo(() => {
    let items = activeCategory === 'All'
      ? FAQ_ITEMS
      : FAQ_ITEMS.filter(i => i.category === activeCategory);

    const q = searchText.trim().toLowerCase();
    if (q) {
      items = items.filter(i =>
        i.q.toLowerCase().includes(q) || i.a.toLowerCase().includes(q)
      );
    }
    return items;
  }, [activeCategory, searchText]);

  // Reset open item when filter changes
  const handleCategory = (cat: Category) => {
    setActiveCategory(cat);
    setOpenIndex(null);
  };
  const handleSearch = (text: string) => {
    setSearchText(text);
    setOpenIndex(null);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: T.bg0 }}>

      {/* ── Search bar ──────────────────────────────────────────────────── */}
      <View style={{
        flexDirection: 'row', alignItems: 'center',
        backgroundColor: T.bg1, borderRadius: RADIUS.md,
        borderWidth: 1, borderColor: T.border,
        marginHorizontal: SPACING.lg, marginTop: SPACING.md, marginBottom: SPACING.sm,
        paddingHorizontal: 12}}>
        <Text style={{ color: T.textDim, fontSize: 14, marginRight: 8 }}>🔍</Text>
        <TextInput
          value={searchText}
          onChangeText={handleSearch}
          placeholder="Search questions…"
          placeholderTextColor={T.textDim}
          style={{ flex: 1, color: T.text, fontSize: 13, paddingVertical: 11 }}
          returnKeyType="search"
          clearButtonMode="while-editing"
        />
        {searchText.length > 0 && (
          <TouchableOpacity onPress={() => handleSearch('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={{ color: T.textDim, fontSize: 15 }}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Category tabs ───────────────────────────────────────────────── */}
      <View style={{ height: 44 }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: SPACING.lg,
            gap: 8,
            alignItems: 'center',
            height: 44}}
        >
          {CATEGORIES.map(cat => {
            const active = activeCategory === cat;
            return (
              <TouchableOpacity
                key={cat}
                onPress={() => handleCategory(cat)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 7,
                  borderRadius: RADIUS.pill,
                  backgroundColor: active ? T.accent : T.bg1,
                  borderWidth: 1, borderColor: active ? T.accent : T.border}}
              >
                <Text style={{
                  color: active ? '#fff' : T.textDim,
                  fontSize: 12, fontWeight: active ? '700' : '500'}}>
                  {cat}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* ── Result count ────────────────────────────────────────────────── */}
      {searchText.trim().length > 0 && (
        <Text style={{
          color: T.textDim, fontSize: 11, marginHorizontal: SPACING.lg, marginBottom: 6}}>
          {filtered.length} result{filtered.length !== 1 ? 's' : ''} for "{searchText.trim()}"
        </Text>
      )}

      {/* ── FAQ list ────────────────────────────────────────────────────── */}
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: SPACING.lg,
          paddingBottom: 40}}
        keyboardDismissMode="on-drag"
      >
        {filtered.length === 0 ? (
          <View style={{ alignItems: 'center', marginTop: 48 }}>
            <Text style={{ fontSize: 36, marginBottom: 12 }}>🤔</Text>
            <Text style={{ color: T.text, fontWeight: '700', fontSize: 15, marginBottom: 6 }}>
              No results found
            </Text>
            <Text style={{ color: T.textDim, fontSize: 12, textAlign: 'center' }}>
              Try different keywords or browse all categories
            </Text>
            <TouchableOpacity
              onPress={() => { handleSearch(''); handleCategory('All'); }}
              style={{
                marginTop: 16, paddingHorizontal: 20, paddingVertical: 9,
                backgroundColor: T.accent + '20', borderRadius: RADIUS.pill,
                borderWidth: 1, borderColor: T.accent + '50'}}
            >
              <Text style={{ color: T.accent, fontWeight: '700', fontSize: 12 }}>
                Show all questions
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          filtered.map((item, idx) => {
            const isOpen = openIndex === idx;
            return (
              <TouchableOpacity
                key={`${item.category}-${idx}`}
                onPress={() => setOpenIndex(isOpen ? null : idx)}
                activeOpacity={0.85}
                style={{
                  backgroundColor: T.bg1,
                  borderRadius: RADIUS.md,
                  borderWidth: 1,
                  borderColor: isOpen ? T.accent + '70' : T.border,
                  marginBottom: 8,
                  overflow: 'hidden'}}
              >
                {/* Question row */}
                <View style={{
                  flexDirection: 'row', alignItems: 'center',
                  gap: 10, paddingHorizontal: 14, paddingVertical: 14}}>
                  <Text style={{ fontSize: 18 }}>{item.icon}</Text>
                  <Text style={{
                    flex: 1, color: T.text, fontWeight: '600',
                    fontSize: 13, lineHeight: 19}}>
                    {item.q}
                  </Text>
                  <Text style={{
                    color: isOpen ? T.accent : T.textDim,
                    fontSize: 13, fontWeight: '700'}}>
                    {isOpen ? '▲' : '▼'}
                  </Text>
                </View>

                {/* Answer */}
                {isOpen && (
                  <View style={{
                    borderTopWidth: 1, borderTopColor: T.border,
                    paddingHorizontal: 14, paddingVertical: 14,
                    backgroundColor: T.bg0}}>
                    {/* Category badge */}
                    <View style={{
                      alignSelf: 'flex-start',
                      backgroundColor: T.accent + '18',
                      borderRadius: RADIUS.pill,
                      paddingHorizontal: 8, paddingVertical: 3,
                      marginBottom: 10,
                      borderWidth: 1, borderColor: T.accent + '40'}}>
                      <Text style={{ color: T.accent, fontSize: 9, fontWeight: '700' }}>
                        {item.category.toUpperCase()}
                      </Text>
                    </View>
                    <Text style={{
                      color: T.textSub, fontSize: 13, lineHeight: 21}}>
                      {item.a}
                    </Text>
                  </View>
                )}
              </TouchableOpacity>
            );
          })
        )}

        {/* Disclaimer */}
        <Text style={{
          color: T.textDim, fontSize: 9, textAlign: 'center',
          marginTop: 16, lineHeight: 14}}>
          QUANTIS is an educational algorithmic trading research platform.{'\n'}
          Nothing here constitutes financial advice. Trade at your own risk.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}
