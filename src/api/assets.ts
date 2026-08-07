// ─────────────────────────────────────────────────────────────────────────────
// ASSETS — Production Architecture  (v2.0.0)
//
// One LogicalAsset per instrument (Bitcoin, Nifty 50, EUR/USD…).
// Each LogicalAsset carries an `exchanges` map of ExchangeVariant objects —
// one per data source that can serve this instrument.
//
// KEY DESIGN DECISIONS:
//
// 1. variant.symbol is the INTERNAL namespace key used by every downstream
//    system: ML storage, candle cache, price feed, prediction history.
//    It is identical to the old Asset.symbol, so all existing stored data
//    (trained models, candle cache, prediction metadata) remains valid.
//    No migration needed.
//
// 2. assetId ('BTC', 'NIFTY50') is the UI-facing key. It is stable,
//    exchange-agnostic, and used for: navigation params, watchlist entries,
//    exchange preference storage, and Markets screen deduplication.
//
// 3. The ML pipeline never sees assetId or exchange. It receives
//    variant.symbol ('BTCUSD' for Binance, 'BTCUSDT' for CoinDCX) exactly
//    as before. Zero ML changes.
//
// 4. Adding a new exchange (Bybit, OKX, Kraken) = add one ExchangeVariant
//    to the relevant LogicalAsset. Nothing else changes.
// ─────────────────────────────────────────────────────────────────────────────

export type AssetType = 'INDEX' | 'STOCK' | 'FOREX' | 'CRYPTO' | 'COMMODITY';

// ── Per-exchange variant ──────────────────────────────────────────────────────
// Each variant describes how to fetch data for this asset from ONE exchange.
export type ExchangeVariant = {
  src:    string;   // 'binance' | 'coindcx' | 'ao' | 'ao_futures' | 'av' | 'forex'
  symbol: string;   // INTERNAL symbol — used as ML key, cache key, price key
                    // e.g. 'BTCUSD' (Binance), 'BTCUSDT' (CoinDCX), 'NIFTY50' (AO)
  base:   number;   // seed price for initial render before live price arrives
  vol:    number;   // daily volatility estimate (used by ML feature scaling)

  // Binance spot / futures
  bnSym?:     string;   // e.g. 'BTCUSDT'
  // CoinDCX spot
  cdxSym?:    string;   // pair string for candle API: 'B-BTC_USDT'
  cdxMkt?:    string;   // market name for orders+ticker: 'BTCUSDT'
  // Angel One equity / futures
  aoToken?:   string;   // instrument token, e.g. '99926000'
  aoEx?:      string;   // exchange segment: 'NSE', 'NFO'
  // Alpha Vantage (US stocks)
  avSym?:     string;   // e.g. 'AAPL'
  // Forex
  fxKey?:     string;   // currency code, e.g. 'EUR'
  fxInv?:     boolean;  // true = base/quote inverted (e.g. USDJPY)
  // Futures-specific
  lotSize?:   number;
  underlying?: string;
};

// ── One logical instrument ────────────────────────────────────────────────────
export type LogicalAsset = {
  id:              string;                      // stable: 'BTC', 'NIFTY50', 'EURUSD'
  name:            string;                      // display: 'Bitcoin', 'Nifty 50'
  type:            AssetType;
  defaultExchange: string;                      // which exchange to open by default
  exchanges:       Record<string, ExchangeVariant>; // keyed by src string
  custom?:         boolean;                     // true if added via Symbol Search
};

// ── Type colours (unchanged) ──────────────────────────────────────────────────
export const TYPE_COLORS: Record<string, string> = {
  INDEX: '#2962ff', STOCK: '#089981', FOREX: '#ff9800',
  CRYPTO: '#9c27b0', COMMODITY: '#795548',
};

