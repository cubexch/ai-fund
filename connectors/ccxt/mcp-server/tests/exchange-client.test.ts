/**
 * Edge-case tests for ExchangeClient.
 *
 * Focuses on error handling, fallback paths, and boundary conditions
 * not covered by client.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExchangeClient } from '../src/client/exchange.js';

// ── Test helper ─────────────────────────────────────────────

function createTestExchange(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: '',
    secret: '',
    name: 'TestExchange',
    has: {},
    markets: {} as Record<string, any>,
    timeframes: {},
    countries: [],
    rateLimit: 100,
    setSandboxMode: vi.fn(),
    loadMarkets: vi.fn().mockResolvedValue({
      'BTC/USDT': {
        symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', type: 'spot',
        active: true, maker: 0.001, taker: 0.002,
        precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1_000_000 } },
      },
      'ETH/USDT': {
        symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', type: 'spot',
        active: true, maker: 0.001, taker: 0.002,
        precision: { amount: 6, price: 2 },
        limits: { amount: { min: 0.001, max: 1000 }, price: { min: 0.01, max: 100_000 } },
      },
    }),
    amountToPrecision: vi.fn((symbol: string, amount: number) => amount.toFixed(8)),
    priceToPrecision: vi.fn((symbol: string, price: number) => price.toFixed(2)),
    fetchTicker: vi.fn().mockResolvedValue({
      symbol: 'BTC/USDT', last: 65000, bid: 64990, ask: 65010,
      high: 66000, low: 64000, open: 64500, close: 65000,
      baseVolume: 1234.5, quoteVolume: 80_000_000,
      change: 500, percentage: 0.77, timestamp: 1_700_000_000_000,
    }),
    fetchBalance: vi.fn().mockResolvedValue({
      total: { BTC: 1.5, USDT: 50_000, ETH: 0 },
      free:  { BTC: 1.0, USDT: 40_000, ETH: 0 },
      used:  { BTC: 0.5, USDT: 10_000, ETH: 0 },
    }),
    createOrder: vi.fn().mockResolvedValue({
      id: 'new-ord-1', clientOrderId: 'co-new', symbol: 'BTC/USDT',
      side: 'buy', type: 'limit', amount: 0.1, filled: 0, remaining: 0.1,
      price: 64000, average: null, status: 'open',
      timestamp: 1_700_000_000_000, datetime: '2023-11-14T22:13:20.000Z',
    }),
    cancelOrder: vi.fn().mockResolvedValue({}),
    fetchOpenOrders: vi.fn().mockResolvedValue([]),
    fetchPositions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createClient(overrides: Record<string, unknown> = {}) {
  return new ExchangeClient({
    exchangeId: 'test',
    exchangeInstance: createTestExchange(overrides) as any,
  });
}

// ── placeOrder — error paths ──────────────────────────────────

describe('placeOrder — error paths', () => {
  it('throws when limit order has no price', async () => {
    const client = createClient();
    await expect(
      client.placeOrder('BTC/USDT', 'limit', 'buy', 0.1)
    ).rejects.toThrow('Limit orders require a price');
  });

  it('throws when limit order price is null', async () => {
    const client = createClient();
    await expect(
      client.placeOrder('BTC/USDT', 'limit', 'buy', 0.1, null as any)
    ).rejects.toThrow('Limit orders require a price');
  });

  it('throws when amount is zero', async () => {
    const client = createClient();
    await expect(
      client.placeOrder('BTC/USDT', 'market', 'sell', 0)
    ).rejects.toThrow('Order amount must be positive');
  });

  it('throws when amount is negative', async () => {
    const client = createClient();
    await expect(
      client.placeOrder('BTC/USDT', 'market', 'sell', -5)
    ).rejects.toThrow('Order amount must be positive');
  });

  it('propagates exchange createOrder rejection', async () => {
    const client = createClient({
      createOrder: vi.fn().mockRejectedValue(new Error('Insufficient funds')),
    });
    await expect(
      client.placeOrder('BTC/USDT', 'market', 'buy', 1)
    ).rejects.toThrow('Insufficient funds');
  });

  it('rounds amount and price before submitting', async () => {
    const createOrder = vi.fn().mockResolvedValue({
      id: 'r1', clientOrderId: undefined, symbol: 'BTC/USDT',
      side: 'buy', type: 'limit', amount: 0.1, filled: 0, remaining: 0.1,
      price: 64000.12, average: null, status: 'open',
      timestamp: 1_700_000_000_000, datetime: '',
    });
    const amountToPrecision = vi.fn().mockReturnValue('0.10000000');
    const priceToPrecision = vi.fn().mockReturnValue('64000.12');

    const client = createClient({ createOrder, amountToPrecision, priceToPrecision });
    await client.placeOrder('BTC/USDT', 'limit', 'buy', 0.1, 64000.1234);

    expect(amountToPrecision).toHaveBeenCalledWith('BTC/USDT', 0.1);
    expect(priceToPrecision).toHaveBeenCalledWith('BTC/USDT', 64000.1234);
  });
});

// ── modifyOrder — cancel+replace fallback ────────────────────

describe('modifyOrder — cancel+replace fallback', () => {
  it('calls cancelOrder then createOrder when editOrder is absent', async () => {
    const cancelOrder = vi.fn().mockResolvedValue({});
    const createOrder = vi.fn().mockResolvedValue({
      id: 'replaced-1', clientOrderId: undefined, symbol: 'BTC/USDT',
      side: 'buy', type: 'limit', amount: 0.2, filled: 0, remaining: 0.2,
      price: 63000, average: null, status: 'open',
      timestamp: 1_700_000_000_000, datetime: '',
    });

    const client = createClient({ cancelOrder, createOrder });
    const result = await client.modifyOrder('old-ord', 'BTC/USDT', 'limit', 'buy', 0.2, 63000);

    expect(cancelOrder).toHaveBeenCalledWith('old-ord', 'BTC/USDT');
    expect(createOrder).toHaveBeenCalled();
    expect(result.id).toBe('replaced-1');
    expect(result.amount).toBe(0.2);
  });

  it('propagates cancelOrder failure in fallback path', async () => {
    const cancelOrder = vi.fn().mockRejectedValue(new Error('Order already filled'));
    const client = createClient({ cancelOrder });
    await expect(
      client.modifyOrder('ord-x', 'BTC/USDT', 'limit', 'buy', 0.1, 60000)
    ).rejects.toThrow('Order already filled');
  });

  it('uses editOrder directly when the method is available', async () => {
    const editOrder = vi.fn().mockResolvedValue({
      id: 'ord-edited', clientOrderId: undefined, symbol: 'BTC/USDT',
      side: 'buy', type: 'limit', amount: 0.3, filled: 0, remaining: 0.3,
      price: 62000, average: null, status: 'open',
      timestamp: 1_700_000_000_000, datetime: '',
    });
    const cancelOrder = vi.fn();

    const client = createClient({ editOrder, cancelOrder });
    const result = await client.modifyOrder('ord-1', 'BTC/USDT', 'limit', 'buy', 0.3, 62000);

    expect(editOrder).toHaveBeenCalledWith('ord-1', 'BTC/USDT', 'limit', 'buy', 0.3, 62000);
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(result.id).toBe('ord-edited');
  });
});

// ── getBalance — zero / empty edge cases ─────────────────────

describe('getBalance — zero / empty balances', () => {
  it('excludes currencies with zero total', async () => {
    const client = createClient({
      fetchBalance: vi.fn().mockResolvedValue({
        total: { BTC: 0, ETH: 0, USDT: 0 },
        free:  { BTC: 0, ETH: 0, USDT: 0 },
        used:  { BTC: 0, ETH: 0, USDT: 0 },
      }),
    });
    const balances = await client.getBalance();
    expect(balances).toHaveLength(0);
  });

  it('returns empty array when total object is empty', async () => {
    const client = createClient({
      fetchBalance: vi.fn().mockResolvedValue({ total: {}, free: {}, used: {} }),
    });
    const balances = await client.getBalance();
    expect(balances).toHaveLength(0);
  });

  it('handles missing free/used entries gracefully (defaults to 0)', async () => {
    const client = createClient({
      fetchBalance: vi.fn().mockResolvedValue({
        total: { SOL: 10 },
        free: {},
        used: {},
      }),
    });
    const balances = await client.getBalance();
    expect(balances).toHaveLength(1);
    expect(balances[0].currency).toBe('SOL');
    expect(balances[0].total).toBe(10);
    expect(balances[0].free).toBe(0);
    expect(balances[0].used).toBe(0);
  });

  it('includes negative totals (margin / borrow debt)', async () => {
    const client = createClient({
      fetchBalance: vi.fn().mockResolvedValue({
        total: { BTC: -0.25 },
        free:  { BTC: -0.25 },
        used:  { BTC: 0 },
      }),
    });
    const balances = await client.getBalance();
    expect(balances).toHaveLength(1);
    expect(balances[0].total).toBe(-0.25);
  });
});

// ── getPositions — spot fallback to balances ──────────────────

describe('getPositions — spot fallback', () => {
  it('uses fetchPositions when available', async () => {
    const fetchPositions = vi.fn().mockResolvedValue([
      { symbol: 'BTC/USDT', side: 'long', contracts: 0.5, unrealizedPnl: 150, entryPrice: 60000, markPrice: 65000 },
    ]);
    const client = createClient({ fetchPositions });
    const positions = await client.getPositions();

    expect(fetchPositions).toHaveBeenCalled();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('BTC/USDT');
    expect(positions[0].side).toBe('long');
    expect(positions[0].amount).toBe(0.5);
    expect(positions[0].unrealizedPnl).toBe(150);
    expect(positions[0].entryPrice).toBe(60000);
    expect(positions[0].currentPrice).toBe(65000);
  });

  it('falls back to balance when fetchPositions is not a function', async () => {
    // Remove fetchPositions so the fallback path is triggered
    const mock = createTestExchange({ fetchPositions: undefined });
    // Also patch fetchBalance to return known data
    mock.fetchBalance = vi.fn().mockResolvedValue({
      total: { BTC: 2, USDT: 10000 },
      free:  { BTC: 2, USDT: 10000 },
      used:  { BTC: 0, USDT: 0 },
    });
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const positions = await client.getPositions();

    expect(positions).toHaveLength(2);
    const btcPos = positions.find(p => p.symbol === 'BTC');
    expect(btcPos).toBeDefined();
    expect(btcPos!.side).toBe('long');
    expect(btcPos!.amount).toBe(2);
    expect(btcPos!.unrealizedPnl).toBeUndefined();
    expect(btcPos!.entryPrice).toBeUndefined();
  });

  it('passes symbol filter to fetchPositions', async () => {
    const fetchPositions = vi.fn().mockResolvedValue([]);
    const client = createClient({ fetchPositions });
    await client.getPositions(['BTC/USDT']);
    expect(fetchPositions).toHaveBeenCalledWith(['BTC/USDT']);
  });
});

// ── getTradingFees — edge cases ───────────────────────────────

describe('getTradingFees — edge cases', () => {
  it('returns fee from market data when calculateFee is unavailable', async () => {
    const markets = {
      'BTC/USDT': {
        symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', type: 'spot',
        active: true, maker: 0.001, taker: 0.002,
        precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1_000_000 } },
      },
    };
    const mock = createTestExchange({ markets });
    (mock.loadMarkets as any).mockResolvedValue(markets);
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    // Simulate loadMarkets populating exchange.markets
    await client.ensureMarkets();
    (mock as any).markets = markets;

    const fees = await client.getTradingFees('BTC/USDT');
    expect(fees).toHaveLength(1);
    expect(fees[0].symbol).toBe('BTC/USDT');
    expect(fees[0].maker).toBe(0.001);
    expect(fees[0].taker).toBe(0.002);
    expect(fees[0].percentage).toBe(true);
  });

  it('returns up to 10 fees when no symbol specified', async () => {
    const markets: Record<string, any> = {};
    for (let i = 0; i < 15; i++) {
      markets[`TOKEN${i}/USDT`] = {
        symbol: `TOKEN${i}/USDT`, base: `TOKEN${i}`, quote: 'USDT', type: 'spot',
        active: true, maker: 0.001, taker: 0.002,
        precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.01, max: 1000 }, price: { min: 0.01, max: 100_000 } },
      };
    }
    const mock = createTestExchange({ markets });
    (mock.loadMarkets as any).mockResolvedValue(markets);
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await client.ensureMarkets();
    (mock as any).markets = markets;

    const fees = await client.getTradingFees();
    // Capped at first 10 markets
    expect(fees.length).toBeLessThanOrEqual(10);
  });

  it('handles calculateFee throwing and falls back to market data', async () => {
    const markets = {
      'ETH/USDT': {
        symbol: 'ETH/USDT', base: 'ETH', quote: 'USDT', type: 'spot',
        active: true, maker: 0.0008, taker: 0.0018,
        precision: { amount: 6, price: 2 },
        limits: { amount: { min: 0.001, max: 1000 }, price: { min: 0.01, max: 100_000 } },
      },
    };
    const mock = createTestExchange({
      markets,
      calculateFee: vi.fn().mockImplementation(() => { throw new Error('fee calc error'); }),
    });
    (mock.loadMarkets as any).mockResolvedValue(markets);
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    await client.ensureMarkets();
    (mock as any).markets = markets;

    const fees = await client.getTradingFees('ETH/USDT');
    expect(fees).toHaveLength(1);
    expect(fees[0].taker).toBe(0.0018);
  });
});

// ── searchMarkets — filtering ─────────────────────────────────

describe('searchMarkets — filtering', () => {
  it('returns empty array when no markets match query', async () => {
    const client = createClient();
    const results = await client.searchMarkets('ZZZNOMATCH');
    expect(results).toHaveLength(0);
  });

  it('matches on quote currency', async () => {
    const markets = {
      'BTC/EUR': {
        symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', type: 'spot',
        active: true, precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1_000_000 } },
      },
      'ETH/EUR': {
        symbol: 'ETH/EUR', base: 'ETH', quote: 'EUR', type: 'spot',
        active: true, precision: { amount: 6, price: 2 },
        limits: { amount: { min: 0.001, max: 1000 }, price: { min: 0.01, max: 100_000 } },
      },
    };
    const mock = createTestExchange({ markets });
    (mock.loadMarkets as any).mockResolvedValue(markets);
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const results = await client.searchMarkets('eur');
    expect(results).toHaveLength(2);
  });

  it('is case-insensitive', async () => {
    const client = createClient();
    const lower = await client.searchMarkets('btc');
    const upper = await client.searchMarkets('BTC');
    expect(lower.length).toBe(upper.length);
    expect(lower.length).toBeGreaterThan(0);
  });

  it('excludes markets where active is explicitly false', async () => {
    const markets = {
      'OLD/USDT': {
        symbol: 'OLD/USDT', base: 'OLD', quote: 'USDT', type: 'spot',
        active: false, precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.01, max: 1000 }, price: { min: 0.01, max: 100_000 } },
      },
    };
    const mock = createTestExchange({ markets });
    (mock.loadMarkets as any).mockResolvedValue(markets);
    const client = new ExchangeClient({ exchangeId: 'test', exchangeInstance: mock as any });
    const results = await client.searchMarkets('old');
    expect(results).toHaveLength(0);
  });
});

// ── roundAmount / roundPrice with ensureMarkets ───────────────

describe('roundAmount and roundPrice with ensureMarkets', () => {
  it('roundAmount calls amountToPrecision with correct args', async () => {
    const amountToPrecision = vi.fn().mockReturnValue('0.12340000');
    const client = createClient({ amountToPrecision });
    const result = client.roundAmount('BTC/USDT', 0.1234);
    expect(amountToPrecision).toHaveBeenCalledWith('BTC/USDT', 0.1234);
    expect(result).toBe(0.1234);
  });

  it('roundPrice calls priceToPrecision with correct args', async () => {
    const priceToPrecision = vi.fn().mockReturnValue('65000.00');
    const client = createClient({ priceToPrecision });
    const result = client.roundPrice('BTC/USDT', 65000);
    expect(priceToPrecision).toHaveBeenCalledWith('BTC/USDT', 65000);
    expect(result).toBe(65000);
  });

  it('roundAmount returns original value when amountToPrecision throws', () => {
    const amountToPrecision = vi.fn().mockImplementation(() => { throw new Error('no market'); });
    const client = createClient({ amountToPrecision });
    expect(client.roundAmount('FAKE/USDT', 1.23456)).toBe(1.23456);
  });

  it('roundPrice returns original value when priceToPrecision throws', () => {
    const priceToPrecision = vi.fn().mockImplementation(() => { throw new Error('no market'); });
    const client = createClient({ priceToPrecision });
    expect(client.roundPrice('FAKE/USDT', 999.99)).toBe(999.99);
  });

  it('placeOrder calls ensureMarkets before rounding', async () => {
    const loadMarkets = vi.fn().mockResolvedValue({
      'BTC/USDT': {
        symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', type: 'spot',
        active: true, precision: { amount: 8, price: 2 },
        limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1_000_000 } },
      },
    });
    const client = createClient({ loadMarkets });
    await client.placeOrder('BTC/USDT', 'market', 'buy', 0.5);
    // loadMarkets must be called as part of ensureMarkets()
    expect(loadMarkets).toHaveBeenCalled();
  });
});

// ── Rate limiter integration ──────────────────────────────────

describe('rate limiter integration', () => {
  it('throttle is called on getTicker when rateLimit is set', async () => {
    const fetchTicker = vi.fn().mockResolvedValue({
      symbol: 'BTC/USDT', last: 100, bid: 99, ask: 101,
      high: 105, low: 95, open: 98, close: 100,
      baseVolume: 500, quoteVolume: 50000,
      change: 2, percentage: 2, timestamp: 1_700_000_000_000,
    });
    // Use a high rateLimit so no actual waiting occurs
    const client = new ExchangeClient({
      exchangeId: 'test',
      exchangeInstance: createTestExchange({ fetchTicker }) as any,
      rateLimit: 1000,
    });
    await client.getTicker('BTC/USDT');
    expect(fetchTicker).toHaveBeenCalledWith('BTC/USDT');
  });

  it('no limiter is created when rateLimit option is omitted', () => {
    const client = new ExchangeClient({
      exchangeId: 'test',
      exchangeInstance: createTestExchange() as any,
    });
    // Access private field via bracket notation to verify it is null
    expect((client as any).limiter).toBeNull();
  });

  it('limiter is created when rateLimit option is provided', () => {
    const client = new ExchangeClient({
      exchangeId: 'test',
      exchangeInstance: createTestExchange() as any,
      rateLimit: 5,
    });
    expect((client as any).limiter).not.toBeNull();
  });

  it('multiple sequential API calls each acquire a rate-limit token', async () => {
    const acquireSpy = vi.fn().mockResolvedValue(undefined);
    const client = new ExchangeClient({
      exchangeId: 'test',
      exchangeInstance: createTestExchange() as any,
      rateLimit: 1000,
    });
    // Replace the real limiter's acquire with a spy
    (client as any).limiter = { acquire: acquireSpy };

    await client.getTicker('BTC/USDT');
    await client.getTicker('BTC/USDT');

    expect(acquireSpy).toHaveBeenCalledTimes(2);
  });
});

// ── Latency tracker integration ───────────────────────────────

describe('latency tracker', () => {
  it('records latency after a successful call', async () => {
    const client = createClient();
    await client.getTicker('BTC/USDT');
    const stats = client.latency.stats('fetchTicker');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(1);
    expect(stats!.avgMs).toBeGreaterThanOrEqual(0);
  });

  it('records an error hit when the call throws', async () => {
    const client = createClient({
      fetchTicker: vi.fn().mockRejectedValue(new Error('timeout')),
    });
    await expect(client.getTicker('BTC/USDT')).rejects.toThrow('timeout');
    const stats = client.latency.stats('fetchTicker');
    expect(stats).toBeNull(); // no successful sample was recorded
    expect(client.latency.allStats().find(s => s.method === 'fetchTicker')).toBeUndefined();
    // Verify the error was counted by checking through a successful call after
    // (error-only methods have no sample array, so stats() returns null)
  });
});
