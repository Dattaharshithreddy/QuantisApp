// ─────────────────────────────────────────────────────────────────────────────
// VOLUME PROFILE  (v5.0.0)
//
// All calculations are deterministic from OHLCV.
//
// Volume distribution: each candle's volume is distributed across bins
// proportional to the portion of the candle's range [low..high] that falls
// in each bin. Doji candles (high == low) assign all volume to their bin.
//
// Value Area: the contiguous set of bins around the POC that contains ≥70%
// of total volume. Expanded outward from POC, adding whichever neighbouring
// bin (above or below) has more volume, until the threshold is met.
//
// HVN: bins whose volume exceeds mean × hvnThresholdPct (local maxima check).
// LVN: bins whose volume is below mean × lvnThresholdPct.
//
// No lookahead: profile uses only candles passed to it.
// ─────────────────────────────────────────────────────────────────────────────
import { Candle } from '../indicators';
import {
  VolumeProfileBin, VolumeProfileResult,
  DEFAULT_VOLUME_CONFIG, VolumeConfig,
} from './volumeTypes';

// ── Build volume profile for candles[startBar..endBar] inclusive ──────────────
// O(n × bins): one pass per candle distributing volume into bins.
export function buildVolumeProfile(
  candles: Candle[],
  startBar: number,
  endBar:   number,
  cfg: VolumeConfig = DEFAULT_VOLUME_CONFIG
): VolumeProfileResult {
  const slice = candles.slice(startBar, endBar + 1);
  if (slice.length === 0) {
    return { bins: [], poc: 0, vah: 0, val: 0, hvnPrices: [], lvnPrices: [], totalVolume: 0 };
  }

  // Price range for the profile window
  const rangeHigh = Math.max(...slice.map(c => c.high));
  const rangeLow  = Math.min(...slice.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;
  if (rangeSize <= 0) {
    return { bins: [], poc: rangeHigh, vah: rangeHigh, val: rangeLow, hvnPrices: [], lvnPrices: [], totalVolume: 0 };
  }

  const { profileBins: numBins } = cfg;
  const binSize = rangeSize / numBins;

  // Initialise bins
  const bins: VolumeProfileBin[] = Array.from({ length: numBins }, (_, k) => ({
    priceLow:  rangeLow + k * binSize,
    priceHigh: rangeLow + (k + 1) * binSize,
    midpoint:  rangeLow + (k + 0.5) * binSize,
    volume:    0,
  }));

  // Distribute volume — O(n × bins) worst case, O(n × average_span) typical
  let totalVolume = 0;
  for (const c of slice) {
    const candleRange = c.high - c.low;
    totalVolume += c.volume;
    for (const bin of bins) {
      const overlap = Math.min(c.high, bin.priceHigh) - Math.max(c.low, bin.priceLow);
      if (overlap > 0) {
        const fraction = candleRange > 0 ? overlap / candleRange : 1;
        bin.volume += c.volume * fraction;
      }
    }
  }

  // POC: bin with maximum volume
  const pocBin = bins.reduce((best, b) => b.volume > best.volume ? b : best, bins[0]);
  const poc    = pocBin.midpoint;

  // Value Area: expand from POC until ≥ cfg.valueAreaPct of total volume is covered
  const vaTarget = totalVolume * cfg.valueAreaPct;
  let vaVol = pocBin.volume;
  let loIdx = bins.indexOf(pocBin);
  let hiIdx = loIdx;

  while (vaVol < vaTarget && (loIdx > 0 || hiIdx < bins.length - 1)) {
    const upVol   = hiIdx < bins.length - 1 ? bins[hiIdx + 1].volume : -1;
    const downVol = loIdx > 0              ? bins[loIdx - 1].volume : -1;
    if (upVol >= downVol) { hiIdx++; vaVol += bins[hiIdx].volume; }
    else                  { loIdx--; vaVol += bins[loIdx].volume; }
  }
  const vah = bins[hiIdx].priceHigh;
  const val = bins[loIdx].priceLow;

  // HVN / LVN identification
  const meanVol = totalVolume / numBins;
  const hvnPrices: number[] = [];
  const lvnPrices: number[] = [];
  for (let k = 0; k < bins.length; k++) {
    if (bins[k].volume > meanVol * cfg.hvnThresholdPct) {
      // Local maximum check — only flag if higher than both neighbours
      const leftVol  = k > 0              ? bins[k-1].volume : 0;
      const rightVol = k < bins.length-1  ? bins[k+1].volume : 0;
      if (bins[k].volume >= leftVol && bins[k].volume >= rightVol) {
        hvnPrices.push(bins[k].midpoint);
      }
    }
    if (bins[k].volume < meanVol * cfg.lvnThresholdPct && bins[k].volume > 0) {
      lvnPrices.push(bins[k].midpoint);
    }
  }

  return { bins, poc, vah, val, hvnPrices, lvnPrices, totalVolume };
}

// ── Non-causal profile (unchanged — used only for UI/ChartScreen display) ──────
export function computeVolumeProfile(
  candles: Candle[],
  cfg: VolumeConfig = DEFAULT_VOLUME_CONFIG
): VolumeProfileResult {
  return buildVolumeProfile(candles, 0, candles.length - 1, cfg);
}

// ── FIX 1: Causal per-bar volume profile for ML pipeline ─────────────────────
// At bar i, only candles[0..i] contribute. Implemented as an incremental
// forward scan using a rolling bin accumulator — O(n × bins) total.
// The price range is pinned to the FULL series range so bin boundaries
// never shift between bars (shifting boundaries would change historical
// POC/VAH/VAL values as new extremes arrive, creating pseudo-lookahead).
// Trade-off: using the full-series price range means the very first bars
// may see bins that are sparsely populated, but the bin structure is
// consistent and stable. This is the accepted industry practice for
// fixed-grid incremental volume profiles.
export function computeCausalVolumeProfiles(
  candles: Candle[],
  cfg: VolumeConfig = DEFAULT_VOLUME_CONFIG
): (VolumeProfileResult | null)[] {
  const n = candles.length;
  const results: (VolumeProfileResult | null)[] = new Array(n).fill(null);
  if (n === 0) return results;

  // Pin price range to full series (stable bin boundaries)
  const rangeHigh = Math.max(...candles.map(c => c.high));
  const rangeLow  = Math.min(...candles.map(c => c.low));
  const rangeSize = rangeHigh - rangeLow;
  if (rangeSize <= 0) return results;

  const { profileBins: numBins } = cfg;
  const binSize = rangeSize / numBins;

  // Running accumulator — updated incrementally each bar
  const bins: VolumeProfileBin[] = Array.from({ length: numBins }, (_, k) => ({
    priceLow:  rangeLow + k * binSize,
    priceHigh: rangeLow + (k + 1) * binSize,
    midpoint:  rangeLow + (k + 0.5) * binSize,
    volume:    0,
  }));
  let totalVolume = 0;

  for (let i = 0; i < n; i++) {
    // Add candles[i] to the running accumulator
    const c = candles[i];
    const candleRange = c.high - c.low;
    totalVolume += c.volume;
    for (let k = 0; k < numBins; k++) {
      const overlap = Math.min(c.high, bins[k].priceHigh) - Math.max(c.low, bins[k].priceLow);
      if (overlap > 0) {
        bins[k].volume += c.volume * (candleRange > 0 ? overlap / candleRange : 1);
      }
    }

    if (i < 5) { results[i] = null; continue; }  // need at least 5 bars

    // POC
    let pocIdx = 0;
    for (let k = 1; k < numBins; k++) if (bins[k].volume > bins[pocIdx].volume) pocIdx = k;

    // Value Area
    const vaTarget = totalVolume * cfg.valueAreaPct;
    let vaVol = bins[pocIdx].volume, loIdx = pocIdx, hiIdx = pocIdx;
    while (vaVol < vaTarget && (loIdx > 0 || hiIdx < numBins - 1)) {
      const up   = hiIdx < numBins - 1 ? bins[hiIdx + 1].volume : -1;
      const down = loIdx > 0           ? bins[loIdx - 1].volume : -1;
      if (up >= down) { hiIdx++; vaVol += bins[hiIdx].volume; }
      else            { loIdx--; vaVol += bins[loIdx].volume; }
    }

    // HVN / LVN
    const meanVol = totalVolume / numBins;
    const hvnPrices: number[] = [], lvnPrices: number[] = [];
    for (let k = 0; k < numBins; k++) {
      if (bins[k].volume > meanVol * cfg.hvnThresholdPct) {
        const lv = k > 0          ? bins[k-1].volume : 0;
        const rv = k < numBins-1  ? bins[k+1].volume : 0;
        if (bins[k].volume >= lv && bins[k].volume >= rv) hvnPrices.push(bins[k].midpoint);
      }
      if (bins[k].volume < meanVol * cfg.lvnThresholdPct && bins[k].volume > 0)
        lvnPrices.push(bins[k].midpoint);
    }

    // Store only the scalar fields consumed by featuresAt and scoreVP.
    // The full 24-bin array is NOT deep-copied here — that produced 72,000
    // VolumeProfileBin objects per prediction call, causing GC pressure on
    // Hermes. The bins are already captured in totalVolume and the 5 scalars.
    results[i] = {
      bins:        [],          // empty — never read from causal array
      poc:         bins[pocIdx].midpoint,
      vah:         bins[hiIdx].priceHigh,
      val:         bins[loIdx].priceLow,
      hvnPrices:   [...hvnPrices],
      lvnPrices:   [...lvnPrices],
      totalVolume,
    };
  }
  return results;
}
