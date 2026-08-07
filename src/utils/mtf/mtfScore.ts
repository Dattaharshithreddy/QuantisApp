// ─────────────────────────────────────────────────────────────────────────────
// MTF SCORING  (v5.1.0) — all heuristics isolated here
//
// MTF_SCORING_V1
// ─────────────────────────────────────────────────────────────────────────────
import { TFSignal, MTFAlignment, MTFScores, MTFConfig, Timeframe, TF_ORDER } from './mtfTypes';

// ── MTF_SCORING_V1 ────────────────────────────────────────────────────────────
// Version: MTF_SCORING_V1
//
// Alignment formula (per dimension, e.g. trend):
//   For N available higher TFs with signals s_1..s_N (each ∈ {-1,0,+1}):
//   weight_k = (tfIndex_k + 1)^htfWeightPower   (higher TF = heavier weight)
//   alignment = Σ(s_k × weight_k) / Σ(weight_k)   ∈ [-1, +1]
//
// Assumption:
//   Higher timeframes carry more structural significance.
//   A Daily trend agrees more strongly with an intraday signal than a 15m trend.
//   htfWeightPower=1.5 gives Daily ~5× the weight of 5m.
//
// Overall score formula:
//   overallScore = trendAlign×0.30 + structAlign×0.20 + bosAlign×0.15
//               + smcAlign×0.15 + vwapAlign×0.10 + volumeAlign×0.10
//
// HTF bias:
//   Signal from the single highest available TF (with ≥ minBarsForTF bars).
//   Falls back to trendDir of the next-highest TF if the highest has too few bars.
//
// Configurable: cfg.htfWeightPower, cfg.minBarsForTF
export function computeAlignment(
  baseTF:   Timeframe,
  signals:  TFSignal[],
  cfg:      MTFConfig
): MTFAlignment {
  // Filter to TFs strictly above the base TF with enough data
  const baseTFIdx = TF_ORDER.indexOf(baseTF);
  const higher = signals.filter(s =>
    TF_ORDER.indexOf(s.tf) > baseTFIdx && s.barCount >= cfg.minBarsForTF
  );

  if (higher.length === 0) {
    return {
      trendAlignment: 0, structureAlignment: 0, bosAlignment: 0,
      chochAlignment: 0, smcAlignment: 0, fvgAlignment: 0,
      vwapAlignment: 0,  volumeAlignment: 0,
      overallScore: 0,   htfBias: 0};
  }

  // Weights: higher index in TF_ORDER = higher TF = more weight
  const weights = higher.map(s => Math.pow(TF_ORDER.indexOf(s.tf) + 1, cfg.htfWeightPower));
  const totalW  = weights.reduce((a, b) => a + b, 0) || 1;

  const wavg = (vals: number[]) =>
    vals.reduce((sum, v, k) => sum + v * weights[k], 0) / totalW;

  const trendAlignment     = wavg(higher.map(s => s.trendDir));
  const structureAlignment = wavg(higher.map(s => s.structureDir));
  const bosAlignment       = wavg(higher.map(s => s.bosDir));
  const chochAlignment     = wavg(higher.map(s => s.chochDetected ? (s.bosDir * -1) : 0));
  const smcAlignment       = wavg(higher.map(s => s.smcBias));
  const fvgAlignment       = wavg(higher.map(s =>
    s.fvgBelow ? 1 : s.fvgAbove ? -1 : 0
  ));
  const vwapAlignment      = wavg(higher.map(s => s.aboveVWAP ? 1 : -1));
  const volumeAlignment    = wavg(higher.map(s => s.volumeBias));

  const overallScore =
    trendAlignment     * 0.30 +
    structureAlignment * 0.20 +
    bosAlignment       * 0.15 +
    smcAlignment       * 0.15 +
    vwapAlignment      * 0.10 +
    volumeAlignment    * 0.10;

  // HTF bias: signal from the highest available TF
  const htfSignal = higher[higher.length - 1];
  const htfBias   = htfSignal.trendDir !== 0
    ? htfSignal.trendDir
    : htfSignal.structureDir;

  return {
    trendAlignment:     Math.max(-1, Math.min(1, trendAlignment)),
    structureAlignment: Math.max(-1, Math.min(1, structureAlignment)),
    bosAlignment:       Math.max(-1, Math.min(1, bosAlignment)),
    chochAlignment:     Math.max(-1, Math.min(1, chochAlignment)),
    smcAlignment:       Math.max(-1, Math.min(1, smcAlignment)),
    fvgAlignment:       Math.max(-1, Math.min(1, fvgAlignment)),
    vwapAlignment:      Math.max(-1, Math.min(1, vwapAlignment)),
    volumeAlignment:    Math.max(-1, Math.min(1, volumeAlignment)),
    overallScore:       Math.max(-1, Math.min(1, overallScore)),
    htfBias:            htfBias};
}

export function toMTFScores(a: MTFAlignment): MTFScores {
  return {
    trendAlignment:     a.trendAlignment,
    structureAlignment: a.structureAlignment,
    bosAlignment:       a.bosAlignment,
    chochAlignment:     a.chochAlignment,
    smcAlignment:       a.smcAlignment,
    fvgAlignment:       a.fvgAlignment,
    vwapAlignment:      a.vwapAlignment,
    volumeAlignment:    a.volumeAlignment,
    overallMTFScore:    a.overallScore,
    htfBias:            a.htfBias};
}
