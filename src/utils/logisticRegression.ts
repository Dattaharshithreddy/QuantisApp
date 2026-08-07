// A second, STRUCTURALLY DIFFERENT model from the MLP — plain logistic
// regression (single linear layer + sigmoid, no hidden layer) trained via
// its own gradient descent. This is what makes the "ensemble" genuine rather
// than cosmetic: two different model families voting, not the same network
// counted twice.
//
// ── v2: allocation optimizations (zero change to math or output) ──────────────
// Profiling found two allocation hotspots per epoch:
//
//   1. gW = this.w.map(() => 0) — creates a new D-element array every epoch
//      Fix: pre-allocate _gW once in constructor, zero in-place each epoch
//      Math: identical — zero then accumulate = allocate-zeroed then accumulate
//
//   2. this.w = this.w.map((w,i) => w - lr*(gW[i]/n + l2*w))
//      Creates a new D-element array every epoch, garbage-collecting the old one
//      Fix: mutate this.w in-place with a for loop
//      Math: identical — same subtraction, same result, no new array
//
//   3. predict() used x.reduce() which allocates a closure+accumulator per call
//      Called N×E = 21,200 times during training
//      Fix: inline as a for loop — same dot product, no closure allocation
//      Math: identical

export type LRWeights = { w: number[]; b: number };

export class LogisticRegression {
  w: number[]; b: number;
  private _gW: number[]; // pre-allocated gradient buffer

  constructor(inputSize: number, rng: () => number = Math.random) {
    this.w  = Array.from({ length: inputSize }, () => (rng() * 2 - 1) * 0.1);
    this.b  = 0;
    this._gW = new Array(inputSize).fill(0); // pre-allocated, reused every epoch
  }

  predict(x: number[]): number {
    // Inline for loop — same dot product as x.reduce(), no closure allocation
    let z = this.b;
    const w = this.w;
    for (let i = 0; i < w.length; i++) z += w[i] * x[i];
    return 1 / (1 + Math.exp(-z));
  }

  // Model Improvement Phase: increased from 0.001, same reasoning as
  // neuralNet.ts's identical change — see that file's comment.
  trainEpoch(X: number[][], y: number[], lr: number, l2 = 0.005): void {
    const n = X.length;
    const gW = this._gW;
    const w  = this.w;
    const d  = w.length;

    // Zero gradient buffer in-place — no allocation
    for (let i = 0; i < d; i++) gW[i] = 0;
    let gB = 0;

    for (let s = 0; s < n; s++) {
      const x   = X[s];
      const err = this.predict(x) - y[s];
      for (let i = 0; i < d; i++) gW[i] += err * x[i];
      gB += err;
    }

    // In-place weight update — no new array, same math as this.w.map(...)
    const lr_n = lr / n;
    for (let i = 0; i < d; i++) w[i] -= lr_n * gW[i] + lr * l2 * w[i];
    this.b -= lr_n * gB;
  }

  getWeights(): LRWeights { return { w: this.w, b: this.b }; }
  loadWeights(lrw: LRWeights) { this.w = lrw.w; this.b = lrw.b; }
}
