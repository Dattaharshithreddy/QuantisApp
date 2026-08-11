export type AIAnalysis = {
  tradeType: 'LONG' | 'SHORT' | 'BUY_CE' | 'BUY_PE' | 'SELL_CE' | 'SELL_PE' | 'NO_TRADE';
  style: 'SCALP' | 'INTRADAY' | 'SWING';
  marketRegime: 'TRENDING_BULL' | 'TRENDING_BEAR' | 'RANGING' | 'BREAKOUT' | 'REVERSAL' | 'VOLATILE';
  entry: number; stopLoss: number; target1: number; target2: number; target3: number;
  riskReward: number; confidence: number; volatility: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  patternDetected: string; technicalSetup: string; trendAnalysis: string; keyLevels: string;
  momentumReading: string; smartMoney: string; macroContext: string; marketPsychology: string;
  riskFactors: string; invalidation: string; suggestedPosition: string;
  priorCallUpdate: string;  // tracks continuity: is prior call playing out?
  executiveSummary: string;
  analyzedAt: number;       // Unix ms — when this analysis was generated
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
      'anthropic-version': '2023-06-01'},
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 3200, messages: [{ role: 'user', content: prompt }] })});
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Invalid Anthropic API key — check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited by Anthropic — wait a moment and try again.');
    throw new Error(`HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 150) : ''}`);
  }
  const raw = await res.json();
  // Detect token-limit truncation: finish_reason === 'max_tokens' means the
  // response was cut off before JSON was closed. Surface a clear error instead
  // of silently returning an empty analysis object.
  const stopReason = raw.stop_reason ?? raw.stop_sequence ?? null;
  const text = (raw.content || []).map((b: any) => b.text || '').join('');
  const clean = text.replace(/```json\n?|```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(clean);
    // Validate that key text fields are non-empty — if all empty, response was likely truncated
    const hasContent = parsed.technicalSetup || parsed.technical_setup ||
                       parsed.executiveSummary || parsed.executive_summary;
    if (!hasContent && stopReason === 'max_tokens') {
      throw new Error('Response was truncated by token limit — please try again.');
    }
    return normalizeAnalysis(parsed);
  } catch (parseErr: any) {
    // Attempt partial-object recovery
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m?.[0]) {
      throw new Error('AI response could not be parsed. Check your API key and try again.');
    }
    try {
      const partial = JSON.parse(m[0]);
      const hasContent = partial.technicalSetup || partial.technical_setup ||
                         partial.executiveSummary || partial.executive_summary;
      if (!hasContent) {
        throw new Error('Analysis returned empty — response may have been truncated. Try again.');
      }
      return normalizeAnalysis(partial);
    } catch {
      throw new Error(parseErr?.message || 'Analysis failed — please try again.');
    }
  }
}

