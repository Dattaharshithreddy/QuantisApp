// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION TYPES  (v5.6.0)
// ─────────────────────────────────────────────────────────────────────────────
import { PaperTradeRecord } from '../utils/paperTradeJournal';

// ── Per-trade enriched record ─────────────────────────────────────────────────
export type ValidatedTrade = PaperTradeRecord & {
  // Return metrics (deterministic from existing fields)
  returnPct:    number;      // pnlPct (alias for clarity)
  mfe:          number;      // maxUnrealizedProfit / entryPrice × 100  (%)
  mae:          number;      // maxDrawdownDuringTrade / entryPrice × 100 (%)
  holdingBars:  number;      // holdingMs / timeframeMs (approximate bar count)

  // Classification
  isWin:        boolean;     // pnl > 0
  falseSignal:  FalseSignalType | null;

  // Breakdown keys (derived from entrySnapshot / marketRegime)
  regimeLabel:  string;      // marketRegime field
  confidenceGrade: ConfidenceGrade;
  sessionLabel: string;      // 'Asia' | 'London' | 'NewYork' | 'Overlap' | 'Off'
  mtfAligned:   boolean;     // entrySnapshot top feature 'MTF overall score' > 0.2
  hasBullOB:    boolean;     // 'SMC bull OB strength' top feature > 0.2
  hasFVG:       boolean;     // 'FVG bull strength' or 'FVG bear strength' > 0.2
};

export type FalseSignalType =
  | 'FALSE_BUY'   // LONG opened, price fell immediately (MAE > 0.5 × ATR within 3 bars)
  | 'FALSE_SELL'  // SHORT opened, price rose immediately
  | 'LATE_ENTRY'  // entered after move already matured (MFE < 0.3 × expected move)
  | 'EARLY_EXIT'; // closed before target hit, price continued favorably afterward

export type ConfidenceGrade = 'A+' | 'A' | 'B' | 'C' | 'D';

// ── Core statistics ───────────────────────────────────────────────────────────
export type ValidationStats = {
  tradeCount:       number;
  winCount:         number;
  lossCount:        number;
  winRate:          number;  // 0–1
  profitFactor:     number;  // gross wins / gross losses
  expectancy:       number;  // avg return per trade (%)
  avgWin:           number;  // avg % gain on winning trades
  avgLoss:          number;  // avg % loss on losing trades
  avgMFE:           number;  // avg Maximum Favorable Excursion (%)
  avgMAE:           number;  // avg Maximum Adverse Excursion (%)
  avgHoldingBars:   number;
  sharpeRatio:      number;  // returns / stddev, annualized approximation
  sortinoRatio:     number;  // returns / downside stddev
  calmarRatio:      number;  // annualized return / max drawdown
  maxDrawdownPct:   number;  // % peak-to-trough on equity curve
  totalReturnPct:   number;
};

// ── Breakdown slice ───────────────────────────────────────────────────────────
export type ValidationSlice = {
  label:      string;
  stats:      ValidationStats;
  trades:     ValidatedTrade[];
  sampleSize: number;
};

// ── Calibration table ─────────────────────────────────────────────────────────
// Maps nominal confidence band → actual win rate
export type CalibrationRow = {
  band:          string;   // e.g. '90–100%'
  nominalLow:    number;   // 0–1
  nominalHigh:   number;   // 0–1
  actualWinRate: number;   // 0–1
  sampleCount:   number;
  calibrationError: number; // |mid - actualWinRate|
};

// ── False signal summary ──────────────────────────────────────────────────────
export type FalseSignalSummary = {
  type:        FalseSignalType;
  count:       number;
  pct:         number;  // proportion of total trades
  avgLossPct:  number;
  commonRegime:string;  // most frequent regime when this false signal occurs
};

// ── Full validation report ────────────────────────────────────────────────────
export type ValidationReport = {
  generatedAt:    number;   // Unix timestamp
  symbol:         string;
  timeframe:      string;
  totalTrades:    number;
  dateRange:      { from: number; to: number };

  // Core stats
  overall:        ValidationStats;

  // Breakdown slices
  byRegime:       ValidationSlice[];
  byGrade:        ValidationSlice[];
  byMTFAlignment: ValidationSlice[];
  bySMC:          ValidationSlice[];
  byFVG:          ValidationSlice[];
  bySession:      ValidationSlice[];
  byTimeframe:    ValidationSlice[];

  // Calibration
  calibration:    CalibrationRow[];

  // False signals
  falseSignals:   FalseSignalSummary[];

  // Best / worst conditions
  bestConditions: ValidationSlice[];   // top 3 slices by expectancy
  worstConditions:ValidationSlice[];   // bottom 3

  // Highest / lowest confidence
  highConfTrades: ValidatedTrade[];    // aiConfidence ≥ 0.75, top 10 by pnlPct
  lowConfTrades:  ValidatedTrade[];    // aiConfidence < 0.45, worst 10

  // Feature attribution
  bestFeatures:   { name: string; avgInfluenceOnWins: number }[];
  worstFeatures:  { name: string; avgInfluenceOnLosses: number }[];
};
