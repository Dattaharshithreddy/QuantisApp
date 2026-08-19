// STATUS: DISCONNECTED — companion formatter to validationEngine.ts.
// Wire alongside validationEngine.ts when it is connected to a screen.
//
// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION REPORT FORMATTER  (v5.6.0)
// Converts ValidationReport into human-readable text sections.
// ─────────────────────────────────────────────────────────────────────────────
import { ValidationReport, ValidationStats, ValidationSlice, CalibrationRow } from './validationTypes';

function pct(v: number, dp = 1): string { return (v * 100).toFixed(dp) + '%'; }
function num(v: number, dp = 2): string { return isFinite(v) ? v.toFixed(dp) : '—'; }

function statsLines(s: ValidationStats): string[] {
  return [
    `Trades: ${s.tradeCount}  Win Rate: ${pct(s.winRate)}  Profit Factor: ${num(s.profitFactor)}`,
    `Expectancy: ${num(s.expectancy)}%  Avg Win: ${num(s.avgWin)}%  Avg Loss: ${num(s.avgLoss)}%`,
    `Sharpe: ${num(s.sharpeRatio)}  Sortino: ${num(s.sortinoRatio)}  Calmar: ${num(s.calmarRatio)}`,
    `MFE: ${num(s.avgMFE)}%  MAE: ${num(s.avgMAE)}%  Max DD: ${num(s.maxDrawdownPct)}%`,
    `Avg Hold: ${num(s.avgHoldingBars, 0)} bars  Total Return: ${num(s.totalReturnPct)}%`,
  ];
}

function sliceTable(slices: ValidationSlice[]): string[] {
  const lines = [`${'Label'.padEnd(22)} ${'Trades'.padStart(6)} ${'WinR'.padStart(6)} ${'Expect'.padStart(8)} ${'PF'.padStart(6)} ${'Sharpe'.padStart(7)}`];
  lines.push('─'.repeat(60));
  for (const s of slices) {
    lines.push(
      s.label.padEnd(22) +
      String(s.sampleSize).padStart(6) +
      pct(s.stats.winRate).padStart(7) +
      (num(s.stats.expectancy) + '%').padStart(9) +
      num(s.stats.profitFactor).padStart(7) +
      num(s.stats.sharpeRatio).padStart(8)
    );
  }
  return lines;
}

function calibrationTable(rows: CalibrationRow[]): string[] {
  const lines = [`${'Band'.padEnd(12)} ${'N'.padStart(5)} ${'Nominal'.padStart(9)} ${'Actual'.padStart(8)} ${'Error'.padStart(7)}`];
  lines.push('─'.repeat(44));
  for (const r of rows) {
    const mid = ((r.nominalLow + r.nominalHigh) / 2 * 100).toFixed(0) + '%';
    lines.push(
      r.band.padEnd(12) +
      String(r.sampleCount).padStart(6) +
      mid.padStart(10) +
      pct(r.actualWinRate).padStart(9) +
      (num(r.calibrationError * 100, 1) + 'pp').padStart(8)
    );
  }
  return lines;
}

// ── Main formatter ────────────────────────────────────────────────────────────
export function formatReport(report: ValidationReport): string {
  const lines: string[] = [];

  const ts = new Date(report.generatedAt).toISOString();
  lines.push(`QUANTIS VALIDATION REPORT — ${report.symbol} ${report.timeframe}`);
  lines.push(`Generated: ${ts}   Total trades: ${report.totalTrades}`);
  lines.push('═'.repeat(64));

  lines.push('\n── OVERALL STATISTICS ──');
  lines.push(...statsLines(report.overall));

  lines.push('\n── CALIBRATION (Confidence → Actual Win Rate) ──');
  lines.push(...calibrationTable(report.calibration));

  lines.push('\n── BY MARKET REGIME ──');
  lines.push(...sliceTable(report.byRegime));

  lines.push('\n── BY CONFIDENCE GRADE ──');
  lines.push(...sliceTable(report.byGrade));

  lines.push('\n── BY MTF ALIGNMENT ──');
  lines.push(...sliceTable(report.byMTFAlignment));

  lines.push('\n── BY SESSION ──');
  lines.push(...sliceTable(report.bySession));

  lines.push('\n── FALSE SIGNAL BREAKDOWN ──');
  if (report.falseSignals.length === 0) {
    lines.push('  No false signal patterns detected.');
  } else {
    for (const fs of report.falseSignals) {
      lines.push(`  ${fs.type.padEnd(14)} count=${fs.count}  ${pct(fs.pct)}  avgLoss=${num(fs.avgLossPct)}%  most common regime: ${fs.commonRegime}`);
    }
  }

  lines.push('\n── BEST CONDITIONS (by expectancy) ──');
  for (const s of report.bestConditions) {
    lines.push(`  ${s.label}: expectancy=${num(s.stats.expectancy)}%  winRate=${pct(s.stats.winRate)}  n=${s.sampleSize}`);
  }

  lines.push('\n── WORST CONDITIONS ──');
  for (const s of report.worstConditions) {
    lines.push(`  ${s.label}: expectancy=${num(s.stats.expectancy)}%  winRate=${pct(s.stats.winRate)}  n=${s.sampleSize}`);
  }

  lines.push('\n── TOP FEATURES ON WINNING TRADES ──');
  for (const f of report.bestFeatures.slice(0, 5)) {
    lines.push(`  ${String(f.name).padEnd(32)} avg influence: ${num(f.avgInfluenceOnWins ?? 0, 4)}`);
  }

  lines.push('\n── TOP FEATURES ON LOSING TRADES ──');
  for (const f of report.worstFeatures.slice(0, 5)) {
    lines.push(`  ${String(f.name).padEnd(32)} avg influence: ${num(f.avgInfluenceOnLosses ?? 0, 4)}`);
  }

  return lines.join('\n');
}
