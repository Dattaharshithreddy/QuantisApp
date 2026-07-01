// A second, STRUCTURALLY DIFFERENT model from the MLP — plain logistic
// regression (single linear layer + sigmoid, no hidden layer) trained via
// its own gradient descent. This is what makes the "ensemble" genuine rather
// than cosmetic: two different model families voting, not the same network
// counted twice.

export type LRWeights = { w: number[]; b: number };

export class LogisticRegression {
  w: number[]; b: number;
  constructor(inputSize: number, rng: () => number = Math.random) {
    this.w = Array.from({ length: inputSize }, () => (rng() * 2 - 1) * 0.1);
    this.b = 0;
  }
  predict(x: number[]): number {
    const z = x.reduce((s, v, i) => s + v * this.w[i], 0) + this.b;
    return 1 / (1 + Math.exp(-z));
  }
  // Model Improvement Phase: increased from 0.001, same reasoning as
  // neuralNet.ts's identical change — see that file's comment.
  trainEpoch(X: number[][], y: number[], lr: number, l2 = 0.005) {
    const n = X.length;
    const gW = this.w.map(() => 0); let gB = 0;
    X.forEach((x, s) => {
      const pred = this.predict(x);
      const err = pred - y[s];
      x.forEach((v, i) => { gW[i] += err * v; });
      gB += err;
    });
    this.w = this.w.map((w, i) => w - lr * (gW[i] / n + l2 * w));
    this.b -= lr * (gB / n);
  }
  getWeights(): LRWeights { return { w: this.w, b: this.b }; }
  loadWeights(w: LRWeights) { this.w = w.w; this.b = w.b; }
}
