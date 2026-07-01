import { Candle } from './indicators';
import { logger } from './logger';

const TF_MS: Record<string, number> = {
  '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1D': 86400000, '1W': 604800000,
};

export type Gap = { afterIndex: number; expectedTime: number; actualTime: number; missingBars: number };

// Scans a candle series for gaps larger than the expected bar interval. Real
// markets have legitimate gaps (weekends, market closed hours, exchange
// downtime) so this flags candidates rather than assuming every gap is an
// error — the caller decides whether to attempt a repair fetch.
export function detectGaps(candles: Candle[], tf: string, toleranceMultiplier = 1.5): Gap[] {
  const interval = TF_MS[tf] ?? 900000;
  const gaps: Gap[] = [];
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].time - candles[i - 1].time;
    if (diff > interval * toleranceMultiplier) {
      const missingBars = Math.round(diff / interval) - 1;
      gaps.push({ afterIndex: i - 1, expectedTime: candles[i - 1].time + interval, actualTime: candles[i].time, missingBars });
    }
  }
  if (gaps.length) logger.info('gapDetection', `Found ${gaps.length} gap(s) in series of ${candles.length} bars`);
  return gaps;
}

// Attempts to repair detected gaps by re-fetching that specific window from
// the same source. `fetchRange` is supplied by the caller (knows which API
// to hit for this asset) — if a gap can't be filled (e.g. it's a legitimate
// market-closed period, or the source has no data for it), it's left as-is
// rather than fabricating anything.
export async function repairGaps(
  candles: Candle[],
  gaps: Gap[],
  fetchRange: (fromTime: number, toTime: number) => Promise<Candle[]>
): Promise<Candle[]> {
  if (!gaps.length) return candles;
  let result = [...candles];
  for (const gap of gaps) {
    try {
      const filler = await fetchRange(gap.expectedTime, gap.actualTime);
      if (filler.length) {
        const byTime = new Map(result.map(c => [c.time, c]));
        filler.forEach(c => byTime.set(c.time, c));
        result = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
        logger.info('gapDetection', `Repaired gap with ${filler.length} real bars`);
      } else {
        logger.info('gapDetection', `Gap at ${new Date(gap.expectedTime).toISOString()} has no data available (likely market closed) — left as-is`);
      }
    } catch (e: any) {
      logger.warn('gapDetection', `Repair fetch failed: ${e.message}`);
    }
  }
  return result;
}
