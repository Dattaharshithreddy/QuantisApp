// ─────────────────────────────────────────────────────────────────────────────
// XAI SCORING  (v5.3.0) — XAI_SCORING_V1
//
// Generates human-readable explanations from feature values and influence
// scores. Every sentence is CONDITIONAL on a threshold — no sentence fires
// unless its feature value exceeds the stated threshold. No hallucination.
//
// XAI_SCORING_V1
// Sentence generation rule: value × sign threshold → sentence string.
// Every rule documents: feature index, threshold, condition, sentence.
// ─────────────────────────────────────────────────────────────────────────────
import {
  AttributedFeature, FeatureGroup, RiskFlag, RiskLevel, FEATURE_GROUP_MAP,
} from './xaiTypes';

// ── Assign direction to a feature value (XAI_SCORING_V1) ─────────────────────
// Features with naturally signed ranges: positive = bullish, negative = bearish.
// Features that are proximity/age/freshness: value itself signals nothing about direction.
// This mapping is fixed — changing it requires bumping to XAI_SCORING_V2.
const UNSIGNED_FEATURES = new Set([
  'ATR (norm)', 'Historical volatility', 'Relative volume', 'ADX',
  'BB width %', 'FVG distance', 'FVG age', 'SMC OB distance', 'SMC OB age',
  'SMC OB freshness', 'Hour (sin)', 'Day of week', 'Regime volatility',
  'Regime confidence', 'MTF overall score',
]);

export function featureDirection(name: string, value: number): 'bullish' | 'bearish' | 'neutral' {
  if (UNSIGNED_FEATURES.has(name)) return 'neutral';
  if (value > 0.05) return 'bullish';
  if (value < -0.05) return 'bearish';
  return 'neutral';
}

// ── Sentence templates (XAI_SCORING_V1) ──────────────────────────────────────
// Rules: [featureName, bullThreshold, bearThreshold, bullSentence, bearSentence]
// A sentence fires only when value crosses its threshold.
// Threshold of null = fire whenever direction matches.
type SentenceRule = [string, number | null, number | null, string, string];
const SENTENCE_RULES: SentenceRule[] = [
  // Trend
  ['Trend direction',       0.3, -0.3,
    'EMA trend is bullish.',                          'EMA trend is bearish.'],
  ['MS trend strength',     0.4, -0.4,
    'Market structure confirms bullish trend.',       'Market structure confirms bearish trend.'],
  ['MS trend confidence',   0.5, null,
    'Trend confidence is high.',                      'Trend confidence is low.'],
  ['MS trend persistence',  0.6, null,
    'Trend has been persistent.',                     'Trend lacks persistence.'],
  // Structure
  ['MS HH score',           0.2, null,
    'Higher Highs forming — bullish sequence.',       ''],
  ['MS HL score',           0.2, null,
    'Higher Lows forming — structure intact.',        ''],
  ['MS LH score',           null, 0.2,
    '',                                               'Lower Highs forming — bearish sequence.'],
  ['MS LL score',           null, 0.2,
    '',                                               'Lower Lows forming — structure deteriorating.'],
  ['MS BOS detected',       0.5, null,
    'Break of Structure detected — bullish momentum.',''],
  ['MS CHoCH detected',     null, 0.5,
    '',                                               'Change of Character — possible reversal.'],
  // SMC
  ['SMC bull OB strength',  0.4, null,
    'Bullish Order Block is active and strong.',      ''],
  ['SMC bear OB strength',  null, 0.4,
    '',                                               'Bearish Order Block is active above price.'],
  ['SMC OB freshness',      0.5, null,
    'Order Block is fresh — not yet retested.',       ''],
  ['SMC OB confidence',     0.6, null,
    'Order Block confidence is high.',                ''],
  ['SMC liquidity sweep',   0.5, null,
    'Liquidity sweep detected — potential reversal.',  ''],
  ['SMC stop hunt prob',    0.5, null,
    'Stop hunt probability elevated — watch for trap.',''],
  ['SMC PD bias',           0.3, -0.3,
    'Price trades in discount zone — bullish bias.',  'Price trades in premium zone — bearish bias.'],
  ['SMC breaker score',     0.3, -0.3,
    'Bullish Breaker Block supports price.',          'Bearish Breaker Block resists price.'],
  // FVG
  ['FVG bull strength',     0.3, null,
    'Bullish Fair Value Gap remains open below.',     ''],
  ['FVG bear strength',     null, 0.3,
    '',                                               'Bearish Fair Value Gap remains open above.'],
  ['FVG bias',              0.2, -0.2,
    'FVG bias is bullish.',                           'FVG bias is bearish.'],
  ['FVG fill pct',          0.8, null,
    'Nearest FVG is nearly filled.',                  ''],
  ['FVG cluster score',     0.5, null,
    'Multiple FVGs cluster at key level.',            ''],
  // VWAP
  ['Vol above VWAP',        0.5, null,
    'Price is trading above VWAP.',                   ''],
  ['Vol below VWAP',        0.5, null,
    '',                                               'Price is trading below VWAP.'],
  ['Vol VWAP slope',        0.3, -0.3,
    'VWAP is rising — bullish intraday bias.',        'VWAP is falling — bearish intraday bias.'],
  ['Vol VWAP confidence',   0.6, null,
    'VWAP level has high institutional significance.',''],
  ['Vol dist from POC',     null, null,
    '',                                               ''],  // no sentence — POC proximity is context only
  ['Vol HVN proximity',     0.6, null,
    'Price is near a High Volume Node — expect support/resistance.',''],
  ['Vol LVN proximity',     0.6, null,
    'Price is in a Low Volume Node — expect fast move.',''],
  ['Vol profile bias',      0.3, -0.3,
    'Volume profile shows bullish bias above POC.',   'Volume profile shows bearish bias below POC.'],
  // MTF
  ['MTF trend align',       0.3, -0.3,
    'Higher timeframes confirm bullish trend.',       'Higher timeframes confirm bearish trend.'],
  ['MTF overall score',     0.25, -0.25,
    'Multi-timeframe alignment is bullish.',          'Multi-timeframe alignment is bearish.'],
  ['MTF HTF bias',          0.5, -0.5,
    'Higher timeframe is in a bull trend.',           'Higher timeframe is in a bear trend.'],
  ['MTF VWAP align',        0.3, -0.3,
    'Higher TF VWAPs are above price.',               'Higher TF VWAPs are below price.'],
  // Regime
  ['Regime bull score',     0.5, null,
    'Market regime is bullish — trend continuation expected.',''],
  ['Regime bear score',     null, 0.5,
    '',                                               'Market regime is bearish.'],
  ['Regime breakout',       0.5, null,
    'Breakout regime detected — momentum expanding.', ''],
  ['Regime mean revert',    0.5, null,
    'Mean reversion environment — fade extremes.',    ''],
  ['Regime volatility',     0.7, null,
    'High volatility environment — wider risk range.',  ''],
  ['Regime confidence',     0.6, null,
    'Regime classification has high confidence.',     ''],
  // Returns
  ['Return 1-bar',          0.01, -0.01,
    'Last candle closed bullish.',                    'Last candle closed bearish.'],
  ['Return 5-bar',          0.03, -0.03,
    '5-bar momentum is positive.',                    '5-bar momentum is negative.'],
];

