import { describe, it, expect } from 'vitest';
import { ExchangeClient } from '../src/client/exchange.js';

// ── Mock CCXT exchange for unit testing ─────────────────────

function createMockCcxtExchange(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: overrides.apiKey ?? '',
    secret: overrides.secret ?? '',
    name: overrides.name ?? 'MockExchange',
    urls: { api: 'https://api.example.com' },
    markets: {} as Record<string, any>,
    setSandboxMode: () => {},
    loadMarkets: async () => ({
      'BTC/USDT': {
        symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', type: 'spot',
        active: true,
        precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1000000 } },
      },
      'ETH/USDT': {
        symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', type: 'spot',
        active: true,
        precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.001, max: 1000 }, price: { min: 0.01, max: 100000 } },
      },
      'DOGE/USDT': {
        symbol: 'DOGE/USDT', base: 'DOGE', quote: 'USDT', type: 'spot',
        active: false,
        precision: { amount: 0, price: 6 },
        limits: { amount: { min: 1, max: 10000000 }, price: { min: 0.000001, max: 10 } },
      },
    }),
    fetchTicker: async (symbol: string) => ({
      symbol,
      last: 65000,
      bid: 64990,
      ask: 65010,
      high: 66000,
      low: 64000,
      open: 64500,
      close: 65000,
      baseVolume: 1234.5,
      quoteVolume: 80000000,
      change: 500,
      percentage: 0.77,
      timestamp: 1700000000000,
    }),
    fetchTickers: async (symbols?: string[]) => {
      const ticker = {
        symbol: 'BTC/USDT',
        last: 65000, bid: 64990, ask: 65010,
        high: 66000, low: 64000, open: 64500, close: 65000,
        baseVolume: 1234.5, quoteVolume: 80000000,
        change: 500, percentage: 0.77, timestamp: 1700000000000,
      };
      return { 'BTC/USDT': ticker };
    },
    fetchOHLCV: async () => [
      [1700000000000, 65000, 66000, 64000, 65500, 1000],
      [1700086400000, 65500, 67000, 65000, 66800, 1200],
    ],
    fetchOrderBook: async (symbol: string) => ({
      symbol,
      bids: [[64990, 1.5], [64980, 2.0]],
      asks: [[65010, 1.0], [65020, 1.8]],
      timestamp: 1700000000000,
    }),
    fetchTrades: async (symbol: string) => [
      { id: 't1', timestamp: 1700000000000, symbol, side: 'buy', price: 65000, amount: 0.5, cost: 32500 },
      { id: 't2', timestamp: 1700000001000, symbol, side: 'sell', price: 65010, amount: 0.3, cost: 19503 },
    ],
    fetchBalance: async () => ({
      total: { BTC: 1.5, USDT: 50000, ETH: 0 },
      free: { BTC: 1.0, USDT: 40000, ETH: 0 },
      used: { BTC: 0.5, USDT: 10000, ETH: 0 },
    }),
    createOrder: async (symbol: string, type: string, side: string, amount: number, price?: number) => ({
      id: 'ord-123',
      clientOrderId: 'co-1',
      symbol, side, type,
      amount, filled: 0, remaining: amount,
      price: price ?? null,
      average: null,
      status: 'open',
      timestamp: 1700000000000,
      datetime: '2023-11-14T22:13:20.000Z',
    }),
    cancelOrder: async () => ({}),
    cancelAllOrders: async () => ({}),
    fetchOpenOrders: async () => [
      {
        id: 'ord-1', clientOrderId: 'co-1', symbol: 'BTC/USDT', side: 'buy',
        type: 'limit', amount: 0.1, filled: 0, remaining: 0.1,
        price: 64000, average: null, status: 'open',
        timestamp: 1700000000000, datetime: '2023-11-14T22:13:20.000Z',
      },
    ],
    fetchClosedOrders: async () => [
      {
        id: 'ord-2', clientOrderId: 'co-2', symbol: 'BTC/USDT', side: 'sell',
        type: 'market', amount: 0.5, filled: 0.5, remaining: 0,
        price: null, average: 65100, status: 'closed',
        timestamp: 1699999000000, datetime: '2023-11-14T21:56:40.000Z',
      },
    ],
    fetchOrder: async (id: string) => ({
      id, clientOrderId: 'co-1', symbol: 'BTC/USDT', side: 'buy',
      type: 'limit', amount: 0.1, filled: 0, remaining: 0.1,
      price: 64000, average: null, status: 'open',
      timestamp: 1700000000000, datetime: '2023-11-14T22:13:20.000Z',
    }),
    fetchMyTrades: async () => [
      { id: 'mt1', timestamp: 1700000000000, symbol: 'BTC/USDT', side: 'buy', price: 65000, amount: 0.1, cost: 6500 },
    ],
    ...overrides,
  };
}

