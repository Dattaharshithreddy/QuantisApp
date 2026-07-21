// ─────────────────────────────────────────────────────────────────────────────
// PORTFOLIO RISK ENGINE  (v6.0.9)
//
// Sits above Trade Management and Execution. Called once per open attempt.
// Complexity: O(P) where P = number of open positions. No matrix operations.
//
// Reuses without duplicating:
//   calcPositionSize  — riskManager.ts  (quantity from dollar risk)
//   calcKelly         — riskManager.ts  (win-rate optimal fraction)
//   FEE_PCT / SLIPPAGE_PCT — imported constants from paperTradingEngine context
//     (passed in, not re-declared here)
//   Regime / Confidence / MTF — consumed as already-computed scalar fields
//     from MLPrediction.confidenceBreakdown and prediction.*
//
// No indicators are recomputed. No engine calls are made inside this module.
// ─────────────────────────────────────────────────────────────────────────────
import { PaperPortfolioState } from './paperPortfolio';
import { getDynamicCorrelation } from './correlationEngine';
import { Candle } from './indicators';
import { calcKelly } from './riskManager';
import { logger } from './logger';

// ── Correlation groups — static lookup, O(1) ──────────────────────────────────
// Conservative grouping. Two symbols in the same group are treated as
// having correlation = INTRA_GROUP_CORR. Cross-group = CROSS_GROUP_CORR.
// No historical matrix is computed; this is a deliberately lightweight
// structural model (standard in real-time risk systems where latency matters).
const CORRELATION_GROUPS: Record<string, string> = {
  // BTC family
  BTC: 'BTC_FAMILY', BTCUSDT: 'BTC_FAMILY', WBTC: 'BTC_FAMILY', BTCB: 'BTC_FAMILY',
  // ETH ecosystem
  ETH: 'ETH_ECOSYSTEM', ETHUSDT: 'ETH_ECOSYSTEM',
  STETH: 'ETH_ECOSYSTEM', WETH: 'ETH_ECOSYSTEM', RETH: 'ETH_ECOSYSTEM',
  // Layer 1
  SOL: 'LAYER1', AVAX: 'LAYER1', ADA: 'LAYER1', DOT: 'LAYER1',
  NEAR: 'LAYER1', APT: 'LAYER1', SUI: 'LAYER1', SEI: 'LAYER1',
  // AI tokens
  FET: 'AI', AGIX: 'AI', OCEAN: 'AI', RNDR: 'AI', WLD: 'AI', TAO: 'AI',
  // DeFi
  UNI: 'DEFI', AAVE: 'DEFI', CRV: 'DEFI', MKR: 'DEFI',
  SNX: 'DEFI', COMP: 'DEFI', BAL: 'DEFI', LDO: 'DEFI',
  // Equities (broad market)
  SPY: 'EQUITIES', QQQ: 'EQUITIES', IWM: 'EQUITIES',
  NIFTY50: 'EQUITIES', BANKNIFTY: 'EQUITIES', SENSEX: 'EQUITIES',
  // Forex
  EURUSD: 'FOREX', GBPUSD: 'FOREX', USDJPY: 'FOREX',
  AUDUSD: 'FOREX', USDCAD: 'FOREX', USDCHF: 'FOREX',
  // Commodities
  GOLD: 'COMMODITIES', SILVER: 'COMMODITIES', OIL: 'COMMODITIES',
  XAUUSD: 'COMMODITIES', XAGUSD: 'COMMODITIES',
};

const INTRA_GROUP_CORR = 0.75;  // same-group assumed correlation
const CROSS_GROUP_CORR = 0.20;  // different-group base correlation

function correlationOf(symA: string, symB: string): number {
  const gA = CORRELATION_GROUPS[symA.toUpperCase()] ?? symA;
  const gB = CORRELATION_GROUPS[symB.toUpperCase()] ?? symB;
  if (symA === symB) return 1.0;
  return gA === gB ? INTRA_GROUP_CORR : CROSS_GROUP_CORR;
}

