// ─────────────────────────────────────────────────────────────────────────────
// HelpBottomSheet  (v1.0.0)
//
// Reusable (?) help button + bottom sheet for advanced financial terms.
// Uses the existing BottomSheet component — no new dependency.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState } from 'react';
import { TouchableOpacity, Text, View, ScrollView } from 'react-native';
import { BottomSheet } from './BottomSheet';
import { SPACING } from '../theme/colors';

export type HelpTopic = {
  term:        string;
  definition:  string;
  example?:    string;
  warning?:    string;
};

// ── Built-in help topics ────────────────────────────────────────────────────
export const HELP_TOPICS: Record<string, HelpTopic> = {
  var: {
    term:       'Value at Risk (VaR)',
    definition: 'VaR is a statistical estimate of the maximum loss your portfolio could suffer over one day at a given confidence level. VaR₉₅ of ₹10,000 means: on 95% of days, your loss will be less than ₹10,000. On the other 5% of days, it could be more.',
    example:    'If your portfolio VaR₉₅ is ₹50,000 and you have ₹5,00,000 total capital, that is 10% of capital at risk daily — which the system would classify as HIGH risk.',
    warning:    'VaR is a model estimate, not a guarantee. Actual losses can exceed VaR during market crashes.'},
  regime: {
    term:       'Market Regime',
    definition: 'A market regime describes the current behaviour of the market: trending up (BULL_TREND), trending down (BEAR_TREND), choppy and directionless (RANGING), or highly volatile (HIGH_VOLATILITY). Different strategies work better in different regimes.',
    example:    'A breakout strategy works well in BULL_TREND but loses money in RANGING. QUANTIS uses the regime label to filter out signals that historically underperform in the current regime.'},
  confidence: {
    term:       'Prediction Confidence',
    definition: 'The confidence score (0–100) reflects how certain the AI ensemble is about its signal. It combines multiple factors: model agreement, feature quality, recent prediction accuracy, and market context alignment.',
    example:    'A confidence of 82 means all models agree strongly and market conditions support the signal. A confidence of 45 means models disagree or conditions are uncertain — the system will show WAIT or AVOID.',
    warning:    'Even 90% confidence does not guarantee profit. Trading always involves risk.'},
  profitFactor: {
    term:       'Profit Factor',
    definition: 'Profit Factor = Total Gross Profit ÷ Total Gross Loss. A Profit Factor above 1.0 means your winners outpace your losers. Above 1.5 is strong. Below 1.0 means you are net losing.',
    example:    'If your trades made ₹30,000 in total wins and lost ₹15,000 in total losses, your Profit Factor = 30,000 ÷ 15,000 = 2.0.'},
  marginUtilisation: {
    term:       'Margin Utilisation',
    definition: 'The percentage of your available capital that is currently locked up as margin for open futures positions. High margin utilisation means less buffer to absorb adverse moves.',
    example:    'If you have ₹5L in your futures account and ₹4L is blocked as margin, your margin utilisation is 80% — which is HIGH risk.',
    warning:    'If margin utilisation exceeds 100% (margin call), your broker will force-close your positions.'},
  fundingRate: {
    term:       'Funding Rate',
    definition: 'On Binance perpetual futures, longs and shorts exchange payments every 8 hours. When the funding rate is positive, longs pay shorts. When negative, shorts pay longs. This mechanism keeps the perpetual price anchored to the spot price.',
    example:    'If you hold 1 BTC long (≈ $60,000) and the funding rate is 0.01%, you pay $6 every 8 hours — $18/day — to maintain the position.',
    warning:    'Funding rate can change every 8 hours. High positive funding means the market is heavily long — a contrarian signal.'},
  liquidation: {
    term:       'Liquidation',
    definition: 'When your isolated margin is exhausted by losses, the exchange force-closes your position at the liquidation price. You lose the entire margin allocated to that position.',
    example:    'If you open 1 BTC long at $60,000 with 10× leverage, your liquidation price is approximately $54,300 (a 9.5% move against you). The margin ($6,000) is lost entirely.',
    warning:    'Higher leverage = liquidation price closer to entry. At 100× leverage, a 1% adverse move can trigger liquidation. Use high leverage only if you understand the risk.'},
  ready: {
    term:       'READY Signal',
    definition: 'READY means all signal gates have passed: the regime supports the direction, confidence is above threshold, multi-timeframe alignment is confirmed, and market context is not adverse. This is the highest-quality signal state.',
    example:    'READY does not mean the trade will win. It means all the conditions the AI checks have been met. You still decide whether to trade.'},
  wait: {
    term:       'WAIT Signal',
    definition: 'WAIT means the prediction direction is present but one or more signal gates are cautioning against entry. Common reasons: regime is not ideal, confidence is moderate, or market context is mixed.',
    example:    'You can still trade on WAIT — use the Override button — but the system is telling you conditions are not optimal.'},
  avoid: {
    term:       'AVOID Signal',
    definition: 'AVOID means multiple signal gates are blocking entry. The regime may be against the direction, confidence is low, or market context is strongly adverse. The risk/reward is unfavourable.',
    example:    'Trading AVOID is possible via Override but carries meaningfully higher risk. The Shadow Journal tracks all AVOID overrides so you can review whether they were profitable.'},
};

