export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

// NOTE: this app no longer fabricates any price or candle data. If a symbol
// has no connected live source, screens show an explicit "no live data"
// state instead of a simulated chart — what you see on screen is always
// either real, or clearly marked as unavailable.

export function pFmt(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return '—';
  if (v > 10000) return v.toFixed(0);
  if (v > 100) return v.toFixed(2);
  if (v > 1) return v.toFixed(4);
  return v.toFixed(5);
}

export function calcMA(data: Candle[], p: number): (number | null)[] {
  return data.map((_, i) => (i < p - 1 ? null : data.slice(i - p + 1, i + 1).reduce((s, c) => s + c.close, 0) / p));
}

export function calcRSI(data: Candle[], period = 14): number {
  if (data.length < period + 1) return 50;
  let g = 0, l = 0;
  for (let i = data.length - period; i < data.length; i++) {
    const d = data[i].close - data[i - 1]?.close;
    if (d > 0) g += d; else l -= d;
  }
  return l === 0 ? 100 : Math.round(100 - 100 / (1 + (g / period) / (l / period)));
}

export function calcVolumeProfile(data: Candle[], bins = 24) {
  if (!data.length) return { levels: [] as { price: number; vol: number }[], poc: null as null | { price: number; vol: number } };
  const vis = data.slice(-120);
  const hi = Math.max(...vis.map(c => c.high)), lo = Math.min(...vis.map(c => c.low));
  const range = hi - lo || 1;
  const step = range / bins;
  const levels = Array.from({ length: bins }, (_, i) => ({ price: lo + step * (i + 0.5), vol: 0 }));
  vis.forEach(c => {
    const lowIdx = Math.max(0, Math.min(bins - 1, Math.floor((c.low - lo) / step)));
    const hiIdx = Math.max(0, Math.min(bins - 1, Math.floor((c.high - lo) / step)));
    const span = Math.max(1, hiIdx - lowIdx + 1);
    for (let i = lowIdx; i <= hiIdx; i++) levels[i].vol += c.volume / span;
  });
  const poc = levels.reduce((a, b) => (b.vol > a.vol ? b : a), levels[0]);
  return { levels, poc };
}
