import { describe, it, expect } from 'vitest';
import { registerMarketDataTools } from '../src/tools/market-data.js';
import { createMockClient, MockMcpServer } from './helpers.js';

function setup(overrides: Record<string, unknown> = {}) {
  const client = createMockClient({
    getTickers: async () => [
      { symbol: 'BTC/USDT', last: 65000, bid: 64990, ask: 65010, high: 66000, low: 64000, open: 64500, close: 65000, volume: 1234.5, quoteVolume: 80000000, change: 500, percentage: 0.77, timestamp: 1700000000000 },
      { symbol: 'ETH/USDT', last: 3500, bid: 3499, ask: 3501, high: 3600, low: 3400, open: 3450, close: 3500, volume: 5000, quoteVolume: 17500000, change: 50, percentage: 1.43, timestamp: 1700000000000 },
    ],
    getBars: async () => [
      { timestamp: 1700000000000, open: 65000, high: 66000, low: 64000, close: 65500, volume: 1000 },
      { timestamp: 1700086400000, open: 65500, high: 67000, low: 65000, close: 66800, volume: 1200 },
    ],
    getOrderBook: async () => ({
      symbol: 'BTC/USDT',
      bids: [[64990, 1.5], [64980, 2.0]],
      asks: [[65010, 1.0], [65020, 1.8]],
      timestamp: 1700000000000,
    }),
    getTrades: async () => [
      { id: 't1', timestamp: 1700000000000, symbol: 'BTC/USDT', side: 'buy', price: 65000, amount: 0.5, cost: 32500 },
    ],
    searchMarkets: async () => [
      { symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', type: 'spot', active: true, precision: { amount: 8, price: 2 }, limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1000000 } } },
    ],
    ...overrides,
  } as any);
  const server = new MockMcpServer();
  registerMarketDataTools(server as any, client);
  return { server, client };
}

// ── get_tickers ────────────────────────────────────────────

describe('get_tickers tool', () => {
  it('returns formatted tickers', async () => {
    const { server } = setup();
    const result = await server.callTool('get_tickers', {});

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(2);
    expect(data[0].symbol).toBe('BTC/USDT');
    expect(data[0].last).toBe(65000);
    expect(data[0].bid).toBe(64990);
    expect(data[0].ask).toBe(65010);
    expect(data[0].volume).toBe(1234.5);
    expect(data[1].symbol).toBe('ETH/USDT');
  });

  it('passes symbol filter', async () => {
    const { server, client } = setup();
    await server.callTool('get_tickers', { symbols: 'BTC/USDT,ETH/USDT' });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].method).toBe('getTickers');
    expect(client.calls[0].args[0]).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('returns error on failure', async () => {
    const { server } = setup({
      getTickers: async () => { throw new Error('rate limit'); },
    });
    const result = await server.callTool('get_tickers', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('rate limit');
  });
});

// ── get_bars ───────────────────────────────────────────────

describe('get_bars tool', () => {
  it('returns formatted bars with correct shape', async () => {
    const { server } = setup();
    const result = await server.callTool('get_bars', {
      symbol: 'BTC/USDT', timeframe: '1d', limit: 100,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.bars).toHaveLength(2);
    expect(data.bars[0]).toEqual({
      timestamp: 1700000000000,
      open: 65000,
      high: 66000,
      low: 64000,
      close: 65500,
      volume: 1000,
    });
  });

  it('parses ISO date string for since param', async () => {
    const { server, client } = setup();
    await server.callTool('get_bars', {
      symbol: 'BTC/USDT', timeframe: '1h', since: '2024-01-01T00:00:00Z', limit: 100,
    });

    expect(client.calls[0].method).toBe('getBars');
    const since = client.calls[0].args[2] as number;
    expect(since).toBe(new Date('2024-01-01T00:00:00Z').getTime());
  });

  it('parses numeric timestamp for since param', async () => {
    const { server, client } = setup();
    await server.callTool('get_bars', {
      symbol: 'BTC/USDT', timeframe: '1d', since: '1700000000000', limit: 100,
    });

    expect(client.calls[0].args[2]).toBe(1700000000000);
  });

  it('returns error on failure', async () => {
    const { server } = setup({
      getBars: async () => { throw new Error('invalid timeframe'); },
    });
    const result = await server.callTool('get_bars', {
      symbol: 'BTC/USDT', timeframe: 'bad', limit: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid timeframe');
  });
});

// ── get_order_book ─────────────────────────────────────────

describe('get_order_book tool', () => {
  it('returns bids and asks with correct shape', async () => {
    const { server } = setup();
    const result = await server.callTool('get_order_book', { symbol: 'BTC/USDT', limit: 20 });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.bids).toHaveLength(2);
    expect(data.asks).toHaveLength(2);
    expect(data.bids[0]).toEqual([64990, 1.5]);
    expect(data.asks[0]).toEqual([65010, 1.0]);
    expect(data.timestamp).toBe(1700000000000);
  });

  it('returns error on failure', async () => {
    const { server } = setup({
      getOrderBook: async () => { throw new Error('symbol not found'); },
    });
    const result = await server.callTool('get_order_book', { symbol: 'INVALID/USDT', limit: 20 });
    expect(result.isError).toBe(true);
  });
});

// ── get_trades ─────────────────────────────────────────────

describe('get_trades tool', () => {
  it('returns formatted trades', async () => {
    const { server } = setup();
    const result = await server.callTool('get_trades', { symbol: 'BTC/USDT', limit: 50 });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.trades).toHaveLength(1);
    expect(data.trades[0].price).toBe(65000);
    expect(data.trades[0].amount).toBe(0.5);
    expect(data.trades[0].side).toBe('buy');
  });

  it('returns error on failure', async () => {
    const { server } = setup({
      getTrades: async () => { throw new Error('exchange down'); },
    });
    const result = await server.callTool('get_trades', { symbol: 'BTC/USDT', limit: 50 });
    expect(result.isError).toBe(true);
  });
});

// ── search_assets ──────────────────────────────────────────

describe('search_assets tool', () => {
  it('returns matching markets', async () => {
    const { server } = setup();
    const result = await server.callTool('search_assets', { query: 'BTC' });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].symbol).toBe('BTC/USDT');
    expect(data[0].base).toBe('BTC');
    expect(data[0].type).toBe('spot');
    expect(data[0].active).toBe(true);
    expect(data[0].precision).toEqual({ amount: 8, price: 2 });
  });

  it('returns error on failure', async () => {
    const { server } = setup({
      searchMarkets: async () => { throw new Error('failed'); },
    });
    const result = await server.callTool('search_assets', { query: 'BTC' });
    expect(result.isError).toBe(true);
  });
});
