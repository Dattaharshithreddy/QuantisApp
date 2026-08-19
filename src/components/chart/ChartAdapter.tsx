// ─────────────────────────────────────────────────────────────────────────────
// CHART ADAPTER  (v6.4.0)
//
// Single switch between chart rendering providers. Everything above this file
// (screens, hooks, PredictionCard, overlays, markers, trade levels) is
// provider-agnostic and passes identical props either way.
//
//   'tradingview' → TradingView Lightweight Charts in a WebView (new default).
//                   No RNGH, no react-native-svg — sidesteps the Android
//                   native touch crash entirely.
//   'custom'      → the legacy SVG/RNGH chart, byte-for-byte untouched.
//
// ROLLBACK PLAN: change CHART_PROVIDER to 'custom'. One line. No other file
// needs to change, because both providers implement the same Props surface.
// ─────────────────────────────────────────────────────────────────────────────
import LegacyChart, { OverlayToggles as LegacyOverlayToggles } from '../CandlestickChart';
import TradingViewChart from './TradingViewChart';

export const CHART_PROVIDER: 'tradingview' | 'custom' = 'tradingview';

export type OverlayToggles = LegacyOverlayToggles;

const CandlestickChart = CHART_PROVIDER === 'tradingview' ? TradingViewChart : LegacyChart;
export default CandlestickChart;