// ── Constructor ─────────────────────────────────────────────

describe('ExchangeClient constructor', () => {
  it('accepts an exchange instance', () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({
      exchangeId: 'coinbase',
      exchangeInstance: mock as any,
    });
    expect(client.exchangeId).toBe('coinbase');
    expect(client.name).toBe('MockExchange');
  });

  it('reports hasCredentials correctly', () => {
    const withCreds = new ExchangeClient({
      exchangeId: 'coinbase',
      exchangeInstance: createMockCcxtExchange({ apiKey: 'k', secret: 's' }) as any,
    });
    expect(withCreds.hasCredentials).toBe(true);

    const noCreds = new ExchangeClient({
      exchangeId: 'coinbase',
      exchangeInstance: createMockCcxtExchange() as any,
    });
    expect(noCreds.hasCredentials).toBe(false);
  });

  it('throws on unknown exchange ID', () => {
    expect(() => new ExchangeClient({ exchangeId: 'not_a_real_exchange_xyz' })).toThrow('Unknown exchange');
  });

  it('tracks sandbox mode explicitly from constructor opts', () => {
    const sandbox = new ExchangeClient({
      exchangeId: 'test',
      exchangeInstance: createMockCcxtExchange() as any,
      sandbox: true,
    });
    expect(sandbox.isSandbox).toBe(true);

    const live = new ExchangeClient({
      exchangeId: 'test',
      exchangeInstance: createMockCcxtExchange() as any,
    });
    expect(live.isSandbox).toBe(false);
  });
});

// ── Market Data ─────────────────────────────────────────────

describe('getTicker', () => {
  it('returns formatted ticker', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const ticker = await client.getTicker('BTC/USDT');

    expect(ticker.symbol).toBe('BTC/USDT');
    expect(ticker.last).toBe(65000);
    expect(ticker.bid).toBe(64990);
    expect(ticker.ask).toBe(65010);
    expect(ticker.high).toBe(66000);
    expect(ticker.low).toBe(64000);
    expect(ticker.volume).toBe(1234.5);
    expect(ticker.percentage).toBe(0.77);
    expect(ticker.timestamp).toBe(1700000000000);
  });
});

describe('getTickers', () => {
  it('returns array of formatted tickers', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const tickers = await client.getTickers();

    expect(tickers).toHaveLength(1);
    expect(tickers[0].symbol).toBe('BTC/USDT');
    expect(tickers[0].last).toBe(65000);
  });
});

describe('getBars', () => {
  it('returns formatted OHLCV bars', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const bars = await client.getBars('BTC/USDT', '1d', undefined, 2);

    expect(bars).toHaveLength(2);
    expect(bars[0].timestamp).toBe(1700000000000);
    expect(bars[0].open).toBe(65000);
    expect(bars[0].high).toBe(66000);
    expect(bars[0].low).toBe(64000);
    expect(bars[0].close).toBe(65500);
    expect(bars[0].volume).toBe(1000);
    expect(bars[1].open).toBe(65500);
  });
});