// ── Help button (?) ────────────────────────────────────────────────────────────

export function HelpButton({
  topicKey, T,
}: {
  topicKey: string;
  T: any;
}) {
  const [visible, setVisible] = useState(false);
  const topic = HELP_TOPICS[topicKey];
  if (!topic) return null;

  return (
    <>
      <TouchableOpacity
        onPress={() => setVisible(true)}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel={`Help: ${topic.term}`}
        accessibilityRole="button"
        style={{ width: 18, height: 18, borderRadius: 9,
          backgroundColor: T.bg3, borderWidth: 1, borderColor: T.border,
          justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: T.accent, fontSize: 10, fontWeight: '800' }}>?</Text>
      </TouchableOpacity>

      <BottomSheet visible={visible} onClose={() => setVisible(false)}
        title={topic.term} theme={T}>
        <ScrollView style={{ maxHeight: 340 }}>
          <Text style={{ color: T.text, fontSize: 13, lineHeight: 20,
            marginBottom: SPACING.md }}>
            {topic.definition}
          </Text>
          {topic.example && (
            <View style={{ backgroundColor: T.bg3, borderRadius: 8,
              padding: SPACING.sm, marginBottom: SPACING.sm }}>
              <Text style={{ color: T.textDim, fontSize: 10, fontWeight: '700',
                marginBottom: 4 }}>EXAMPLE</Text>
              <Text style={{ color: T.text, fontSize: 12, lineHeight: 18 }}>
                {topic.example}
              </Text>
            </View>
          )}
          {topic.warning && (
            <View style={{ backgroundColor: T.amber + '20', borderRadius: 8,
              padding: SPACING.sm, borderWidth: 1, borderColor: T.amber + '40' }}>
              <Text style={{ color: T.amber, fontSize: 10, fontWeight: '700',
                marginBottom: 4 }}>⚠ NOTE</Text>
              <Text style={{ color: T.text, fontSize: 12, lineHeight: 18 }}>
                {topic.warning}
              </Text>
            </View>
          )}
        </ScrollView>
      </BottomSheet>
    </>
  );
}

// ── Inline label + help button ─────────────────────────────────────────────────
export function LabelWithHelp({
  label, topicKey, T, style,
}: {
  label: string; topicKey: string; T: any; style?: any;
}) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 5 }, style]}>
      <Text style={{ color: T.textDim, fontSize: 11, fontWeight: '700' }}>{label}</Text>
      <HelpButton topicKey={topicKey} T={T} />
    </View>
  );
}
