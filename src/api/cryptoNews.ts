// ─────────────────────────────────────────────────────────────────────────────
// CRYPTO NEWS API
//
// Sources (tried in order, no API key required for free tier):
//   1. CryptoPanic — https://cryptopanic.com/api/free/v1/posts/
//      Free, no key, crypto-specific, 50 req/min
//   2. CoinGecko trending news — free, no key
//   3. Fallback: return empty array silently
//
// Used by DataContext for news[] state → passes to Claude chat context
// Claude uses it to comment on current market sentiment and news impact
// ─────────────────────────────────────────────────────────────────────────────

export interface CryptoNewsItem {
  headline:    string;
  source:      string;
  url:         string;
  publishedAt: string; // ISO string
  sentiment?:  'positive' | 'negative' | 'neutral';
  currencies?: string[]; // e.g. ['BTC', 'ETH']
}

// Fetch latest crypto news — no API key needed
// symbols: e.g. ['BTC', 'ETH'] — filters news to relevant assets
export async function fetchCryptoNews(
  symbols: string[] = [],
  limit = 10,
): Promise<CryptoNewsItem[]> {
  // Try CryptoPanic first
  try {
    const currencies = symbols
      .map(s => s.replace('USDT','').replace('INR','').replace('/',''))
      .filter(Boolean)
      .slice(0, 3)
      .join(',');

    const url = currencies
      ? `https://cryptopanic.com/api/free/v1/posts/?auth_token=free&kind=news&currencies=${currencies}&public=true`
      : `https://cryptopanic.com/api/free/v1/posts/?auth_token=free&kind=news&public=true`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      const results = data?.results ?? [];
      return results.slice(0, limit).map((item: any): CryptoNewsItem => ({
        headline:    item.title ?? '',
        source:      item.source?.title ?? 'CryptoPanic',
        url:         item.url ?? '',
        publishedAt: item.published_at ?? new Date().toISOString(),
        sentiment:   item.votes?.positive > item.votes?.negative ? 'positive'
                   : item.votes?.negative > item.votes?.positive ? 'negative'
                   : 'neutral',
        currencies:  item.currencies?.map((c: any) => c.code) ?? [],
      }));
    }
  } catch { /* fall through */ }

  // Fallback: CoinGecko news (no key, always available)
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/news',
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.ok) {
      const data = await res.json();
      const items = data?.data ?? [];
      return items.slice(0, limit).map((item: any): CryptoNewsItem => ({
        headline:    item.title ?? '',
        source:      item.news_site ?? 'CoinGecko',
        url:         item.url ?? '',
        publishedAt: item.created_at
          ? new Date(item.created_at * 1000).toISOString()
          : new Date().toISOString(),
        sentiment:   'neutral',
        currencies:  [],
      }));
    }
  } catch { /* fall through */ }

  return []; // silent failure — chat still works without news
}

// Format news for Claude context (compact, fits in system prompt)
export function formatNewsForContext(news: CryptoNewsItem[], maxItems = 5): string {
  if (!news.length) return '';
  const lines = news.slice(0, maxItems).map(n => {
    const age = getNewsAge(n.publishedAt);
    const sentiment = n.sentiment === 'positive' ? '📈' : n.sentiment === 'negative' ? '📉' : '📰';
    return `${sentiment} [${age}] ${n.headline}`;
  });
  return lines.join('\n');
}

function getNewsAge(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch { return ''; }
}