describe('getOrderBook', () => {
  it('returns bids and asks with spread analysis', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const ob = await client.getOrderBook('BTC/USDT');

    expect(ob.symbol).toBe('BTC/USDT');
    expect(ob.bids).toHaveLength(2);
    expect(ob.asks).toHaveLength(2);
    expect(ob.bids[0][0]).toBe(64990);
    expect(ob.asks[0][0]).toBe(65010);
    expect(ob.bestBid).toBe(64990);
    expect(ob.bestAsk).toBe(65010);
    expect(ob.mid).toBe(65000);
    expect(ob.spread).toBe(20);
    expect(ob.spreadBps).toBeTypeOf('number');
    expect(ob.spreadBps).toBeGreaterThan(0);
    expect(ob.timestamp).toBe(1700000000000);
  });

  it('handles empty order book gracefully', async () => {
    const mock = createMockCcxtExchange({
      fetchOrderBook: async () => ({ bids: [], asks: [], timestamp: 1700000000000 }),
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const ob = await client.getOrderBook('BTC/USDT');

    expect(ob.bestBid).toBeUndefined();
    expect(ob.bestAsk).toBeUndefined();
    expect(ob.mid).toBeUndefined();
    expect(ob.spread).toBeUndefined();
    expect(ob.spreadBps).toBeUndefined();
  });
});

describe('getTrades', () => {
  it('returns formatted public trades', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const trades = await client.getTrades('BTC/USDT');

    expect(trades).toHaveLength(2);
    expect(trades[0].id).toBe('t1');
    expect(trades[0].price).toBe(65000);
    expect(trades[0].amount).toBe(0.5);
    expect(trades[0].side).toBe('buy');
    expect(trades[1].side).toBe('sell');
  });
});

describe('loadMarkets', () => {
  it('returns formatted market list', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const markets = await client.loadMarkets();

    expect(markets).toHaveLength(3);
    const btc = markets.find(m => m.symbol === 'BTC/USDT');
    expect(btc).toBeDefined();
    expect(btc!.base).toBe('BTC');
    expect(btc!.quote).toBe('USDT');
    expect(btc!.type).toBe('spot');
    expect(btc!.active).toBe(true);
    expect(btc!.precision.amount).toBe(8);
  });
});

describe('searchMarkets', () => {
  it('searches by symbol', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const results = await client.searchMarkets('BTC');

    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe('BTC/USDT');
  });

  it('searches by base currency', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const results = await client.searchMarkets('eth');

    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe('ETH/USDT');
  });

  it('excludes inactive markets', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const results = await client.searchMarkets('DOGE');

    expect(results).toHaveLength(0);
  });

  it('limits results to 20', async () => {
    const manyMarkets: Record<string, any> = {};
    for (let i = 0; i < 30; i++) {
      const sym = `TEST${i}/USDT`;
      manyMarkets[sym] = {
        symbol: sym, base: `TEST${i}`, quote: 'USDT', type: 'spot',
        active: true, precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.01, max: 1000 }, price: { min: 0.01, max: 100000 } },
      };
    }
    const mock = createMockCcxtExchange({ loadMarkets: async () => manyMarkets, markets: manyMarkets });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const results = await client.searchMarkets('test');

    expect(results).toHaveLength(20);
  });
});

// ── Account ────────────────────────────────────────────────

describe('getBalance', () => {
  it('returns non-zero balances', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const balances = await client.getBalance();

    // ETH has 0 total, should be excluded
    expect(balances).toHaveLength(2);
    const btc = balances.find(b => b.currency === 'BTC');
    expect(btc).toBeDefined();
    expect(btc!.free).toBe(1.0);
    expect(btc!.used).toBe(0.5);
    expect(btc!.total).toBe(1.5);

    const usdt = balances.find(b => b.currency === 'USDT');
    expect(usdt).toBeDefined();
    expect(usdt!.total).toBe(50000);
  });
});

// ── Orders ─────────────────────────────────────────────────

describe('placeOrder', () => {
  it('returns formatted order', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const order = await client.placeOrder('BTC/USDT', 'limit', 'buy', 0.1, 64000);

    expect(order.id).toBe('ord-123');
    expect(order.symbol).toBe('BTC/USDT');
    expect(order.side).toBe('buy');
    expect(order.type).toBe('limit');
    expect(order.amount).toBe(0.1);
    expect(order.status).toBe('open');
  });
});

describe('cancelOrder', () => {
  it('cancels without error', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await expect(client.cancelOrder('ord-1', 'BTC/USDT')).resolves.toBeUndefined();
  });
});

