/**
 * Tests for @ai-fund/lib/test-fixtures — ensures the shared test
 * infrastructure itself works correctly.
 */

import { describe, it, expect } from 'vitest';
import {
  MockMcpServer,
  createMockExchangeClient,
  mockFetch,
  mockFetchRouter,
  TICKERS, BALANCES, MARKETS,
  BTC_BARS, ETH_BARS, SOL_BARS,
  BTC_ORDER_BOOK, BTC_TRADES,
  FILLED_ORDER, OPEN_LIMIT_ORDER,
  generateBars, generateOrderBook, generateTrades,
  ticker, allTickers,
} from '@ai-fund/lib/test-fixtures';

// ── MockMcpServer ────────────────────────────────────────────

describe('MockMcpServer', () => {
  it('registers and invokes tools', async () => {
    const server = new MockMcpServer();
    server.tool('test_tool', 'A test tool', {}, async (params: any) => ({
      content: [{ type: 'text', text: JSON.stringify({ echo: params.msg }) }],
    }));

    expect(server.hasTool('test_tool')).toBe(true);
    expect(server.toolNames).toEqual(['test_tool']);

    const result = await server.callTool('test_tool', { msg: 'hello' });
    expect(result.content[0].text).toBe('{"echo":"hello"}');
  });

  it('callToolJson parses JSON response', async () => {
    const server = new MockMcpServer();
    server.tool('json_tool', 'Returns JSON', {}, async () => ({
      content: [{ type: 'text', text: '{"value":42}' }],
    }));

    const { data, isError } = await server.callToolJson<{ value: number }>('json_tool');
    expect(data.value).toBe(42);
    expect(isError).toBe(false);
  });

  it('callToolJson detects error responses', async () => {
    const server = new MockMcpServer();
    server.tool('err_tool', 'Errors', {}, async () => ({
      content: [{ type: 'text', text: 'Something broke' }],
      isError: true,
    }));

    const { isError } = await server.callToolJson('err_tool');
    expect(isError).toBe(true);
  });

  it('throws on unknown tool', async () => {
    const server = new MockMcpServer();
    await expect(server.callTool('nonexistent')).rejects.toThrow('not registered');
  });
});

// ── createMockExchangeClient ─────────────────────────────────

describe('createMockExchangeClient', () => {
  it('returns default properties', () => {
    const client = createMockExchangeClient();
    expect(client.exchangeId).toBe('coinbase');
    expect(client.name).toBe('Coinbase');
    expect(client.hasCredentials).toBe(true);
    expect(client.isSandbox).toBe(false);
  });

  it('overrides properties', () => {
    const client = createMockExchangeClient({ exchangeId: 'binance', name: 'Binance', isSandbox: true });
    expect(client.exchangeId).toBe('binance');
    expect(client.name).toBe('Binance');
    expect(client.isSandbox).toBe(true);
  });

  it('records method calls', async () => {
    const client = createMockExchangeClient();
    await client.getTicker('BTC/USDT');
    await client.getBalance();

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0].method).toBe('getTicker');
    expect(client.calls[0].args).toEqual(['BTC/USDT']);
    expect(client.calls[1].method).toBe('getBalance');
  });

  it('returns fixture tickers', async () => {
    const client = createMockExchangeClient();
    const t = await client.getTicker('BTC/USDT');
    expect(t.symbol).toBe('BTC/USDT');
    expect(t.last).toBe(65000);
    expect(t.bid).toBe(64990);
    expect(t.ask).toBe(65010);
  });

  it('returns fixture balances', async () => {
    const client = createMockExchangeClient();
    const balances = await client.getBalance();
    expect(balances).toHaveLength(4);
    expect(balances[0].currency).toBe('USDT');
    expect(balances[0].total).toBe(50000);
  });

  it('returns fixture bars with limit', async () => {
    const client = createMockExchangeClient();
    const bars = await client.getBars('BTC/USDT', '1h', undefined, 10);
    expect(bars).toHaveLength(10);
    expect(bars[0]).toHaveProperty('open');
    expect(bars[0]).toHaveProperty('close');
    expect(bars[0]).toHaveProperty('volume');
  });

  it('returns fixture order book', async () => {
    const client = createMockExchangeClient();
    const ob = await client.getOrderBook('BTC/USDT');
    expect(ob.bids.length).toBeGreaterThan(0);
    expect(ob.asks.length).toBeGreaterThan(0);
    expect(ob.mid).toBeGreaterThan(0);
  });

  it('simulates market order placement', async () => {
    const client = createMockExchangeClient();
    const order = await client.placeOrder('BTC/USDT', 'market', 'buy', 0.5);
    expect(order.symbol).toBe('BTC/USDT');
    expect(order.side).toBe('buy');
    expect(order.type).toBe('market');
    expect(order.amount).toBe(0.5);
    expect(order.filled).toBe(0.5);
    expect(order.status).toBe('closed');
  });

  it('simulates limit order placement', async () => {
    const client = createMockExchangeClient();
    const order = await client.placeOrder('BTC/USDT', 'limit', 'sell', 0.1, 70000);
    expect(order.status).toBe('open');
    expect(order.remaining).toBe(0.1);
    expect(order.price).toBe(70000);
  });

  it('accepts method overrides', async () => {
    const client = createMockExchangeClient({}, {
      getTicker: async () => ({ symbol: 'CUSTOM/USDT', last: 999 }),
    });
    const t = await client.getTicker('anything');
    expect(t.symbol).toBe('CUSTOM/USDT');
    expect(t.last).toBe(999);
    expect(client.calls[0].method).toBe('getTicker');
  });

  it('returns empty array for unknown methods', async () => {
    const client = createMockExchangeClient();
    const result = await client.someUnknownMethod();
    expect(result).toEqual([]);
    expect(client.calls[0].method).toBe('someUnknownMethod');
  });
});