// ── Configuration ─────────────────────────────────────────────────────────────
export type PortfolioRiskConfig = {
  maxPortfolioRiskPct:  number;   // sum of all open position risks / account (default 6%)
  kellyFractionCap:     number;   // maximum Kelly fraction applied (default 0.25 = 25%)
  kellyBlend:           number;   // weight of Kelly vs base risk (0 = pure base, 1 = pure Kelly) default 0.5
  minConfidenceToOpen:  number;   // confidence score below which trade is BLOCKED (default 30)
  reduceSizeThreshold:  number;   // confidence below this → REDUCE_SIZE (default 55)
  regimeSizeMultipliers:Record<string, number>; // regime label → position size multiplier
  atrVolatilityScaling: boolean;  // scale down in high-ATR environments (default true)
  atrBaselinePct:       number;   // "normal" ATR as % of price (default 0.015 = 1.5%)
  corrAdjustmentFactor: number;   // how much corr exposure inflates risk score (default 0.5)
};

export const DEFAULT_PORTFOLIO_RISK_CONFIG: PortfolioRiskConfig = {
  maxPortfolioRiskPct:   6,
  kellyFractionCap:      0.25,
  kellyBlend:            0.5,
  minConfidenceToOpen:   30,
  reduceSizeThreshold:   55,
  regimeSizeMultipliers: {
    STRONG_BULL_TREND:  1.10,
    BULL_TREND:         1.05,
    WEAK_BULL_TREND:    0.95,
    SIDEWAYS:           0.80,
    MEAN_REVERSION:     0.80,
    WEAK_BEAR_TREND:    0.85,
    BEAR_TREND:         0.70,
    STRONG_BEAR_TREND:  0.60,
    BREAKOUT:           0.90,
    HIGH_VOLATILITY:    0.70,
    LOW_VOLATILITY:     1.00,
    UNKNOWN:            0.90,
  },
  atrVolatilityScaling:  true,
  atrBaselinePct:        0.015,
  corrAdjustmentFactor:  0.5,
};

// ── Inputs for the risk engine ─────────────────────────────────────────────────
export type PortfolioRiskInput = {
  symbol:          string;
  direction:       'LONG' | 'SHORT';
  assetClass:      string;
  entryPrice:      number;
  stopLoss:        number;
  takeProfit:      number;
  // From MLPrediction — already computed by the caller
  confidence:      number;    // 0–100
  ensembleProb:    number;    // 0–1
  regimeLabel:     string;
  mtfOverall:      number;    // -1 to +1
  atr:             number;    // current ATR (absolute price)
  // Historical performance (used for Kelly) — from aiPerformanceTracking
  winRatePct:      number;    // e.g. 55
  avgWinPct:       number;    // avg % gain on winners
  avgLossPct:      number;    // avg % loss on losers (positive number)
  // Account
  accountSize:     number;
  baseRiskPct:     number;    // from RiskSettings.riskPerTradePct
  // Costs (passed in from engine constants — not re-declared)
  feePct:          number;    // e.g. 0.1
  slippagePct:     number;    // e.g. 0.05
  // Optional: loaded candle histories for dynamic correlation.
  // If provided, replaces static group correlation with Pearson r.
  // If absent or insufficient, falls back to CORRELATION_GROUPS.
  candleSeries?: { symbol: string; candles: Candle[] }[];
  correlationWindow?: number;  // rolling window in bars (default 90)
};

// ── Outputs ───────────────────────────────────────────────────────────────────
export type PortfolioRiskDecision = 'ALLOW' | 'REDUCE_SIZE' | 'BLOCK';

export type PortfolioRiskResult = {
  decision:              PortfolioRiskDecision;
  reason:                string;
  // Dynamic sizing
  recommendedRiskPct:    number;   // final risk % after all adjustments
  recommendedPositionSize: number; // qty × entryPrice (notional)
  riskCapital:           number;   // $ amount at risk (= accountSize × recommendedRiskPct/100)
  effectiveLeverage:     number;   // recommendedPositionSize / accountSize
  // Adjustments applied (for transparency)
  kellyFraction:         number;   // raw Kelly output (capped)
  confidenceMultiplier:  number;   // 0–1 applied to base risk
  regimeMultiplier:      number;   // from regimeSizeMultipliers
  atrMultiplier:         number;   // 1.0 in normal vol; < 1 in high vol
  correlationAdjustment: number;   // effective portfolio risk increase from correlation
  // Portfolio risk score
  portfolioRiskScore:    number;   // 0–100
  riskComponents: {
    exposureScore:     number;   // 0–100
    concentrationScore:number;   // 0–100
    confidenceScore:   number;   // 0–100 (inverted: low conf = high score)
    volatilityScore:   number;   // 0–100
    correlationScore:  number;   // 0–100
    drawdownScore:     number;   // 0–100
  };
};

