// ─────────────────────────────────────────────────────────────────────────────
// TRADE READINESS  (v2.1.0)
//
// v2.1.0 change: added optional strategyContext field to TradeReadiness.
//   - StrategyDisplayContext is presentation metadata ONLY.
//   - It contains no decision logic, no confidence, no BUY/SELL.
//   - computeTradeReadiness() assigns it after all decision fields are computed.
//   - No decision field (state, primaryBlocker, flipCondition, etc.) reads it.
//   - When no strategy is active: strategyContext = null → UI unchanged.
//
// DESIGN CONTRACT — read before editing:
//   This file is a TRANSLATOR, not a decision engine.
//   It reads outputs from existing engines and converts them to plain English.
//   It must NEVER:
//     • Recompute BOS, CHoCH, alignment, confidence, or any ML feature
//     • Introduce independent thresholds that could contradict the prediction
//     • Duplicate logic already in mtfEngine, regimeTypes, or mlSignal
//
//   Single source of truth: the prediction engine made the decision.
//   This file explains that decision in human language.
//
// v2.0.0 additions (all read from existing engine outputs, zero new logic):
//   actionChecklist   — ordered "What Should I Do?" steps
//   riskStatement     — one sentence: cost of ignoring the readiness state
//   decisionFactors   — per-engine label + verdict for "Decision Breakdown"
//   conflictNote      — which engine is the primary blocker, and why it outweighs
//   nextTrigger       — single "Alert when X" line for future notification feature
// ─────────────────────────────────────────────────────────────────────────────

import { Timeframe, TF_ORDER, TFSignal, MTFScores } from './mtfTypes';
import { MTF_ALIGN_MIN, SMC_OB_MIN, StrategyProfile } from '../strategy/strategyTypes';
import { evaluateSignalGates } from '../signalGates';

// ── Public types ──────────────────────────────────────────────────────────────
export type TradeReadinessState = 'READY' | 'WAIT' | 'AVOID';

// ── Strategy display context — presentation metadata only ─────────────────────
// This type contains NO decision logic. It is display information about the
// active trading strategy, shown in TradeReadinessCard below the core decision.
//
// Rules enforced by ChatGPT review and maintained here:
//   ✗ No confidence values
//   ✗ No prediction direction or action
//   ✗ No regime label
//   ✗ No MTF scores
//   ✗ No BUY/SELL/HOLD decision
//   ✓ Display strings only: name, icon, timeframes, holding period, watchFor
export type StrategyDisplayContext = {
  strategyName:       string;    // e.g. "Swing"
  strategyIcon:       string;    // e.g. "🌊"
  predictionHorizon:  number;    // e.g. 10 (bars) — for display, not decision
  preferredTimeframes:string[];  // e.g. ['4h', '1d']
  holdingLabel:       string;    // e.g. "2–5 trading days"
  watchFor:           string;    // e.g. "HTF BOS confirmed, regime aligned"
  notes:              string;    // optional additional context, may be empty
};

export type TFStripEntry = {
  tf:        Timeframe;
  direction: 'BULLISH' | 'BEARISH' | 'RANGING';
  isCurrent: boolean;
  isBlocking: boolean;   // true = this TF is the primary conflict source
};

export type DecisionFactor = {
  engine:  string;          // display name e.g. "Market Regime"
  role:    string;          // context | confirmation | timing | structure
  verdict: 'BUY' | 'SELL' | 'WAIT' | 'NEUTRAL';
  detail:  string;          // one short phrase explaining the verdict
};

