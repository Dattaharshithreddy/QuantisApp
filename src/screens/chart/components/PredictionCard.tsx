// Presentational — receives ml state and callbacks, renders the full
// prediction panel. No hooks. No memoization. Zero engine calls.
import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { appendOverrideLog, readOverrideLog, summariseOverrideOutcomes, OverrideOutcomeSummary } from '../../../utils/overrideLog';
import { notifyOverrideRecorded, notifySignalReady } from '../../../utils/paperNotifications';
import type { TradeReadiness } from '../../../utils/mtf/tradeReadiness';
import { MLPrediction, PRIMARY_HORIZON, FEATURE_NAMES } from '../../../utils/mlSignal';
import { explainPrediction } from '../../../utils/xai/xaiEngine';
import { computeConfidence } from '../../../utils/confidence/confidenceEngine';
import { generateExplanation } from '../../../utils/aiExplanation';
import { checkRegimeFilter } from '../../../utils/regimeFilter';
import { fromSinglePrediction, formatTradeQualityScore } from '../../../utils/tradeQuality';
import { TrainingStatusCard } from '../../../components/TrainingStatusCard';
import { formatMemoryResult } from '../../../utils/memoryEngine';
import { PredictionSourceCard } from '../../../components/PredictionSourceCard';
import { ModelUsageTimeline } from '../../../components/ModelUsageTimeline';
import { Card, SectionLabel, Pill, GradientButton, Skeleton, Gauge, ExpandableToggle, MetricBox } from '../../../components/Common';
import { Candle } from '../../../utils/indicators';
import { RADIUS, SPACING } from '../../../theme/colors';
import { MarketContextCard } from '../../../components/MarketContextCard';
import { navigateToPaperTrading, navigateToShadowJournal, navigateToLivePositions } from '../../../utils/navigationRef';

type Props = {
  symbol: string;
  tf: string;
  candlesLength: number; // replaces candles array — only candles.length-1 was used
  mlStatus: 'idle'|'training'|'done'|'error';
  mlData:   MLPrediction | null;
  mlErr:    string | null;
  tradeQualityResult: any;
  validatedPatterns?: any[] | null; // ValidatedPattern[] from Pattern Validation Framework
  retrainDecision: any;
  postPredictionMsg: string | null;
  showQualityBreakdown: boolean;
  setShowQualityBreakdown: (v: boolean) => void;
  showConfidenceBreakdown: boolean;
  setShowConfidenceBreakdown: (v: boolean) => void;
  msStr: any;
  smcSnap: any;
  fvgSnap: any;
  vwapSnap: any;
  vpSnap: any;
  mtfSnap: any;
  regimeSnap: any;
  onRunPrediction: (force?: boolean) => void;
  onPaperTrade: (d: MLPrediction, bypassGates?: boolean, mtfReadinessState?: 'READY' | 'WAIT' | 'AVOID' | null) => Promise<import('../../../utils/paperTradingEngine').OpenAttemptResult> | void;
  // Optional TradeReadiness from ChartScreen — when present, enables signal hierarchy UI.
  readiness?: TradeReadiness | null;
  // Live trading — when isLiveMode is true, trade buttons route to OrderConfirmation
  isLiveMode?: boolean;
  onLiveTrade?: (req: {
    prediction: MLPrediction; bypassGates: boolean;
    mtfState: 'READY' | 'WAIT' | 'AVOID' | null;
    signalSnapshot: any; marketContext?: any;
  }) => void;
  T: any;
};

