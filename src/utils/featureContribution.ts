import { FittedEnsemble } from './backtest';
import { FEATURE_NAMES } from './mlSignal';

// LEAK-SAFE feature importance via permutation importance (Breiman's
// method): shuffle ONE feature column in the HELD-OUT TEST SET only, measure
// how much test accuracy drops compared to the unshuffled baseline. A
// feature whose shuffling causes a big accuracy drop is important; one that
// causes little/no drop contributed almost nothing to what the model
// actually learned. This never touches training data or labels — it only
// ever evaluates the already-trained, frozen model against data it was
// never fit on, which is what makes it leak-safe by construction.

export type FeatureImportanceEntry = { name: string; index: number; baselineAccDrop: number; rank: number };
export type FeatureContributionReport = {
  entries: FeatureImportanceEntry[]; // sorted descending by importance
  testSetSize: number;
  baselineAccuracy: number;
  redundantPairs: { featureA: string; featureB: string; correlation: number }[];
};

function accuracyOf(predict: (x: number[]) => number, X: number[][], y: number[]): number {
  if (!X.length) return 0;
  let correct = 0;
  X.forEach((x, i) => { if ((predict(x) > 0.5 ? 1 : 0) === y[i]) correct++; });
  return (correct / X.length) * 100;
}

// Simple seeded shuffle for a single column (Fisher-Yates on indices, then
// reassign that column's values across rows) — deterministic given a seed
// so repeated runs of this analysis are themselves reproducible.
function shuffleColumn(X: number[][], colIdx: number, rng: () => number): number[][] {
  const values = X.map(row => row[colIdx]);
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return X.map((row, i) => row.map((v, j) => (j === colIdx ? values[i] : v)));
}

export function analyzeFeatureContribution(fitted: FittedEnsemble, rng: () => number): FeatureContributionReport | null {
  if (fitted.testX.length < 15) return null; // too few held-out samples for a stable estimate

  // Ensemble prediction function — matches what's actually used live
  const predict = (x: number[]) => (fitted.mlp.predict(x) + fitted.lr.predict(x)) / 2;
  const baselineAccuracy = accuracyOf(predict, fitted.testX, fitted.testY);

  const entries: FeatureImportanceEntry[] = FEATURE_NAMES.map((name, idx) => {
    const shuffled = shuffleColumn(fitted.testX, idx, rng);
    const shuffledAcc = accuracyOf(predict, shuffled, fitted.testY);
    return { name, index: idx, baselineAccDrop: baselineAccuracy - shuffledAcc, rank: 0 };
  });

  entries.sort((a, b) => b.baselineAccDrop - a.baselineAccDrop);
  entries.forEach((e, i) => { e.rank = i + 1; });

  // Redundancy: correlate feature columns with EACH OTHER (no labels
  // involved at all, so there's no leakage question here whatsoever) across
  // the combined train+test feature data available to this fitted model.
  const allX = [...fitted.testX]; // test set alone is enough to estimate correlation structure reasonably
  const redundantPairs: { featureA: string; featureB: string; correlation: number }[] = [];
  const n = FEATURE_NAMES.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const colI = allX.map(r => r[i]), colJ = allX.map(r => r[j]);
      const corr = pearsonCorrelation(colI, colJ);
      if (Math.abs(corr) > 0.85) redundantPairs.push({ featureA: FEATURE_NAMES[i], featureB: FEATURE_NAMES[j], correlation: corr });
    }
  }

  return { entries, testSetSize: fitted.testX.length, baselineAccuracy, redundantPairs };
}

function pearsonCorrelation(a: number[], b: number[]): number {
  const n = a.length;
  const meanA = a.reduce((s, v) => s + v, 0) / n, meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, denA = 0, denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    num += da * db; denA += da * da; denB += db * db;
  }
  const den = Math.sqrt(denA * denB);
  return den === 0 ? 0 : num / den;
}
