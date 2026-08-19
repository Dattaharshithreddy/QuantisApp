// STATUS: DISCONNECTED — not currently called by mlSignal.ts.
// Wire into trainAndPredictInner() after walk-forward evaluation to get
// evidence-based feature removal recommendations. See comment below re: 
// FEATURE_NAMES length constraint before enabling auto-pruning.
//
import { FeatureContributionReport } from './featureContribution';

// Model Improvement Phase — feature quality audit. Reuses
// analyzeFeatureContribution's already-computed, leak-safe permutation
// importance and correlation data entirely; this module only INTERPRETS
// that report into a removal recommendation. No new importance or
// correlation logic.
//
// Deliberately advisory, not automatically applied: FEATURE_NAMES has a
// FIXED length woven through every persisted model's weight shapes
// (MLP.W1 is sized to feature count). Silently changing the live feature
// set per-asset would mean different assets train models with different
// input dimensions — a much larger architectural change than this phase
// asked for, with real risk of subtle shape-mismatch bugs. This produces
// a clear, evidence-based recommendation for a human to act on (or for a
// future phase to wire in deliberately), rather than silently mutating
// what every model is trained on.

export type PruningRecommendation = {
  removeCandidates: { name: string; avgAccuracyDrop: number; reason: string }[];
  redundantToConsider: { keepOneOf: [string, string]; correlation: number }[];
};

// "Consistently near-zero" — a single low-importance reading on one
// dataset could be noise; this only flags features whose importance
// stayed low across EVERY report passed in (e.g., one per asset
// evaluated), which is a much stronger signal of genuine redundancy.
export function recommendPruning(reports: FeatureContributionReport[], dropThreshold = 0.5): PruningRecommendation {
  if (!reports.length) return { removeCandidates: [], redundantToConsider: [] };

  const dropsByFeature = new Map<string, number[]>();
  reports.forEach(r => r.entries.forEach(e => {
    if (!dropsByFeature.has(e.name)) dropsByFeature.set(e.name, []);
    dropsByFeature.get(e.name)!.push(e.baselineAccDrop);
  }));

  const removeCandidates = Array.from(dropsByFeature.entries())
    .map(([name, drops]) => ({ name, avgAccuracyDrop: drops.reduce((s, d) => s + d, 0) / drops.length, sampleCount: drops.length }))
    .filter(f => f.sampleCount === reports.length && f.avgAccuracyDrop <= dropThreshold) // consistently low across every report provided, not just one
    .map(f => ({ name: f.name, avgAccuracyDrop: f.avgAccuracyDrop, reason: `Average accuracy drop of only ${f.avgAccuracyDrop.toFixed(2)} points across ${f.sampleCount} evaluation(s) — contributes almost nothing to what the model actually learned.` }))
    .sort((a, b) => a.avgAccuracyDrop - b.avgAccuracyDrop);

  // Redundancy: flag pairs that showed up as highly correlated in EVERY
  // report, not just one — same "consistently," not "once."
  const redundantCounts = new Map<string, { pair: [string, string]; correlations: number[] }>();
  reports.forEach(r => r.redundantPairs.forEach(p => {
    const key = [p.featureA, p.featureB].sort().join('|');
    if (!redundantCounts.has(key)) redundantCounts.set(key, { pair: [p.featureA, p.featureB], correlations: [] });
    redundantCounts.get(key)!.correlations.push(p.correlation);
  }));
  const redundantToConsider = Array.from(redundantCounts.values())
    .filter(r => r.correlations.length === reports.length)
    .map(r => ({ keepOneOf: r.pair, correlation: r.correlations.reduce((s, c) => s + c, 0) / r.correlations.length }));

  return { removeCandidates, redundantToConsider };
}
