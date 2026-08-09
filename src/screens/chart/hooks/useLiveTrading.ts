// ─────────────────────────────────────────────────────────────────────────────
// useLiveTrading  (v1.0.2)
//
// Hook that manages the live trading mode toggle and provides the live trade
// handler. Reads LiveTradeSettings to know whether MANUAL or AUTO mode is
// active. Connects PredictionCard button presses to either:
//   MANUAL → navigate to OrderConfirmationScreen (user must tap confirm)
//   AUTO   → placeLiveOrder directly (no second confirmation)
//
// Design constraints:
//   • Zero effect on paper trading path — returns null when live mode is off
//   • Never imports ML or signal logic
//   • Session validation before any navigation/order attempt
//   • isLiveMode persists per execution provider so switching to LIVE on
//     Angel One never affects Binance, and vice versa. Every provider
//     independently defaults to PAPER. Keys use provider display names
//     (angelone, binance) not internal abbreviations (ao) so they remain
//     stable and readable as more providers are added (zerodha, upstox,
//     bybit, okx, etc.).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert } from 'react-native';
import { getLiveTradeSettings, LiveTradeSettings } from '../../LiveTradeSettingsScreen';
import { getLiveTradingCredential } from '../../../utils/secureCredentials';
import type { MLPrediction } from '../../../utils/mlSignal';
import type { Asset } from '../../../api/assets';
import type { AOSession } from '../../../api/angelOne';

// Maps internal asset.src abbreviations to stable provider IDs used in storage.
// Add new providers here — storage keys never change for existing providers.
// Sources that have no live execution capability map to 'paper' (always PAPER).
const PROVIDER_ID: Record<string, string> = {
  ao:               'angelone',           // Angel One NSE/BSE equity
  ao_futures:       'angelone_futures',   // Angel One NFO futures
  binance:          'binance',            // Binance spot
  binance_futures:  'binance_futures',    // Binance USDM perpetual futures
  av:               'paper',             // Alpha Vantage — data only
  forex:            'paper',             // Forex data — no live execution yet
};

// Storage key per provider — v3 prefix because:
//   v1 was a single global key (all sources shared it — the original bug)
//   v2 was keyed by asset.src abbreviation (ao, binance) — transitional
//   v3 is keyed by stable provider name (angelone, binance) — canonical
// Changing from v2 to v3 intentionally resets any persisted mode, which is
// safe — users re-opt into LIVE explicitly per provider.
function modeKey(src: string): string {
  const provider = PROVIDER_ID[src] ?? `unknown_${src}`;
  return `quantis_execution_mode_v3_${provider}`;
}

export type TradingMode = 'PAPER' | 'LIVE';

export type LiveTradeRequest = {
  prediction:     MLPrediction;
  bypassGates:    boolean;
  mtfState:       'READY' | 'WAIT' | 'AVOID' | null;
  signalSnapshot: any;
  marketContext?: any;
};

