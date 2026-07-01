import { Candle } from './indicators';

export type PatternMatch = { name: string; bullish: boolean | null }; // null = neutral/context-dependent

function body(c: Candle) { return Math.abs(c.close - c.open); }
function range(c: Candle) { return c.high - c.low || 1e-9; }
function upperWick(c: Candle) { return c.high - Math.max(c.open, c.close); }
function lowerWick(c: Candle) { return Math.min(c.open, c.close) - c.low; }

// Rule-based classic candlestick pattern detection on the LAST 1-3 bars.
// These are textbook geometric definitions, not validated against any
// proprietary pattern-recognition model — genuinely useful as a heuristic
// signal, not a guarantee the pattern "works" in any given market.
export function detectPatterns(c: Candle[]): PatternMatch[] {
  if (c.length < 3) return [];
  const patterns: PatternMatch[] = [];
  const last = c[c.length - 1], prev = c[c.length - 2], prev2 = c[c.length - 3];

  // Doji — open ≈ close, small body relative to range
  if (body(last) / range(last) < 0.1) patterns.push({ name: 'Doji', bullish: null });

  // Hammer — small body near the top, long lower wick, little upper wick (bullish reversal context)
  if (lowerWick(last) > body(last) * 2 && upperWick(last) < body(last) * 0.5 && body(last) / range(last) < 0.35) {
    patterns.push({ name: 'Hammer', bullish: true });
  }
  // Pin Bar (shooting-star style) — long upper wick, small body near bottom
  if (upperWick(last) > body(last) * 2 && lowerWick(last) < body(last) * 0.5 && body(last) / range(last) < 0.35) {
    patterns.push({ name: 'Pin Bar (bearish)', bullish: false });
  }

  // Bullish Engulfing — prior red candle fully engulfed by a larger green candle
  if (prev.close < prev.open && last.close > last.open && last.open <= prev.close && last.close >= prev.open) {
    patterns.push({ name: 'Bullish Engulfing', bullish: true });
  }
  // Bearish Engulfing — mirror
  if (prev.close > prev.open && last.close < last.open && last.open >= prev.close && last.close <= prev.open) {
    patterns.push({ name: 'Bearish Engulfing', bullish: false });
  }

  // Morning Star — downtrend, small-body middle candle, strong bullish 3rd candle closing above midpoint of 1st
  if (prev2.close < prev2.open && body(prev) / range(prev) < 0.3 && last.close > last.open &&
      last.close > (prev2.open + prev2.close) / 2) {
    patterns.push({ name: 'Morning Star', bullish: true });
  }
  // Evening Star — mirror
  if (prev2.close > prev2.open && body(prev) / range(prev) < 0.3 && last.close < last.open &&
      last.close < (prev2.open + prev2.close) / 2) {
    patterns.push({ name: 'Evening Star', bullish: false });
  }

  // Inside Bar — fully contained within the prior bar's range (consolidation/continuation context)
  if (last.high <= prev.high && last.low >= prev.low) patterns.push({ name: 'Inside Bar', bullish: null });

  // Outside Bar — fully engulfs the prior bar's range (volatility expansion)
  if (last.high >= prev.high && last.low <= prev.low) patterns.push({ name: 'Outside Bar', bullish: null });

  return patterns;
}