const RULE_MAP = new Map<string, SentenceRule>(SENTENCE_RULES.map(r => [r[0], r]));

export function buildSentence(name: string, value: number): string {
  const rule = RULE_MAP.get(name);
  if (!rule) return '';
  const [, bullThr, bearThr, bullSen, bearSen] = rule;
  if (bullThr !== null && value >= bullThr && bullSen) return bullSen;
  if (bearThr !== null && value <= -Math.abs(bearThr) && bearSen) return bearSen;
  return '';
}

// ── Risk level computation (XAI_SCORING_V1) ──────────────────────────────────
// riskScore = Σ(flag_weight) for each flag present
// LOW < 0.25, MEDIUM < 0.5, HIGH < 0.75, VERY_HIGH ≥ 0.75
const FLAG_WEIGHTS: Record<RiskFlag, number> = {
  HIGH_VOLATILITY:      0.25,
  COUNTER_TREND:        0.20,
  WEAK_HTF_AGREE:       0.15,
  BREAKOUT_ENV:         0.15,
  MEAN_REVERSION_ENV:   0.10,
  LOW_REGIME_CONF:      0.10,
  FRESH_OB_ABSENT:      0.10,
  FVG_FILLED:           0.05,
};

export function computeRiskLevel(flags: RiskFlag[]): RiskLevel {
  const score = flags.reduce((s, f) => s + (FLAG_WEIGHTS[f] ?? 0), 0);
  if (score >= 0.75) return 'VERY_HIGH';
  if (score >= 0.5)  return 'HIGH';
  if (score >= 0.25) return 'MEDIUM';
  return 'LOW';
}

export function buildRiskSentence(level: RiskLevel, flags: RiskFlag[]): string {
  const flagTexts: Record<RiskFlag, string> = {
    COUNTER_TREND:      'signal is counter-trend',
    HIGH_VOLATILITY:    'high volatility',
    LOW_REGIME_CONF:    'unclear market regime',
    WEAK_HTF_AGREE:     'weak higher-timeframe agreement',
    MEAN_REVERSION_ENV: 'mean reversion environment',
    FRESH_OB_ABSENT:    'no fresh Order Block supporting the trade',
    FVG_FILLED:         'Fair Value Gap already filled',
    BREAKOUT_ENV:       'breakout conditions increase uncertainty'};
  if (flags.length === 0) return 'Risk is low — conditions are aligned.';
  const items = flags.slice(0, 3).map(f => flagTexts[f]).join(', ');
  return `Risk is ${level.replace('_', ' ').toLowerCase()}: ${items}.`;
}

// ── Confidence explanation ────────────────────────────────────────────────────
export function buildConfidenceLines(prob: number, direction: string): string[] {
  const lines: string[] = [];
  const pct = (prob * 100).toFixed(0);
  if (prob > 0.7)       lines.push(`Model confidence is high at ${pct}%.`);
  else if (prob > 0.55) lines.push(`Model confidence is moderate at ${pct}%.`);
  else                  lines.push(`Model confidence is low at ${pct}% — trade with caution.`);
  if (direction === 'NEUTRAL') lines.push('Ensemble models disagree — no clear directional edge.');
  return lines;
}

// ── Group-level score ─────────────────────────────────────────────────────────
export function computeGroupScores(
  features: { name: string; influence: number; group: FeatureGroup }[]
): Record<FeatureGroup, number> {
  const totals: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const f of features) {
    totals[f.group] = (totals[f.group] ?? 0) + f.influence;
    counts[f.group] = (counts[f.group] ?? 0) + 1;
  }
  const result: Record<string, number> = {};
  const allGroups = Object.keys(FEATURE_GROUP_MAP) as FeatureGroup[];
  const maxTotal = Math.max(...Object.values(totals), 1);
  for (const g of allGroups) {
    result[g] = Math.min(1, (totals[g] ?? 0) / maxTotal);
  }
  return result as Record<FeatureGroup, number>;
}
