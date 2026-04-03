/**
 * Shared canned market data fixtures for offline testing.
 *
 * All data is realistic but static — based on typical BTC/USDT, ETH/USDT, SOL/USDT
 * market snapshots. Timestamps use epoch ms for consistency.
 */

// ── Tickers ──────────────────────────────────────────────────

export interface TickerFixture {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  high: number;
  low: number;
  open: number;
  close: number;
  volume: number;
  quoteVolume: number;
  change: number;
  percentage: number;
  timestamp: number;
}

const BASE_TS = 1711929600000; // 2024-04-01T00:00:00Z

export const TICKERS: Record<string, TickerFixture> = {
  'BTC/USDT': {
    symbol: 'BTC/USDT',
    last: 65000,
    bid: 64990,
    ask: 65010,
    high: 66200,
    low: 63800,
    open: 64500,
    close: 65000,
    volume: 1234.56,
    quoteVolume: 80246400,
    change: 500,
    percentage: 0.78,
    timestamp: BASE_TS,
  },
  'ETH/USDT': {
    symbol: 'ETH/USDT',
    last: 3400,
    bid: 3399,
    ask: 3401,
    high: 3480,
    low: 3320,
    open: 3350,
    close: 3400,
    volume: 15678.9,
    quoteVolume: 53308260,
    change: 50,
    percentage: 1.49,
    timestamp: BASE_TS,
  },
  'SOL/USDT': {
    symbol: 'SOL/USDT',
    last: 175,
    bid: 174.9,
    ask: 175.1,
    high: 180,
    low: 170,
    open: 172,
    close: 175,
    volume: 456789,
    quoteVolume: 79938075,
    change: 3,
    percentage: 1.74,
    timestamp: BASE_TS,
  },
};

/** Get a single ticker fixture. */
export function ticker(symbol: string): TickerFixture {
  return TICKERS[symbol] ?? { ...TICKERS['BTC/USDT'], symbol };
}

/** Get all ticker fixtures as an array. */
export function allTickers(): TickerFixture[] {
  return Object.values(TICKERS);
}

// ── OHLCV Bars ───────────────────────────────────────────────