export function PredictionCard({
  symbol, tf, candlesLength, mlStatus, mlData, mlErr, tradeQualityResult,
  retrainDecision, postPredictionMsg, showQualityBreakdown, setShowQualityBreakdown,
  showConfidenceBreakdown, setShowConfidenceBreakdown,
  msStr, smcSnap, fvgSnap, vwapSnap, vpSnap, mtfSnap, regimeSnap,
  validatedPatterns,
  onRunPrediction, onPaperTrade, readiness = null, isLiveMode = false, onLiveTrade, T,
}: Props) {
  if (__DEV__) console.count('PredictionCard render');

  // Override log stats — read once on mount.
  // Initialized to null (no flash): async read only updates if there's history.
  // Uses a module-level cache so subsequent renders don't re-read AsyncStorage.
  const [overrideStats, setOverrideStats] = useState<OverrideOutcomeSummary | null>(null);
  const overrideLoadedRef = React.useRef(false);
  // Guard: prevent double-tap on override/trade buttons while a position open is in-flight.
  // Without this, two rapid taps both pass the "already open" check before the first
  // position is written to AsyncStorage, creating duplicate positions + phantom shadows.
  const [isSubmitting, setIsSubmitting] = useState(false);

  // CTA state machine — replaces the open/short button once the user acts.
  // Reset whenever the prediction changes (new signalId = new candle = new signal).
  // Driven entirely by the engine's returned result — never inferred from signal state.
  type CtaState =
    | { type: 'idle' }
    | { type: 'position_opened'; isLive: boolean }   // override or ready → trade opened
    | { type: 'shadow_recorded' }                    // engine blocked → shadow written
    | { type: 'waiting' }                            // user kept AI decision on WAIT (no shadow)
    | { type: 'error'; message: string };            // engine threw unexpectedly

  const [ctaState, setCtaState] = useState<CtaState>({ type: 'idle' });
  const lastSignalIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (overrideLoadedRef.current) return;  // already loaded this session
    overrideLoadedRef.current = true;
    readOverrideLog().then(log => {
      if (log.length > 0) {
        summariseOverrideOutcomes(log, 'AVOID').then(setOverrideStats);
      }
    }).catch(() => {});
  }, []); // empty deps — load once per component mount

  return (
    <Card theme={T} style={{ marginTop: 14 }}>
      <SectionLabel theme={T}>🤖 SIGNAL ENGINE</SectionLabel>

      {mlStatus === 'idle' && (
        <View>
          <TrainingStatusCard symbol={symbol} timeframe={tf} theme={T} refreshKey={mlData} />
          <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 17 }}>
            Trains two models across 5 horizons on {FEATURE_NAMES.length} features from {symbol}'s own price history.
          </Text>
        </View>
      )}
      {mlStatus === 'training' && (
        <View style={{ paddingVertical: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Skeleton width={28} height={28} radius={14} theme={T} />
            <View style={{ flex: 1, gap: 6 }}>
              <Skeleton width="70%" height={9} theme={T} />
              <Skeleton width="45%" height={9} theme={T} />
            </View>
          </View>
          <Text style={{ color: T.textDim, fontSize: 10, textAlign: 'center' }}>Training 5 horizon models + ensemble + walk-forward validation…</Text>
        </View>
      )}
      {mlStatus === 'error' && <Text style={{ color: T.red, fontSize: 12 }}>⚠ {mlErr}</Text>}

      {mlStatus === 'done' && mlData && (() => {
        const d = mlData;
        // Backward-compat: old stored predictions may lack direction field — derive from action
        const dDir: 'UP' | 'DOWN' | 'NEUTRAL' = d.direction ?? (d.action === 'BUY' ? 'UP' : d.action === 'SELL' ? 'DOWN' : 'NEUTRAL');
        const dirColor    = dDir === 'UP' ? T.green : dDir === 'DOWN' ? T.red : T.textDim;
        const actionColor = d.action === 'BUY' ? T.green : d.action === 'SELL' ? T.red : T.amber;
        const wfReliable  = d.walkForwardAccuracy >= 55;

        // XAI
        const imp   = new Array(FEATURE_NAMES.length).fill(0);
        d.topFeatures.forEach((f: any) => { const idx = FEATURE_NAMES.indexOf(f.name as any); if (idx >= 0) imp[idx] = f.influence; });
        const liveF = FEATURE_NAMES.map((n: string) => { const tf2 = d.topFeatures.find((f: any) => f.name === n); return tf2?.value ?? 0; });
        const fMean = liveF.reduce((s: number, v: number) => s + v, 0) / (liveF.length || 1);
        const fStd  = Math.sqrt(liveF.reduce((s: number, v: number) => s + (v - fMean)**2, 0) / (liveF.length || 1)) || 1;
        const normF = liveF.map((v: number) => (v - fMean) / fStd);
        const xai   = explainPrediction({
          features: liveF, featureNames: FEATURE_NAMES as unknown as string[],
          inputImportance: imp, normalizedFeatures: normF,
          direction: dDir, probability: d.ensembleProbUp,
          mtfOverall: liveF[106], fvgFillPct: liveF[82],
          regimeScores: { volatilityScore: liveF[114], meanRevScore: liveF[113], confidence: liveF[115], breakoutScore: liveF[112] },
        });

        // Confidence
        const conf = computeConfidence(
          d.confidenceBreakdown, d.ensembleProbUp, dDir,
          d.ensembleAgree, d.walkForwardAccuracy * 100, d.riskScore,
          msStr ?? { scoresArr: [] }, candlesLength - 1,
          smcSnap, fvgSnap ? { fvgConfidence: fvgSnap.fvgConfidence, fvgBias: fvgSnap.fvgBias, gapFillPct: fvgSnap.gapFillPct } : null,
          vwapSnap ? { sessionVWAP: vwapSnap.sessionVWAP } : null,
          vpSnap   ? { profileBias: vpSnap.profileBias ?? 0, hvnProximity: vpSnap.hvnProximity ?? 0, vwapConfidence: 0.7 } : null,
          mtfSnap  ? { overallMTFScore: mtfSnap.overallMTFScore, trendAlignment: mtfSnap.trendAlignment, htfBias: mtfSnap.htfBias } : null,
          regimeSnap ? { confidence: regimeSnap.confidence, bullScore: regimeSnap.bullScore, bearScore: regimeSnap.bearScore, volatilityScore: regimeSnap.volatilityScore, breakoutScore: regimeSnap.breakoutScore, meanRevScore: regimeSnap.meanRevScore } : null,
          validatedPatterns ?? null, // Pattern Validation Framework — 9th consensus dimension
        );
        const gradeColor = conf.grade === 'A+' || conf.grade === 'A' ? T.green : conf.grade === 'B' ? T.amber : T.red;
        const riskColor  = conf.risk === 'LOW' ? T.green : conf.risk === 'MEDIUM' ? T.amber : T.red;

        return (
          <View>
            <PredictionSourceCard prediction={d} symbol={symbol} timeframe={tf} theme={T} overallConfidence={conf.overall} />
            <ModelUsageTimeline prediction={d} theme={T} overallConfidence={conf.overall} />

            {/* ── Signal Hierarchy — replaces hero BUY badge ─────────────── */}
            {/* Visual priority: Prediction (neutral) → Confidence (graded) →  */}
            {/* Recommendation (primary) → Trade Readiness (dominant)           */}
            <View style={{ gap: 6, marginTop: 4, marginBottom: 10 }}>

              {/* Row 1+2: Prediction + Confidence side by side (informational, smaller) */}
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {/* Prediction — neutral styling, informational only */}
                <View style={{ flex: 1, backgroundColor: T.bg3, borderRadius: RADIUS.sm,
                  padding: 10, borderWidth: 1, borderColor: T.textDim + '30' }}>
                  <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
                    letterSpacing: 0.5, marginBottom: 4 }}>PREDICTION</Text>
                  <Text style={{ color: T.text, fontSize: 13, fontWeight: '700' }}>
                    {dDir === 'UP' ? '▲ Bullish' : dDir === 'DOWN' ? '▼ Bearish' : '— Neutral'}
                  </Text>
                  <Text style={{ color: T.textDim, fontSize: 9, marginTop: 2 }}>
                    {isFinite(d.ensembleProbUp) ? (d.ensembleProbUp * 100).toFixed(1) + '%' : '—'} P(up)
                  </Text>
                </View>

                {/* Confidence — grade color emphasis */}
                <View style={{ flex: 1, backgroundColor: gradeColor + '12', borderRadius: RADIUS.sm,
                  padding: 10, borderWidth: 1, borderColor: gradeColor + '40' }}>
                  <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
                    letterSpacing: 0.5, marginBottom: 4 }}>CONFIDENCE</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                    <Text style={{ color: gradeColor, fontSize: 18, fontWeight: '800' }}>
                      {Math.max(0, Math.min(100, conf.overall + (d.memoryResult?.confidenceAdjust ?? 0))).toFixed(0)}%
                    </Text>
                    <Text style={{ color: gradeColor, fontSize: 13, fontWeight: '800' }}>
                      {conf.grade}
                    </Text>
                  </View>
                  {(d.memoryResult?.confidenceAdjust ?? 0) !== 0 && (
                    <Text style={{ color: T.textDim, fontSize: 8, marginTop: 1 }}>
                      ML: {conf.overall.toFixed(0)}% · Memory: {(d.memoryResult?.confidenceAdjust ?? 0) > 0 ? '+' : ''}{d.memoryResult?.confidenceAdjust}pts
                    </Text>
                  )}
                  <Text style={{ color: riskColor, fontSize: 9, fontWeight: '700', marginTop: 2 }}>
                    {conf.risk} RISK
                  </Text>
                </View>
              </View>

              {/* Row 3: Recommendation — large, primary decision */}
              {(() => {
                const recBull = conf.recommendation.includes('BUY');
                const recBear = conf.recommendation.includes('SELL');
                const recCol  = recBull ? T.green : recBear ? T.red : T.amber;
                return (
                  <View style={{ backgroundColor: recCol + '15', borderRadius: RADIUS.sm,
                    padding: 11, borderWidth: 1.5, borderColor: recCol + '60',
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.5 }}>
                      RECOMMENDATION
                    </Text>
                    <Text style={{ color: recCol, fontSize: 15, fontWeight: '800', letterSpacing: 0.3 }}>
                      {conf.recommendation}
                    </Text>
                  </View>
                );
              })()}

              {/* Memory Card — shown when episode store has sufficient similar history */}
              {(() => {
                const mem = d.memoryResult;
                if (!mem?.available) return null;
                const memFmt = formatMemoryResult(mem);
                const adj = mem.confidenceAdjust;
                const adjColor = adj > 0 ? T.green : adj < 0 ? T.amber : T.textDim;
                return (
                  <View style={{
                    backgroundColor: T.bg1, borderRadius: RADIUS.sm, padding: 11,
                    borderWidth: 1, borderColor: T.border,
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.5 }}>
                        🧠 MARKET MEMORY
                      </Text>
                      {adj !== 0 && (
                        <Text style={{ color: adjColor, fontSize: 9, fontWeight: '800' }}>
                          {adj > 0 ? '+' : ''}{adj}pts
                        </Text>
                      )}
                    </View>
                    <Text style={{ color: T.text, fontSize: 12, fontWeight: '600', marginBottom: 2 }}>
                      {memFmt.headline}
                    </Text>
                    <Text style={{ color: T.textDim, fontSize: 10, marginBottom: adj !== 0 ? 5 : 0 }}>
                      {memFmt.subtitle}
                    </Text>
                    {adj !== 0 && (
                      <Text style={{ color: adjColor, fontSize: 10, fontWeight: '600' }}>
                        {memFmt.adjustLabel}
                      </Text>
                    )}
                    {memFmt.patterns.length > 0 && (
                      <View style={{ marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: T.border }}>
                        <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.5, marginBottom: 4 }}>
                          RECURRING PATTERNS IN SIMILAR LOSSES
                        </Text>
                        {memFmt.patterns.map((p, i) => (
                          <Text key={i} style={{ color: T.amber, fontSize: 10, marginBottom: 2 }}>
                            ⚠ {p}
                          </Text>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })()}

              {/* Row 4: Trade Readiness — largest, most dominant, colored by state */}
              {readiness && (() => {
                const rdCol = readiness.state === 'READY' ? T.green
                            : readiness.state === 'AVOID' ? T.red : T.amber;
                const rdEmoji = readiness.state === 'READY' ? '🟢'
                              : readiness.state === 'AVOID' ? '🔴' : '🟡';
                return (
                  <View style={{ backgroundColor: rdCol + '18', borderRadius: RADIUS.sm,
                    padding: 12, borderWidth: 2, borderColor: rdCol + '70',
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700', letterSpacing: 0.5 }}>
                      TRADE READINESS
                    </Text>
                    <Text style={{ color: rdCol, fontSize: 18, fontWeight: '900', letterSpacing: 0.3 }}>
                      {rdEmoji} {readiness.state}
                    </Text>
                  </View>
                );
              })()}
            </View>

            {/* Confidence details now in Signal Hierarchy above — this section removed */}

            {/* ── Plain-English Confidence Explanation ─────────────────── */}
            {(() => {
              const overall = conf.overall;
              const dim     = conf.dimensions as any;
              const risk    = conf.risk;
              const wfa     = d.walkForwardAccuracy;   // 0–1
              const pUp     = d.ensembleProbUp;         // 0–1
              const isBull  = dDir === 'UP';
              const isBear  = dDir === 'DOWN';
              const accent  = overall >= 70 ? T.green : overall >= 50 ? T.amber : T.red;

              // ── All 9 engine dimensions ─────────────────────────────────
              const dimEntries: [string, number][] = [
                ['ML model', dim.mlModel ?? 0], ['Trend', dim.trend ?? 0],
                ['Market structure', dim.structure ?? 0], ['Smart money', dim.smc ?? 0],
                ['Fair value gaps', dim.fvg ?? 0], ['Volume / VWAP', dim.volume ?? 0],
                ['Multi-timeframe', dim.mtf ?? 0], ['Regime', dim.regime ?? 0],
                ['Chart pattern', dim.patternValidation ?? 0],
              ];
              const sorted   = [...dimEntries].sort((a, b) => b[1] - a[1]);
              const supporting = sorted.filter(([,v]) => v >= 55).slice(0, 3);
              const dragging   = sorted.filter(([,v]) => v < 35).reverse().slice(0, 3);

              // ── 1. LEAD: conclusion first ───────────────────────────────
              const confWord  = overall >= 70 ? 'high' : overall >= 55 ? 'moderate' : overall >= 40 ? 'low' : 'very low';
              const dirPhrase = isBull ? 'move higher' : isBear ? 'move lower' : 'move sideways';
              const recStrong = overall >= 65;
              const leadLine  = isBull || isBear
                ? `The AI expects the price to ${dirPhrase}, but confidence is ${confWord} at ${overall.toFixed(0)}%. ${
                    recStrong
                      ? 'The evidence is reasonably consistent — this is a tradeable signal with appropriate risk management.'
                      : 'The evidence is not strong enough for a high-conviction trade. Consider waiting for better confirmation.'
                  }`
                : `The AI sees no clear directional edge right now. Confidence is ${confWord} and the engines are too split to favour either side.`;

              // ── 2. WHY: supporting vs dragging engines ──────────────────
              const supportLine = supporting.length
                ? supporting.map(([n]) => n).join(', ') + ` ${supporting.length === 1 ? 'supports' : 'support'} the ${isBull ? 'bullish' : 'bearish'} case.`
                : '';
              // Plain-English drag sentence — no percentages, no jargon
              const dragParts: string[] = [];
              if ((dim.patternValidation ?? 0) < 25) dragParts.push('there is no confirmed chart pattern');
              if ((dim.volume ?? 0) < 35) dragParts.push('volume is not supporting the move');
              if ((dim.mtf ?? 0) < 35) dragParts.push('higher timeframes are not aligned');
              if ((dim.trend ?? 0) < 35) dragParts.push('the short-term trend is unclear');
              if ((dim.structure ?? 0) < 35) dragParts.push('market structure is weak');
              const dragLine = dragParts.length
                ? `Confidence is held back mainly because ${dragParts.slice(0, 2).join(' and ')}.`
                : '';

              // ── 3. MODEL QUALITY ────────────────────────────────────────
              const mlNote = wfa < 0.52
                ? `Model quality: The model's recent performance on this symbol has been weak, so its prediction should be treated cautiously rather than relied on alone.`
                : wfa < 0.60
                ? `Model quality: The model has modest but real edge here — weight it alongside technicals, not above them.`
                : `Model quality: The model has demonstrated consistent edge on this symbol and timeframe — it earns reasonable weight.`;

              // ── 4. BOTTOM LINE: actionable ──────────────────────────────
              const missingConfirmation: string[] = [];
              if ((dim.volume ?? 0) < 35) missingConfirmation.push('stronger volume');
              if ((dim.patternValidation ?? 0) < 25) missingConfirmation.push('a confirmed chart pattern');
              if ((dim.mtf ?? 0) < 35) missingConfirmation.push('higher-timeframe alignment');

              const bottomLine = risk === 'EXTREME' || risk === 'HIGH'
                ? missingConfirmation.length
                  ? `Wait for stronger confirmation — especially ${missingConfirmation.slice(0,2).join(' or ')} — before considering a trade.`
                  : `Risk is ${risk.toLowerCase()} — keep any position size well below your normal.`
                : overall >= 65
                ? `This is a valid signal. Manage risk with a clear stop-loss and take partial profits at the first target.`
                : missingConfirmation.length
                  ? `Patience pays here. Wait for ${missingConfirmation.slice(0,2).join(' or ')} to strengthen the case before entering.`
                  : `Proceed with standard risk management — the setup is clear enough to trade.`;

              // ── Highlight rows ──────────────────────────────────────────
              const highlights: { label: string; value: string; color: string }[] = [];
              supporting.forEach(([n, v]) => highlights.push({ label: `✓ ${n}`, value: `${v.toFixed(0)}%`, color: T.green }));
              dragging.forEach(([n, v])   => highlights.push({ label: `✗ ${n}`, value: `${v.toFixed(0)}%`, color: T.red   }));

              return (
                <View style={{ backgroundColor: (T.bg2 ?? T.bg1 ?? '#1a1f2e') + 'dd',
                  borderRadius: 12, padding: 14, marginTop: 10, marginBottom: 2,
                  borderLeftWidth: 3, borderLeftColor: accent }}>
                  <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
                    letterSpacing: 1, marginBottom: 10 }}>WHY THE AI IS SAYING {d.action}</Text>

                  {/* Lead: conclusion first */}
                  <Text style={{ color: T.text, fontSize: 12.5, lineHeight: 20,
                    fontWeight: '500', marginBottom: 10 }}>{leadLine}</Text>

                  {/* Why: supporting + drag sentences */}
                  {(supportLine || dragLine) && (
                    <View style={{ marginBottom: 10, gap: 4 }}>
                      {supportLine ? <Text style={{ color: T.text, fontSize: 11.5, lineHeight: 18 }}>{'Why? '}{supportLine}</Text> : null}
                      {dragLine    ? <Text style={{ color: T.text, fontSize: 11.5, lineHeight: 18 }}>{dragLine}</Text> : null}
                    </View>
                  )}

                  {/* Engine score rows */}
                  {highlights.length > 0 && (
                    <View style={{ backgroundColor: (T.bg3 ?? '#0d1117') + 'aa', borderRadius: 8,
                      paddingHorizontal: 10, paddingVertical: 8, marginBottom: 10, gap: 5 }}>
                      {highlights.map(h => (
                        <View key={h.label} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Text style={{ color: T.textDim, fontSize: 10.5 }}>{h.label}</Text>
                          <Text style={{ color: h.color, fontSize: 10.5, fontWeight: '700' }}>{h.value}</Text>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* Model quality — no jargon, no 'random' */}
                  <Text style={{ color: T.textDim, fontSize: 11, lineHeight: 18,
                    fontStyle: 'italic', marginBottom: 10 }}>{mlNote}</Text>

                  {/* Bottom line — actionable */}
                  <View style={{ borderTopWidth: 1, borderTopColor: (T.border ?? '#333') + '60', paddingTop: 10 }}>
                    <Text style={{ color: T.textDim, fontSize: 8, fontWeight: '700',
                      letterSpacing: 0.8, marginBottom: 5 }}>BOTTOM LINE</Text>
                    <Text style={{ color: T.text, fontSize: 12, lineHeight: 19 }}>
                      <Text style={{ color: accent, fontWeight: '700' }}>{conf.recommendation}. </Text>
                      {bottomLine}
                    </Text>
                  </View>
                </View>
              );
            })()}

            {/* Trade Quality — setup quality, separate from confidence.
                Confidence = How sure is the AI? · Trade Quality = If correct, how good is the setup?
                Display only — never gates trades. */}
            {tradeQualityResult && (() => {
              const tq = (tradeQualityResult as any).quality as { score: number; grade: string; stars: string; riskBadge: string };
              const bd = (tradeQualityResult as any).breakdown as { strengths: string[]; weaknesses: string[] };
              if (!tq) return null;
              const tqColor = tq.grade === 'A+' || tq.grade === 'A' ? T.green : tq.grade === 'B' ? T.amber : T.red;
              const rbColor = tq.riskBadge === 'Low' ? T.green : tq.riskBadge === 'Medium' ? T.amber : T.red;
              return (
                <View style={{ marginBottom: 12, backgroundColor: T.bg3, borderRadius: 6, padding: 8 }}>
                  <Text style={{ color: T.textDim, fontSize: 9, letterSpacing: 1, marginBottom: 6 }}>📊 TRADE QUALITY</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={{ color: tqColor, fontSize: 20, fontWeight: '800' }}>{tq.grade}</Text>
                      <View>
                        <Text style={{ color: T.textSub, fontSize: 10, fontWeight: '700' }}>{tq.score.toFixed(0)}/100 {tq.stars}</Text>
                        <Text style={{ color: T.textDim, fontSize: 8 }}>Setup quality · not confidence</Text>
                      </View>
                    </View>
                    <View style={{ backgroundColor: rbColor + '20', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 }}>
                      <Text style={{ color: rbColor, fontSize: 8, fontWeight: '700' }}>{tq.riskBadge} Risk</Text>
                    </View>
                  </View>
                  {(bd?.strengths?.[0] || bd?.weaknesses?.[0]) ? (
                    <View style={{ marginTop: 5, gap: 2 }}>
                      {bd?.strengths?.[0] ? <Text style={{ color: T.green, fontSize: 8 }}>✓ {bd.strengths[0]}</Text> : null}
                      {bd?.weaknesses?.[0] ? <Text style={{ color: T.red, fontSize: 8 }}>✗ {bd.weaknesses[0]}</Text> : null}
                    </View>
                  ) : null}
                </View>
              );
            })()}

            {/* XAI reasoning */}
            {xai.summaryLines.length > 0 && (
              <View style={{ marginBottom: 10 }}>
                <Text style={{ color: T.textDim, fontSize: 9, letterSpacing: 1, marginBottom: 4 }}>🧠 AI REASONING</Text>
                {xai.summaryLines.map((line: string, i: number) => (
                  <Text key={i} style={{ color: T.textSub, fontSize: 9, lineHeight: 14, marginBottom: 2 }}>• {line}</Text>
                ))}
                {xai.riskFlags.length > 0 && (
                  <View style={{ backgroundColor: T.red+'12', borderRadius: 5, padding: 6, marginTop: 4 }}>
                    <Text style={{ color: T.red, fontSize: 9, fontWeight: '600' }}>⚠ {xai.riskSentence}</Text>
                  </View>
                )}
              </View>
            )}

            {/* Holdout + Drift metrics (Item 3) */}
            {(d.holdout || d.driftScore != null) && (
              <View style={{ backgroundColor: T.bg3, borderRadius: 6, padding: 8, marginBottom: 10 }}>
                <Text style={{ color: T.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, marginBottom: 5 }}>OUT-OF-SAMPLE VALIDATION</Text>
                {d.holdout && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                    {[
                      ['Holdout Acc', `${d.holdout.ensembleAccuracy.toFixed(1)}%`],
                      ['MLP Acc',     `${d.holdout.mlpAccuracy.toFixed(1)}%`],
                      ['LR Acc',      `${d.holdout.lrAccuracy.toFixed(1)}%`],
                      ['Precision',   `${(d.holdout.precision * 100).toFixed(1)}%`],
                      ['Recall',      `${(d.holdout.recall * 100).toFixed(1)}%`],
                      ['F1',          `${(d.holdout.f1 * 100).toFixed(1)}%`],
                    ].map(([label, value]) => (
                      <View key={label} style={{ alignItems: 'center', minWidth: 70 }}>
                        <Text style={{ color: T.textDim, fontSize: 8 }}>{label}</Text>
                        <Text style={{ color: T.text, fontSize: 11, fontWeight: '700' }}>{value}</Text>
                      </View>
                    ))}
                  </View>
                )}
                {d.holdout && (
                  <Text style={{ color: T.textDim, fontSize: 8 }}>
                    Confusion matrix (n={d.holdout.sampleCount})  TP:{d.holdout.truePositives} FP:{d.holdout.falsePositives} TN:{d.holdout.trueNegatives} FN:{d.holdout.falseNegatives}
                  </Text>
                )}
                {d.driftScore != null && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                    <Text style={{ color: T.textDim, fontSize: 8 }}>Distribution Drift Score</Text>
                    <Text style={{ color: d.driftScore > 1.5 ? T.red : d.driftScore > 0.8 ? T.amber : T.green, fontSize: 10, fontWeight: '700' }}>
                      {d.driftScore.toFixed(2)} {d.driftScore > 1.5 ? '⚠ HIGH' : d.driftScore > 0.8 ? '~ WATCH' : '✓ OK'}
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Top features */}
            <Text style={{ color: T.textDim, fontSize: 9, marginBottom: 2, letterSpacing: 1 }}>TOP CONTRIBUTING FEATURES</Text>
            {d.topFeatures.slice(0, 6).map((f: any, i: number) => {
              const maxInf = Math.max(...d.topFeatures.map((x: any) => x.influence), 1e-9);
              const barW   = Math.max(4, (f.influence / maxInf) * 100);
              const fColor = f.value > 0.05 ? T.green : f.value < -0.05 ? T.red : T.textDim;
              return (
                <View key={i} style={{ marginBottom: 6 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 }}>
                    <Text style={{ color: T.text, fontSize: 9.5 }}>{f.name}</Text>
                    <Text style={{ color: fColor, fontSize: 9.5, fontWeight: '700' }}>{isFinite(f.value) ? f.value.toFixed(3) : '—'}</Text>
                  </View>
                  <View style={{ height: 3, backgroundColor: T.bg0, borderRadius: 2 }}>
                    <View style={{ width: `${barW}%`, height: '100%', backgroundColor: fColor, borderRadius: 2 }} />
                  </View>
                </View>
              );
            })}

            {/* ── Market Context ─────────────────────────────────────────── */}
            {/* Always rendered when a prediction exists and kind !== NONE.   */}
            {/* Shows "Market Context unavailable" if data fetch failed.      */}
            <MarketContextCard snapshot={d.marketContext ?? null} T={T} />

            {/* ── Final Decision Banner + Gated CTA ──────────────────────── */}
            {/* Reserved area — prevents layout shift regardless of readiness state.     */}
            {/* Sequence (per ChatGPT review):                                           */}
            {/*   Prediction done → spinner → readiness computed → correct button        */}
            {/* The button NEVER renders before readiness is available.                  */}
            {/* No fallback state, no temporary WAIT button flashing before READY.       */}
            {d.action !== 'HOLD' && (
              <View style={{ marginTop: 12, minHeight: 120 }}>
                {!readiness ? (
                  // Spinner shown until readiness is non-null.
                  // minHeight on parent keeps the layout stable during this gap.
                  <View style={{ flex: 1, paddingVertical: 18, alignItems: 'center',
                    backgroundColor: T.bg3, borderRadius: RADIUS.md, borderWidth: 1,
                    borderColor: T.textDim + '20' }}>
                    <ActivityIndicator size="small" color={T.textDim} />
                    <Text style={{ color: T.textDim, fontSize: 10, marginTop: 6 }}>
                      Evaluating trade readiness…
                    </Text>
                  </View>
                ) : (() => {
              // readiness is guaranteed non-null here — no fallback needed.
              const rdState = readiness.state;
              const rdBlocker = readiness?.primaryBlocker ?? '';
              const isAvoid = rdState === 'AVOID';
              const isWait  = rdState === 'WAIT';
              const isReady = rdState === 'READY';
              const isBuy   = d.action === 'BUY';

              // Reset CTA state whenever a new prediction arrives (new signalId = new candle).
              // This is the canonical reset point — driven by data, not by user gesture.
              if (d.signalId && lastSignalIdRef.current !== d.signalId) {
                lastSignalIdRef.current = d.signalId;
                if (ctaState.type !== 'idle') setCtaState({ type: 'idle' });
              }

              // Final decision banner colors
              const bannerCol = isReady ? T.green : isAvoid ? T.red : T.amber;
              const bannerEmoji = isReady ? '✅' : isAvoid ? '🚫' : '⚠️';
              const bannerTitle = isReady ? 'READY TO TRADE'
                                : isAvoid ? 'NOT RECOMMENDED'
                                : 'PROCEED WITH CAUTION';

              // Banner body — from existing engine outputs, no new reasoning
              const bannerBody = (() => {
                if (isReady) return 'All signals aligned. Trade Readiness is READY.';
                if (isAvoid && readiness?.whyText) return readiness.whyText;
                if (isAvoid) return `Prediction is ${dDir === 'UP' ? 'bullish' : 'bearish'}, but confidence is low (${conf.overall.toFixed(0)}%, Grade ${conf.grade}) and Trade Readiness is AVOID.`;
                if (readiness?.whyText) return readiness.whyText;
                return `Prediction is ${dDir === 'UP' ? 'mildly bullish' : 'mildly bearish'}, but confidence (${conf.overall.toFixed(0)}%, Grade ${conf.grade}) is insufficient for a high-conviction entry.`;
              })();

              const handleTrade = () => {
                if (isSubmitting) return;
                setIsSubmitting(true);
                const enriched = { ...d, _liveOverallConfidence: conf.overall, _liveConfGrade: conf.grade } as any;
                if (isLiveMode && onLiveTrade) {
                  setIsSubmitting(false);
                  setCtaState({ type: 'position_opened', isLive: true });
                  onLiveTrade({
                    prediction:     enriched,
                    bypassGates:    false,
                    mtfState:       rdState,
                    signalSnapshot: null,
                    marketContext:  (d as any).marketContext ?? null,
                  });
                } else {
                  Promise.resolve(onPaperTrade(enriched, false, rdState))
                    .then((result: any) => {
                      if (result && result.opened === true) {
                        setCtaState({ type: 'position_opened', isLive: false });
                      } else if (result && result.opened === false) {
                        if (result.shadowRecorded) {
                          setCtaState({ type: 'shadow_recorded' });
                        } else {
                          setCtaState({ type: 'error', message: result.reason ?? 'Trade could not be opened.' });
                        }
                      }
                    })
                    .catch((err: any) => {
                      setCtaState({ type: 'error', message: `Engine error: ${err?.message ?? 'unknown'}` });
                    })
                    .finally(() => setIsSubmitting(false));
                }
              };

              const handleOverrideTrade = () => {
                // Lock BEFORE showing the alert — prevents double-tap opening a second dialog.
                if (isSubmitting) return;
                setIsSubmitting(true);

                // Build a human-readable reason list from strategy blockers.
                const allBlockers: any[] = (readiness as any)?.strategyBlockers ?? [];
                const ALERT_GROUPS = [
                  { label: 'Market Conditions',    sources: ['REGIME', 'MTF'] },
                  { label: 'Signal Quality',        sources: ['CONFIDENCE'] },
                  { label: 'Strategy Requirements', sources: ['BOS', 'PATTERN', 'SMC'] },
                ];
                const groupedMsg = ALERT_GROUPS
                  .map(g => ({ ...g, items: allBlockers.filter((b: any) => g.sources.includes(b.source)) }))
                  .filter(g => g.items.length > 0)
                  .map(g => g.label + ':\n' + g.items.map((b: any) => '  ' + (b.severity === 'AVOID' ? '✕' : '•') + ' ' + b.reason).join('\n'))
                  .join('\n\n');

                // Plain-English alert title and body — no engineering jargon.
                const alertTitle = isAvoid
                  ? '⚠️ AI Recommends Against This Trade'
                  : '⚠️ AI Suggests Waiting';
                const alertBody = (groupedMsg || rdBlocker || bannerBody) +
                  '\n\nIf you override, the trade is opened immediately and recorded in your history. ' +
                  'The AI\'s reasoning is saved for your Trading Coach to review later.';

                Alert.alert(
                  alertTitle,
                  alertBody,
                  [
                    {
                      text: isAvoid ? 'Keep AI Decision' : 'Wait (Recommended)',
                      style: 'cancel',
                      onPress: () => {
                        setIsSubmitting(false);
                        // WAIT: user is just waiting, signal still active, no shadow written.
                        // AVOID: engine already wrote a shadow entry when it evaluated this
                        // signal. We confirm this from result.shadowRecorded, not from the
                        // signal state. Since we don't have an engine result here (user
                        // cancelled before attempting), we use WAIT state for both —
                        // the shadow entry the engine wrote when computing AVOID readiness
                        // is already in the journal from the earlier evaluation pass.
                        // The ctaState here just controls what the button shows next.
                        setCtaState({ type: 'waiting' });
                      },
                    },
                    {
                      text: 'Override & Enter Anyway',
                      style: 'destructive',
                      onPress: () => {
                        const enrichedOverride = { ...d, _liveOverallConfidence: conf.overall, _liveConfGrade: conf.grade } as any;
                        if (isLiveMode && onLiveTrade) {
                          setIsSubmitting(false);
                          setCtaState({ type: 'position_opened', isLive: true });
                          onLiveTrade({
                            prediction:     enrichedOverride,
                            bypassGates:    true,
                            mtfState:       rdState,
                            signalSnapshot: null,
                            marketContext:  (d as any).marketContext ?? null,
                          });
                        } else {
                          Promise.resolve(onPaperTrade(enrichedOverride, true, rdState))
                            .then((result: any) => {
                              if (result && result.opened === true) {
                                appendOverrideLog({
                                  timestamp:             Date.now(),
                                  symbol,
                                  tradeReadiness:        rdState,
                                  blockerReason:         rdBlocker || bannerBody,
                                  predictionDirection:   dDir,
                                  predictionProbability: d.ensembleProbUp,
                                  confidenceOverall:     conf.overall,
                                  confidenceGrade:       conf.grade,
                                  recommendation:        conf.recommendation,
                                }).catch(() => {});
                                setOverrideStats(prev => prev
                                  ? { ...prev, total: prev.total + 1, forState: isAvoid ? prev.forState + 1 : prev.forState }
                                  : { total: 1, forState: isAvoid ? 1 : 0, wins: 0, losses: 0, winRate: NaN, settled: 0 }
                                );
                                notifyOverrideRecorded(symbol, dDir === 'UP' ? 'LONG' : 'SHORT', rdState as 'WAIT' | 'AVOID').catch(() => {});
                                setCtaState({ type: 'position_opened', isLive: false });
                              } else if (result && result.opened === false) {
                                // Use engine's shadowRecorded — never infer from reason strings.
                                if (result.shadowRecorded) {
                                  setCtaState({ type: 'shadow_recorded' });
                                } else {
                                  setCtaState({ type: 'error', message: result.reason ?? 'Trade could not be opened.' });
                                }
                              }
                            })
                            .catch((err: any) => {
                              setCtaState({ type: 'error', message: `Engine error: ${err?.message ?? 'unknown'}` });
                            })
                            .finally(() => setIsSubmitting(false));
                        }
                      },
                    },
                  ],
                );
              };

              return (
                <View style={{ gap: 8 }}>
                  {/* Final Decision Banner */}
                  <View style={{
                    backgroundColor: bannerCol + '15',
                    borderRadius: RADIUS.md,
                    borderLeftWidth: 4,
                    borderLeftColor: bannerCol,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: bannerCol + '40',
                  }}>
                    <Text style={{ color: bannerCol, fontSize: 11, fontWeight: '800',
                      letterSpacing: 0.3, marginBottom: 5 }}>
                      {bannerEmoji} {bannerTitle}
                    </Text>
                    <Text style={{ color: T.text, fontSize: 11, lineHeight: 16 }}>
                      {bannerBody}
                    </Text>
                  </View>

                  {/* Override outcome summary — shown for WAIT and AVOID when user has prior overrides */}
                  {(isAvoid || isWait) && overrideStats && overrideStats.forState > 0 && (() => {
                    const { forState, wins, losses, winRate, settled } = overrideStats;
                    const hasOutcomes = settled > 0;
                    const wrColor = !hasOutcomes ? T.textDim
                      : winRate >= 55 ? T.green
                      : winRate >= 45 ? T.amber ?? '#f59e0b'
                      : T.red;
                    return (
                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                        gap: 6, paddingVertical: 4, paddingHorizontal: 10,
                        backgroundColor: T.bg3, borderRadius: 6 }}>
                        <Text style={{ color: T.textDim, fontSize: 9 }}>
                          Override history:
                        </Text>
                        <Text style={{ color: T.textSub, fontSize: 9, fontWeight: '700' }}>
                          {forState} trade{forState !== 1 ? 's' : ''}
                        </Text>
                        {hasOutcomes ? (
                          <>
                            <Text style={{ color: T.textDim, fontSize: 9 }}>•</Text>
                            <Text style={{ color: T.green, fontSize: 9, fontWeight: '700' }}>
                              {wins}W
                            </Text>
                            <Text style={{ color: T.red, fontSize: 9, fontWeight: '700' }}>
                              {losses}L
                            </Text>
                            <Text style={{ color: T.textDim, fontSize: 9 }}>•</Text>
                            <Text style={{ color: wrColor, fontSize: 9, fontWeight: '800' }}>
                              {winRate.toFixed(0)}% WR
                            </Text>
                          </>
                        ) : (
                          <Text style={{ color: T.textDim, fontSize: 9 }}>• awaiting outcome</Text>
                        )}
                      </View>
                    );
                  })()}

                  {/* ── CTA State Machine ───────────────────────────────────────── */}
                  {/* Driven by engine result — never inferred from signal state.    */}
                  {/* Resets when signalId changes (new prediction = new candle).    */}
                  {ctaState.type === 'idle' && (
                    <>
                      {isReady && (
                        <TouchableOpacity
                          onPress={handleTrade}
                          disabled={isSubmitting}
                          activeOpacity={0.85}
                          style={{ backgroundColor: isSubmitting ? (T.blue ?? T.accent) + '80' : (T.blue ?? T.accent),
                            paddingVertical: 14, borderRadius: RADIUS.md, alignItems: 'center' }}>
                          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.3 }}>
                            {isLiveMode ? '● ' : ''}{isBuy ? '▲ Open Long' : '▼ Open Short'}{isLiveMode ? ' (LIVE)' : ''}
                          </Text>
                        </TouchableOpacity>
                      )}
                      {isWait && (
                        <TouchableOpacity
                          onPress={handleOverrideTrade}
                          disabled={isSubmitting}
                          activeOpacity={0.85}
                          style={{ backgroundColor: isSubmitting ? (T.amber ?? '#F59E0B') + '80' : (T.amber ?? '#F59E0B'),
                            paddingVertical: 14, borderRadius: RADIUS.md, alignItems: 'center' }}>
                          <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.3 }}>
                            ⚠ {isBuy ? 'Open Long' : 'Open Short'} — Caution{isLiveMode ? ' (LIVE)' : ''}
                          </Text>
                        </TouchableOpacity>
                      )}
                      {isAvoid && (
                        <TouchableOpacity
                          onPress={handleOverrideTrade}
                          disabled={isSubmitting}
                          activeOpacity={0.75}
                          style={{ backgroundColor: T.red + '12', paddingVertical: 12,
                            borderRadius: RADIUS.md, alignItems: 'center',
                            borderWidth: 1.5, borderColor: isSubmitting ? T.red + '50' : T.red }}>
                          <Text style={{ color: T.red, fontWeight: '700', fontSize: 14, letterSpacing: 0.3 }}>
                            {isBuy ? '▲ Open Long' : '▼ Open Short'}{isLiveMode ? ' (LIVE)' : ''} — Override AI
                          </Text>
                          <Text style={{ color: T.red + 'aa', fontSize: 9, marginTop: 2 }}>
                            Tap to see reasons and confirm
                          </Text>
                        </TouchableOpacity>
                      )}
                    </>
                  )}

                  {/* Position opened — replace button with Manage Position */}
                  {ctaState.type === 'position_opened' && (
                    <TouchableOpacity
                      onPress={() => ctaState.isLive ? navigateToLivePositions() : navigateToPaperTrading()}
                      activeOpacity={0.85}
                      style={{ backgroundColor: T.green + '18', paddingVertical: 14,
                        borderRadius: RADIUS.md, alignItems: 'center',
                        borderWidth: 1.5, borderColor: T.green }}>
                      <Text style={{ color: T.green, fontWeight: '800', fontSize: 14, letterSpacing: 0.3 }}>
                        📊 Manage Position →
                      </Text>
                      <Text style={{ color: T.green + 'bb', fontSize: 10, marginTop: 2 }}>
                        {ctaState.isLive ? 'View in Live Positions' : 'View in Paper Trading'}
                      </Text>
                    </TouchableOpacity>
                  )}

                  {/* Shadow journal recorded — replace button with View Shadow Journal */}
                  {ctaState.type === 'shadow_recorded' && (
                    <TouchableOpacity
                      onPress={() => navigateToShadowJournal()}
                      activeOpacity={0.85}
                      style={{ backgroundColor: T.accent + '18', paddingVertical: 14,
                        borderRadius: RADIUS.md, alignItems: 'center',
                        borderWidth: 1.5, borderColor: T.accent }}>
                      <Text style={{ color: T.accent, fontWeight: '800', fontSize: 14, letterSpacing: 0.3 }}>
                        🔍 View Shadow Journal →
                      </Text>
                      <Text style={{ color: T.accent + 'bb', fontSize: 10, marginTop: 2 }}>
                        Opportunity tracked — tap to review
                      </Text>
                    </TouchableOpacity>
                  )}

                  {/* User chose to wait — no shadow entry written, signal still valid */}
                  {ctaState.type === 'waiting' && (
                    <View style={{ backgroundColor: T.bg3, paddingVertical: 13,
                      borderRadius: RADIUS.md, alignItems: 'center',
                      borderWidth: 1, borderColor: T.border }}>
                      <Text style={{ color: T.textDim, fontWeight: '700', fontSize: 13 }}>
                        ⏳ Waiting — re-predict when conditions improve
                      </Text>
                      <Text style={{ color: T.textDim, fontSize: 10, marginTop: 3 }}>
                        Tap Predict below to check the signal again
                      </Text>
                    </View>
                  )}

                  {/* Engine error or hard-gate failure with no shadow written */}
                  {ctaState.type === 'error' && (
                    <View style={{ backgroundColor: T.red + '12', paddingVertical: 12,
                      borderRadius: RADIUS.md, paddingHorizontal: 14,
                      borderWidth: 1, borderColor: T.red + '50' }}>
                      <Text style={{ color: T.red, fontWeight: '700', fontSize: 12, lineHeight: 17 }}>
                        🔴 {ctaState.message}
                      </Text>
                    </View>
                  )}
                </View>
              );
                })()}
              </View>
            )}
          </View>
        );
      })()}

      <View style={{ marginTop: 12 }}>
        <GradientButton
          label={mlStatus === 'training' ? '⏳ Predicting...' : '🔮 Predict'}
          onPress={() => onRunPrediction(false)}
          color={T.accent}
          theme={T}
          disabled={mlStatus === 'training'}
        />
      </View>

    </Card>
  );
}

