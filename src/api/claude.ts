export type AIAnalysis = {
  tradeType: 'LONG' | 'SHORT' | 'BUY_CE' | 'BUY_PE' | 'SELL_CE' | 'SELL_PE' | 'NO_TRADE';
  style: 'SCALP' | 'INTRADAY' | 'SWING';
  marketRegime: 'TRENDING_BULL' | 'TRENDING_BEAR' | 'RANGING' | 'BREAKOUT' | 'REVERSAL' | 'VOLATILE';
  entry: number; stopLoss: number; target1: number; target2: number; target3: number;
  riskReward: number; confidence: number; volatility: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  patternDetected: string; technicalSetup: string; trendAnalysis: string; keyLevels: string;
  momentumReading: string; smartMoney: string; macroContext: string; marketPsychology: string;
  riskFactors: string; invalidation: string; suggestedPosition: string; executiveSummary: string;
};

// FIXED: this previously had NO authentication header at all. That worked only
// inside Claude.ai's web sandbox, which silently injects credentials for you.
// A real standalone app talking to Anthropic's actual API must send its own
// 'x-api-key' header — without it every request gets rejected outright. This
// was almost certainly why "Claude is not connecting."
export async function analyzeWithClaude(prompt: string, apiKey: string): Promise<AIAnalysis> {
  if (!apiKey) throw new Error('No Anthropic API key set — add one in Settings to use the AI Copilot.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1100, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Invalid Anthropic API key — check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by Anthropic — wait a moment and try again.');
    throw new Error(`HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 150) : ''}`);
  }
  const raw = await res.json();
  const text = (raw.content || []).map((b: any) => b.text || '').join('');
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    return JSON.parse(m?.[0] || '{}');
  }
}

export function buildAnalysisPrompt(opts: {
  assetName: string; symbol: string; type: string; tf: string; srcLabel: string;
  price: number; ch5: string; rsi: number; ma20: number | null; ma50: number | null;
  high10: number; low10: number; ohlc: string; recentNews?: string;
  obLine?: string; pocLine?: string; volSpikeLine?: string; mlLine?: string;
}) {
  const { assetName, symbol, type, tf, srcLabel, price, ch5, rsi, ma20, ma50, high10, low10, ohlc, recentNews, obLine, pocLine, volSpikeLine, mlLine } = opts;
  return `You are a top-1% institutional trader and quant analyst with 20+ years at elite hedge funds. Respond ONLY with a valid JSON object, no markdown, no text outside JSON.

ASSET: ${assetName} (${symbol}) | ${type} | TF:${tf} | DATA:${srcLabel}
PRICE:${price} | 5-BAR CHG:${ch5}% | RSI≈${rsi} | MA20:${ma20 ?? '—'} | MA50:${ma50 ?? '—'}
HIGH(10):${high10} | LOW(10):${low10}
${volSpikeLine || ''}
${pocLine || ''}
${obLine || ''}
${mlLine || ''}
LAST 10 BARS:\n${ohlc}
${recentNews ? `\nLIVE NEWS:\n${recentNews}` : ''}

Use order book imbalance and volume profile POC as direct evidence in "smartMoney" — cite actual numbers. The neural net signal (if present) is a minor, low-sample-size quant input — weigh it lightly and explicitly say so if it's used, never present it as decisive on its own.

Return ONLY: {"tradeType":"LONG|SHORT|BUY_CE|BUY_PE|SELL_CE|SELL_PE|NO_TRADE","style":"SCALP|INTRADAY|SWING","marketRegime":"TRENDING_BULL|TRENDING_BEAR|RANGING|BREAKOUT|REVERSAL|VOLATILE","entry":<n>,"stopLoss":<n>,"target1":<n>,"target2":<n>,"target3":<n>,"riskReward":<n>,"confidence":<0-100>,"volatility":"LOW|MEDIUM|HIGH|EXTREME","patternDetected":"<or NONE>","technicalSetup":"<2-3 sentences>","trendAnalysis":"<multi-tf>","keyLevels":"<S/R>","momentumReading":"<RSI vol>","smartMoney":"<institutional footprint citing order book + volume profile>","macroContext":"<macro & news impact>","marketPsychology":"<sentiment>","riskFactors":"<top risks>","invalidation":"<what invalidates>","suggestedPosition":"<% portfolio>","executiveSummary":"<2-3 sentences>"}`;
}

// ─────────────────────────────────────────────────
// CONVERSATIONAL CHAT — multi-turn, grounded in live market context
// ─────────────────────────────────────────────────
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export async function chatWithClaude(messages: ChatMessage[], apiKey: string, systemContext: string): Promise<string> {
  if (!apiKey) throw new Error('No Anthropic API key set — add one in Settings to use AI Chat.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: systemContext,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Invalid Anthropic API key — check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by Anthropic — wait a moment and try again.');
    throw new Error(`HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 150) : ''}`);
  }
  const raw = await res.json();
  return (raw.content || []).map((b: any) => b.text || '').join('').trim();
}

// Builds the live-market grounding context sent as the `system` field on
// every chat request — re-sent each time since the API is stateless, so the
// AI always reasons from real current numbers, not stale memory of an
// earlier turn or, worse, no real data at all.
export function buildChatContext(opts: {
  assetName: string; symbol: string; type: string; tf: string; srcLabel: string;
  price: number; chgPct: number; rsi: number; ma20: number | null; ma50: number | null;
  ohlc: string; mlSummary?: string; obSummary?: string; newsSummary?: string;
}): string {
  const { assetName, symbol, type, tf, srcLabel, price, chgPct, rsi, ma20, ma50, ohlc, mlSummary, obSummary, newsSummary } = opts;
  return `You are a top-1% institutional trader, quant analyst, and options strategist with 20+ years at elite hedge funds, chatting directly with a retail trader who is using your reasoning to inform real trading decisions.

LIVE MARKET CONTEXT (current as of this message):
ASSET: ${assetName} (${symbol}) | ${type} | Timeframe: ${tf} | Data source: ${srcLabel}
CURRENT PRICE: ${price} | TODAY'S CHANGE: ${chgPct}% | RSI(14): ${rsi} | MA20: ${ma20 ?? 'n/a'} | MA50: ${ma50 ?? 'n/a'}
RECENT BARS:\n${ohlc}
${mlSummary ? `\nON-DEVICE ML SIGNAL: ${mlSummary}` : ''}
${obSummary ? `\nORDER BOOK: ${obSummary}` : ''}
${newsSummary ? `\nRECENT NEWS: ${newsSummary}` : ''}

Ground every answer in the real numbers above — never invent prices, news, or data not given to you. When asked for a trade idea, prediction, or entry/target/stop-loss levels, ALWAYS give:
1. A clear directional view (or explicitly say "no clean setup right now" if that's honestly the case — don't force a trade call)
2. Specific entry, stop-loss, and 1-2 target levels as real numbers derived from the price/levels above
3. Your reasoning: what in the data above supports this (trend, momentum, levels, ML signal, order flow if given)
4. The key risk that would invalidate the idea
5. A brief note on position sizing or risk management if relevant

If the ML signal is mentioned above, treat it as one minor input among several — never as the sole basis for a call, and say so explicitly if you lean on it. Be direct and concise; this is a chat, not a report — use short paragraphs, not heavy markdown formatting.`;
}