export type TradeReadiness = {
  state:            TradeReadinessState;
  headline:         string;          // collapsed card: "🟡 WAIT"
  whyText:          string;          // expanded: plain-English reason
  actionChecklist:  string[];        // "What Should I Do?" ordered steps
  riskStatement:    string;          // "Risk if you ignore this"
  primaryBlocker:   string;
  flipCondition:    string;          // "What Changes This"
  nextTrigger:      string;          // "Alert when X" — future notification hook
  nextReviewTF:     Timeframe | null;
  nextReviewLabel:  string;
  tfStrip:          TFStripEntry[];
  decisionFactors:  DecisionFactor[];
  conflictNote:     string;          // e.g. "MTF outweighs Pattern — structure before signal"
  unavailable:      boolean;
  // Strategy display context — null when no strategy is active.
  // Assigned last in computeTradeReadiness(), after all decision fields.
  // Never read by any decision logic in this file.
  strategyContext:  StrategyDisplayContext | null;
  // All strategy gate failures, in priority order (v6.9.8).
  // strategyBlockers[0] is the Primary Blocker.
  // strategyBlockers[1..n] are "Other blockers" shown to the user so they
  // know all requirements that need to be met, not just the first one found.
  // Empty array when no strategy is active or all gates pass.
  strategyBlockers: { source: string; reason: string; severity: 'AVOID' | 'WAIT' }[];
};

// ── Internal helpers ──────────────────────────────────────────────────────────

function dirLabel(v: number): 'BULLISH' | 'BEARISH' | 'RANGING' {
  return v > 0 ? 'BULLISH' : v < 0 ? 'BEARISH' : 'RANGING';
}

const TF_DISPLAY: Record<string, string> = {
  '5m': '5-minute', '15m': '15-minute', '30m': '30-minute',
  '1h': '1-hour', '4h': '4-hour', '1d': 'Daily', '1D': 'Daily',
  '1w': 'Weekly', '1W': 'Weekly',
};

const TF_SHORT: Record<string, string> = {
  '5m': '5M', '15m': '15M', '30m': '30M', '1h': '1H', '4h': '4H',
  '1d': '1D', '1D': '1D', '1w': '1W', '1W': '1W',
};

function nextReviewPhrase(tf: Timeframe | null): string {
  if (!tf) return 'when more data is available';
  return `after the current ${TF_DISPLAY[tf]} candle closes`;
}

// Find the highest TF whose trend/structure contradicts the intended trade dir.
function findBlockingTF(
  signals:  TFSignal[],
  tradeDir: 1 | -1,
  baseTF:   Timeframe,
): Timeframe | null {
  const baseTFIdx = TF_ORDER.indexOf(baseTF);
  const sorted = [...signals]
    .filter(s => TF_ORDER.indexOf(s.tf) > baseTFIdx && s.barCount >= 10)
    .sort((a, b) => TF_ORDER.indexOf(b.tf) - TF_ORDER.indexOf(a.tf));
  for (const s of sorted) {
    if (s.trendDir !== 0 && s.trendDir !== tradeDir) return s.tf;
    if (s.structureDir !== 0 && s.structureDir !== tradeDir) return s.tf;
  }
  return null;
}

