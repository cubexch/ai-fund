import { describe, it, expect } from 'vitest';
import { registerExecutionTools } from '../src/tools/execution.js';
import { createMockClient, MockMcpServer } from './helpers.js';

// ── Setup ─────────────────────────────────────────────────

function setup(overrides: Record<string, unknown> = {}) {
  const client = createMockClient({
    getMyTrades: async (symbol: string) => [
      { id: 't1', symbol, side: 'buy', price: 64900, amount: 1.0, cost: 64900, timestamp: 1700000000000, takerOrMaker: 'taker' },
      { id: 't2', symbol, side: 'buy', price: 65100, amount: 0.5, cost: 32550, timestamp: 1700000001000, takerOrMaker: 'maker' },
      { id: 't3', symbol, side: 'buy', price: 65000, amount: 1.5, cost: 97500, timestamp: 1700000002000, takerOrMaker: 'taker' },
    ],
    getQuote: async (symbol: string) => ({
      symbol, bid: 64990, bidSize: 1.5, ask: 65010, askSize: 1.0,
      mid: 65000, spread: 20, spreadBps: 3.08, last: 65000, timestamp: 1700000000000,
    }),
    getOpenOrders: async () => [
      { id: 'o1', symbol: 'BTC/USDT', side: 'buy', amount: 0.5, price: 64800, status: 'open' },
    ],
    getTrades: async (_symbol: string, _since: unknown, _limit: number) => [
      { id: 'p1', timestamp: 1700000000000, symbol: 'BTC/USDT', side: 'buy', price: 65000, amount: 0.5, cost: 32500 },
      { id: 'p2', timestamp: 1700000001000, symbol: 'BTC/USDT', side: 'sell', price: 65010, amount: 0.3, cost: 19503 },
      { id: 'p3', timestamp: 1700000002000, symbol: 'BTC/USDT', side: 'buy', price: 65020, amount: 0.8, cost: 52016 },
      { id: 'p4', timestamp: 1700000003000, symbol: 'BTC/USDT', side: 'sell', price: 64990, amount: 0.2, cost: 12998 },
      { id: 'p5', timestamp: 1700000004000, symbol: 'BTC/USDT', side: 'buy', price: 65050, amount: 2.5, cost: 162625 },
    ],
    ...overrides,
  } as any);
  const server = new MockMcpServer();
  registerExecutionTools(server as any, client);
  return { server, client };
}

// ── get_execution_quality ─────────────────────────────────