describe('getOpenOrders', () => {
  it('returns formatted open orders', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const orders = await client.getOpenOrders();

    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe('ord-1');
    expect(orders[0].status).toBe('open');
    expect(orders[0].price).toBe(64000);
  });
});

describe('getClosedOrders', () => {
  it('returns formatted closed orders', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const orders = await client.getClosedOrders();

    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe('ord-2');
    expect(orders[0].status).toBe('closed');
    expect(orders[0].average).toBe(65100);
  });
});

describe('getOrder', () => {
  it('returns a single order', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const order = await client.getOrder('ord-1');

    expect(order.id).toBe('ord-1');
    expect(order.symbol).toBe('BTC/USDT');
  });
});

describe('getMyTrades', () => {
  it('returns formatted personal trades', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const trades = await client.getMyTrades();

    expect(trades).toHaveLength(1);
    expect(trades[0].id).toBe('mt1');
    expect(trades[0].price).toBe(65000);
    expect(trades[0].amount).toBe(0.1);
  });
});

// ── Input validation ──────────────────────────────────────

describe('placeOrder validation', () => {
  it('rejects limit orders without price', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await expect(client.placeOrder('BTC/USDT', 'limit', 'buy', 0.1)).rejects.toThrow('Limit orders require a price');
  });

  it('rejects zero amount', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await expect(client.placeOrder('BTC/USDT', 'market', 'buy', 0)).rejects.toThrow('amount must be positive');
  });

  it('rejects negative amount', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await expect(client.placeOrder('BTC/USDT', 'market', 'buy', -1)).rejects.toThrow('amount must be positive');
  });

  it('allows market orders without price', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const order = await client.placeOrder('BTC/USDT', 'market', 'buy', 0.1);
    expect(order.id).toBe('ord-123');
  });
});