// Normalises the raw JSON Claude returns into the AIAnalysis shape.
// Claude occasionally returns snake_case keys (technical_setup, smart_money,
// risk_reward etc.) even when the prompt asks for camelCase. This function
// maps every known variant so the UI never shows empty sections or
// '1:undefined' for R:R.
function normalizeAnalysis(d: any): AIAnalysis {
  const pick = (...keys: string[]) => {
    for (const k of keys) if (d[k] != null) return d[k];
    return undefined;
  };
  const entry    = pick('entry',    'entryPrice',  'entry_price')  ?? 0;
  const stopLoss = pick('stopLoss', 'stop_loss',   'stoploss')     ?? 0;
  const target1  = pick('target1',  'target_1',    'tp1', 'tp')   ?? 0;
  const target2  = pick('target2',  'target_2',    'tp2')         ?? 0;
  const target3  = pick('target3',  'target_3',    'tp3')         ?? 0;
  // Compute riskReward from levels if the model omits or misnames it
  const rrRaw   = pick('riskReward','risk_reward','riskRewardRatio','risk_reward_ratio');
  const riskReward = (rrRaw != null && isFinite(Number(rrRaw)))
    ? Number(rrRaw)
    : (entry && stopLoss && target1 && Math.abs(entry - stopLoss) > 0)
      ? Math.abs(target1 - entry) / Math.abs(entry - stopLoss)
      : 0;
  return {
    tradeType:        pick('tradeType',   'trade_type',    'type')            ?? 'NO_TRADE',
    style:            pick('style',       'tradeStyle',    'trade_style')     ?? 'INTRADAY',
    marketRegime:     pick('marketRegime','market_regime', 'regime')          ?? 'RANGING',
    entry, stopLoss, target1, target2, target3, riskReward,
    confidence:       Number(pick('confidence') ?? 0),
    volatility:       pick('volatility')                                      ?? 'MEDIUM',
    patternDetected:  pick('patternDetected', 'pattern_detected', 'pattern')  ?? '',
    technicalSetup:   pick('technicalSetup',  'technical_setup',  'techSetup')           ?? '',
    trendAnalysis:    pick('trendAnalysis',    'trend_analysis',   'trend')               ?? '',
    keyLevels:        pick('keyLevels',        'key_levels',       'levels')              ?? '',
    momentumReading:  pick('momentumReading',  'momentum_reading', 'momentum')            ?? '',
    smartMoney:       pick('smartMoney',       'smart_money',      'institutionalFlow')   ?? '',
    macroContext:     pick('macroContext',      'macro_context',    'macro')               ?? '',
    marketPsychology: pick('marketPsychology', 'market_psychology','psychology','sentiment') ?? '',
    riskFactors:      pick('riskFactors',       'risk_factors',    'risks')               ?? '',
    invalidation:     pick('invalidation',      'invalidationLevel','invalidation_level')  ?? '',
    suggestedPosition:pick('suggestedPosition', 'suggested_position','positionSize')       ?? '',
    priorCallUpdate:  pick('priorCallUpdate',   'prior_call_update', 'priorCall')          ?? '',
    analyzedAt:       Date.now(),
    executiveSummary: pick('executiveSummary',  'executive_summary','summary')            ?? ''};
}

export function buildAnalysisPrompt(opts: {
  assetName: string; symbol: string; type: string; tf: string; srcLabel: string;
  price: number; ch5: string; rsi: number; ma20: number | null; ma50: number | null;
  atr?: number | null;
  high10: number; low10: number; ohlc: string; recentNews?: string;
  obLine?: string; obDepthLines?: string; pocLine?: string; volSpikeLine?: string; mlLine?: string;
  priorAnalysis?: string; // last analysis summary for continuity
}) {
  const {
    assetName, symbol, type, tf, srcLabel, price, ch5, rsi, ma20, ma50, atr,
    high10, low10, ohlc, recentNews, obLine, obDepthLines, pocLine, volSpikeLine, mlLine,
    priorAnalysis,
  } = opts;

  const priorSection = priorAnalysis
    ? `\nPRIOR ANALYSIS (your last call on this symbol — use for continuity, not as bias):\n${priorAnalysis}\n`
    : '';

  return `You are a top-1% institutional trader and quant analyst with 20+ years at elite hedge funds.
Respond ONLY with a valid JSON object — no markdown, no text outside JSON.

ASSET: ${assetName} (${symbol}) | Type:${type} | TF:${tf} | Source:${srcLabel}
PRICE:${price} | 5-BAR CHG:${ch5}% | RSI(14):${Math.round(rsi)} | MA20:${ma20 ?? '—'} | MA50:${ma50 ?? '—'}${atr != null ? ` | ATR:${atr.toFixed(2)}` : ''}
10-BAR RANGE: High:${high10} | Low:${low10} | Range:${(high10 - low10).toFixed(2)}
${volSpikeLine || ''}
${pocLine || ''}
${obLine || ''}
${obDepthLines || ''}
${mlLine || ''}
${priorSection}
RECENT ${ohlc.split('\n').length} BARS (O/H/L/C/Vol):
${ohlc}
${recentNews ? `\nLIVE NEWS (most recent first):\n${recentNews}` : ''}

ANALYSIS RULES:
1. Order book: cite specific bid/ask walls and spread — "83% buy pressure with ${(high10 * 0.001).toFixed(2)} spread" not just percentages
2. ATR context: use ATR for stop sizing — stops < 0.5×ATR are too tight and will be hunted
3. ML Signal: treat as one of many inputs. If it conflicts with price action, explain why
4. Prior analysis: if provided, reference whether the prior call is playing out or has been invalidated
5. Invalidation: must be a specific price level, not vague language
6. Risk:Reward: only recommend trades with R:R ≥ 1.5

Return ONLY valid JSON:
{"tradeType":"LONG|SHORT|BUY_CE|BUY_PE|SELL_CE|SELL_PE|NO_TRADE","style":"SCALP|INTRADAY|SWING","marketRegime":"TRENDING_BULL|TRENDING_BEAR|RANGING|BREAKOUT|REVERSAL|VOLATILE","entry":<n>,"stopLoss":<n>,"target1":<n>,"target2":<n>,"target3":<n>,"riskReward":<n>,"confidence":<0-100>,"volatility":"LOW|MEDIUM|HIGH|EXTREME","patternDetected":"<pattern or NONE>","technicalSetup":"<2-3 sentences citing specific levels and indicators>","trendAnalysis":"<multi-timeframe view>","keyLevels":"<specific S/R prices>","momentumReading":"<RSI, ATR, volume context>","smartMoney":"<institutional footprint — cite exact order book levels if provided>","macroContext":"<macro & news impact on this specific asset>","marketPsychology":"<fear/greed, sentiment>","riskFactors":"<top 2-3 specific risks>","invalidation":"<exact price that invalidates this call>","suggestedPosition":"<% of portfolio>","priorCallUpdate":"<is prior call playing out, invalidated, or n/a>","executiveSummary":"<2-3 sentences — directional view, key evidence, key risk>"}`;
}

