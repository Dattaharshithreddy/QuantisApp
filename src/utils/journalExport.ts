// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED EXPORT ENGINE  v5.0  —  Real PDF via expo-print + expo-sharing
//
// ── What changed from v4.0 ───────────────────────────────────────────────────
//   v4.0 used React Native's Share API to send an HTML data: URI, which opened
//   in the device browser and required the user to manually Print → Save as PDF.
//   That was the best available approach without native dependencies.
//
//   v5.0 uses:
//     • expo-print@13.0.1   — Print.printToFileAsync(html) → file:// URI of
//                             a real .pdf written to the app cache directory
//     • expo-sharing@12.0.1 — Sharing.shareAsync(uri) → native share sheet
//                             showing the .pdf directly (WhatsApp, Drive, Email…)
//     • expo-file-system@17.0.1 — FileSystem.deleteAsync(uri) → clean up the
//                             temp PDF from cache after sharing completes
//
//   Both packages are SDK 51 compatible, managed-workflow safe, and require
//   zero ejecting. expo-sharing's Android FileProvider is bundled in the
//   package's own AndroidManifest.xml and merged automatically by Gradle at
//   build time via expo-modules-autolinking — no manual manifest edits needed.
//
// ── User experience ──────────────────────────────────────────────────────────
//   Tap PDF → progress indicator → native share sheet opens with a real .pdf →
//   user picks WhatsApp / Drive / Email / Files → done.
//   No browser. No print dialog. No HTML visible. No manual conversion.
//   Identical to a Zerodha / Upstox statement export.
//
// ── Fallback ─────────────────────────────────────────────────────────────────
//   If expo-print or expo-sharing is unavailable (Expo Go without dev client,
//   very old Android), the code catches the error and falls back to the
//   React Native Share API with a data: URI so export NEVER completely fails.
//
// ── CSV export ───────────────────────────────────────────────────────────────
//   Uses expo-file-system to write a real .csv file, then expo-sharing to share it.
//   Identical pipeline to PDF: write to cache → native share sheet → delete cache.
//   Filename: QUANTIS_Report_YYYY-MM-DD_HHMM.csv (preserved by all share targets).
//   UTF-8 BOM (\uFEFF) ensures ₹ and other symbols render correctly in Excel/Sheets.
//   Fallback: Share.share({ message }) if expo-file-system / expo-sharing unavailable.
// ─────────────────────────────────────────────────────────────────────────────

import { Share, Platform, Alert } from 'react-native';
import type { PaperTradeRecord }    from './paperTradeJournal';
import type { ShadowTrade }         from './shadowTradeJournal';
import type { PaperPortfolioStats } from './paperAnalytics';

// ── Lazy-load native PDF modules ──────────────────────────────────────────────
// Lazy-loading prevents startup crashes if the native module is not yet linked
// (e.g. first `expo run:android` after install, before autolinking has run).
// The actual PDF path is only entered when the user taps the PDF button.
async function loadPrintModule() {
  try {
    return await import('expo-print');
  } catch {
    return null;
  }
}
async function loadSharingModule() {
  try {
    return await import('expo-sharing');
  } catch {
    return null;
  }
}
async function loadFSModule() {
  try {
    return await import('expo-file-system');
  } catch {
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number | null | undefined, dec = 2): string {
  if (n == null || !isFinite(n)) return '—';
  return n.toFixed(dec);
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false });
}

function fmtHold(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtReason(r: string): string {
  const map: Record<string, string> = {
    TAKE_PROFIT: '🎯 Take Profit', TRAILING_STOP: '📈 Trailing Stop',
    BREAK_EVEN_STOP: '⚖️ Break-Even', STOP_LOSS: '🛑 Stop Loss',
    MANUAL_CLOSE: '🤚 Manual', MANUAL_EXIT: '🤚 Manual',
    TIME_EXIT: '⏱ Time Exit', AI_EXIT_SIGNAL: '🤖 AI Exit',
    PARTIAL_CLOSE: '½ Partial',
  };
  return map[r] ?? r ?? '—';
}

function csvEscape(v: any): string {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvRow(vals: any[]): string { return vals.map(csvEscape).join(','); }

// ── Internal stats ────────────────────────────────────────────────────────────

function paperStats(trades: PaperTradeRecord[]) {
  const closed = trades.filter(t => t.exitTime > 0 && t.exitReason !== 'PARTIAL_CLOSE');
  const wins   = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    total: closed.length, wins: wins.length, losses: losses.length, totalPnl,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
    avgWin:  wins.length   > 0 ? gp / wins.length   : 0,
    avgLoss: losses.length > 0 ? gl / losses.length : 0,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    avgHold: closed.length > 0 ? closed.reduce((s, t) => s + t.holdingMs, 0) / closed.length : 0,
    totalFees: trades.reduce((s, t) => s + (t.totalFees ?? 0), 0),
  };
}

function shadowStats(trades: ShadowTrade[]) {
  const settled = trades.filter(t => t.outcome !== 'OPEN' && t.pnlPct != null);
  const wins    = settled.filter(t => (t.pnlPct ?? 0) > 0);
  return {
    total: trades.length, settled: settled.length, wins: wins.length,
    winRate: settled.length > 0 ? (wins.length / settled.length) * 100 : 0,
    avgPnl:  settled.length > 0 ? settled.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / settled.length : 0,
    avgConf: trades.length  > 0 ? trades.reduce((s, t) => s + t.signal.confidence, 0) / trades.length : 0,
  };
}

// ── PDF-optimised CSS ─────────────────────────────────────────────────────────
// expo-print renders HTML via a WKWebView (iOS) or WebView (Android) and then
// invokes the platform PDF renderer. The CSS below is tuned for this pipeline:
//   • @page sets paper size and margins
//   • @media print rules override screen colours for white-background PDF output
//   • page-break-* prevents tables from splitting mid-row
//   • No external fonts (Google Fonts, etc.) — WKWebView cannot load them during
//     headless PDF render. System fonts only.
//   • No CSS Grid on Android < API 28 — use flexbox or table-display fallbacks.
const CSS = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
@page {
  size: A4 portrait;
  margin: 18mm 14mm 18mm 14mm;
}
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, 'Helvetica Neue', Arial, sans-serif;
  font-size: 10pt;
  line-height: 1.45;
  color: #111;
  background: #fff;
}