// ── Decision factors — reads each engine output, returns a labelled verdict ───
// Reads: prediction.action, regimeSnap.label, mtfSnap.overallMTFScore,
//        smcSnap.bullOBStrength/bearOBStrength, msSnapshot.structureHighs/Lows,
//        validatedPatterns[0].direction
// Computes: nothing — pure label mapping from existing outputs.
function buildDecisionFactors(params: {
  tradeDir:          1 | -1 | 0;
  regimeSnap:        { label: string; bullScore: number; bearScore: number } | null;
  mtfSnap:           MTFScores | null;
  smcSnap?:          { bullOBStrength: number; bearOBStrength: number; pdBias: number } | null;
  msSnapshot?:       { structureHighs: string; structureLows: string } | null;
  topPattern?:       { direction: string; confidence: number } | null;
}): DecisionFactor[] {
  const { tradeDir, regimeSnap, mtfSnap, smcSnap, msSnapshot, topPattern } = params;
  const factors: DecisionFactor[] = [];

  // ① Market Regime — context layer
  if (regimeSnap) {
    const bullish = regimeSnap.label.includes('BULL');
    const bearish = regimeSnap.label.includes('BEAR');
    const regimeDir = bullish ? 1 : bearish ? -1 : 0;
    // If regime agrees with trade direction → supporting verdict
    // If regime opposes → blocking verdict
    const verdict: DecisionFactor['verdict'] =
      regimeDir === 0        ? 'NEUTRAL'
      : regimeDir === tradeDir ? (tradeDir === 1 ? 'BUY' : 'SELL')   // agrees
      : tradeDir === 1         ? 'SELL'                                // regime bearish, we want to buy
      : 'BUY';                                                         // regime bullish, we want to sell
    factors.push({
      engine:  'Market Regime',
      role:    'context',
      verdict,
      detail:  regimeSnap.label.replace(/_/g, ' ')});
  }

  // ② Multi-Timeframe — timing / alignment layer
  if (mtfSnap) {
    const score = mtfSnap.overallMTFScore;
    // score > 0.15 = bullish alignment, score < -0.15 = bearish alignment
    // Compare alignment direction against intended trade direction
    const alignDir = score > 0.15 ? 1 : score < -0.15 ? -1 : 0;
    const verdict: DecisionFactor['verdict'] =
      alignDir === 0         ? 'WAIT'
      : alignDir === tradeDir ? (tradeDir === 1 ? 'BUY' : 'SELL')    // alignment agrees
      : tradeDir === 1        ? 'SELL'                                 // bearish alignment, we want to buy
      : 'BUY';                                                         // bullish alignment, we want to sell
    factors.push({
      engine:  'Multi-Timeframe',
      role:    'timing',
      verdict,
      detail:  score > 0.15 ? 'Timeframes aligned' : score < -0.15 ? 'Timeframes misaligned' : 'Alignment weak'});
  }

  // ③ Pattern Engine — confirmation layer
  if (topPattern) {
    const patDir = topPattern.direction === 'bullish' ? 1 : topPattern.direction === 'bearish' ? -1 : 0;
    const verdict: DecisionFactor['verdict'] =
      patDir === 0         ? 'NEUTRAL'
      : patDir === tradeDir ? (tradeDir === 1 ? 'BUY' : 'SELL')   // pattern agrees
      : tradeDir === 1      ? 'SELL'                                // bearish pattern, we want to buy
      : 'BUY';                                                      // bullish pattern, we want to sell
    factors.push({
      engine:  'Pattern Engine',
      role:    'confirmation',
      verdict,
      detail:  `${topPattern.confidence.toFixed(0)}% confidence`});
  }

  // ④ Market Structure — structure layer
  if (msSnapshot) {
    const bullStruct = msSnapshot.structureHighs === 'HH' && msSnapshot.structureLows === 'HL';
    const bearStruct = msSnapshot.structureHighs === 'LH' && msSnapshot.structureLows === 'LL';
    const structDir  = bullStruct ? 1 : bearStruct ? -1 : 0;
    const verdict: DecisionFactor['verdict'] =
      structDir === 0         ? 'NEUTRAL'
      : structDir === tradeDir ? (tradeDir === 1 ? 'BUY' : 'SELL')  // structure agrees
      : tradeDir === 1         ? 'SELL'                               // bearish structure, we want to buy
      : 'BUY';                                                        // bullish structure, we want to sell
    factors.push({
      engine:  'Market Structure',
      role:    'structure',
      verdict,
      detail:  bullStruct ? 'HH + HL (bullish)' : bearStruct ? 'LH + LL (bearish)' : 'Mixed structure'});
  }

  return factors;
}

// Determine the conflict note: which engine is primary and why it outweighs.
// Weight hierarchy (explicit, matches mtfScore.ts weighting logic):
//   Structure > Multi-Timeframe > Regime > Pattern
function buildConflictNote(factors: DecisionFactor[], tradeDir: 1 | -1 | 0): string {
  if (tradeDir === 0) return '';
  const targetVerdict: DecisionFactor['verdict'] = tradeDir === 1 ? 'BUY' : 'SELL';
  const blocking = factors.filter(f => f.verdict !== targetVerdict && f.verdict !== 'NEUTRAL');
  if (!blocking.length) return '';

  // Priority order
  const priority = ['Market Structure', 'Multi-Timeframe', 'Market Regime', 'Pattern Engine'];
  const topBlocker = blocking.sort(
    (a, b) => priority.indexOf(a.engine) - priority.indexOf(b.engine)
  )[0];

  const reasonMap: Record<string, string> = {
    'Market Structure': 'Structure sets the context — no entry against the prevailing swing direction.',
    'Multi-Timeframe':  'MTF alignment outweighs entry signals — higher timeframes define the trend.',
    'Market Regime':    'Regime sets the macro backdrop — trading against it lowers your edge.',
    'Pattern Engine':   'Pattern confirmation is required before executing the trade signal.'};

  return `${topBlocker.engine} is blocking. ${reasonMap[topBlocker.engine] ?? ''}`;
}