describe('modifyOrder', () => {
  it('uses editOrder when available', async () => {
    const mock = createMockCcxtExchange({
      editOrder: async (id: string, symbol: string, type: string, side: string, amount?: number, price?: number) => ({
        id, clientOrderId: 'co-mod', symbol, side, type,
        amount: amount ?? 0.1, filled: 0, remaining: amount ?? 0.1,
        price: price ?? 64000, average: null, status: 'open',
        timestamp: 1700000000000, datetime: '2023-11-14T22:13:20.000Z',
      }),
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const order = await client.modifyOrder('ord-1', 'BTC/USDT', 'limit', 'buy', 0.2, 63000);
    expect(order.id).toBe('ord-1');
    expect(order.amount).toBe(0.2);
    expect(order.price).toBe(63000);
  });

  it('falls back to cancel+replace when editOrder unavailable', async () => {
    const mock = createMockCcxtExchange();
    // Default mock doesn't have editOrder
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const order = await client.modifyOrder('ord-1', 'BTC/USDT', 'limit', 'buy', 0.1, 64000);
    expect(order.id).toBe('ord-123'); // new order from createOrder
  });
});

describe('cancelAllOrders fallback', () => {
  it('continues canceling remaining orders when one fails', async () => {
    let cancelledIds: string[] = [];
    const mock = createMockCcxtExchange({
      cancelAllOrders: undefined, // force fallback path
      fetchOpenOrders: async () => [
        { id: 'ord-1', symbol: 'BTC/USDT' },
        { id: 'ord-2', symbol: 'BTC/USDT' },
        { id: 'ord-3', symbol: 'BTC/USDT' },
      ],
      cancelOrder: async (id: string) => {
        if (id === 'ord-2') throw new Error('cancel failed');
        cancelledIds.push(id);
      },
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await expect(client.cancelAllOrders()).rejects.toThrow('Failed to cancel 1/3 orders');
    // ord-1 and ord-3 should still have been attempted
    expect(cancelledIds).toContain('ord-1');
    expect(cancelledIds).toContain('ord-3');
  });
});

describe('getBalance', () => {
  it('includes negative balances (margin debt)', async () => {
    const mock = createMockCcxtExchange({
      fetchBalance: async () => ({
        total: { BTC: -0.5, USDT: 50000 },
        free: { BTC: -0.5, USDT: 40000 },
        used: { BTC: 0, USDT: 10000 },
      }),
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const balances = await client.getBalance();
    expect(balances).toHaveLength(2);
    const btc = balances.find(b => b.currency === 'BTC');
    expect(btc!.total).toBe(-0.5);
    expect(btc!.free).toBe(-0.5);
  });
});

// ── Precision rounding ─────────────────────────────────────

describe('ensureMarkets', () => {
  it('loads markets only once', async () => {
    let loadCount = 0;
    const mock = createMockCcxtExchange({
      loadMarkets: async () => { loadCount++; return {}; },
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await client.ensureMarkets();
    await client.ensureMarkets();
    expect(loadCount).toBe(1);
  });
});

describe('roundAmount', () => {
  it('rounds using exchange precision', () => {
    const mock = createMockCcxtExchange({
      amountToPrecision: (_symbol: string, amount: number) => amount.toFixed(4),
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    expect(client.roundAmount('BTC/USDT', 1.123456789)).toBe(1.1235);
  });

  it('returns original on error', () => {
    const mock = createMockCcxtExchange({
      amountToPrecision: () => { throw new Error('no market'); },
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    expect(client.roundAmount('BTC/USDT', 1.5)).toBe(1.5);
  });
});

describe('roundPrice', () => {
  it('rounds using exchange precision', () => {
    const mock = createMockCcxtExchange({
      priceToPrecision: (_symbol: string, price: number) => price.toFixed(2),
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    expect(client.roundPrice('BTC/USDT', 65123.456)).toBe(65123.46);
  });

  it('returns original on error', () => {
    const mock = createMockCcxtExchange({
      priceToPrecision: () => { throw new Error('no market'); },
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    expect(client.roundPrice('BTC/USDT', 100)).toBe(100);
  });
});

// ── Quoting & Fees ─────────────────────────────────────────

describe('getQuote', () => {
  it('returns spread analysis from ticker', async () => {
    const mock = createMockCcxtExchange();
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const q = await client.getQuote('BTC/USDT');

    expect(q.symbol).toBe('BTC/USDT');
    expect(q.bid).toBe(64990);
    expect(q.ask).toBe(65010);
    expect(q.mid).toBe(65000);
    expect(q.spread).toBe(20);
    expect(q.spreadBps).toBeTypeOf('number');
    expect(q.spreadBps).toBeGreaterThan(0);
    expect(q.last).toBe(65000);
  });

  it('handles missing bid/ask', async () => {
    const mock = createMockCcxtExchange({
      fetchTicker: async () => ({
        symbol: 'BTC/USDT', last: 65000,
        bid: undefined, ask: undefined,
        high: 66000, low: 64000, open: 64500, close: 65000,
        baseVolume: 1000, quoteVolume: 65000000,
        change: 500, percentage: 0.77, timestamp: 1700000000000,
      }),
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const q = await client.getQuote('BTC/USDT');

    expect(q.mid).toBeUndefined();
    expect(q.spread).toBeUndefined();
    expect(q.spreadBps).toBeUndefined();
  });
});

describe('getMarketInfo', () => {
  it('returns market with fee rates', async () => {
    const mock = createMockCcxtExchange({
      markets: {
        'BTC/USDT': {
          symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', type: 'spot',
          active: true,
          precision: { amount: 8, price: 2 },
          limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1000000 } },
          maker: 0.001, taker: 0.002,
        },
      },
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const info = await client.getMarketInfo('BTC/USDT');

    expect(info.symbol).toBe('BTC/USDT');
    expect(info.precision.amount).toBe(8);
    expect(info.maker).toBe(0.001);
    expect(info.taker).toBe(0.002);
  });

  it('throws for unknown symbol', async () => {
    const mock = createMockCcxtExchange({ markets: {} });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await expect(client.getMarketInfo('FAKE/USDT')).rejects.toThrow('Market not found');
  });
});

// ── Error handling ──────────────────────────────────────────

describe('error handling', () => {
  it('propagates exchange errors', async () => {
    const mock = createMockCcxtExchange({
      fetchTicker: async () => { throw new Error('Exchange unavailable'); },
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await expect(client.getTicker('BTC/USDT')).rejects.toThrow('Exchange unavailable');
  });
});
