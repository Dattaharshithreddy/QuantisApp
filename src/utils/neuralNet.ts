// A genuine, minimal feedforward neural network (1 hidden layer) trained via
// backpropagation, running entirely on-device in plain TypeScript — no native
// ML library needed, so it works inside Expo Go without a custom dev client.
//
// HONEST SCOPE: this is real gradient-descent learning, not a buzzword. But it
// trains on whatever price history is available (typically 100-150 bars per
// asset) which is a small sample for financial time series. Treat its output
// as one weighted opinion among several signals — not a certainty, and not a
// substitute for risk management.

function randInit(rows: number, cols: number, scale: number, rng: () => number = Math.random): number[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => (rng() * 2 - 1) * scale));
}
const tanh = (x: number) => Math.tanh(x);
const tanhDeriv = (y: number) => 1 - y * y; // y = tanh(x) already
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export type MLPWeights = {
  W1: number[][]; b1: number[]; W2: number[]; b2: number;
  featureMean: number[]; featureStd: number[];
  trainedAt: number; trainAccuracy: number; testAccuracy: number; sampleCount: number;
};

export class MLP {
  inputSize: number; hiddenSize: number;
  W1: number[][]; b1: number[]; W2: number[]; b2: number;

  // FIX (reproducibility): weight initialization previously used JS's
  // non-seedable Math.random() — meaning "rerun with the same data gives the
  // same result" was not actually true, just assumed. An optional seeded RNG
  // can now be passed in; live/production training still defaults to
  // Math.random() (you want fresh randomness there), while the backtest
  // engine passes a fixed seed so its results are genuinely reproducible.
  constructor(inputSize: number, hiddenSize = 8, rng: () => number = Math.random) {
    this.inputSize = inputSize; this.hiddenSize = hiddenSize;
    const scale = Math.sqrt(2 / inputSize);
    this.W1 = randInit(hiddenSize, inputSize, scale, rng);
    this.b1 = Array(hiddenSize).fill(0);
    this.W2 = Array.from({ length: hiddenSize }, () => (rng() * 2 - 1) * scale);
    this.b2 = 0;
  }

  forward(x: number[]) {
    const hidden = this.W1.map((row, i) => tanh(row.reduce((s, w, k) => s + w * x[k], 0) + this.b1[i]));
    const z = hidden.reduce((s, h, i) => s + h * this.W2[i], 0) + this.b2;
    const output = sigmoid(z);
    return { hidden, output };
  }

  predict(x: number[]): number { return this.forward(x).output; }

  // One epoch of mini-batch gradient descent (batch = full dataset for simplicity, data is small)
  // Model Improvement Phase: increased from 0.001. A model with 116 input
  // features and only 8 hidden units is relatively easy to overfit on a
  // limited training sample (especially for assets with shorter available
  // history) — stronger regularization trades a small amount of in-sample
  // fit for hopefully-better generalization out of the specific training
  // window. This is a reasoned, bounded hyperparameter change, NOT
  // something verified against real per-asset data from this environment
  // — flagged honestly in the accompanying report as needing real A/B
  // confirmation via the Production Evaluation tools.
  trainEpoch(X: number[][], y: number[], lr: number, l2 = 0.005) {
    const n = X.length;
    const gW1 = this.W1.map(row => row.map(() => 0));
    const gB1 = this.b1.map(() => 0);
    const gW2 = this.W2.map(() => 0);
    let gB2 = 0;
    let lossSum = 0;

    for (let s = 0; s < n; s++) {
      const x = X[s], target = y[s];
      const { hidden, output } = this.forward(x);
      const err = output - target; // dL/doutput for BCE+sigmoid combo simplifies to (output - target)
      lossSum += -(target * Math.log(output + 1e-9) + (1 - target) * Math.log(1 - output + 1e-9));

      for (let i = 0; i < this.hiddenSize; i++) {
        gW2[i] += err * hidden[i];
      }
      gB2 += err;

      for (let i = 0; i < this.hiddenSize; i++) {
        const dHidden = err * this.W2[i] * tanhDeriv(hidden[i]);
        for (let k = 0; k < this.inputSize; k++) gW1[i][k] += dHidden * x[k];
        gB1[i] += dHidden;
      }
    }

    for (let i = 0; i < this.hiddenSize; i++) {
      for (let k = 0; k < this.inputSize; k++) this.W1[i][k] -= lr * (gW1[i][k] / n + l2 * this.W1[i][k]);
      this.b1[i] -= lr * (gB1[i] / n);
      this.W2[i] -= lr * (gW2[i] / n + l2 * this.W2[i]);
    }
    this.b2 -= lr * (gB2 / n);
    return lossSum / n;
  }

  getWeights(): Pick<MLPWeights, 'W1' | 'b1' | 'W2' | 'b2'> {
    return { W1: this.W1, b1: this.b1, W2: this.W2, b2: this.b2 };
  }
  loadWeights(w: Pick<MLPWeights, 'W1' | 'b1' | 'W2' | 'b2'>) {
    this.W1 = w.W1; this.b1 = w.b1; this.W2 = w.W2; this.b2 = w.b2;
  }
}
