import { logger } from './logger';

// Generic retry-with-exponential-backoff wrapper. Applied to the actual
// network fetchers (Binance klines, Angel One candles, Alpha Vantage) so a
// transient failure (brief network blip, momentary rate-limit) gets retried
// before the app gives up and shows an error / falls back.
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number; tag?: string; shouldRetry?: (e: any) => boolean } = {}
): Promise<T> {
  const { retries = 2, baseDelayMs = 500, tag = 'fetch', shouldRetry = () => true } = opts;
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      logger.warn(tag, `Attempt ${attempt + 1}/${retries + 1} failed: ${e.message}`);
      if (attempt < retries && shouldRetry(e)) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      } else if (!shouldRetry(e)) {
        logger.warn(tag, 'Error marked non-retryable — stopping early');
        break;
      }
    }
  }
  logger.error(tag, `All attempts exhausted: ${lastErr?.message}`);
  throw lastErr;
}
