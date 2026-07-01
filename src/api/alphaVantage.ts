import { Candle } from '../utils/indicators';
import { withRetry } from '../utils/retry';

const TF_AV_INT: Record<string, string> = { '1m': '1min', '5m': '5min', '15m': '15min', '1h': '60min', '4h': '60min' };

export async function fetchAVKlines(sym: string, tf: string, key: string): Promise<Candle[]> {
  return withRetry(async () => {
    let fn = '', params = '';
    if (['1m', '5m', '15m', '1h', '4h'].includes(tf)) {
      fn = 'TIME_SERIES_INTRADAY'; params = `&interval=${TF_AV_INT[tf]}&outputsize=full`;
    } else if (tf === '1D') { fn = 'TIME_SERIES_DAILY'; params = '&outputsize=compact'; }
    else { fn = 'TIME_SERIES_WEEKLY'; }
    const r = await fetch(`https://www.alphavantage.co/query?function=${fn}&symbol=${sym}${params}&apikey=${key}`);
    if (!r.ok) throw new Error(`AV HTTP ${r.status}`);
    const json = await r.json();
    if (json.Note || json.Information) throw new Error('AV rate limit — wait 1 min');
    const tsKey = Object.keys(json).find(k => k.startsWith('Time Series') || k.startsWith('Weekly'));
    if (!tsKey) throw new Error('AV: no data for ' + sym);
    return Object.entries(json[tsKey]).slice(0, 150).reverse().map(([t, v]: [string, any]) => ({
      time: new Date(t).getTime(),
      open: parseFloat(v['1. open']), high: parseFloat(v['2. high']),
      low: parseFloat(v['3. low']), close: parseFloat(v['4. close']),
      volume: parseFloat(v['5. volume'] || '0'),
    }));
  }, {
    tag: 'alphavantage-klines', retries: 2,
    // Deliberately do NOT retry rate-limit errors — AV's free tier allows
    // only 25 requests/day total, so retrying a rate-limited call just burns
    // through that budget faster instead of helping. Only genuine transient
    // errors (network blips, unexpected HTTP errors) get retried.
    shouldRetry: (e: any) => !String(e.message).includes('rate limit'),
  });
}

export async function fetchAVQuote(sym: string, key: string): Promise<{ price: number; chg: number }> {
  const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${sym}&apikey=${key}`);
  if (!r.ok) throw new Error('AV quote error');
  const json = await r.json();
  if (json.Note || json.Information) throw new Error('AV rate limited');
  const q = json['Global Quote'] || {};
  return { price: parseFloat(q['05. price'] || '0'), chg: parseFloat((q['10. change percent'] || '0%').replace('%', '')) };
}

export type NewsItem = { t: string; txt: string; src?: string; url?: string; imp: 'pos' | 'neg' | 'neu' };

export async function fetchAVNews(key: string, topic = 'financial_markets'): Promise<NewsItem[] | null> {
  const r = await fetch(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${topic}&sort=LATEST&limit=20&apikey=${key}`);
  if (!r.ok) return null;
  const json = await r.json();
  if (!json.feed?.length) return null;
  return json.feed.map((item: any) => {
    const sentiment = item.overall_sentiment_label || 'Neutral';
    const imp: 'pos' | 'neg' | 'neu' = sentiment.includes('Bullish') ? 'pos' : sentiment.includes('Bearish') ? 'neg' : 'neu';
    return { t: item.time_published?.slice(9, 11) + ':' + item.time_published?.slice(11, 13), txt: item.title, src: item.source, url: item.url, imp };
  });
}