describe('get_execution_quality tool', () => {
  it('computes VWAP, slippage, fill rate, and maker/taker breakdown', async () => {
    const { server } = setup();
    const result = await server.callTool('get_execution_quality', { symbol: 'BTC/USDT' });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.totalFills).toBe(3);
    // totalVolume = 1.0 + 0.5 + 1.5 = 3.0
    expect(data.totalVolume).toBe(3);
    // totalCost = 64900 + 32550 + 97500 = 194950
    expect(data.totalCost).toBe(194950);
    // vwap = 194950 / 3.0 = 64983.33...
    expect(data.vwap).toBeCloseTo(64983.33, 0);
    // avgFillPrice = (64900 + 65100 + 65000) / 3 = 65000
    expect(data.avgFillPrice).toBe(65000);
    // currentMid = 65000
    expect(data.currentMid).toBe(65000);
    // slippageBps = ((64983.33 - 65000) / 65000) * 10000 ~ -2.56
    expect(data.slippageBps).toBeDefined();
    expect(typeof data.slippageBps).toBe('number');
    // fillRate: totalVolume=3, openOrders amount=0.5, totalRequested=3.5, fillRate=3/3.5*100=85.71
    expect(data.fillRatePct).toBeCloseTo(85.71, 0);
    // maker/taker: 1 maker, 2 taker
    expect(data.makerTaker).toBeDefined();
    expect(data.makerTaker.maker).toBe(1);
    expect(data.makerTaker.taker).toBe(2);
    expect(data.makerTaker.makerPct).toBeCloseTo(33.33, 0);
  });

  it('handles no fills gracefully', async () => {
    const { server } = setup({
      getMyTrades: async () => [],
    });
    const result = await server.callTool('get_execution_quality', { symbol: 'BTC/USDT' });

    const data = JSON.parse(result.content[0].text);
    expect(data.totalFills).toBe(0);
    expect(data.message).toContain('No recent fills');
  });

  it('requires authentication', async () => {
    const { server } = setup({ hasCredentials: false });
    const result = await server.callTool('get_execution_quality', { symbol: 'BTC/USDT' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('credentials');
  });
});

// ── get_spread_monitor ────────────────────────────────────

describe('get_spread_monitor tool', () => {
  it('returns spreads sorted by spreadBps ascending', async () => {
    const { server } = setup({
      getQuote: async (symbol: string) => {
        const quotes: Record<string, any> = {
          'BTC/USDT': { symbol: 'BTC/USDT', bid: 64990, ask: 65010, mid: 65000, spread: 20, spreadBps: 3.08 },
          'ETH/USDT': { symbol: 'ETH/USDT', bid: 3498, ask: 3502, mid: 3500, spread: 4, spreadBps: 11.43 },
          'SOL/USDT': { symbol: 'SOL/USDT', bid: 99.99, ask: 100.01, mid: 100, spread: 0.02, spreadBps: 2.0 },
        };
        return quotes[symbol];
      },
    });

    const result = await server.callTool('get_spread_monitor', {
      symbols: 'BTC/USDT,ETH/USDT,SOL/USDT',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.exchange).toBe('Coinbase');
    expect(data.timestamp).toBeDefined();
    expect(data.symbols).toHaveLength(3);
    // Sorted: SOL (2.0) < BTC (3.08) < ETH (11.43)
    expect(data.symbols[0].symbol).toBe('SOL/USDT');
    expect(data.symbols[1].symbol).toBe('BTC/USDT');
    expect(data.symbols[2].symbol).toBe('ETH/USDT');
    expect(data.tightest).toBe('SOL/USDT');
    expect(data.widest).toBe('ETH/USDT');
  });

  it('handles quote errors for individual symbols', async () => {
    const { server } = setup({
      getQuote: async (symbol: string) => {
        if (symbol === 'INVALID/USDT') throw new Error('symbol not found');
        return { symbol, bid: 64990, ask: 65010, mid: 65000, spread: 20, spreadBps: 3.08 };
      },
    });

    const result = await server.callTool('get_spread_monitor', {
      symbols: 'BTC/USDT,INVALID/USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbols).toHaveLength(2);
    // BTC should be first (valid), INVALID last (error -> Infinity spreadBps)
    expect(data.symbols[0].symbol).toBe('BTC/USDT');
    expect(data.symbols[1].symbol).toBe('INVALID/USDT');
    expect(data.symbols[1].error).toContain('symbol not found');
  });
});

// ── get_order_flow_imbalance ──────────────────────────────

describe('get_order_flow_imbalance tool', () => {
  it('computes buy/sell imbalance and detects large trades', async () => {
    const { server } = setup();
    const result = await server.callTool('get_order_flow_imbalance', {
      symbol: 'BTC/USDT',
      limit: 100,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.totalTrades).toBe(5);
    // buyVolume = 0.5 + 0.8 + 2.5 = 3.8
    expect(data.buyVolume).toBeCloseTo(3.8, 4);
    // sellVolume = 0.3 + 0.2 = 0.5
    expect(data.sellVolume).toBeCloseTo(0.5, 4);
    expect(data.buyCount).toBe(3);
    expect(data.sellCount).toBe(2);
    // buySellRatio = 3.8 / 0.5 = 7.6
    expect(data.buySellRatio).toBe(7.6);
    // imbalancePct = (3.8 - 0.5) / 4.3 * 100 = 76.74%
    expect(data.imbalancePct).toBeGreaterThan(70);
    // signal should be strong_buy_pressure since imbalancePct > 20
    expect(data.signal).toBe('strong_buy_pressure');

    // Large trades: avg size = (0.5+0.3+0.8+0.2+2.5)/5 = 0.86, threshold = 1.72
    // Only trade p5 (amount=2.5) exceeds threshold
    expect(data.largeTrades.count).toBe(1);
    expect(data.largeTrades.trades[0].amount).toBe(2.5);
    expect(data.largeTrades.trades[0].side).toBe('buy');
  });

  it('handles no trades gracefully', async () => {
    const { server } = setup({
      getTrades: async () => [],
    });
    const result = await server.callTool('get_order_flow_imbalance', {
      symbol: 'BTC/USDT',
      limit: 100,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.totalTrades).toBe(0);
    expect(data.message).toContain('No recent trades');
  });

  it('detects sell pressure when sells dominate', async () => {
    const { server } = setup({
      getTrades: async () => [
        { id: 's1', timestamp: 1700000000000, symbol: 'BTC/USDT', side: 'sell', price: 65000, amount: 2.0, cost: 130000 },
        { id: 's2', timestamp: 1700000001000, symbol: 'BTC/USDT', side: 'sell', price: 64990, amount: 1.5, cost: 97485 },
        { id: 'b1', timestamp: 1700000002000, symbol: 'BTC/USDT', side: 'buy', price: 65010, amount: 0.1, cost: 6501 },
      ],
    });
    const result = await server.callTool('get_order_flow_imbalance', {
      symbol: 'BTC/USDT',
      limit: 100,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.imbalancePct).toBeLessThan(-20);
    expect(data.signal).toBe('strong_sell_pressure');
  });

  it('passes limit to getTrades', async () => {
    const { server, client } = setup();
    await server.callTool('get_order_flow_imbalance', {
      symbol: 'ETH/USDT',
      limit: 50,
    });

    const call = client.calls.find(c => c.method === 'getTrades');
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe('ETH/USDT');
    expect(call!.args[2]).toBe(50);
  });
});

// ── detect_arbitrage_opportunity ──────────────────────────

describe('detect_arbitrage_opportunity tool', () => {
  it('is registered as a tool', () => {
    const { server } = setup();
    expect(server.tools.has('detect_arbitrage_opportunity')).toBe(true);
  });

  it('returns error quotes for unknown exchanges', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_arbitrage_opportunity', {
      symbol: 'BTC/USDT',
      exchanges: 'fake_exchange_abc,fake_exchange_xyz',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.quotes).toHaveLength(2);
    expect(data.quotes[0].exchange).toBe('fake_exchange_abc');
    expect(data.quotes[0].error).toBe('Unknown exchange');
    expect(data.quotes[1].exchange).toBe('fake_exchange_xyz');
    expect(data.quotes[1].error).toBe('Unknown exchange');
    expect(data.arbitrage).toBeNull();
    expect(data.message).toContain('at least 2 exchanges');
  });

  it('returns expected response structure fields', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_arbitrage_opportunity', {
      symbol: 'BTC/USDT',
      exchanges: 'not_real_1',
    });

    const data = JSON.parse(result.content[0].text);

    // Verify top-level structure
    expect(data).toHaveProperty('symbol');
    expect(data).toHaveProperty('quotes');
    expect(data).toHaveProperty('arbitrage');
    expect(Array.isArray(data.quotes)).toBe(true);
  });

  it('handles single exchange with error gracefully', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_arbitrage_opportunity', {
      symbol: 'BTC/USDT',
      exchanges: 'unknown_only',
    });

    const data = JSON.parse(result.content[0].text);

    expect(data.quotes).toHaveLength(1);
    expect(data.arbitrage).toBeNull();
    expect(data.message).toBeDefined();
  });

  it('trims whitespace from exchange IDs', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_arbitrage_opportunity', {
      symbol: 'BTC/USDT',
      exchanges: ' fake1 , fake2 ',
    });

    const data = JSON.parse(result.content[0].text);

    expect(data.quotes[0].exchange).toBe('fake1');
    expect(data.quotes[1].exchange).toBe('fake2');
  });
});
