// Deterministic PRNG (mulberry32) — same seed always produces the same
// sequence of numbers. This is what makes "rerun with the same data gives
// the same result" actually true, rather than just claimed. Used for model
// weight initialization and Monte Carlo shuffling, both of which previously
// relied on JS's non-seedable Math.random().
export function createRNG(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