// ── mockFetch ────────────────────────────────────────────────

describe('mockFetch', () => {
  it('returns queued responses in order', async () => {
    const fetch = mockFetch([
      { status: 200, body: { ok: true } },
      { status: 404, body: { error: 'not found' } },
    ]);

    const r1 = await fetch('http://test.com/a');
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });

    const r2 = await fetch('http://test.com/b');
    expect(r2.status).toBe(404);
    expect(await r2.json()).toEqual({ error: 'not found' });
  });

  it('records calls with urls and init', async () => {
    const fetch = mockFetch([{ body: {} }]);
    await fetch('http://test.com/api', { method: 'POST', body: '{}' });

    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0].url).toBe('http://test.com/api');
    expect(fetch.calls[0].init?.method).toBe('POST');
  });

  it('throws when queue exhausted', async () => {
    const fetch = mockFetch([{ body: {} }]);
    await fetch('http://test.com/1');
    await expect(fetch('http://test.com/2')).rejects.toThrow('No more mock responses');
  });

  it('handles null body', async () => {
    const fetch = mockFetch([{ status: 204 }]);
    const res = await fetch('http://test.com/del');
    expect(res.status).toBe(204);
  });
});

describe('mockFetchRouter', () => {
  it('matches URL patterns', async () => {
    const fetch = mockFetchRouter([
      { pattern: '/users', response: { body: [{ id: 1 }] } },
      { pattern: '/orders', response: { body: [{ id: 'ord-1' }] } },
    ]);

    const r1 = await fetch('http://api.com/users');
    expect(await r1.json()).toEqual([{ id: 1 }]);

    const r2 = await fetch('http://api.com/orders');
    expect(await r2.json()).toEqual([{ id: 'ord-1' }]);
  });

  it('matches regex patterns', async () => {
    const fetch = mockFetchRouter([
      { pattern: /\/v\d+\/prices/, response: { body: { price: 65000 } } },
    ]);

    const res = await fetch('http://api.com/v2/prices/BTC');
    expect(await res.json()).toEqual({ price: 65000 });
  });

  it('filters by HTTP method', async () => {
    const fetch = mockFetchRouter([
      { pattern: '/orders', method: 'GET', response: { body: [] } },
      { pattern: '/orders', method: 'POST', response: { status: 201, body: { id: 'new' } } },
    ]);

    const r1 = await fetch('http://api.com/orders', { method: 'GET' });
    expect(r1.status).toBe(200);

    const r2 = await fetch('http://api.com/orders', { method: 'POST' });
    expect(r2.status).toBe(201);
    expect(await r2.json()).toEqual({ id: 'new' });
  });

  it('throws on no matching route', async () => {
    const fetch = mockFetchRouter([
      { pattern: '/known', response: { body: {} } },
    ]);
    await expect(fetch('http://api.com/unknown')).rejects.toThrow('No matching route');
  });
});

// ── Market data fixtures ─────────────────────────────────────