// ── Core engine — O(P) where P = open positions ───────────────────────────────
export function evaluatePortfolioRisk(
  portfolio:   PaperPortfolioState,
  input:       PortfolioRiskInput,
  portfolioValue: number,
  cfg:         PortfolioRiskConfig = DEFAULT_PORTFOLIO_RISK_CONFIG,
): PortfolioRiskResult {
  const P = portfolio.openPositions;
  const n = P.length;

  // Fix 4: zero/negative capital must hard-block before any sizing math.
  // Division-by-zero and negative leverage would produce nonsensical results.
  if (portfolioValue <= 0 || !Number.isFinite(portfolioValue)) {
    return block(
      `Account value is ${portfolioValue <= 0 ? 'zero or negative' : 'invalid'} ` +
      `(${portfolioValue}). No positions can be opened until capital is added.`,
      input, portfolioValue, cfg, 0,
    );
  }

  // ── 1. Confidence multiplier ───────────────────────────────────────────────
  // Linear ramp: 0 at confidence=0, 1 at confidence=100.
  // Below minConfidenceToOpen: block. Below reduceSizeThreshold: reduce.
  if (input.confidence < cfg.minConfidenceToOpen) {
    return block(`Confidence ${input.confidence.toFixed(0)}/100 is below minimum threshold ${cfg.minConfidenceToOpen}. Model has insufficient conviction.`, input, portfolioValue, cfg, 0);
  }
  const confidenceMultiplier = Math.min(1, input.confidence / 100);

  // ── 2. Kelly fraction ──────────────────────────────────────────────────────
  // calcKelly is already in riskManager.ts — reused directly.
  // kellyBlend: 0.5 = half Kelly (institutional standard for live trading).
  const rawKelly = calcKelly(input.winRatePct, input.avgWinPct, input.avgLossPct);
  const kellyFraction = Math.min(rawKelly, cfg.kellyFractionCap * 100); // in %
  const kellyRiskPct  = input.baseRiskPct * (1 - cfg.kellyBlend) + (kellyFraction * cfg.kellyBlend / 100 * input.baseRiskPct * 10);
  // Kelly blends toward the base: if Kelly says 0%, we halve the base risk.
  // If Kelly says 25%, we add 50% of the gap. Capped at baseRisk × 1.5.
  const kellyAdjustedRisk = Math.min(
    Math.max(input.baseRiskPct * 0.25, kellyRiskPct),
    input.baseRiskPct * 1.5,
  );

  // ── 3. Regime multiplier ───────────────────────────────────────────────────
  const regimeMultiplier = cfg.regimeSizeMultipliers[input.regimeLabel] ?? 0.9;

  // ── 4. ATR volatility scaling ──────────────────────────────────────────────
  // Compare current ATR to the baseline ATR (expected "normal" volatility).
  // High ATR → scale down to keep dollar risk constant; low ATR → no change.
  let atrMultiplier = 1.0;
  if (cfg.atrVolatilityScaling && input.entryPrice > 0) {
    const currentAtrPct = input.atr / input.entryPrice;
    if (currentAtrPct > cfg.atrBaselinePct) {
      atrMultiplier = Math.max(0.5, cfg.atrBaselinePct / currentAtrPct);
    }
  }

  // ── 5. Correlation-aware portfolio risk — O(P) ─────────────────────────────
  // Effective portfolio risk = Σ_i Σ_j √(risk_i × risk_j × corr_ij)
  // This is the standard two-asset corr formula extended to N assets.
  // For each open position, compute its individual risk (stopDistance × qty).
  // Then compute the cross-position correlation adjustment for the new trade.
  //
  // We avoid a full N×N matrix: we only need the sum of cross-terms
  // involving the NEW position (all existing × new). This is O(P), not O(P²).
  const newPositionRisk = input.accountSize * (input.baseRiskPct / 100);

  let correlationAdjustment = 0;  // additional effective risk from correlation
  let totalExistingRisk = 0;

  const candleMap = new Map<string, Candle[]>();
  if (input.candleSeries) {
    input.candleSeries.forEach(({ symbol, candles }) => candleMap.set(symbol, candles));
  }
  const window = input.correlationWindow ?? 90;

  for (const pos of P) {
    const posRisk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.qty;
    // Diagnostic: warn if stopLoss is 0 or implausibly far — this would inflate
    // posRisk to full position value, distorting the correlation adjustment.
    if (pos.stopLoss === 0 || Math.abs(pos.entryPrice - pos.stopLoss) >= pos.entryPrice * 0.5) {
      logger.warn('portfolioRiskEngine',
        `Position ${pos.symbol} has stopLoss=${pos.stopLoss} vs entry=${pos.entryPrice}. ` +
        `posRisk=${posRisk.toFixed(2)} — verify stop loss was set correctly at open.`);
    }
    totalExistingRisk += posRisk;

    // Dynamic correlation: use Pearson r from loaded candle history when available.
    // Falls back to static group model if insufficient shared history exists.
    const newCandles = candleMap.get(input.symbol);
    const posCandles = candleMap.get(pos.symbol);
    let corr: number;
    if (newCandles && posCandles && newCandles.length >= 30 && posCandles.length >= 30) {
      const dynamic = getDynamicCorrelation(input.symbol, newCandles, pos.symbol, posCandles, window);
      corr = dynamic !== null ? dynamic : correlationOf(input.symbol, pos.symbol);
    } else {
      corr = correlationOf(input.symbol, pos.symbol);  // static fallback
    }

    correlationAdjustment += 2 * corr * Math.sqrt(newPositionRisk * posRisk);
  }

  const corrContributionDollars = correlationAdjustment * cfg.corrAdjustmentFactor;
  const effectiveNewPortfolioRisk = totalExistingRisk + newPositionRisk + corrContributionDollars;
  const portfolioRiskPct = portfolioValue > 0 ? (effectiveNewPortfolioRisk / portfolioValue) * 100 : 0;
  // Audit log — traces every intermediate value for debugging
  logger.info('portfolioRiskEngine', JSON.stringify({
    baseRisk: newPositionRisk.toFixed(2),
    totalExistingRisk: totalExistingRisk.toFixed(2),
    correlationAdjustmentRaw: correlationAdjustment.toFixed(2),
    corrContributionDollars: corrContributionDollars.toFixed(2),
    corrContributionPct: portfolioValue > 0 ? (corrContributionDollars / portfolioValue * 100).toFixed(2) + '%' : 'n/a',
    effectiveRisk: effectiveNewPortfolioRisk.toFixed(2),
    portfolioRiskPct: portfolioRiskPct.toFixed(2) + '%',
    maxAllowedRisk: cfg.maxPortfolioRiskPct + '%',
    portfolioValue: portfolioValue.toFixed(2),
  }));

  if (portfolioRiskPct > cfg.maxPortfolioRiskPct) {
    const excess = portfolioRiskPct - cfg.maxPortfolioRiskPct;
    return block(
      `Portfolio risk would reach ${portfolioRiskPct.toFixed(1)}%, exceeding limit of ${cfg.maxPortfolioRiskPct}% (excess: ${excess.toFixed(1)}%). ` +
      `Correlation with existing positions adds ${portfolioValue > 0 ? ((correlationAdjustment * cfg.corrAdjustmentFactor / portfolioValue) * 100).toFixed(1) : '0'}% of portfolio in effective risk.`,
      input, portfolioValue, cfg, correlationAdjustment,
    );
  }

  // ── 6. Composite adjusted risk % ──────────────────────────────────────────
  let adjustedRiskPct = kellyAdjustedRisk * confidenceMultiplier * regimeMultiplier * atrMultiplier;

  // Fee + slippage cost adjustment: the round-trip transaction cost reduces
  // the net profit of a winning trade. We subtract the expected round-trip
  // cost from the risk budget so the net risk budget is accurate.
  const roundTripCostPct = (input.feePct + input.slippagePct) * 2 / 100;
  adjustedRiskPct = Math.max(0, adjustedRiskPct - roundTripCostPct * 100);

  // ── 7. Dollar sizing ───────────────────────────────────────────────────────
  const riskCapital = input.accountSize * (adjustedRiskPct / 100);
  const stopDistance = Math.abs(input.entryPrice - input.stopLoss);
  const recommendedQty = stopDistance > 0 ? riskCapital / stopDistance : 0;
  const recommendedPositionSize = recommendedQty * input.entryPrice;
  const effectiveLeverage = portfolioValue > 0 ? recommendedPositionSize / portfolioValue : 0;

  // ── 8. Portfolio risk score — 0–100 ───────────────────────────────────────
  const exposurePct     = portfolioValue > 0 ? (P.reduce((s, p) => s + p.entryPrice * p.qty, 0) / portfolioValue) * 100 : 0;
  const exposureScore   = Math.min(100, exposurePct / 0.8);  // 80% exposure = score 100

  const maxSymbolNotional = P.length > 0
    ? Math.max(...P.map(p => p.entryPrice * p.qty))
    : recommendedPositionSize;
  const concentrationScore = portfolioValue > 0 ? Math.min(100, (maxSymbolNotional / portfolioValue) * 200) : 0;

  const invConfidence   = Math.max(0, 100 - input.confidence);
  const confidenceScore = invConfidence;

  const atrPct          = input.entryPrice > 0 ? (input.atr / input.entryPrice) * 100 : 1.5;
  const volatilityScore = Math.min(100, (atrPct / (cfg.atrBaselinePct * 100)) * 50);

  const corrScore       = Math.min(100, (correlationAdjustment / (newPositionRisk || 1)) * 50);

  // Drawdown proxy: use maxUnrealizedDrawdown from open positions
  const totalDrawdown   = P.reduce((s, p) => s + Math.min(0, p.maxUnrealizedDrawdown), 0);
  const drawdownScore   = portfolioValue > 0 ? Math.min(100, Math.abs(totalDrawdown) / portfolioValue * 500) : 0;

  const portfolioRiskScore = Math.round(
    exposureScore   * 0.25 +
    concentrationScore * 0.20 +
    confidenceScore * 0.20 +
    volatilityScore * 0.15 +
    corrScore       * 0.10 +
    drawdownScore   * 0.10
  );

  const riskComponents = {
    exposureScore: Math.round(exposureScore),
    concentrationScore: Math.round(concentrationScore),
    confidenceScore: Math.round(confidenceScore),
    volatilityScore: Math.round(volatilityScore),
    correlationScore: Math.round(corrScore),
    drawdownScore: Math.round(drawdownScore),
  };

  // ── 9. Decision ────────────────────────────────────────────────────────────
  const decision: PortfolioRiskDecision = input.confidence < cfg.reduceSizeThreshold
    ? 'REDUCE_SIZE'
    : 'ALLOW';

  const reason = decision === 'REDUCE_SIZE'
    ? `Confidence ${input.confidence.toFixed(0)}/100 is below ${cfg.reduceSizeThreshold} — position size reduced to ${adjustedRiskPct.toFixed(2)}% risk. ` +
      `Kelly: ${kellyFraction.toFixed(1)}%, regime: ×${regimeMultiplier.toFixed(2)}, ATR: ×${atrMultiplier.toFixed(2)}.`
    : `Trade approved. Risk: ${adjustedRiskPct.toFixed(2)}% (base ${input.baseRiskPct}%). ` +
      `Kelly: ${kellyFraction.toFixed(1)}%, regime: ×${regimeMultiplier.toFixed(2)}, portfolio risk score: ${portfolioRiskScore}/100.`;

  return {
    decision, reason,
    recommendedRiskPct:    adjustedRiskPct,
    recommendedPositionSize,
    riskCapital,
    effectiveLeverage,
    kellyFraction,
    confidenceMultiplier,
    regimeMultiplier,
    atrMultiplier,
    correlationAdjustment,
    portfolioRiskScore,
    riskComponents,
  };
}

// ── Helper: build a BLOCK result ───────────────────────────────────────────────
function block(
  reason: string, input: PortfolioRiskInput,
  portfolioValue: number, cfg: PortfolioRiskConfig,
  corrAdj: number,
): PortfolioRiskResult {
  return {
    decision: 'BLOCK', reason,
    recommendedRiskPct: 0, recommendedPositionSize: 0,
    riskCapital: 0, effectiveLeverage: 0,
    kellyFraction: 0, confidenceMultiplier: 0,
    regimeMultiplier: 0, atrMultiplier: 0,
    correlationAdjustment: corrAdj,
    portfolioRiskScore: 100,
    riskComponents: { exposureScore: 100, concentrationScore: 0, confidenceScore: 100, volatilityScore: 0, correlationScore: 0, drawdownScore: 0 },
  };
}
