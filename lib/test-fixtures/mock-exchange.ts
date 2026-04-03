/**
 * Shared mock exchange client factory for offline testing.
 *
 * Creates a fake ExchangeClient-compatible object backed by canned fixtures.
 * Works with any connector that uses the unified tool API.
 */

import {
  TICKERS, BALANCES, MARKETS,
  BTC_BARS, ETH_BARS, SOL_BARS,
  BTC_ORDER_BOOK, BTC_TRADES,
  FILLED_ORDER,
  generateBars, generateOrderBook, generateTrades,
  type TickerFixture, type BarFixture, type BalanceFixture,
  type OrderBookFixture, type OrderFixture, type TradeFixture,
  type MarketFixture,
} from './market-data';

// ── Types ────────────────────────────────────────────────────

export interface MockCall {
  method: string;
  args: unknown[];
}

export interface MockExchangeOpts {
  exchangeId?: string;
  name?: string;
  hasCredentials?: boolean;
  isSandbox?: boolean;
  tickers?: Record<string, TickerFixture>;
  bars?: Record<string, BarFixture[]>;
  balances?: BalanceFixture[];
  markets?: MarketFixture[];
  orderBook?: OrderBookFixture;
  trades?: TradeFixture[];
  openOrders?: OrderFixture[];
  closedOrders?: OrderFixture[];
}

/**
 * Create a mock exchange client that records calls and returns fixture data.
 *
 * Compatible with the CCXT ExchangeClient interface used by tool registrations.
 * Override any method by passing it in `overrides`.
 */
export function createMockExchangeClient(
  opts: MockExchangeOpts = {},
  overrides: Record<string, any> = {},
): any & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  const tickers = opts.tickers ?? TICKERS;
  const bars: Record<string, BarFixture[]> = opts.bars ?? {
    'BTC/USDT': BTC_BARS,
    'ETH/USDT': ETH_BARS,
    'SOL/USDT': SOL_BARS,
  };
  const balances = opts.balances ?? BALANCES;
  const markets = opts.markets ?? MARKETS;

  const methods: Record<string, (...args: any[]) => any> = {
    // Market data (public)
    getTicker: async (symbol: string) => tickers[symbol] ?? { ...tickers['BTC/USDT'], symbol },
    getTickers: async (symbols?: string[]) => {
      const all = Object.values(tickers);
      if (!symbols) return all;
      return all.filter(t => symbols.includes(t.symbol));
    },
    getBars: async (symbol: string, _tf: string, _since?: number, limit?: number) => {
      const data = bars[symbol] ?? generateBars({ startPrice: 65000, count: limit ?? 100 });
      return limit ? data.slice(-limit) : data;
    },
    getOrderBook: async (symbol: string, _limit?: number) => opts.orderBook ?? generateOrderBook(symbol),
    getTrades: async (symbol: string, _since?: number, limit?: number) => {
      const data = opts.trades ?? generateTrades(symbol, limit ?? 50);
      return limit ? data.slice(-limit) : data;
    },
    getQuote: async (symbol: string) => {
      const t = tickers[symbol] ?? tickers['BTC/USDT'];
      const mid = t.bid && t.ask ? (t.bid + t.ask) / 2 : t.last;
      const spread = t.ask && t.bid ? t.ask - t.bid : 0;
      return {
        symbol: t.symbol,
        bid: t.bid,
        ask: t.ask,
        mid,
        spread,
        spreadBps: mid > 0 ? Math.round((spread / mid) * 10000 * 100) / 100 : 0,
        last: t.last,
        timestamp: t.timestamp,
      };
    },
    searchMarkets: async (query: string) => {
      const q = query.toLowerCase();
      return markets.filter(m =>
        m.symbol.toLowerCase().includes(q) ||
        m.base.toLowerCase().includes(q)
      ).slice(0, 20);
    },
    loadMarkets: async () => markets,

    // Account (private)
    getBalance: async () => balances,
    getPositions: async () => balances.map(b => ({
      symbol: b.currency,
      side: 'long',
      amount: b.total,
      unrealizedPnl: undefined,
      entryPrice: undefined,
      currentPrice: undefined,
    })),

    // Orders (private)
    placeOrder: async (symbol: string, type: string, side: string, amount: number, price?: number) => ({
      ...FILLED_ORDER,
      symbol,
      type,
      side,
      amount,
      filled: type === 'market' ? amount : 0,
      remaining: type === 'market' ? 0 : amount,
      price,
      average: type === 'market' ? (tickers[symbol]?.last ?? 65000) : undefined,
      status: type === 'market' ? 'closed' : 'open',
    }),
    cancelOrder: async () => undefined,
    modifyOrder: async (_id: string, symbol: string, type: string, side: string, amount?: number, price?: number) => ({
      ...FILLED_ORDER,
      symbol,
      type,
      side,
      amount: amount ?? 0.1,
      price,
      status: 'open',
    }),
    cancelAllOrders: async () => undefined,
    getOpenOrders: async () => opts.openOrders ?? [],
    getClosedOrders: async () => opts.closedOrders ?? [FILLED_ORDER],
    getOrder: async () => FILLED_ORDER,
    getMyTrades: async (symbol?: string) => {
      const data = opts.trades ?? BTC_TRADES;
      return symbol ? data.filter(t => t.symbol === symbol) : data;
    },

    // Quoting & fees
    getTradingFees: async () => [{ symbol: 'BTC/USDT', maker: 0.001, taker: 0.002, percentage: true }],
    getExchangeInfo: async () => ({
      id: opts.exchangeId ?? 'coinbase',
      name: opts.name ?? 'Coinbase',
      countries: ['US'],
      rateLimit: 100,
      has: { fetchTicker: true, fetchOrderBook: true, fetchOHLCV: true, createOrder: true },
      timeframes: ['1m', '5m', '15m', '1h', '4h', '1d'],
      totalMarkets: markets.length,
      activeMarkets: markets.length,
    }),
    getMarketInfo: async (symbol: string) => {
      const m = markets.find(mk => mk.symbol === symbol);
      if (!m) throw new Error(`Market not found: ${symbol}`);
      return { ...m, maker: 0.001, taker: 0.002 };
    },

    // Precision
    ensureMarkets: async () => undefined,
    roundAmount: (_symbol: string, amount: number) => amount,
    roundPrice: (_symbol: string, price: number) => price,
  };

  // Properties
  const props: Record<string, any> = {
    exchangeId: opts.exchangeId ?? 'coinbase',
    name: opts.name ?? 'Coinbase',
    hasCredentials: opts.hasCredentials ?? true,
    isSandbox: opts.isSandbox ?? false,
    store: null,
    journal: null,
    latency: { allStats: () => [], record: () => {}, recordError: () => {} },
  };

  const proxy = new Proxy({} as any, {
    get(_target, prop: string) {
      if (prop === 'calls') return calls;

      // Check overrides first
      if (prop in overrides) {
        const val = overrides[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            calls.push({ method: prop, args });
            return val(...args);
          };
        }
        return val;
      }

      // Properties
      if (prop in props) return props[prop];

      // Methods
      if (prop in methods) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return methods[prop](...args);
        };
      }

      // Default: async no-op returning empty array
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return Promise.resolve([]);
      };
    },
  });

  return proxy;
}
