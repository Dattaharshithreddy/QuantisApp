import { Candle } from './indicators';
import { fetchBnKlines } from '../api/binance';
import { detectGaps } from './gapDetection';
import { logger } from './logger';

// Binance klines endpoint: 1000 candles max per call.
// To reach 50,000 candles: 50 chunks × 1000 bars.
// maxChunks is derived from targetBars with +2 safety margin to handle
// partial last chunk (Binance returns < 1000 when hitting exchange history start).
//
// historyExhausted = true when Binance returns < 1000 bars on the last chunk,
// meaning we genuinely hit the beginning of available exchange data.

export type MaxHistoryResult = {
  candles:          Candle[];
  historyExhausted: boolean;
};

export async function fetchMaxHistory(
  bnSym: string,
  tf: string,
  targetBars = 50_000,   // raised from 5000 → 50000
): Promise<MaxHistoryResult> {
  const chunks: Candle[][] = [];
  let endTime: number | undefined = undefined;
  let totalFetched = 0;
  let hitExchangeStart = false;
  // +2 to handle the partial chunk at the oldest end of Binance history
  const maxChunks = Math.ceil(targetBars / 1000) + 2;

  for (let i = 0; i < maxChunks && totalFetched < targetBars; i++) {
    let chunk: Candle[];
    try {
      chunk = await fetchBnKlines(bnSym, tf, 1000, endTime);
    } catch (e: any) {
      logger.warn('maxHistoryFetch', `${bnSym}/${tf}: chunk ${i} failed: ${e.message}`);
      break;
    }
    if (!chunk.length) { hitExchangeStart = true; break; }
    chunks.unshift(chunk);
    totalFetched += chunk.length;
    endTime = chunk[0].time - 1;
    if (chunk.length < 1000) { hitExchangeStart = true; break; }
  }

  const byTime = new Map<number, Candle>();
  chunks.flat().forEach(c => byTime.set(c.time, c));
  const result = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  const trimmed = result.slice(-targetBars);

  const historyExhausted = hitExchangeStart;

  const gaps = detectGaps(trimmed, tf);
  if (gaps.length) {
    logger.warn('maxHistoryFetch', `${bnSym}/${tf}: ${gaps.length} gap(s) across ${chunks.length} chunks`);
  }
  logger.info('maxHistoryFetch',
    `${bnSym}/${tf}: ${trimmed.length} bars across ${chunks.length} chunk(s) | historyExhausted=${historyExhausted}`);

  return { candles: trimmed, historyExhausted };
}