// ─────────────────────────────────────────────────────────────────────────────
// ASSETS — built-in instrument list
// ─────────────────────────────────────────────────────────────────────────────
export const ASSETS: LogicalAsset[] = [

  // ── Indian Indices (Angel One) ───────────────────────────────────────────
  { id: 'NIFTY50',    name: 'Nifty 50',        type: 'INDEX',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'NIFTY50',    aoToken:'99926000', aoEx:'NSE', base:24900, vol:0.009 } } },
  { id: 'BANKNIFTY',  name: 'Bank Nifty',       type: 'INDEX',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'BANKNIFTY',  aoToken:'99926009', aoEx:'NSE', base:52800, vol:0.013 } } },
  { id: 'FINNIFTY',   name: 'Fin Nifty',        type: 'INDEX',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'FINNIFTY',   aoToken:'99926037', aoEx:'NSE', base:23400, vol:0.011 } } },

  // ── Indian Stocks (Angel One) ────────────────────────────────────────────
  { id: 'RELIANCE',   name: 'Reliance Ind.',    type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'RELIANCE',   aoToken:'2885',     aoEx:'NSE', base:2945,  vol:0.013 } } },
  { id: 'TCS',        name: 'TCS',              type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'TCS',        aoToken:'11536',    aoEx:'NSE', base:3900,  vol:0.011 } } },
  { id: 'INFY',       name: 'Infosys',          type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'INFY',       aoToken:'1594',     aoEx:'NSE', base:1450,  vol:0.014 } } },
  { id: 'HDFCBANK',   name: 'HDFC Bank',        type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'HDFCBANK',   aoToken:'1333',     aoEx:'NSE', base:1650,  vol:0.015 } } },
  { id: 'ICICIBANK',  name: 'ICICI Bank',       type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'ICICIBANK',  aoToken:'4963',     aoEx:'NSE', base:1220,  vol:0.014 } } },
  { id: 'SBIN',       name: 'State Bank India', type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'SBIN',       aoToken:'3045',     aoEx:'NSE', base:785,   vol:0.016 } } },
  { id: 'BAJFINANCE', name: 'Bajaj Finance',    type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'BAJFINANCE', aoToken:'317',      aoEx:'NSE', base:7200,  vol:0.018 } } },
  { id: 'TATAMOTORS', name: 'Tata Motors',      type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'TATAMOTORS', aoToken:'3456',     aoEx:'NSE', base:955,   vol:0.020 } } },
  { id: 'MARUTI',     name: 'Maruti Suzuki',    type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'MARUTI',     aoToken:'10999',    aoEx:'NSE', base:12400, vol:0.012 } } },
  { id: 'WIPRO',      name: 'Wipro',            type: 'STOCK',  defaultExchange: 'ao',
    exchanges: { ao: { src:'ao', symbol:'WIPRO',      aoToken:'3787',     aoEx:'NSE', base:520,   vol:0.014 } } },

  // ── US Stocks (Alpha Vantage) ────────────────────────────────────────────
  { id: 'AAPL', name: 'Apple Inc.',   type: 'STOCK', defaultExchange: 'av',
    exchanges: { av: { src:'av', symbol:'AAPL', avSym:'AAPL', base:192, vol:0.014 } } },
  { id: 'NVDA', name: 'NVIDIA Corp.', type: 'STOCK', defaultExchange: 'av',
    exchanges: { av: { src:'av', symbol:'NVDA', avSym:'NVDA', base:875, vol:0.024 } } },
  { id: 'TSLA', name: 'Tesla Inc.',   type: 'STOCK', defaultExchange: 'av',
    exchanges: { av: { src:'av', symbol:'TSLA', avSym:'TSLA', base:249, vol:0.026 } } },
  { id: 'MSFT', name: 'Microsoft',    type: 'STOCK', defaultExchange: 'av',
    exchanges: { av: { src:'av', symbol:'MSFT', avSym:'MSFT', base:415, vol:0.011 } } },

  // ── Forex ────────────────────────────────────────────────────────────────
  { id: 'EURUSD', name: 'EUR / USD', type: 'FOREX', defaultExchange: 'forex',
    exchanges: { forex: { src:'forex', symbol:'EURUSD', fxKey:'EUR', fxInv:false, base:1.0847, vol:0.003 } } },
  { id: 'GBPUSD', name: 'GBP / USD', type: 'FOREX', defaultExchange: 'forex',
    exchanges: { forex: { src:'forex', symbol:'GBPUSD', fxKey:'GBP', fxInv:false, base:1.2634, vol:0.004 } } },
  { id: 'USDJPY', name: 'USD / JPY', type: 'FOREX', defaultExchange: 'forex',
    exchanges: { forex: { src:'forex', symbol:'USDJPY', fxKey:'JPY', fxInv:true,  base:154.2,  vol:0.003 } } },
  { id: 'USDINR', name: 'USD / INR', type: 'FOREX', defaultExchange: 'forex',
    exchanges: { forex: { src:'forex', symbol:'USDINR', fxKey:'INR', fxInv:true,  base:83.4,   vol:0.002 } } },

  // ── Crypto — multi-exchange ───────────────────────────────────────────────
  // Bitcoin: Binance spot + CoinDCX spot + Binance perpetual futures
  { id: 'BTC', name: 'Bitcoin', type: 'CRYPTO', defaultExchange: 'binance',
    exchanges: {
      binance:  { src:'binance',  symbol:'BTCUSD',  bnSym:'BTCUSDT',  base:67420, vol:0.028 },
      coindcx:  { src:'coindcx',  symbol:'BTCUSDT', cdxSym:'B-BTC_USDT', cdxMkt:'BTCUSDT', base:67420, vol:0.028 },
    } },

  // Ethereum
  { id: 'ETH', name: 'Ethereum', type: 'CRYPTO', defaultExchange: 'binance',
    exchanges: {
      binance:  { src:'binance',  symbol:'ETHUSD',  bnSym:'ETHUSDT',  base:3485,  vol:0.032 },
      coindcx:  { src:'coindcx',  symbol:'ETHUSDT', cdxSym:'B-ETH_USDT', cdxMkt:'ETHUSDT', base:3485, vol:0.032 },
    } },

  // BNB
  { id: 'BNB', name: 'BNB', type: 'CRYPTO', defaultExchange: 'binance',
    exchanges: {
      binance:  { src:'binance',  symbol:'BNBUSD',  bnSym:'BNBUSDT',  base:580,   vol:0.025 },
      coindcx:  { src:'coindcx',  symbol:'BNBUSDT', cdxSym:'B-BNB_USDT', cdxMkt:'BNBUSDT', base:580, vol:0.025 },
    } },

  // Solana
  { id: 'SOL', name: 'Solana', type: 'CRYPTO', defaultExchange: 'binance',
    exchanges: {
      binance:  { src:'binance',  symbol:'SOLUSD',  bnSym:'SOLUSDT',  base:148,   vol:0.035 },
      coindcx:  { src:'coindcx',  symbol:'SOLUSDT', cdxSym:'B-SOL_USDT', cdxMkt:'SOLUSDT', base:148, vol:0.035 },
    } },

  // XRP
  { id: 'XRP', name: 'XRP', type: 'CRYPTO', defaultExchange: 'binance',
    exchanges: {
      binance:  { src:'binance',  symbol:'XRPUSD',  bnSym:'XRPUSDT',  base:0.52,  vol:0.040 },
      coindcx:  { src:'coindcx',  symbol:'XRPUSDT', cdxSym:'B-XRP_USDT', cdxMkt:'XRPUSDT', base:0.52, vol:0.040 },
    } },

  // DOGE (Binance futures only — not on CoinDCX USDT pair list)
  { id: 'DOGE', name: 'Dogecoin', type: 'CRYPTO', defaultExchange: 'binance_futures',
    exchanges: {
      binance_futures:  { src:'binance_futures',  symbol:'DOGE-PERP', bnSym:'DOGEUSDT', base:0.078, vol:0.055 },
    } },

  // ── NSE Futures (Angel One NFO) ───────────────────────────────────────────
  // aoToken populated at runtime by futuresContracts.getContractsWithTokens()
  { id: 'NIFTY-FUT',     name: 'Nifty 50 Futures',   type: 'INDEX',  defaultExchange: 'ao_futures',
    exchanges: { ao_futures: { src:'ao_futures', symbol:'NIFTY-FUT',     underlying:'NIFTY',      lotSize:75,   aoEx:'NFO', base:24900, vol:0.009 } } },
  { id: 'BANKNIFTY-FUT', name: 'Bank Nifty Futures',  type: 'INDEX',  defaultExchange: 'ao_futures',
    exchanges: { ao_futures: { src:'ao_futures', symbol:'BANKNIFTY-FUT', underlying:'BANKNIFTY',  lotSize:30,   aoEx:'NFO', base:52800, vol:0.013 } } },
  { id: 'FINNIFTY-FUT',  name: 'Fin Nifty Futures',   type: 'INDEX',  defaultExchange: 'ao_futures',
    exchanges: { ao_futures: { src:'ao_futures', symbol:'FINNIFTY-FUT',  underlying:'FINNIFTY',   lotSize:65,   aoEx:'NFO', base:23400, vol:0.011 } } },
  { id: 'RELIANCE-FUT',  name: 'Reliance Futures',    type: 'STOCK',  defaultExchange: 'ao_futures',
    exchanges: { ao_futures: { src:'ao_futures', symbol:'RELIANCE-FUT',  underlying:'RELIANCE',   lotSize:250,  aoEx:'NFO', base:2945,  vol:0.013 } } },
  { id: 'TCS-FUT',       name: 'TCS Futures',         type: 'STOCK',  defaultExchange: 'ao_futures',
    exchanges: { ao_futures: { src:'ao_futures', symbol:'TCS-FUT',       underlying:'TCS',        lotSize:150,  aoEx:'NFO', base:3900,  vol:0.011 } } },
  { id: 'INFY-FUT',      name: 'Infosys Futures',     type: 'STOCK',  defaultExchange: 'ao_futures',
    exchanges: { ao_futures: { src:'ao_futures', symbol:'INFY-FUT',      underlying:'INFY',       lotSize:300,  aoEx:'NFO', base:1450,  vol:0.014 } } },
  { id: 'HDFCBANK-FUT',  name: 'HDFC Bank Futures',   type: 'STOCK',  defaultExchange: 'ao_futures',
    exchanges: { ao_futures: { src:'ao_futures', symbol:'HDFCBANK-FUT',  underlying:'HDFCBANK',   lotSize:550,  aoEx:'NFO', base:1650,  vol:0.015 } } },
  { id: 'SBIN-FUT',      name: 'SBI Futures',         type: 'STOCK',  defaultExchange: 'ao_futures',
    exchanges: { ao_futures: { src:'ao_futures', symbol:'SBIN-FUT',      underlying:'SBIN',       lotSize:1500, aoEx:'NFO', base:785,   vol:0.016 } } },
];