// ─────────────────────────────────────────────────
// CONVERSATIONAL CHAT — multi-turn, grounded in live market context
// ─────────────────────────────────────────────────
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

// Streaming chat — calls onChunk with each text delta so the UI can render
// tokens as they arrive (same experience as Claude.ai / ChatGPT).
// Falls back to non-streaming if the environment doesn't support ReadableStream.
export async function chatWithClaudeStream(
  messages: ChatMessage[],
  apiKey: string,
  systemContext: string,
  onChunk: (delta: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey) throw new Error('No Anthropic API key set — add one in Settings to use AI Chat.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':          apiKey,
      'anthropic-version':  '2023-06-01',
      'anthropic-beta':     'messages-2023-12-15',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 1200,
      system:     systemContext,
      messages:   messages.map(m => ({ role: m.role, content: m.content })),
    }),
    signal,
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Invalid Anthropic API key — check it in Settings.');
    if (res.status === 429) throw new Error('Rate limited — wait a moment and try again.');
    throw new Error(`HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 150) : ''}`);
  }

  // React Native's Hermes engine does not expose ReadableStream on fetch responses.
  // res.body is undefined on Android. Fall back to non-streaming fetch,
  // then simulate streaming by delivering the response word-by-word
  // so the UI still feels responsive rather than showing a blank wait.
  if (!res.body || typeof (res.body as any).getReader !== 'function') {
    const raw = await res.json();
    const full = (raw.content || []).map((b: any) => b.text || '').join('').trim();
    // Simulate streaming: deliver ~4 words at a time with tiny delays
    const words = full.split(' ');
    let accumulated = '';
    for (let i = 0; i < words.length; i += 4) {
      const chunk = (i > 0 ? ' ' : '') + words.slice(i, i + 4).join(' ');
      accumulated += chunk;
      onChunk(chunk);
      // Tiny yield to keep UI responsive
      await new Promise(r => setTimeout(r, 16));
      if (signal?.aborted) break;
    }
    return accumulated.trim();
  }

  // True SSE streaming (web/Node environments)
  const reader = (res.body as any).getReader();
  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;
      try {
        const evt = JSON.parse(data);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const chunk = evt.delta.text ?? '';
          full += chunk;
          onChunk(chunk);
        }
      } catch { /* skip malformed SSE line */ }
    }
  }
  return full.trim();
}

// Non-streaming fallback (kept for compatibility)
export async function chatWithClaude(messages: ChatMessage[], apiKey: string, systemContext: string): Promise<string> {
  if (!apiKey) throw new Error('No Anthropic API key set — add one in Settings to use AI Chat.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'},
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: systemContext,
      messages: messages.map(m => ({ role: m.role, content: m.content }))})});
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