export interface BarFixture {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Generate N realistic OHLCV bars with a random walk.
 * Deterministic for a given symbol (uses simple hash for seed).
 */
export function generateBars(opts: {
  symbol?: string;
  count?: number;
  startPrice?: number;
  startTime?: number;
  intervalMs?: number;
}): BarFixture[] {
  const {
    count = 100,
    startPrice = 65000,
    startTime = BASE_TS - count * 3600_000,
    intervalMs = 3600_000, // 1h default
  } = opts;

  const bars: BarFixture[] = [];
  let price = startPrice;

  // Simple deterministic pseudo-random (mulberry32)
  let seed = 0x9E3779B9;
  const rand = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  for (let i = 0; i < count; i++) {
    const volatility = price * 0.02; // 2% vol per bar
    const change = (rand() - 0.5) * volatility;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + rand() * volatility * 0.5;
    const low = Math.min(open, close) - rand() * volatility * 0.5;
    const volume = 100 + rand() * 900;

    bars.push({
      timestamp: startTime + i * intervalMs,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume: Math.round(volume * 100) / 100,
    });

    price = close;
  }

  return bars;
}

/** Pre-generated 100 bars of BTC/USDT 1h data. */
export const BTC_BARS = generateBars({ symbol: 'BTC/USDT', count: 100, startPrice: 65000 });

/** Pre-generated 100 bars of ETH/USDT 1h data. */
export const ETH_BARS = generateBars({ symbol: 'ETH/USDT', count: 100, startPrice: 3400 });

/** Pre-generated 100 bars of SOL/USDT 1h data. */
export const SOL_BARS = generateBars({ symbol: 'SOL/USDT', count: 100, startPrice: 175 });

// ── Order Book ───────────────────────────────────────────────

export interface OrderBookFixture {
  symbol: string;
  bids: [number, number][];
  asks: [number, number][];
  bestBid: number;
  bestAsk: number;
  mid: number;
  spread: number;
  spreadBps: number;
  timestamp: number;
}

/**
 * Generate a realistic order book with N levels per side.
 */
export function generateOrderBook(symbol: string, midPrice?: number, levels = 20): OrderBookFixture {
  const mid = midPrice ?? (TICKERS[symbol]?.last ?? 65000);
  const tickSize = mid * 0.0001; // 1 bps

  const bids: [number, number][] = [];
  const asks: [number, number][] = [];

  for (let i = 0; i < levels; i++) {
    const bidPrice = Math.round((mid - tickSize * (i + 1)) * 100) / 100;
    const askPrice = Math.round((mid + tickSize * (i + 1)) * 100) / 100;
    // Deeper levels have more size
    const bidSize = Math.round((0.1 + i * 0.05) * 10000) / 10000;
    const askSize = Math.round((0.1 + i * 0.05) * 10000) / 10000;
    bids.push([bidPrice, bidSize]);
    asks.push([askPrice, askSize]);
  }

  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const spread = Math.round((bestAsk - bestBid) * 100) / 100;
  const spreadBps = Math.round((spread / mid) * 10000 * 100) / 100;

  return {
    symbol,
    bids,
    asks,
    bestBid,
    bestAsk,
    mid: Math.round(mid * 100) / 100,
    spread,
    spreadBps,
    timestamp: BASE_TS,
  };
}

/** Pre-generated BTC/USDT order book. */
export const BTC_ORDER_BOOK = generateOrderBook('BTC/USDT');

// ── Trades ───────────────────────────────────────────────────

export interface TradeFixture {
  id: string;
  timestamp: number;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  cost: number;
}

/**
 * Generate N realistic trades for a symbol.
 */
export function generateTrades(symbol: string, count = 50): TradeFixture[] {
  const basePrice = TICKERS[symbol]?.last ?? 65000;
  const trades: TradeFixture[] = [];

  for (let i = 0; i < count; i++) {
    const side: 'buy' | 'sell' = i % 3 === 0 ? 'sell' : 'buy';
    const jitter = (Math.sin(i * 1.7) * 0.001) * basePrice;
    const price = Math.round((basePrice + jitter) * 100) / 100;
    const amount = Math.round((0.01 + Math.abs(Math.sin(i * 0.8)) * 0.5) * 10000) / 10000;
    const cost = Math.round(price * amount * 100) / 100;

    trades.push({
      id: `trade-${i}`,
      timestamp: BASE_TS - (count - i) * 1000,
      symbol,
      side,
      price,
      amount,
      cost,
    });
  }

  return trades;
}

/** Pre-generated BTC/USDT trades. */
export const BTC_TRADES = generateTrades('BTC/USDT');

// ── Balances ─────────────────────────────────────────────────

export interface BalanceFixture {
  currency: string;
  free: number;
  used: number;
  total: number;
}

/** Typical portfolio balances. */
export const BALANCES: BalanceFixture[] = [
  { currency: 'USDT', free: 50000, used: 0, total: 50000 },
  { currency: 'BTC', free: 0.5, used: 0, total: 0.5 },
  { currency: 'ETH', free: 5, used: 0, total: 5 },
  { currency: 'SOL', free: 100, used: 0, total: 100 },
];

// ── Orders ───────────────────────────────────────────────────

export interface OrderFixture {
  id: string;
  clientOrderId: string | undefined;
  symbol: string;
  side: string;
  type: string;
  amount: number;
  filled: number;
  remaining: number;
  price: number | undefined;
  average: number | undefined;
  status: string;
  timestamp: number;
  datetime: string;
}

/** A filled market buy order. */
export const FILLED_ORDER: OrderFixture = {
  id: 'ord-001',
  clientOrderId: 'client-001',
  symbol: 'BTC/USDT',
  side: 'buy',
  type: 'market',
  amount: 0.1,
  filled: 0.1,
  remaining: 0,
  price: undefined,
  average: 65005,
  status: 'closed',
  timestamp: BASE_TS,
  datetime: '2024-04-01T00:00:00.000Z',
};

/** An open limit sell order. */
export const OPEN_LIMIT_ORDER: OrderFixture = {
  id: 'ord-002',
  clientOrderId: 'client-002',
  symbol: 'BTC/USDT',
  side: 'sell',
  type: 'limit',
  amount: 0.1,
  filled: 0,
  remaining: 0.1,
  price: 70000,
  average: undefined,
  status: 'open',
  timestamp: BASE_TS,
  datetime: '2024-04-01T00:00:00.000Z',
};

// ── Markets ──────────────────────────────────────────────────

export interface MarketFixture {
  symbol: string;
  base: string;
  quote: string;
  type: string;
  active: boolean;
  precision: { amount: number; price: number };
  limits: {
    amount: { min: number; max: number };
    price: { min: number; max: number };
  };
}

export const MARKETS: MarketFixture[] = [
  {
    symbol: 'BTC/USDT',
    base: 'BTC',
    quote: 'USDT',
    type: 'spot',
    active: true,
    precision: { amount: 8, price: 2 },
    limits: {
      amount: { min: 0.00001, max: 1000 },
      price: { min: 0.01, max: 1000000 },
    },
  },
  {
    symbol: 'ETH/USDT',
    base: 'ETH',
    quote: 'USDT',
    type: 'spot',
    active: true,
    precision: { amount: 6, price: 2 },
    limits: {
      amount: { min: 0.0001, max: 10000 },
      price: { min: 0.01, max: 100000 },
    },
  },
  {
    symbol: 'SOL/USDT',
    base: 'SOL',
    quote: 'USDT',
    type: 'spot',
    active: true,
    precision: { amount: 4, price: 2 },
    limits: {
      amount: { min: 0.01, max: 100000 },
      price: { min: 0.01, max: 10000 },
    },
  },
];

/** Base timestamp for all fixtures. */
export { BASE_TS };
