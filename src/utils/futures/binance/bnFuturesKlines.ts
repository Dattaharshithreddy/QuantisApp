// ─────────────────────────────────────────────────────────────────────────────
// BINANCE FUTURES KLINES  (v1.0.0)
//
// Fetches OHLCV candle data from Binance USDM Perpetuals (fapi.binance.com).
// No auth required — public endpoint.
// Used by watchlistScanner and chart for binance_futures assets.
// ─────────────────────────────────────────────────────────────────────────────

import { Candle } from '../../indicators';

const FAPI_BASE = 'https://fapi.binance.com';

const TF_MAP: Record<string, string> = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h',
  '1D': '1d', '1W': '1w',
};

export default async function fetchBnFuturesKlines(
  symbol: string,
  tf: string,
  limit = 200,
): Promise<Candle[]> {
  const interval = TF_MAP[tf] ?? '15m';
  const url = `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance Futures klines HTTP ${r.status}`);
  const raw: any[][] = await r.json();
  return raw.map(k => ({
    time:   k[0] / 1000,
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}
