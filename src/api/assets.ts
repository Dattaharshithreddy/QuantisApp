export type Asset = {
  symbol: string;
  name: string;
  type: 'INDEX' | 'STOCK' | 'FOREX' | 'CRYPTO' | 'COMMODITY';
  src: 'ao' | 'binance' | 'av' | 'forex'; // 'sim' removed — no fabricated data sources remain
  base: number;
  vol: number;
  bnSym?: string;
  avSym?: string;
  fxKey?: string;
  fxInv?: boolean;
  aoToken?: string; // Angel One instrument token — required for src:'ao' assets
  aoEx?: string;    // Angel One exchange segment, e.g. 'NSE'
  custom?: boolean; // true if this was added via Symbol Search, not built-in
};

export const ASSETS: Asset[] = [
  { symbol: 'NIFTY50',    name: 'Nifty 50',          type: 'INDEX',  src: 'ao', aoToken: '99926000', aoEx: 'NSE', base: 24900, vol: 0.009 },
  { symbol: 'BANKNIFTY',  name: 'Bank Nifty',         type: 'INDEX',  src: 'ao', aoToken: '99926009', aoEx: 'NSE', base: 52800, vol: 0.013 },
  { symbol: 'FINNIFTY',   name: 'Fin Nifty',          type: 'INDEX',  src: 'ao', aoToken: '99926037', aoEx: 'NSE', base: 23400, vol: 0.011 },
  { symbol: 'RELIANCE',   name: 'Reliance Ind.',      type: 'STOCK',  src: 'ao', aoToken: '2885',     aoEx: 'NSE', base: 2945,  vol: 0.013 },
  { symbol: 'TCS',        name: 'TCS',                type: 'STOCK',  src: 'ao', aoToken: '11536',    aoEx: 'NSE', base: 3900,  vol: 0.011 },
  { symbol: 'INFY',       name: 'Infosys',            type: 'STOCK',  src: 'ao', aoToken: '1594',     aoEx: 'NSE', base: 1450,  vol: 0.014 },
  { symbol: 'HDFCBANK',   name: 'HDFC Bank',          type: 'STOCK',  src: 'ao', aoToken: '1333',     aoEx: 'NSE', base: 1650,  vol: 0.015 },
  { symbol: 'ICICIBANK',  name: 'ICICI Bank',         type: 'STOCK',  src: 'ao', aoToken: '4963',     aoEx: 'NSE', base: 1220,  vol: 0.014 },
  { symbol: 'SBIN',       name: 'State Bank India',   type: 'STOCK',  src: 'ao', aoToken: '3045',     aoEx: 'NSE', base: 785,   vol: 0.016 },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance',      type: 'STOCK',  src: 'ao', aoToken: '317',      aoEx: 'NSE', base: 7200,  vol: 0.018 },
  { symbol: 'TATAMOTORS', name: 'Tata Motors',        type: 'STOCK',  src: 'ao', aoToken: '3456',     aoEx: 'NSE', base: 955,   vol: 0.020 },
  { symbol: 'MARUTI',     name: 'Maruti Suzuki',      type: 'STOCK',  src: 'ao', aoToken: '10999',    aoEx: 'NSE', base: 12400, vol: 0.012 },
  { symbol: 'WIPRO',      name: 'Wipro',              type: 'STOCK',  src: 'ao', aoToken: '3787',     aoEx: 'NSE', base: 520,   vol: 0.014 },
  { symbol: 'AAPL', name: 'Apple Inc.',   type: 'STOCK', src: 'av', avSym: 'AAPL', base: 192, vol: 0.014 },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', type: 'STOCK', src: 'av', avSym: 'NVDA', base: 875, vol: 0.024 },
  { symbol: 'TSLA', name: 'Tesla Inc.',   type: 'STOCK', src: 'av', avSym: 'TSLA', base: 249, vol: 0.026 },
  { symbol: 'MSFT', name: 'Microsoft',    type: 'STOCK', src: 'av', avSym: 'MSFT', base: 415, vol: 0.011 },
  { symbol: 'EURUSD', name: 'EUR / USD', type: 'FOREX', src: 'forex', fxKey: 'EUR', fxInv: false, base: 1.0847, vol: 0.003 },
  { symbol: 'GBPUSD', name: 'GBP / USD', type: 'FOREX', src: 'forex', fxKey: 'GBP', fxInv: false, base: 1.2634, vol: 0.004 },
  { symbol: 'USDJPY', name: 'USD / JPY', type: 'FOREX', src: 'forex', fxKey: 'JPY', fxInv: true,  base: 154.2,  vol: 0.003 },
  { symbol: 'USDINR', name: 'USD / INR', type: 'FOREX', src: 'forex', fxKey: 'INR', fxInv: true,  base: 83.4,   vol: 0.002 },
  { symbol: 'BTCUSD', name: 'Bitcoin',  type: 'CRYPTO', src: 'binance', bnSym: 'BTCUSDT', base: 67420, vol: 0.028 },
  { symbol: 'ETHUSD', name: 'Ethereum', type: 'CRYPTO', src: 'binance', bnSym: 'ETHUSDT', base: 3485,  vol: 0.032 },
  { symbol: 'BNBUSD', name: 'BNB',      type: 'CRYPTO', src: 'binance', bnSym: 'BNBUSDT', base: 580,   vol: 0.025 },
  { symbol: 'SOLUSD', name: 'Solana',   type: 'CRYPTO', src: 'binance', bnSym: 'SOLUSDT', base: 148,   vol: 0.035 },
  // NOTE: Gold and Crude Oil were previously listed here with src:'sim' —
  // meaning they had NO real data source at all, only fabricated candles.
  // Removed entirely now that simulation is gone. Add them back if/when a
  // real commodities API gets wired up (e.g. a metals/futures data provider).
];

export const TYPE_COLORS: Record<string, string> = {
  INDEX: '#2962ff', STOCK: '#089981', FOREX: '#ff9800', CRYPTO: '#9c27b0', COMMODITY: '#795548',
};