/* ── Cover ── */
.cover {
  text-align: center;
  padding: 32pt 0 28pt;
  border-bottom: 2pt solid #4f46e5;
  margin-bottom: 20pt;
  page-break-after: avoid;
}
.logo { font-size: 28pt; font-weight: 900; color: #4f46e5; letter-spacing: -1px; }
.cover-title { font-size: 16pt; font-weight: 800; color: #111; margin: 6pt 0 4pt; }
.cover-sub { font-size: 9pt; color: #6b7280; line-height: 1.7; }
.cover-meta {
  display: inline-block;
  background: #f0f0ff;
  border: 1pt solid #c7d2fe;
  border-radius: 6pt;
  padding: 8pt 16pt;
  margin-top: 14pt;
  font-size: 9pt;
  color: #4f46e5;
  font-weight: 600;
}

/* ── Sections ── */
.section { margin-bottom: 18pt; page-break-inside: avoid; }
.section-title {
  font-size: 7.5pt;
  font-weight: 800;
  color: #6b7280;
  letter-spacing: 1pt;
  text-transform: uppercase;
  margin-bottom: 8pt;
  padding-bottom: 4pt;
  border-bottom: 1pt solid #e5e7eb;
}
.pb { page-break-before: always; }

/* ── KPI grid (using table for Android compat) ── */
.kpi-table { width: 100%; border-collapse: collapse; margin-bottom: 10pt; }
.kpi-table td { width: 25%; padding: 0 4pt 8pt 0; vertical-align: top; }
.kpi-box {
  background: #f9fafb;
  border: 1pt solid #e5e7eb;
  border-radius: 5pt;
  padding: 8pt 10pt;
}
.kpi-lbl { font-size: 7pt; font-weight: 700; color: #9ca3af; letter-spacing: .5pt; text-transform: uppercase; margin-bottom: 3pt; }
.kpi-val { font-size: 16pt; font-weight: 800; color: #111; line-height: 1.1; }

/* ── Data tables ── */
table.data { width: 100%; border-collapse: collapse; font-size: 8.5pt; margin-bottom: 6pt; }
table.data th {
  background: #f3f4f6;
  color: #374151;
  font-weight: 700;
  font-size: 7pt;
  letter-spacing: .4pt;
  text-transform: uppercase;
  padding: 5pt 6pt;
  text-align: left;
  border-bottom: 1.5pt solid #d1d5db;
  white-space: nowrap;
}
table.data td { padding: 5pt 6pt; border-bottom: .5pt solid #f3f4f6; vertical-align: middle; }
table.data tr:nth-child(even) td { background: #fafafa; }
table.data tr:last-child td { border-bottom: 1pt solid #e5e7eb; }

/* ── Highlight boxes ── */
.hi { background: #f9fafb; border: 1pt solid #e5e7eb; border-radius: 5pt; padding: 10pt 12pt; margin-bottom: 8pt; }
.hi-title { font-size: 7pt; font-weight: 700; color: #9ca3af; text-transform: uppercase; letter-spacing: .5pt; margin-bottom: 4pt; }
.hi-val { font-size: 14pt; font-weight: 800; }

/* ── Colours ── */
.g { color: #15803d; } .r { color: #dc2626; } .a { color: #d97706; } .b { color: #4f46e5; }
.fw { font-weight: 700; }

/* ── Badges ── */
.badge {
  display: inline-block;
  padding: 1pt 5pt;
  border-radius: 3pt;
  font-size: 7pt;
  font-weight: 700;
  border: .5pt solid currentColor;
}
.bw { color: #15803d; background: #f0fdf4; }
.bl { color: #dc2626; background: #fef2f2; }
.bb { color: #4f46e5; background: #eef2ff; }
.ba { color: #d97706; background: #fffbeb; }
.blong  { color: #15803d; background: #f0fdf4; }
.bshort { color: #dc2626; background: #fef2f2; }

/* ── Two-column layout (table-based for Android) ── */
.two-col { width: 100%; border-collapse: collapse; margin-bottom: 8pt; }
.two-col td { width: 50%; vertical-align: top; padding-right: 8pt; }
.two-col td:last-child { padding-right: 0; }

/* ── Footer ── */
.footer {
  margin-top: 20pt;
  padding-top: 8pt;
  border-top: 1pt solid #e5e7eb;
  font-size: 7.5pt;
  color: #9ca3af;
  text-align: center;
  line-height: 1.6;
}

/* ── Print overrides (kept for any print-path fallback) ── */
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style>`;

// ── HTML section helpers ──────────────────────────────────────────────────────

function kpi(label: string, value: string, colorClass = ''): string {
  return `<td><div class="kpi-box"><div class="kpi-lbl">${label}</div><div class="kpi-val ${colorClass}">${value}</div></div></td>`;
}

function kpiRow(cells: string[]): string {
  // Pad to multiple of 4
  while (cells.length % 4 !== 0) cells.push('<td></td>');
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 4) {
    rows.push(`<tr>${cells.slice(i, i + 4).join('')}</tr>`);
  }
  return `<table class="kpi-table">${rows.join('')}</table>`;
}

function dataTable(heads: string[], rows: string[][]): string {
  if (!rows.length) return '<p style="color:#9ca3af;font-size:9pt">No data.</p>';
  const h = heads.map(h => `<th>${h}</th>`).join('');
  const r = rows.map(r =>
    `<tr>${r.map((c, i) => `<td${i === 0 ? ' class="fw"' : ''}>${c}</td>`).join('')}</tr>`
  ).join('');
  return `<table class="data"><thead><tr>${h}</tr></thead><tbody>${r}</tbody></table>`;
}

const pColor = (n: number) => n > 0 ? 'g' : n < 0 ? 'r' : '';
const wColor = (r: number) => r >= 55 ? 'g' : r >= 45 ? 'a' : 'r';
const ps     = (n: number) => n >= 0 ? '+' : '';

// ── Cover ─────────────────────────────────────────────────────────────────────

function buildCover(
  tradeCount: number,
  stats:      PaperPortfolioStats | null,
  capital:    number,
  generatedAt: string,
): string {
  const winStr = stats
    ? `${stats.totalTrades} trades · ${fmt(stats.winRate, 1)}% win rate · ₹${fmt(stats.totalTrades ? trades_totalPnl(stats) : 0)} net P&L`
    : `${tradeCount} trade${tradeCount !== 1 ? 's' : ''}`;
  return `<div class="cover">
<div class="logo">QUANTIS</div>
<div class="cover-title">Paper Trading Report</div>
<div class="cover-sub">
  ${winStr}<br>
  Starting Capital: ₹${capital.toLocaleString('en-IN')}
</div>
<div class="cover-meta">Generated: ${generatedAt}</div>
<div style="font-size:8pt;color:#9ca3af;margin-top:12pt">
  Educational simulation only · Not financial advice · Not a real brokerage statement
</div>
</div>`;
}

// Helper — derive total P&L from stats (avoid recomputing)
function trades_totalPnl(stats: PaperPortfolioStats): number {
  return stats.avgWin * stats.winningTrades - Math.abs(stats.avgLoss) * stats.losingTrades;
}

// ── Portfolio summary ─────────────────────────────────────────────────────────

function buildPortfolioSection(
  s:     ReturnType<typeof paperStats>,
  stats: PaperPortfolioStats | null,
): string {
  const pfVal = s.pf === Infinity ? '∞' : fmt(s.pf);
  const pfCol = s.pf >= 1.5 ? 'g' : s.pf >= 1 ? 'a' : 'r';

  const row1 = [
    kpi('Total Trades',   String(s.total)),
    kpi('Win Rate',       `${fmt(s.winRate, 1)}%`, wColor(s.winRate)),
    kpi('Profit Factor',  pfVal, pfCol),
    kpi('Net P&L',        `${ps(s.totalPnl)}₹${fmt(s.totalPnl)}`, pColor(s.totalPnl)),
  ];
  const row2 = [
    kpi('Avg Win',    `₹${fmt(s.avgWin)}`, 'g'),
    kpi('Avg Loss',   `-₹${fmt(Math.abs(s.avgLoss))}`, 'r'),
    kpi('Total Fees', `₹${fmt(s.totalFees)}`, 'a'),
    kpi('Avg Hold',   fmtHold(s.avgHold)),
  ];

  let extra = '';
  if (stats) {
    const row3 = [
      kpi('Sharpe Ratio', fmt(stats.sharpeRatio), stats.sharpeRatio >= 1 ? 'g' : stats.sharpeRatio >= 0 ? 'a' : 'r'),
      kpi('Max Drawdown', `${fmt(stats.maxDrawdownPct, 1)}%`, 'r'),
      kpi('Long WR',  `${fmt(stats.longWinRate, 1)}%`,  wColor(stats.longWinRate)),
      kpi('Short WR', `${fmt(stats.shortWinRate, 1)}%`, wColor(stats.shortWinRate)),
    ];
    const row4 = [
      kpi('AI Confidence', `${fmt(stats.avgConfidence, 0)}%`),
      kpi('Avg Risk',      `${fmt(stats.avgRisk, 0)}/100`),
      kpi('Trend',         stats.performanceTrend, stats.performanceTrend === 'IMPROVING' ? 'g' : stats.performanceTrend === 'DECLINING' ? 'r' : ''),
      kpi('Wins / Losses', `${s.wins}W · ${s.losses}L`),
    ];
    extra = kpiRow(row3) + kpiRow(row4);

    if (stats.bestTrade || stats.worstTrade) {
      extra += `<table class="two-col"><tr>
<td><div class="hi"><div class="hi-title">🏆 Best Trade</div>
<div class="hi-val g">${stats.bestTrade
  ? `${stats.bestTrade.symbol}  ${ps(stats.bestTrade.pnl)}₹${fmt(stats.bestTrade.pnl)}  (${fmt(stats.bestTrade.pnlPct, 1)}%)`
  : '—'}</div></div></td>
<td><div class="hi"><div class="hi-title">💸 Worst Trade</div>
<div class="hi-val r">${stats.worstTrade
  ? `${stats.worstTrade.symbol}  ₹${fmt(stats.worstTrade.pnl)}  (${fmt(stats.worstTrade.pnlPct, 1)}%)`
  : '—'}</div></div></td>
</tr></table>`;
    }
  }

  return `<div class="section">
<div class="section-title">Portfolio Summary</div>
${kpiRow(row1)}${kpiRow(row2)}${extra}
</div>`;
}

// ── AI accuracy ───────────────────────────────────────────────────────────────

function buildAISection(stats: PaperPortfolioStats): string {
  const pa  = stats.predictionAccuracyStats;
  const acc = pa.predictionAccuracy != null ? `${fmt(pa.predictionAccuracy, 1)}%` : '—';
  const col = pa.predictionAccuracy != null && pa.predictionAccuracy >= 55 ? 'g' : 'a';
  const rows: string[][] = [
    ['Prediction Accuracy', `<span class="${col} fw">${acc}</span>`, 'Direction correct / total graded trades'],
    ['Correct Predictions',  `<span class="g fw">${pa.correctCount}</span>`, ''],
    ['Incorrect Predictions',`<span class="r fw">${pa.incorrectCount}</span>`, ''],
    ['Neutral (no grade)',    String(pa.neutralCount), 'HOLD trades — no directional call to grade'],
    ['Correct → but lost money', `<span class="a fw">${pa.correctButLosingCount}</span>`, 'Fees / slippage exceeded the gross profit'],
    ['Avg P&L — Correct',   pa.avgPnlCorrect   != null ? `<span class="g fw">₹${fmt(pa.avgPnlCorrect)}</span>`   : '—', ''],
    ['Avg P&L — Incorrect', pa.avgPnlIncorrect != null ? `<span class="r fw">₹${fmt(pa.avgPnlIncorrect)}</span>` : '—', ''],
  ];
  return `<div class="section pb">
<div class="section-title">AI Prediction Accuracy</div>
${dataTable(['Metric', 'Value', 'Note'], rows)}
</div>`;
}

// ── Performance breakdowns ────────────────────────────────────────────────────

function buildBreakdownSection(stats: PaperPortfolioStats): string {
  const sym = dataTable(
    ['Symbol', 'Trades', 'Net P&L', 'Win Rate'],
    stats.bySymbol.slice(0, 15).map(s => [
      s.symbol, String(s.trades),
      `<span class="${pColor(s.netPnl)}">${ps(s.netPnl)}₹${fmt(s.netPnl)}</span>`,
      `<span class="${wColor(s.winRate)}">${fmt(s.winRate, 1)}%</span>`,
    ])
  );
  const tf = dataTable(
    ['Timeframe', 'Trades', 'Net P&L', 'Win Rate'],
    stats.byTimeframe.map(s => [
      s.timeframe, String(s.trades),
      `<span class="${pColor(s.netPnl)}">${ps(s.netPnl)}₹${fmt(s.netPnl)}</span>`,
      `<span class="${wColor(s.winRate)}">${fmt(s.winRate, 1)}%</span>`,
    ])
  );
  const reg = dataTable(
    ['Regime', 'Trades', 'Net P&L', 'Win Rate'],
    stats.byRegime.sort((a, b) => b.trades - a.trades).map(s => [
      s.regime, String(s.trades),
      `<span class="${pColor(s.netPnl)}">${ps(s.netPnl)}₹${fmt(s.netPnl)}</span>`,
      `<span class="${wColor(s.winRate)}">${fmt(s.winRate, 1)}%</span>`,
    ])
  );
  const ac = dataTable(
    ['Asset Class', 'Trades', 'Net P&L', 'Win Rate'],
    stats.byAssetClass.map(s => [
      s.assetClass, String(s.trades),
      `<span class="${pColor(s.netPnl)}">${ps(s.netPnl)}₹${fmt(s.netPnl)}</span>`,
      `<span class="${wColor(s.winRate)}">${fmt(s.winRate, 1)}%</span>`,
    ])
  );
  return `<div class="section pb">
<div class="section-title">Performance Breakdowns</div>
<div style="margin-bottom:12pt">
  <div style="font-size:7.5pt;font-weight:700;color:#6b7280;margin-bottom:5pt">BY SYMBOL (TOP 15)</div>${sym}
</div>
<table class="two-col"><tr>
<td><div style="font-size:7.5pt;font-weight:700;color:#6b7280;margin-bottom:5pt">BY TIMEFRAME</div>${tf}</td>
<td><div style="font-size:7.5pt;font-weight:700;color:#6b7280;margin-bottom:5pt">BY ASSET CLASS</div>${ac}</td>
</tr></table>
<div style="font-size:7.5pt;font-weight:700;color:#6b7280;margin-bottom:5pt">BY MARKET REGIME</div>${reg}
</div>`;
}

// ── Expected edge ─────────────────────────────────────────────────────────────

function buildEdgeSection(stats: PaperPortfolioStats): string {
  const te = stats.tradeEconomicsStats;
  if (te.tradesWithData === 0) return '';
  const rows: string[][] = [
    ['Trades with edge data', String(te.tradesWithData), ''],
    ['Negative-edge trades', `<span class="r fw">${te.negativeEdgeCount}</span>`, 'Expected to lose money at entry time'],
    ['Positive-edge trades', `<span class="g fw">${te.positiveEdgeCount}</span>`, 'Expected to profit at entry time'],
    ['Win rate — negative-edge', te.negativeEdgeWinRate != null ? `${fmt(te.negativeEdgeWinRate, 1)}%` : '—', ''],
    ['Win rate — positive-edge', te.positiveEdgeWinRate != null ? `${fmt(te.positiveEdgeWinRate, 1)}%` : '—', ''],
    ...te.avgPnlByEdgeBucket.map(b => [
      `Avg P&L — ${b.bucket}`,
      b.trades ? `<span class="${pColor(b.avgPnl)}">${ps(b.avgPnl)}₹${fmt(b.avgPnl)}</span>` : '—',
      `${b.trades} trade${b.trades !== 1 ? 's' : ''}`,
    ]),
  ];
  return `<div class="section">
<div class="section-title">Expected Edge Diagnostics</div>
${dataTable(['Metric', 'Value', 'Note'], rows)}
</div>`;
}

// ── Trade journal ─────────────────────────────────────────────────────────────

function buildJournalSection(trades: PaperTradeRecord[], filters: Record<string, any>): string {
  const activeFilters = Object.entries(filters)
    .filter(([, v]) => v && v !== 'ALL')
    .map(([k, v]) => `${k}: ${v}`).join(' · ');

  const rows = trades.map(t => {
    const res = t.exitReason === 'PARTIAL_CLOSE' ? '<span class="badge ba">PARTIAL</span>'
              : t.pnl > 0 ? '<span class="badge bw">WIN</span>'
              : t.pnl < 0 ? '<span class="badge bl">LOSS</span>'
              : '<span class="badge bb">BE</span>';
    const dir = t.direction === 'LONG'
      ? '<span class="badge blong">▲ L</span>'
      : '<span class="badge bshort">▼ S</span>';
    return [
      `${dir} ${t.symbol}`,
      t.timeframe,
      fmtDate(t.entryTime),
      fmtHold(t.holdingMs),
      `₹${fmt(t.entryPrice, 2)}`,
      `₹${fmt(t.exitPrice, 2)}`,
      `<span class="${pColor(t.pnl)} fw">${ps(t.pnl)}₹${fmt(t.pnl)}</span>`,
      `<span class="${pColor(t.pnlPct)}">${fmt(t.pnlPct)}%</span>`,
      res,
      `${fmt(t.aiConfidence, 0)}%`,
      t.marketRegime ?? '—',
      fmtReason(t.exitReason),
    ];
  });

  const filterNote = activeFilters
    ? `<p style="font-size:8pt;color:#6b7280;margin-bottom:7pt">Filters active: ${activeFilters}</p>`
    : '';

  return `<div class="section pb">
<div class="section-title">Trade Journal (${trades.length} trade${trades.length !== 1 ? 's' : ''})</div>
${filterNote}
${dataTable(
  ['Symbol', 'TF', 'Entry', 'Hold', 'Entry ₹', 'Exit ₹', 'P&L ₹', 'P&L%', 'Result', 'AI%', 'Regime', 'Exit'],
  rows
)}
</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC: Generate the unified HTML report (used by PDF and CSV+HTML fallback)
// ═══════════════════════════════════════════════════════════════════════════════

export function generateUnifiedReportHTML(
  trades:         PaperTradeRecord[],
  filters:        Record<string, any>,
  stats:          PaperPortfolioStats | null,
  startingCapital = 100000,
): string {
  const now = new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false });
  const s = paperStats(trades);

  const body = [
    buildCover(trades.length, stats, startingCapital, now),
    buildPortfolioSection(s, stats),
    stats ? buildAISection(stats) : '',
    stats ? buildBreakdownSection(stats) : '',
    stats ? buildEdgeSection(stats) : '',
    buildJournalSection(trades, filters),
    `<div class="footer">
  QUANTIS Paper Trading Report &nbsp;·&nbsp; Generated ${now}
  &nbsp;·&nbsp; ${trades.length} trade${trades.length !== 1 ? 's' : ''}
  &nbsp;·&nbsp; Starting capital ₹${startingCapital.toLocaleString('en-IN')}<br>
  Educational simulation only — not financial advice — not a real brokerage statement
</div>`,
  ].filter(Boolean).join('\n');

  return `<!DOCTYPE html><html lang="en"><head>${CSS}</head><body>${body}</body></html>`;
}

// ═══════════════════════════════════════════════════════════
// PUBLIC: Generate unified CSV
// ═══════════════════════════════════════════════════════════

export function generateUnifiedCSV(trades: PaperTradeRecord[]): string {
  const headers = [
    'Symbol', 'Direction', 'Timeframe', 'Asset Class',
    'Entry Time', 'Exit Time', 'Hold Duration',
    'Entry Price ₹', 'Exit Price ₹',
    'Gross P&L ₹', 'Total Fees ₹', 'Net P&L ₹', 'P&L %',
    'Result', 'Exit Reason',
    'AI Confidence %', 'Risk Score', 'Trade Quality Score', 'Trade Quality Grade',
    'Market Regime', 'Prediction Result', 'Model Version',
    'Peak Profit MFE ₹', 'Max Drawdown MAE ₹',
    'Peak Profit Track ₹', 'Max Profit Withdrawn ₹',
    'Qty', 'Strategy', 'Signal State', 'Override Used',
  ];
  const rows = trades.map(t => csvRow([
    t.symbol, t.direction, t.timeframe, t.assetClass ?? '—',
    fmtDate(t.entryTime), fmtDate(t.exitTime), fmtHold(t.holdingMs),
    t.entryPrice.toFixed(4), t.exitPrice.toFixed(4),
    (t.grossPnl ?? 0).toFixed(4), (t.totalFees ?? 0).toFixed(4),
    t.pnl.toFixed(4), t.pnlPct.toFixed(4),
    t.exitReason === 'PARTIAL_CLOSE' ? 'PARTIAL' : t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'BE',
    t.exitReason ?? '—',
    t.aiConfidence.toFixed(1), (t.riskScoreAtEntry ?? 0).toFixed(1),
    t.tradeQuality ? Math.round(t.tradeQuality.score).toString() : '—',
    t.tradeQuality?.grade ?? '—',
    t.marketRegime ?? '—', t.predictionResult ?? '—',
    t.modelVersion ? `v${t.modelVersion}` : '—',
    t.maxUnrealizedProfit != null ? t.maxUnrealizedProfit.toFixed(4) : '—',
    t.maxDrawdownDuringTrade != null ? t.maxDrawdownDuringTrade.toFixed(4) : '—',
    (t as any).peakProfit        != null ? (t as any).peakProfit.toFixed(4)        : '—',
    (t as any).maxProfitWithdrawn != null ? (t as any).maxProfitWithdrawn.toFixed(4) : '—',
    t.qty?.toFixed(4) ?? '—',
    (t as any).strategyName ?? '—',
    (t as any).signalSnapshot?.originalState ?? '—',
    (t as any).signalSnapshot?.overrideUsed ? 'YES' : 'NO',
  ]));
  return '\uFEFF' + [csvRow(headers), ...rows].join('\n'); // BOM → Excel auto-detects UTF-8
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shadow journal exports (unchanged public API)
// ═══════════════════════════════════════════════════════════════════════════════

export function generateShadowJournalHTML(trades: ShadowTrade[], filters: any): string {
  const s   = shadowStats(trades);
  const now = new Date().toLocaleString('en-IN', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
  const af  = Object.entries(filters).filter(([,v]:any) => v && v !== 'ALL').map(([k,v]) => `${k}: ${v}`).join(' · ') || 'None';

  const gateMap: Record<string, {total:number; wins:number}> = {};
  trades.forEach(t => {
    if (!gateMap[t.blockGate]) gateMap[t.blockGate] = {total:0, wins:0};
    gateMap[t.blockGate].total++;
    if (t.outcome === 'TP_HIT') gateMap[t.blockGate].wins++;
  });
  const gateRows = Object.entries(gateMap)
    .sort(([,a],[,b]) => b.total - a.total)
    .map(([g, {total, wins}]) => [
      `<span class="a fw">${g}</span>`, String(total),
      `<span class="g fw">${wins}</span>`,
      total > 0 ? `${(wins/total*100).toFixed(1)}%` : '—',
    ]);

  const tradeRows = trades.map(t => {
    const bdg = t.outcome === 'TP_HIT' ? 'bw' : t.outcome === 'SL_HIT' ? 'bl' : 'bb';
    const ol  = t.outcome === 'TP_HIT' ? '✅ TP' : t.outcome === 'SL_HIT' ? '❌ SL' : '🔵 Open';
    const dir = t.direction === 'LONG' ? '<span class="badge blong">▲ L</span>' : '<span class="badge bshort">▼ S</span>';
    return [
      `${dir} ${t.symbol}`, t.timeframe, fmtDate(t.blockedAt),
      `<span class="a fw">${t.blockGate}</span>`,
      (t.blockReason ?? '').substring(0, 55),
      `₹${fmt(t.entryPrice)}`, `₹${fmt(t.stopLoss)}`, `₹${fmt(t.takeProfit)}`,
      fmt(t.rr, 2), `<span class="badge ${bdg}">${ol}</span>`,
      t.pnlPct != null ? `<span class="${pColor(t.pnlPct)}">${fmt(t.pnlPct)}%</span>` : '—',
      `${fmt(t.signal.confidence, 0)}%`,
    ];
  });

  const skpis = [
    kpi('Total Blocked', String(s.total)),
    kpi('Shadow Win Rate', `${fmt(s.winRate, 1)}%`, wColor(s.winRate)),
    kpi('Shadow Avg P&L', `${ps(s.avgPnl)}${fmt(s.avgPnl)}%`, pColor(s.avgPnl)),
    kpi('Settled', String(s.settled)),
    kpi('Shadow Wins', String(s.wins), 'g'),
    kpi('Avg Confidence', `${fmt(s.avgConf, 0)}%`),
  ];

  const body = `
<div class="cover">
<div class="logo">QUANTIS</div>
<div class="cover-title">Shadow Journal</div>
<div class="cover-sub">Trades blocked by risk gates · ${trades.length} entries · Filters: ${af}</div>
<div class="cover-meta">Generated: ${now}</div>
<div style="font-size:8pt;color:#9ca3af;margin-top:10pt">These are NOT real executed trades</div>
</div>
<div class="section">
<div class="section-title">Gate Summary</div>
${kpiRow(skpis)}
${dataTable(['Gate', 'Blocked', 'Shadow Wins', 'Win Rate'], gateRows)}
</div>
<div class="section pb">
<div class="section-title">Blocked Trades (${trades.length})</div>
${dataTable(['Symbol', 'TF', 'Blocked At', 'Gate', 'Reason', 'Entry', 'SL', 'TP', 'R:R', 'Outcome', 'P&L%', 'Conf'], tradeRows)}
</div>
<div class="footer">QUANTIS Shadow Journal · These are NOT real executed trades</div>`;

  return `<!DOCTYPE html><html lang="en"><head>${CSS}</head><body>${body}</body></html>`;
}

export function generateShadowJournalCSV(trades: ShadowTrade[]): string {
  const h = ['Symbol','Direction','Timeframe','Blocked At','Gate','Reason','Entry ₹','SL ₹','TP ₹','R:R','Outcome','Shadow P&L %','AI Conf %','Ensemble Prob','Regime'];
  const rows = trades.map(t => csvRow([
    t.symbol, t.direction, t.timeframe, fmtDate(t.blockedAt), t.blockGate, t.blockReason,
    fmt(t.entryPrice), fmt(t.stopLoss), fmt(t.takeProfit), fmt(t.rr, 2),
    t.outcome, t.pnlPct != null ? fmt(t.pnlPct) : '—',
    fmt(t.signal.confidence, 0), fmt(t.signal.ensembleProbUp, 4), t.signal.regime,
  ]));
  return '\uFEFF' + [csvRow(h), ...rows].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// BACKWARD COMPAT STUBS — callers that import old function names keep working
// ═══════════════════════════════════════════════════════════════════════════════

/** @deprecated Use generateUnifiedReportHTML */
export function generatePaperJournalHTML(trades: PaperTradeRecord[], filters: any): string {
  return generateUnifiedReportHTML(trades, filters, null);
}
/** @deprecated Use generateUnifiedCSV */
export function generatePaperJournalCSV(trades: PaperTradeRecord[]): string {
  return generateUnifiedCSV(trades);
}
/** @deprecated Analytics export removed — use unified report from Journal */
export function generatePaperAnalyticsHTML(trades: PaperTradeRecord[], stats: PaperPortfolioStats): string {
  return generateUnifiedReportHTML(trades, {}, stats);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CORE SHARE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generates a real PDF file using expo-print and shares it via expo-sharing.
 *
 * Flow:
 *   1. Print.printToFileAsync(html) → writes a .pdf to the app cache directory
 *      and returns { uri: 'file:///...cache.../print-XXXX.pdf', numberOfPages }
 *   2. Sharing.shareAsync(uri, { mimeType: 'application/pdf', dialogTitle })
 *      → opens the native share sheet showing the real .pdf file
 *   3. FileSystem.deleteAsync(uri, { idempotent: true })
 *      → clean up the cache file after sharing (non-blocking)
 *
 * On failure (module not linked yet, Expo Go without dev client):
 *   falls back to React Native's Share API with a data: URI so export
 *   never fails completely — user gets the HTML in their browser.
 */
async function sharePDF(title: string, html: string): Promise<void> {
  const Print   = await loadPrintModule();
  const Sharing = await loadSharingModule();
  const FS      = await loadFSModule();

  if (Print && Sharing) {
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) throw new Error('Sharing unavailable on this device');

      // Generate the real PDF. printToFileAsync spawns a WKWebView/WebView
      // headlessly, renders the HTML, and writes the PDF in one call.
      // width/height are in pt (72pt = 1 inch). A4 = 595×842pt.
      const result = await Print.printToFileAsync({
        html,
        width:  595,   // A4 width in pt
        height: 842,   // A4 height in pt
        // base64: false (default) — we only need the file URI
      });

      // Share the .pdf directly — native share sheet, no browser
      await Sharing.shareAsync(result.uri, {
        mimeType:    'application/pdf',
        dialogTitle: title,
        UTI:         'com.adobe.pdf', // iOS UTI for .pdf
      });

      // Non-blocking cleanup — fire and forget
      if (FS) {
        FS.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
      }
      return; // success — do not fall through to fallback
    } catch (printErr: any) {
      // Log for debugging but fall through to the HTML fallback below
      console.warn('[QUANTIS export] expo-print failed, falling back to HTML share:', printErr?.message);
    }
  }

  // Fallback: Share HTML as data: URI (opens in browser)
  // This path runs only if expo-print/sharing are unavailable or throw.
  const encoded = encodeURIComponent(html);
  await Share.share({
    title,
    message: Platform.OS === 'android' ? html : undefined,
    url:     Platform.OS === 'ios'     ? `data:text/html;charset=utf-8,${encoded}` : undefined,
  });
}

/**
 * Writes a real .csv file and shares it via expo-sharing.
 *
 * Flow (mirrors sharePDF exactly):
 *   1. FileSystem.writeAsStringAsync(cacheDir + filename, csv, { encoding: 'utf8' })
 *      → writes a real .csv to the app cache with a timestamped filename
 *   2. Sharing.shareAsync(uri, { mimeType: 'text/csv', dialogTitle })
 *      → native share sheet: user saves to Files, opens in Excel/Sheets, emails it, etc.
 *      The filename (e.g. QUANTIS_Report_2026-07-26_1205.csv) is preserved in all apps.
 *   3. FileSystem.deleteAsync(uri, { idempotent: true }) — cache cleanup (non-blocking)
 *
 * The UTF-8 BOM (\uFEFF) is the first character of the CSV string, ensuring Excel
 * and Google Sheets auto-detect UTF-8 and render ₹, ✓, and other symbols correctly.
 *
 * Fallback (modules not linked / Expo Go without dev client):
 *   Share.share({ message: csv }) — plain text share, no filename, no file written.
 *   Export still works; the user manually saves the text. This path should never
 *   be reached in a production Android build with expo-modules-autolinking.
 */
async function shareCSV(title: string, csv: string): Promise<void> {
  const Sharing = await loadSharingModule();
  const FS      = await loadFSModule();

  if (Sharing && FS) {
    try {
      const canShare = await Sharing.isAvailableAsync();
      if (!canShare) throw new Error('Sharing unavailable on this device');

      // Build a timestamped filename so it's identifiable after saving.
      // e.g. "QUANTIS_Report_2026-07-26_1205.csv"
      const now   = new Date();
      const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
      ].join('-') + '_' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      const filename = `QUANTIS_Report_${stamp}.csv`;
      const fileUri  = (FS.cacheDirectory ?? '') + filename;

      // Write the CSV string to the cache directory.
      // encoding: 'utf8' correctly encodes the BOM (\uFEFF → EF BB BF bytes)
      // and all Unicode characters including ₹ (U+20B9).
      await FS.writeAsStringAsync(fileUri, csv, { encoding: 'utf8' });

      // Share the real .csv file — native share sheet with correct filename
      await Sharing.shareAsync(fileUri, {
        mimeType:    'text/csv',
        dialogTitle: title,
        UTI:         'public.comma-separated-values-text', // iOS UTI for .csv
      });

      // Non-blocking cache cleanup — fire and forget
      FS.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
      return; // success — do not fall through to fallback
    } catch (csvErr: any) {
      console.warn('[QUANTIS export] CSV file write failed, falling back to text share:', csvErr?.message);
    }
  }

  // Fallback: plain text share (no file, no filename preserved)
  // Reached only if expo-file-system / expo-sharing are unavailable.
  await Share.share({ title, message: csv });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC EXPORT API — called by PaperJournalScreen and ShadowJournalScreen
// ═══════════════════════════════════════════════════════════════════════════════

export type ExportFormat = 'CSV' | 'PDF';

/**
 * The single export function for the Paper Journal.
 * PDF → real .pdf via expo-print + expo-sharing → native share sheet
 * CSV → real .csv file via expo-file-system + expo-sharing → native share sheet
 */
export async function exportPaperJournal(
  trades:          PaperTradeRecord[],
  format:          ExportFormat,
  filters:         Record<string, any>,
  stats?:          PaperPortfolioStats | null,
  startingCapital?: number,
): Promise<void> {
  if (trades.length === 0) throw new Error('No trades to export.');
  const count = trades.length;
  const title = `QUANTIS Report — ${count} trade${count !== 1 ? 's' : ''}`;
  if (format === 'CSV') {
    await shareCSV(title, generateUnifiedCSV(trades));
  } else {
    await sharePDF(title, generateUnifiedReportHTML(trades, filters, stats ?? null, startingCapital ?? 100000));
  }
}

export async function exportShadowJournal(
  trades:  ShadowTrade[],
  format:  ExportFormat,
  filters: Record<string, any>,
): Promise<void> {
  if (trades.length === 0) throw new Error('No shadow trades to export.');
  const count = trades.length;
  const title = `QUANTIS Shadow Journal — ${count} trade${count !== 1 ? 's' : ''}`;
  if (format === 'CSV') {
    await shareCSV(title, generateShadowJournalCSV(trades));
  } else {
    await sharePDF(title, generateShadowJournalHTML(trades, filters));
  }
}

/** @deprecated use exportShadowJournal */
export async function exportProductionEvalPDF(html: string, symbolCount: number): Promise<void> {
  await sharePDF(`QUANTIS Eval — ${symbolCount} symbol${symbolCount !== 1 ? 's' : ''}`, html);
}
