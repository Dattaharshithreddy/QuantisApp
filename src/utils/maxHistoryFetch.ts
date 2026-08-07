import { Candle } from './indicators';
import { fetchBnKlines } from '../api/binance';
import { detectGaps } from './gapDetection';
import { logger } from './logger';

// Binance's klines endpoint caps each call at 1000 candles. To get genuinely
// "maximum available history" rather than just one capped call, this
// paginates backward using the endTime parameter — fetching consecutive
// 1000-bar chunks moving further into the past until either no more data
// is returned (we've hit the start of the symbol's history) or the
// requested cap is reached.
//
// historyExhausted = true when Binance returned < 1000 bars on the last chunk,
// meaning we genuinely hit the beginning of available exchange data.
// The caller stores this flag in the candle cache so future eval runs can
// skip re-pagination when they already have everything Binance has.
export type MaxHistoryResult = {
  candles:          Candle[];
  historyExhausted: boolean; // true = Binance has no older data; false = cap hit first
};

export async function fetchMaxHistory(bnSym: string, tf: string, targetBars = 5000): Promise<MaxHistoryResult> {
  const chunks: Candle[][] = [];
  let endTime: number | undefined = undefined;
  let totalFetched = 0;
  let hitExchangeStart = false;
  const maxChunks = Math.ceil(targetBars / 1000) + 1;

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
    // Binance returns < 1000 bars only when it has reached the earliest available
    // data for this symbol. This is the definitive "history exhausted" signal.
    if (chunk.length < 1000) { hitExchangeStart = true; break; }
  }

  const byTime = new Map<number, Candle>();
  chunks.flat().forEach(c => byTime.set(c.time, c));
  const result = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  const trimmed = result.slice(-targetBars);

  // If we hit the cap (maxChunks) without exhausting exchange history,
  // historyExhausted stays false — more data exists but we stopped at targetBars.
  const historyExhausted = hitExchangeStart;

  const gaps = detectGaps(trimmed, tf);
  if (gaps.length) {
    logger.warn('maxHistoryFetch', `${bnSym}/${tf}: ${gaps.length} gap(s) detected across ${chunks.length} chunks`);
  }
  logger.info('maxHistoryFetch',
    `${bnSym}/${tf}: ${trimmed.length} bars across ${chunks.length} chunk(s) | historyExhausted=${historyExhausted}`);

  return { candles: trimmed, historyExhausted };
}
