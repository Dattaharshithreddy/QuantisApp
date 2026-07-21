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
// NOTE: chunk-boundary alignment (computing the next `endTime` from the
// previous chunk's earliest bar) was tested with a mock and found to be a
// fragile assumption to trust blindly — exchange-side bar-grid snapping can
// introduce off-by-one-bar quirks at the seam between chunks. Rather than
// assume the boundary math is perfect, the assembled result is explicitly
// validated with the same gap-detector used elsewhere in this app, and any
// detected gaps are logged so they're visible, not silently trusted away.
export async function fetchMaxHistory(bnSym: string, tf: string, targetBars = 5000): Promise<Candle[]> {
  const chunks: Candle[][] = [];
  let endTime: number | undefined = undefined;
  let totalFetched = 0;
  const maxChunks = Math.ceil(targetBars / 1000) + 1;

  for (let i = 0; i < maxChunks && totalFetched < targetBars; i++) {
    let chunk: Candle[];
    try {
      chunk = await fetchBnKlines(bnSym, tf, 1000, endTime);
    } catch (e: any) {
      logger.warn('maxHistoryFetch', `${bnSym}/${tf}: chunk ${i} failed: ${e.message}`);
      break;
    }
    if (!chunk.length) break;
    chunks.unshift(chunk);
    totalFetched += chunk.length;
    endTime = chunk[0].time - 1;
    if (chunk.length < 1000) break;
  }

  const byTime = new Map<number, Candle>();
  chunks.flat().forEach(c => byTime.set(c.time, c));
  const result = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  const trimmed = result.slice(-targetBars);

  const gaps = detectGaps(trimmed, tf);
  if (gaps.length) {
    logger.warn('maxHistoryFetch', `${bnSym}/${tf}: ${gaps.length} gap(s) detected across ${chunks.length} fetched chunks — likely chunk-boundary seams or genuine exchange gaps. Total missing bars: ${gaps.reduce((s, g) => s + g.missingBars, 0)}`);
  }
  logger.info('maxHistoryFetch', `${bnSym}/${tf}: assembled ${trimmed.length} bars across ${chunks.length} chunk(s), ${gaps.length} gap(s) flagged`);
  return trimmed;
}