describe('Market data fixtures', () => {
  it('TICKERS has expected symbols', () => {
    expect(Object.keys(TICKERS)).toEqual(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
    expect(TICKERS['BTC/USDT'].last).toBe(65000);
    expect(TICKERS['ETH/USDT'].last).toBe(3400);
    expect(TICKERS['SOL/USDT'].last).toBe(175);
  });

  it('ticker() returns requested symbol or fallback with BTC price', () => {
    expect(ticker('BTC/USDT').last).toBe(65000);
    // Unknown symbol gets BTC data but with the requested symbol name
    const unknown = ticker('UNKNOWN/USDT');
    expect(unknown.last).toBe(65000);
    expect(unknown.symbol).toBe('UNKNOWN/USDT');
  });

  it('allTickers() returns array of all tickers', () => {
    expect(allTickers()).toHaveLength(3);
  });

  it('BTC_BARS has 100 bars with valid OHLCV shape', () => {
    expect(BTC_BARS).toHaveLength(100);
    for (const bar of BTC_BARS) {
      expect(bar.high).toBeGreaterThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.low).toBeLessThanOrEqual(Math.max(bar.open, bar.close));
      expect(bar.volume).toBeGreaterThan(0);
      expect(bar.timestamp).toBeGreaterThan(0);
    }
  });

  it('generateBars produces deterministic output', () => {
    const a = generateBars({ count: 10, startPrice: 100 });
    const b = generateBars({ count: 10, startPrice: 100 });
    expect(a).toEqual(b);
  });

  it('generateBars respects count and startPrice', () => {
    const bars = generateBars({ count: 5, startPrice: 1000 });
    expect(bars).toHaveLength(5);
    expect(bars[0].open).toBe(1000);
  });

  it('BTC_ORDER_BOOK has valid bid/ask structure', () => {
    expect(BTC_ORDER_BOOK.bids.length).toBeGreaterThan(0);
    expect(BTC_ORDER_BOOK.asks.length).toBeGreaterThan(0);
    expect(BTC_ORDER_BOOK.bestBid).toBeLessThan(BTC_ORDER_BOOK.bestAsk);
    expect(BTC_ORDER_BOOK.spread).toBeGreaterThan(0);
    // Bids descending
    for (let i = 1; i < BTC_ORDER_BOOK.bids.length; i++) {
      expect(BTC_ORDER_BOOK.bids[i][0]).toBeLessThan(BTC_ORDER_BOOK.bids[i - 1][0]);
    }
    // Asks ascending
    for (let i = 1; i < BTC_ORDER_BOOK.asks.length; i++) {
      expect(BTC_ORDER_BOOK.asks[i][0]).toBeGreaterThan(BTC_ORDER_BOOK.asks[i - 1][0]);
    }
  });

  it('generateOrderBook uses mid from TICKERS when available', () => {
    const ob = generateOrderBook('ETH/USDT');
    expect(ob.mid).toBe(3400);
    expect(ob.symbol).toBe('ETH/USDT');
  });

  it('BTC_TRADES has valid trade structure', () => {
    expect(BTC_TRADES.length).toBeGreaterThan(0);
    for (const t of BTC_TRADES) {
      expect(t.symbol).toBe('BTC/USDT');
      expect(['buy', 'sell']).toContain(t.side);
      expect(t.price).toBeGreaterThan(0);
      expect(t.amount).toBeGreaterThan(0);
      expect(t.cost).toBeGreaterThan(0);
    }
  });

  it('BALANCES has expected currencies', () => {
    const currencies = BALANCES.map(b => b.currency);
    expect(currencies).toEqual(['USDT', 'BTC', 'ETH', 'SOL']);
    expect(BALANCES[0].free).toBe(50000);
  });

  it('MARKETS has expected structure', () => {
    expect(MARKETS).toHaveLength(3);
    expect(MARKETS[0].symbol).toBe('BTC/USDT');
    expect(MARKETS[0].precision.amount).toBe(8);
    expect(MARKETS[0].limits.amount.min).toBe(0.00001);
  });

  it('FILLED_ORDER has expected shape', () => {
    expect(FILLED_ORDER.status).toBe('closed');
    expect(FILLED_ORDER.filled).toBe(FILLED_ORDER.amount);
    expect(FILLED_ORDER.remaining).toBe(0);
  });

  it('OPEN_LIMIT_ORDER has expected shape', () => {
    expect(OPEN_LIMIT_ORDER.status).toBe('open');
    expect(OPEN_LIMIT_ORDER.filled).toBe(0);
    expect(OPEN_LIMIT_ORDER.remaining).toBe(OPEN_LIMIT_ORDER.amount);
    expect(OPEN_LIMIT_ORDER.price).toBeGreaterThan(0);
  });
});