export function useLiveTrading(
  asset: Asset | undefined,
  aoSession: AOSession | null,
  navigation: any,
) {
  const [tradingMode, setTradingModeState] = useState<TradingMode>('PAPER');
  const [liveSettings,  setLiveSettings]  = useState<LiveTradeSettings | null>(null);
  const [bnConfigured,  setBnConfigured]  = useState(false);
  const [cdxConfigured, setCdxConfigured] = useState(false);

  // Load persisted mode for this provider whenever asset source changes.
  // Sources mapped to 'paper' always read PAPER (no stored value matters).
  // Any unknown source also defaults to PAPER — safe default.
  useEffect(() => {
    const src = asset?.src ?? '';
    const provider = PROVIDER_ID[src] ?? '';

    if (provider === 'paper' || !provider) {
      setTradingModeState('PAPER');
      return;
    }

    AsyncStorage.getItem(modeKey(src))
      .then(v => setTradingModeState(v === 'LIVE' ? 'LIVE' : 'PAPER'))
      .catch(() => setTradingModeState('PAPER'));
  }, [asset?.src]);  // re-runs on every source change (AO → Binance, etc.)

  // Broker settings — refresh on mount.
  useEffect(() => {
    getLiveTradeSettings().then(setLiveSettings).catch(() => {});
    getLiveTradingCredential('binanceApiKey').then(k => setBnConfigured(!!k)).catch(() => {});
    getLiveTradingCredential('cdxApiKey').then(k => setCdxConfigured(!!k)).catch(() => {});
  }, []);

  // Persist mode change under this provider's key only.
  // Sources mapped to 'paper' cannot be set to LIVE — guard here.
  const setTradingMode = useCallback((mode: TradingMode) => {
    const src = asset?.src ?? '';
    const provider = PROVIDER_ID[src] ?? '';

    if (provider === 'paper' || !provider) {
      // This source has no live execution — silently stay on PAPER.
      setTradingModeState('PAPER');
      return;
    }

    setTradingModeState(mode);
    AsyncStorage.setItem(modeKey(src), mode).catch(() => {});
  }, [asset?.src]);

  // ── Validation before any live trade ──────────────────────────────────────
  const validateLiveReady = useCallback((): string | null => {
    if (!asset) return 'No asset selected.';

    if (asset.src === 'ao') {
      if (!aoSession?.jwtToken) {
        return 'Angel One not connected. Go to Settings → Angel One to connect.';
      }
      if (asset.type === 'INDEX') {
        return 'Indices cannot be traded directly. Trade Nifty futures instead.';
      }
    }

    if (asset.src === 'ao_futures') {
      if (!aoSession?.jwtToken) {
        return 'Angel One not connected. Go to Settings → Angel One to connect.';
      }
      // F&O requires explicit segment activation on the AO account
      // We can't check this programmatically — surface a clear message if order fails
    }

    if (asset.src === 'binance') {
      if (!bnConfigured) {
        return 'Binance API keys not configured. Go to More → Broker Connection.';
      }
    }

    if (asset.src === 'binance_futures') {
      if (!bnConfigured) {
        return 'Binance Futures API keys not configured. Go to More → Broker Connection.\n\nNote: Futures trading requires "Futures" permission on your Binance API key.';
      }
    }

    if (asset.src === 'coindcx' || asset.src === 'coindcx_futures') {
      if (!cdxConfigured) {
        return 'CoinDCX API keys not configured. Go to More → Broker Connection.';
      }
    }

    if (!['ao', 'ao_futures', 'binance', 'binance_futures', 'coindcx', 'coindcx_futures'].includes(asset.src)) {
      return `Live trading is not supported for ${asset.src} assets yet.`;
    }

    return null;
  }, [asset, aoSession, bnConfigured, cdxConfigured]);

  // ── Build the LiveOrderRequest from prediction ────────────────────────────
  const buildRequest = useCallback(async (req: LiveTradeRequest) => {
    if (!asset) return null;
    const { prediction } = req;
    const direction: 'LONG' | 'SHORT' = prediction.action === 'BUY' ? 'LONG' : 'SHORT';
    const orderType = liveSettings?.defaultOrderType ?? 'LIMIT';
    const limitPrice = prediction.suggestedEntry;

    if (asset.src === 'ao_futures') {
      const underlying = (asset as any).underlying as import('../../../utils/futures/futuresTypes').FuturesUnderlying;
      const { getActiveContract }    = await import('../../../utils/futures/futuresContracts');
      const { computeFuturesLots }   = await import('../../../utils/futures/futuresRiskEngine');
      const { aoGetRMS }             = await import('../../../api/angelOne');

      // getActiveContract: always recomputes from today, validates token,
      // busts cache and retries on rollover day. Throws if token unresolvable.
      const contract = await getActiveContract(underlying);

      // Fetch available margin from AO RMS for sizing
      let availableMargin = 0;
      if (aoSession?.jwtToken) {
        const rms = await aoGetRMS(aoSession);
        if (rms) {
          availableMargin = rms.availablecash + rms.collateral;
        }
      }

      const sizing = await computeFuturesLots({
        underlying,
        currentPrice: prediction.suggestedEntry,
        stopLoss:     prediction.suggestedStopLoss,
        availableMargin});

      if (!sizing.ok) {
        // Reject before navigation — show error to user in handleLiveTrade
        throw new Error(sizing.reason);
      }

      return {
        assetSrc:     'ao_futures' as const,
        symbol:       contract.symbol,
        symbolToken:  contract.aoToken,
        exchange:     'NFO' as const,
        direction,
        qty:          sizing.qty,
        lots:         sizing.lots,
        lotSize:      sizing.lotSize,
        underlying,
        expiry:       contract.expiry,
        expiryLabel:  contract.expiryLabel,
        orderType,
        limitPrice,
        stopLoss:     prediction.suggestedStopLoss,
        takeProfit:   prediction.suggestedTakeProfit};
    }

    if (asset.src === 'binance_futures') {
      const { BN_CONTRACT_SPECS, riskBasedQty, maxQtyFromBudget, clampLeverage }
        = await import('../../../utils/futures/binance/bnFuturesTypes');
      const { bnFuturesGetBalance } = await import('../../../api/binanceFuturesApi');
      const { getRiskSettings }     = await import('../../../utils/riskManager');

      const bnSym    = (asset as any).bnSym ?? asset.symbol;
      const spec     = BN_CONTRACT_SPECS[bnSym as keyof typeof BN_CONTRACT_SPECS];
      const leverage = (settings.defaultFuturesLeverage ?? 10);
      const clampedLev = spec ? clampLeverage(leverage, bnSym) : leverage;

      const settings = await getRiskSettings();
      let availableBalance = 0;
      if (bnConfigured) {
        const binKey    = await getLiveTradingCredential('binanceApiKey');
        const binSecret = await getLiveTradingCredential('binanceApiSecret');
        if (binKey && binSecret) {
          const balance = await bnFuturesGetBalance(binKey, binSecret);
          availableBalance = balance?.availableBalance ?? 0;
        }
      }

      // Sizing: risk-based qty limited by affordable margin
      let qty = 0;
      if (spec && availableBalance > 0) {
        const riskBased   = riskBasedQty(limitPrice, prediction.suggestedStopLoss,
          availableBalance, settings.riskPerTradePct, spec);
        const affordable  = maxQtyFromBudget(availableBalance * 0.80, limitPrice, clampedLev, spec);
        qty = Math.max(spec.minQty, Math.min(riskBased > 0 ? riskBased : affordable, affordable));
        // Round to qty step
        qty = Math.floor(qty / spec.qtyStep) * spec.qtyStep;
      }

      if (qty <= 0) {
        throw new Error(
          `Insufficient USDT balance or unsupported symbol for Binance Futures sizing.\n\n` +
          `Available: $${availableBalance.toFixed(2)}\n` +
          `Add USDT to your Binance Futures wallet and try again.`
        );
      }

      return {
        assetSrc:    'binance_futures' as const,
        symbol:      bnSym,
        direction,
        qty,
        leverage:    clampedLev,
        orderType,
        limitPrice,
        stopLoss:    prediction.suggestedStopLoss,
        takeProfit:  prediction.suggestedTakeProfit};
    }

    // CoinDCX spot and futures
    if (asset.src === 'coindcx' || asset.src === 'coindcx_futures') {
      const { getLiveTradingCredential: getCred } = await import('../../../utils/secureCredentials');
      const cdxKey    = await getCred('cdxApiKey');
      const cdxSecret = await getCred('cdxApiSecret');

      let availableBalance = 0;
      if (cdxKey && cdxSecret) {
        try {
          if (asset.src === 'coindcx_futures') {
            const { fetchCdxFuturesWallet } = await import('../../../utils/execution/CoinDCXFuturesExecutor');
            const wallet = await fetchCdxFuturesWallet(cdxKey, cdxSecret);
            availableBalance = wallet.available;
          } else {
            const { fetchCdxBalances } = await import('../../../utils/execution/CoinDCXExecutor');
            const balances = await fetchCdxBalances(cdxKey, cdxSecret);
            availableBalance = balances['USDT']?.available ?? 0;
          }
        } catch { /* use 0 — order screen will show error */ }
      }

      const isFutures = asset.src === 'coindcx_futures';
      const leverage  = isFutures ? (liveSettings?.defaultFuturesLeverage ?? 10) : 1;
      const stopDist  = Math.abs(limitPrice - (prediction.suggestedStopLoss ?? limitPrice * 0.98));
      const riskUsdt  = Math.max(availableBalance * 0.01, 1);
      let qty         = stopDist > 0 ? (riskUsdt / stopDist) * leverage : 0.001;
      qty             = Math.max(0.001, parseFloat(qty.toFixed(3)));

      return {
        assetSrc:    asset.src as 'coindcx' | 'coindcx_futures',
        symbol:      asset.symbol,
        direction,
        qty,
        leverage:    isFutures ? leverage : undefined,
        orderType,
        limitPrice,
        stopLoss:    prediction.suggestedStopLoss,
        takeProfit:  prediction.suggestedTakeProfit,
      };
    }

        return {
      assetSrc:     asset.src as 'ao' | 'binance',
      symbol:       asset.symbol,
      symbolToken:  (asset as any).aoToken,
      exchange:     (asset as any).aoEx,
      direction,
      qty:          1,
      orderType,
      limitPrice,
      stopLoss:     prediction.suggestedStopLoss,
      takeProfit:   prediction.suggestedTakeProfit};
  }, [asset, liveSettings, aoSession, bnConfigured]);

  // ── Live trade handler — called from PredictionCard ───────────────────────
  const handleLiveTrade = useCallback(async (req: LiveTradeRequest) => {
    const validationError = validateLiveReady();
    if (validationError) {
      Alert.alert('Live Trading', validationError);
      return;
    }

    try {
      const liveReq = await buildRequest(req);
      if (!liveReq) return;

      navigation.navigate('OrderConfirmation', {
        request:        liveReq,
        prediction:     req.prediction,
        signalSnapshot: req.signalSnapshot,
        marketContext:  req.marketContext});
    } catch (err: any) {
      // buildRequest throws for token resolution failures and margin rejections.
      // Surface the message directly — it's already user-readable.
      Alert.alert('Cannot Place Order', err.message ?? 'Failed to prepare the order. Please try again.');
    }
  }, [validateLiveReady, buildRequest, navigation]);

  const isLiveMode = tradingMode === 'LIVE';

  return {
    tradingMode,
    setTradingMode,
    isLiveMode,
    liveSettings,
    handleLiveTrade,
    validateLiveReady};
}