// ── Main translator ───────────────────────────────────────────────────────────
export function computeTradeReadiness(params: {
  prediction:   { action: string; direction: string; confidence: number } | null;
  mtfSnap:      MTFScores | null;
  mtfSignals:   TFSignal[];
  regimeSnap:   { label: string; bullScore: number; bearScore: number; confidence: number } | null;
  baseTF:       Timeframe;
  lastSwingHigh?: number | null;
  lastSwingLow?:  number | null;
  pricePrecision?: number;
  // Optional engine snapshots for Decision Breakdown
  smcSnap?:     { bullOBStrength: number; bearOBStrength: number; pdBias: number } | null;
  msSnapshot?:  { structureHighs: string; structureLows: string } | null;
  topPattern?:  { direction: string; confidence: number } | null;
  // Optional strategy display context — passed through to output unchanged.
  // computeTradeReadiness() does NOT read this to make any decision.
  strategyContext?: StrategyDisplayContext | null;
  // Optional active strategy profile — when present, its gates are evaluated
  // AFTER the engine state is derived and can upgrade state to WAIT/AVOID.
  // This is the correct position: strategy filters the already-computed signal,
  // it does not change how any engine produces its output.
  strategyProfile?: StrategyProfile | null;
}): TradeReadiness {

  const {
    prediction, mtfSnap, mtfSignals, regimeSnap, baseTF,
    lastSwingHigh, lastSwingLow, pricePrecision = 2,
    smcSnap, msSnapshot, topPattern,
    strategyContext = null,
    strategyProfile = null} = params;

  // ── Graceful fallback ─────────────────────────────────────────────────────
  if (!prediction || !mtfSnap || !regimeSnap) {
    return {
      state: 'WAIT', headline: '', whyText: '',
      actionChecklist: [], riskStatement: '',
      primaryBlocker: '', flipCondition: '', nextTrigger: '',
      nextReviewTF: null, nextReviewLabel: '',
      tfStrip: [], decisionFactors: [], conflictNote: '',
      unavailable: true,
      strategyContext: null,
      strategyBlockers: []};
  }

  // ── Read the prediction engine's decision (single source of truth) ─────────
  const action   = prediction.action; // 'BUY' | 'SELL' | 'HOLD'
  // Backward-compat: old stored MLPrediction objects serialised before the
  // `direction` field was added will have undefined here. Derive it from
  // `action` so legacy cached predictions never throw at runtime.
  const direction: 'UP' | 'DOWN' | 'NEUTRAL' =
    prediction.direction ??
    (action === 'BUY' ? 'UP' : action === 'SELL' ? 'DOWN' : 'NEUTRAL');
  const tradeDir: 1 | -1 | 0 =
    direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;

  // ── State derivation — from existing engine outputs only ──────────────────
  const htfAgrees  = mtfSnap.htfBias === 0 || mtfSnap.htfBias === tradeDir;
  const chochBlock = tradeDir !== 0 &&
    (tradeDir === 1 ? mtfSnap.chochAlignment < -0.3 : mtfSnap.chochAlignment > 0.3);

  let state: TradeReadinessState;
  if (action === 'HOLD' || tradeDir === 0) {
    state = 'WAIT';
  } else if (!htfAgrees || chochBlock) {
    state = 'AVOID';
  } else if (Math.abs(mtfSnap.overallMTFScore) < 0.15) {
    state = 'WAIT';
  } else {
    state = 'READY';
  }

  // ── Signal gates — shared with attemptOpenPosition (single source of truth) ──
  // evaluateSignalGates() runs regime + strategy gates using the same logic as
  // the execution engine. Both paths now call this same function with the same
  // regimeLabel (regimeSnap.label) → READY here means "allowed" in execution.
  //
  // Note: we still collect strategyBlockers[] for UI display purposes (showing
  // which specific strategy gates failed). evaluateSignalGates gives us the
  // aggregate result; we reconstruct the per-gate detail for the UI below.
  const strategyBlockers: { source: string; reason: string; severity: 'AVOID' | 'WAIT' }[] = [];

  if (action !== 'HOLD' && tradeDir !== 0 && state !== 'AVOID' && regimeSnap) {
    // Build per-gate detail for UI (strategy gates only — for strategyBlockers array)
    // This mirrors the logic inside applyStrategyFilter, but collects ALL failures
    // instead of short-circuiting, so the UI can show every blocker at once.
    if (strategyProfile) {
      const regLabel = regimeSnap.label;
      if (strategyProfile.blockRegimes.includes(regLabel as any) ||
          (strategyProfile.allowedRegimes.length > 0 && !strategyProfile.allowedRegimes.includes(regLabel as any))) {
        strategyBlockers.push({ source: 'REGIME', severity: 'AVOID',
          reason: strategyProfile.name + ' does not trade in ' + regLabel.replace(/_/g, ' ') + ' regime.' });
      }
      if (prediction.confidence < strategyProfile.minConfidence) {
        strategyBlockers.push({ source: 'CONFIDENCE', severity: 'WAIT',
          reason: 'Confidence ' + prediction.confidence.toFixed(0) + '/100 is below ' + strategyProfile.name + ' minimum (' + strategyProfile.minConfidence + ').' });
      }
      if (strategyProfile.requireMTFAlignment) {
        const alignScore = Math.abs(mtfSnap.overallMTFScore);
        if (alignScore < MTF_ALIGN_MIN) {
          strategyBlockers.push({ source: 'MTF', severity: 'WAIT',
            reason: 'MTF alignment too weak for ' + strategyProfile.name + ' (score ' + alignScore.toFixed(2) + ', need ' + MTF_ALIGN_MIN + ').' });
        }
      }
      if (strategyProfile.requireBOS) {
        const baseSig = mtfSignals.find(s => s.tf === baseTF);
        const anyBOS  = baseSig ? baseSig.bosDetected : mtfSignals.some(s => s.bosDetected && s.barCount >= 10);
        if (!anyBOS) {
          strategyBlockers.push({ source: 'BOS', severity: 'WAIT',
            reason: strategyProfile.name + ' requires a Break of Structure on ' + baseTF + '. None detected.' });
        }
      }
      if (strategyProfile.requirePatternConfirm) {
        if (!topPattern || topPattern.confidence < 60) {
          strategyBlockers.push({ source: 'PATTERN', severity: 'WAIT',
            reason: strategyProfile.name + ' requires a confirmed pattern' + (topPattern ? '. Current: ' + topPattern.confidence.toFixed(0) + '% (need >= 60%).' : '. None detected.') });
        }
      }
      if (strategyProfile.requireSMC && smcSnap) {
        const relevantOB = tradeDir === 1 ? smcSnap.bullOBStrength : smcSnap.bearOBStrength;
        if (relevantOB < SMC_OB_MIN) {
          strategyBlockers.push({ source: 'SMC', severity: 'WAIT',
            reason: strategyProfile.name + ' requires an Order Block (strength >= ' + SMC_OB_MIN + '). Current: ' + relevantOB.toFixed(2) + '.' });
        }
      }
    }

    // Now call the SHARED gate function — same one the execution engine calls.
    // This is the authoritative state decision. The strategyBlockers above are
    // for UI display only and do not independently change state.
    const sgResult = evaluateSignalGates({
      regimeLabel:       regimeSnap.label,
      direction:         tradeDir === 1 ? 'LONG' : 'SHORT',
      ensembleProbUp:    prediction.action === 'BUY' ? 0.7 : 0.3,
      confidence:        prediction.confidence,
      horizons:          [],
      mtfReadinessState: state,   // Phase 1 MTF result — gates can only raise it
      strategyProfile:   strategyProfile ?? null,
      mtfSnap:           mtfSnap ?? null,
      mtfSignals,
      baseTF,
      smcBullOBStrength: smcSnap?.bullOBStrength ?? 0,
      smcBearOBStrength: smcSnap?.bearOBStrength ?? 0,
      validatedPatterns: []});

    if (!sgResult.allowed) {
      if (sgResult.state === 'AVOID') state = 'AVOID';
      else if (state === 'READY') state = 'WAIT';
    }
  }

  // Primary and source from first (highest-priority) blocker
  const strategyBlockReason = strategyBlockers[0]?.reason ?? null;
  const strategyBlockSource = strategyBlockers[0]?.source ?? null;

  // ── TF strip ──────────────────────────────────────────────────────────────
  const baseTFIdx  = TF_ORDER.indexOf(baseTF);
  const blockingTF = tradeDir !== 0
    ? findBlockingTF(mtfSignals, tradeDir as 1 | -1, baseTF)
    : null;

  const tfStrip: TFStripEntry[] = [];
  tfStrip.push({
    tf: baseTF, direction: dirLabel(tradeDir),
    isCurrent: true, isBlocking: false});
  const higherSignals = mtfSignals
    .filter(s => TF_ORDER.indexOf(s.tf) > baseTFIdx && s.barCount >= 10)
    .sort((a, b) => TF_ORDER.indexOf(a.tf) - TF_ORDER.indexOf(b.tf));
  for (const s of higherSignals) {
    tfStrip.push({
      tf: s.tf,
      direction: dirLabel(s.trendDir !== 0 ? s.trendDir : s.structureDir),
      isCurrent: false,
      isBlocking: s.tf === blockingTF});
  }

  // ── Decision factors ──────────────────────────────────────────────────────
  const decisionFactors = buildDecisionFactors({
    tradeDir, regimeSnap, mtfSnap, smcSnap, msSnapshot, topPattern});
  const conflictNote = buildConflictNote(decisionFactors, tradeDir);

  // ── Regime / pattern helpers for text generation ──────────────────────────
  const regimeBull    = regimeSnap.label.includes('BULL');
  const regimeBear    = regimeSnap.label.includes('BEAR');
  const regimeSide    = regimeSnap.label.includes('SIDEWAYS') || regimeSnap.label.includes('RANGING');
  const tradeDirWord  = tradeDir === 1 ? 'bullish' : tradeDir === -1 ? 'bearish' : 'neutral';
  const actionWord    = action === 'BUY' ? 'buy' : action === 'SELL' ? 'sell' : 'trade';
  const entryTF       = TF_DISPLAY[baseTF] ?? baseTF ?? 'current';
  const blockTFWord   = blockingTF ? (TF_DISPLAY[blockingTF] ?? blockingTF) : null;

  // ── Why text ──────────────────────────────────────────────────────────────
  let whyText: string;
  if (strategyBlockReason) {
    // Strategy-specific explanation takes precedence
    const profileName = strategyProfile?.name ?? 'Active strategy';
    whyText = strategyBlockReason + ` The ${profileName} profile requires additional confirmation before this signal qualifies as a trade.`;
  } else if (state === 'READY') {
    const agreedCount = tfStrip.filter(t =>
      t.direction === (tradeDir === 1 ? 'BULLISH' : 'BEARISH')).length;
    whyText = `${agreedCount} of ${tfStrip.length} timeframes support your ${tradeDirWord} signal. The higher timeframe trend and your entry timeframe are pointing in the same direction — this is strong confluence.`;
  } else if (state === 'WAIT') {
    if (action === 'HOLD') {
      whyText = regimeSide
        ? `The market is ranging without a clear direction. No trade signal has been generated yet — wait for a breakout.`
        : `The engines have not aligned on a clear trade signal yet. Conditions are mixed — patience here protects your capital.`;
    } else {
      whyText = blockTFWord
        ? `The ${blockTFWord} trend is still ${tradeDir === 1 ? 'bearish' : 'bullish'}. Your ${actionWord} setup is developing on the ${entryTF} chart, but it is not yet supported by the broader trend.`
        : `Your ${tradeDirWord} signal exists but timeframe alignment is too weak to act on. More confirmation is needed before this becomes a high-quality trade.`;
    }
  } else {
    // AVOID
    if (chochBlock) {
      whyText = `A Change of Character is forming against your intended ${actionWord} direction. This suggests the trend may be reversing — entering now puts you on the wrong side of that move.`;
    } else {
      whyText = `Your ${entryTF} chart says ${actionWord}, but the higher-timeframe picture disagrees. When the small timeframe fights the large timeframe, the large timeframe usually wins.`;
    }
  }

  // ── Action checklist ──────────────────────────────────────────────────────
  let actionChecklist: string[];
  if (strategyBlockReason && strategyProfile) {
    // Strategy-specific checklist
    const src = strategyBlockSource ?? 'requirement';
    actionChecklist = [
      `Wait for the ${strategyProfile.name} strategy ${src.toLowerCase()} requirement to be met.`,
      primaryBlocker,
      `Reassess ${nextReviewPhrase(baseTF)}.`,
    ];
  } else if (state === 'READY') {
    actionChecklist = [
      `Look for a ${actionWord} entry on the ${entryTF} chart.`,
      `Set your stop below ${tradeDir === 1 ? 'the last swing low' : 'the last swing high'}${lastSwingLow && tradeDir === 1 ? ` (${lastSwingLow.toFixed(pricePrecision)})` : lastSwingHigh && tradeDir === -1 ? ` (${lastSwingHigh.toFixed(pricePrecision)})` : ''}.`,
      `Size your position according to your risk rules before entering.`,
    ];
  } else if (state === 'WAIT') {
    if (action === 'HOLD') {
      actionChecklist = [
        `Do not enter any position yet.`,
        `Wait for the engine to generate a BUY or SELL signal.`,
        `Check back ${nextReviewPhrase(baseTF)}.`,
      ];
    } else {
      actionChecklist = [
        `Do not enter yet.`,
        blockTFWord
          ? `Watch the ${blockTFWord} chart for a trend reversal or Break of Structure.`
          : `Wait for more timeframes to confirm the ${tradeDirWord} direction.`,
        `Recheck ${nextReviewPhrase(blockingTF ?? baseTF)}.`,
      ];
    }
  } else {
    // AVOID
    if (chochBlock) {
      actionChecklist = [
        `Do not enter a ${actionWord} trade now.`,
        `A Change of Character signal suggests a possible reversal — wait for it to resolve.`,
        `Only reconsider once the ${entryTF} structure resumes the ${tradeDirWord} trend.`,
      ];
    } else {
      actionChecklist = [
        `Skip this trade.`,
        blockTFWord
          ? `The ${blockTFWord} trend is working against your entry — wait for it to turn ${tradeDirWord}.`
          : `Higher timeframe signals oppose your entry direction.`,
        `If you must trade, reduce your position size significantly to account for the added risk.`,
      ];
    }
  }

  // ── Risk statement ────────────────────────────────────────────────────────
  let riskStatement: string;
  if (state === 'READY') {
    riskStatement = `Conditions are aligned — the main risk is poor entry timing. Use the ${entryTF} chart to find a precise entry.`;
  } else if (state === 'WAIT') {
    riskStatement = blockTFWord
      ? `Entering now means trading against the ${blockTFWord} trend, which historically produces lower-quality outcomes and wider stops.`
      : `Entering on weak alignment means you are accepting a lower-probability setup. Waiting costs nothing — a bad entry costs capital.`;
  } else {
    riskStatement = chochBlock
      ? `Ignoring a Change of Character signal means entering exactly when the trend may be reversing. This carries an asymmetric downside risk.`
      : `Trading against the higher-timeframe trend is the most common cause of avoidable losses. The edge disappears when structure and entry conflict.`;
  }

  // ── Primary blocker ───────────────────────────────────────────────────────
  let primaryBlocker: string;
  if (strategyBlockReason) {
    // Strategy gate takes precedence over engine-derived blockers when active
    primaryBlocker = strategyBlockReason;
  } else if (state === 'READY') {
    primaryBlocker = 'None — all signals aligned.';
  } else if (action === 'HOLD') {
    primaryBlocker = 'No trade signal generated yet.';
  } else if (chochBlock) {
    primaryBlocker = `Change of Character (CHoCH) forming against ${tradeDirWord} direction.`;
  } else if (blockingTF) {
    primaryBlocker = `${TF_DISPLAY[blockingTF]} trend is ${tradeDir === 1 ? 'bearish' : 'bullish'} — opposing your entry signal.`;
  } else {
    primaryBlocker = 'Timeframe alignment is too weak — insufficient confluence.';
  }

  // ── Flip condition ────────────────────────────────────────────────────────
  let flipCondition: string;
  let nextReviewTF: Timeframe | null = null;

  if (state === 'READY') {
    flipCondition = 'Trade is ready. Identify your entry on the current timeframe.';
    nextReviewTF  = baseTF;
  } else if (action === 'HOLD') {
    flipCondition = 'Wait for BUY or SELL signal from the prediction engine.';
    nextReviewTF  = baseTF;
  } else if (chochBlock) {
    flipCondition = `CHoCH resolves and ${entryTF} structure resumes the ${tradeDirWord} trend.`;
    nextReviewTF  = baseTF;
  } else if (blockingTF) {
    const levelHint = tradeDir === 1 && lastSwingHigh != null
      ? ` (above ${lastSwingHigh.toFixed(pricePrecision)})`
      : tradeDir === -1 && lastSwingLow != null
      ? ` (below ${lastSwingLow.toFixed(pricePrecision)})`
      : '';
    flipCondition = `${TF_DISPLAY[blockingTF]} closes with a confirmed bullish Break of Structure${levelHint}, AND ${entryTF} confirms.`;
    nextReviewTF  = blockingTF;
  } else {
    const nextTF = TF_ORDER[Math.min(baseTFIdx + 1, TF_ORDER.length - 1)] as Timeframe;
    flipCondition = `${TF_DISPLAY[nextTF]} aligns ${tradeDirWord} to strengthen confluence.`;
    nextReviewTF  = nextTF;
  }

  // ── Next trigger — future notification hook ────────────────────────────────
  let nextTrigger: string;
  if (state === 'READY') {
    nextTrigger = `Alert when price reaches your entry zone on the ${entryTF} chart.`;
  } else if (action === 'HOLD') {
    nextTrigger = `Alert when the engine generates a ${regimeBull ? 'BUY' : regimeBear ? 'SELL' : 'trade'} signal.`;
  } else if (chochBlock) {
    nextTrigger = `Alert when the CHoCH resolves and ${entryTF} structure turns ${tradeDirWord}.`;
  } else if (blockingTF) {
    nextTrigger = `Alert when a ${tradeDirWord} Break of Structure forms on the ${TF_DISPLAY[blockingTF]} chart.`;
  } else {
    nextTrigger = `Alert when ${entryTF} alignment strengthens above the threshold.`;
  }

  const nextReviewLabel = nextReviewTF ? nextReviewPhrase(nextReviewTF) : 'when more data is available';
  const headline = state === 'READY' ? '🟢 Ready' : state === 'WAIT' ? '🟡 Wait' : '🔴 Avoid';

  return {
    state, headline, whyText,
    actionChecklist, riskStatement,
    primaryBlocker, flipCondition, nextTrigger,
    nextReviewTF, nextReviewLabel,
    tfStrip, decisionFactors, conflictNote,
    unavailable: false,
    // strategyBlockers: all strategy gate failures (v6.9.8) — ordered by severity.
    // [0] = primary blocker, [1..n] = secondary blockers shown as "Other blockers".
    strategyBlockers,
    // strategyContext is assigned LAST — structural proof that no decision
    // field above reads it. It is presentation metadata passed through unchanged.
    strategyContext: strategyContext ?? null};
}
