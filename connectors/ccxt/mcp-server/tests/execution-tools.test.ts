import { describe, it, expect } from 'vitest';
import { registerExecutionTools } from '../src/tools/execution';
import { createMockClient, MockMcpServer } from './helpers';

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

// ── get_latency_stats ────────────────────────────────────

describe('get_latency_stats tool', () => {
  it('returns exchange id and stats array', async () => {
    const { server, client } = setup();

    // Record some latency samples on the client's tracker
    client.latency.record('fetchTicker', 12);
    client.latency.record('fetchTicker', 18);
    client.latency.record('createOrder', 45);
    client.latency.recordError('createOrder');

    const result = await server.callTool('get_latency_stats', {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.exchange).toBe('coinbase');
    expect(Array.isArray(data.stats)).toBe(true);
    expect(data.stats.length).toBe(2);

    // Stats sorted by avgMs descending: createOrder (45) > fetchTicker (15)
    const first = data.stats[0];
    expect(first.method).toBe('createOrder');
    expect(first.count).toBe(1);
    expect(first.avgMs).toBe(45);
    expect(first.errorCount).toBe(1);

    const second = data.stats[1];
    expect(second.method).toBe('fetchTicker');
    expect(second.count).toBe(2);
    expect(second.avgMs).toBe(15);
  });

  it('returns empty stats when no requests have been made', async () => {
    const { server } = setup();
    const result = await server.callTool('get_latency_stats', {});

    const data = JSON.parse(result.content[0].text);
    expect(data.exchange).toBe('coinbase');
    expect(data.stats).toEqual([]);
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

// ── get_market_microstructure ────────────────────────────

function setupMicrostructure(overrides: Record<string, unknown> = {}) {
  return setup({
    getOrderBook: async (symbol: string, _depth?: number) => ({
      symbol,
      bids: [
        [64990, 2.0],
        [64980, 1.5],
        [64970, 3.0],
        [64900, 5.0],
        [64800, 10.0],
      ] as [number, number][],
      asks: [
        [65010, 1.0],
        [65020, 2.5],
        [65030, 1.5],
        [65100, 4.0],
        [65200, 8.0],
      ] as [number, number][],
      bestBid: 64990,
      bestAsk: 65010,
      mid: 65000,
      spread: 20,
      spreadBps: 3.08,
      timestamp: 1700000000000,
    }),
    ...overrides,
  });
}

describe('get_market_microstructure tool', () => {
  it('computes imbalance, depth bands, price impact, shape, and weighted mid', async () => {
    const { server } = setupMicrostructure();
    const result = await server.callTool('get_market_microstructure', { symbol: 'BTC/USDT', depth: 20 });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.mid).toBe(65000);
    expect(data.bestBid).toBe(64990);
    expect(data.bestAsk).toBe(65010);
    expect(data.spread).toBe(20);
    expect(data.spreadBps).toBe(3.08);

    // bidVolume = 2+1.5+3+5+10 = 21.5, askVolume = 1+2.5+1.5+4+8 = 17
    expect(data.bidVolume).toBeCloseTo(21.5, 4);
    expect(data.askVolume).toBeCloseTo(17, 4);

    // imbalance = (21.5 - 17) / (21.5 + 17) = 4.5 / 38.5 ≈ 0.1169
    expect(data.imbalance).toBeCloseTo(0.1169, 3);

    // Depth bands
    expect(data.depthBands).toBeDefined();
    expect(data.depthBands['0.1%']).toBeDefined();
    expect(data.depthBands['0.5%']).toBeDefined();
    expect(data.depthBands['1.0%']).toBeDefined();

    // 0.1% band = 65 price units from mid.
    // Bids within 64935..65000: 64990 (2.0), 64980 (1.5), 64970 (3.0) = 6.5
    // Asks within 65000..65065: 65010 (1.0), 65020 (2.5), 65030 (1.5) = 5.0
    expect(data.depthBands['0.1%'].bidDepth).toBeCloseTo(6.5, 4);
    expect(data.depthBands['0.1%'].askDepth).toBeCloseTo(5.0, 4);

    // Price impact
    expect(data.priceImpact).toBeDefined();
    expect(data.priceImpact.marketBuy).toBeDefined();
    expect(data.priceImpact.marketSell).toBeDefined();
    expect(data.priceImpact.marketBuy.avgPrice).toBeDefined();
    expect(data.priceImpact.marketBuy.impactPct).toBeDefined();

    // Shape
    expect(data.shape).toBeDefined();
    expect(data.shape.bids.length).toBe(5);
    expect(data.shape.asks.length).toBe(5);
    // First level ratio is always 1.0
    expect(data.shape.bids[0].ratioVsTop).toBe(1);
    expect(data.shape.asks[0].ratioVsTop).toBe(1);
    // Second bid level: 1.5 / 2.0 = 0.75
    expect(data.shape.bids[1].ratioVsTop).toBe(0.75);
    // Second ask level: 2.5 / 1.0 = 2.5
    expect(data.shape.asks[1].ratioVsTop).toBe(2.5);

    // Weighted mid: (bestBid * askTopSize + bestAsk * bidTopSize) / (bidTopSize + askTopSize)
    // = (64990 * 1.0 + 65010 * 2.0) / (2.0 + 1.0) = (64990 + 130020) / 3 = 195010 / 3 ≈ 65003.33
    expect(data.weightedMid).toBeCloseTo(65003.33, 0);
  });

  it('throws on empty order book', async () => {
    const { server } = setupMicrostructure({
      getOrderBook: async (symbol: string) => ({
        symbol,
        bids: [],
        asks: [],
        bestBid: undefined,
        bestAsk: undefined,
        mid: undefined,
        spread: undefined,
        spreadBps: undefined,
        timestamp: 1700000000000,
      }),
    });
    const result = await server.callTool('get_market_microstructure', { symbol: 'BTC/USDT' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Cannot determine mid price');
  });

  it('shows positive imbalance when bids dominate', async () => {
    const { server } = setupMicrostructure();
    const result = await server.callTool('get_market_microstructure', { symbol: 'BTC/USDT' });
    const data = JSON.parse(result.content[0].text);
    // bidVolume (21.5) > askVolume (17), so imbalance > 0
    expect(data.imbalance).toBeGreaterThan(0);
  });

  it('passes depth parameter to getOrderBook', async () => {
    const { server, client } = setupMicrostructure();
    await server.callTool('get_market_microstructure', { symbol: 'ETH/USDT', depth: 50 });
    const call = client.calls.find(c => c.method === 'getOrderBook');
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe('ETH/USDT');
    expect(call!.args[1]).toBe(50);
  });
});

// ── get_momentum_scanner ─────────────────────────────────

function makeBars(count: number, startPrice: number, trend: number, baseVolume: number, volumeMultiplier: number) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const close = startPrice + trend * i;
    // Last 5 bars get multiplied volume
    const vol = i >= count - 5 ? baseVolume * volumeMultiplier : baseVolume;
    bars.push({
      timestamp: 1700000000000 + i * 3600000,
      open: close - trend * 0.5,
      high: close + 10,
      low: close - 10,
      close,
      volume: vol,
    });
  }
  return bars;
}

function setupMomentum(overrides: Record<string, unknown> = {}) {
  return setup({
    getBars: async (symbol: string, _timeframe: string, _since: unknown, _limit: number) => {
      const barSets: Record<string, any[]> = {
        'BTC/USDT': makeBars(50, 60000, 100, 500, 3),   // strong uptrend, volume surge
        'ETH/USDT': makeBars(50, 3000, -20, 1000, 0.5),  // downtrend, volume decline
        'SOL/USDT': makeBars(50, 100, 0.5, 200, 1.2),    // mild uptrend, slight volume bump
      };
      return barSets[symbol] ?? makeBars(50, 100, 0, 100, 1);
    },
    ...overrides,
  });
}

describe('get_momentum_scanner tool', () => {
  it('returns symbols sorted by momentum score descending', async () => {
    const { server } = setupMomentum();
    const result = await server.callTool('get_momentum_scanner', {
      symbols: 'BTC/USDT,ETH/USDT,SOL/USDT',
      timeframe: '1h',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.exchange).toBe('Coinbase');
    expect(data.timeframe).toBe('1h');
    expect(data.symbols).toHaveLength(3);

    // BTC has strongest uptrend + volume surge -> highest momentum
    expect(data.symbols[0].symbol).toBe('BTC/USDT');
    expect(data.symbols[0].momentumScore).toBeGreaterThan(0);

    // ETH has downtrend -> negative momentum, should be last
    const ethResult = data.symbols.find((s: any) => s.symbol === 'ETH/USDT');
    expect(ethResult).toBeDefined();
    expect(ethResult.momentumScore).toBeLessThan(0);

    // Verify sorted descending
    for (let i = 1; i < data.symbols.length; i++) {
      expect(data.symbols[i - 1].momentumScore).toBeGreaterThanOrEqual(data.symbols[i].momentumScore);
    }
  });

  it('includes price change fields and volume surge', async () => {
    const { server } = setupMomentum();
    const result = await server.callTool('get_momentum_scanner', {
      symbols: 'BTC/USDT',
      timeframe: '1h',
    });

    const data = JSON.parse(result.content[0].text);
    const btc = data.symbols[0];

    expect(btc.price).toBeDefined();
    expect(btc.change1Bar).toBeDefined();
    expect(btc.change5Bar).toBeDefined();
    expect(btc.change10Bar).toBeDefined();
    expect(btc.change20Bar).toBeDefined();
    expect(btc.volumeSurge).toBeDefined();
    expect(btc.momentumScore).toBeDefined();

    // BTC trend = +100/bar, volume surge = 3x
    expect(btc.change1Bar).toBeGreaterThan(0);
    expect(btc.change20Bar).toBeGreaterThan(0);
    expect(btc.volumeSurge).toBe(3);
  });

  it('handles errors per symbol gracefully', async () => {
    const { server } = setupMomentum({
      getBars: async (symbol: string) => {
        if (symbol === 'FAIL/USDT') throw new Error('exchange error');
        return makeBars(50, 100, 1, 100, 1);
      },
    });

    const result = await server.callTool('get_momentum_scanner', {
      symbols: 'BTC/USDT,FAIL/USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbols).toHaveLength(2);

    const good = data.symbols.find((s: any) => s.symbol === 'BTC/USDT');
    const bad = data.symbols.find((s: any) => s.symbol === 'FAIL/USDT');
    expect(good.momentumScore).toBeDefined();
    expect(bad.error).toContain('exchange error');
  });

  it('reports insufficient data instead of crashing', async () => {
    const { server } = setupMomentum({
      getBars: async () => makeBars(10, 100, 1, 100, 1), // only 10 bars
    });

    const result = await server.callTool('get_momentum_scanner', {
      symbols: 'BTC/USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbols[0].error).toContain('Insufficient data');
  });

  it('defaults timeframe to 1h', async () => {
    const { server } = setupMomentum();
    const result = await server.callTool('get_momentum_scanner', {
      symbols: 'BTC/USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.timeframe).toBe('1h');
  });
});

// ── get_exchange_health ─────────────────────────────────

describe('get_exchange_health tool', () => {
  it('returns health status with expected structure', async () => {
    const { server } = setup({
      getTicker: async (symbol: string) => ({
        symbol, last: 65000, bid: 64990, ask: 65010, high: 66000, low: 64000,
        open: 64500, close: 65000, volume: 1000, quoteVolume: 65000000,
        change: 500, percentage: 0.78, timestamp: Date.now(),
      }),
      store: null,
      journal: null,
    });

    const result = await server.callTool('get_exchange_health', {});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.exchange).toBe('coinbase');
    expect(data.status).toBe('healthy');
    expect(data.connectivity).toBeDefined();
    expect(data.connectivity.status).toBe('ok');
    expect(typeof data.connectivity.latencyMs).toBe('number');
    expect(data.auth).toBeDefined();
    expect(data.auth.hasCredentials).toBe(true);
    expect(data.auth.sandbox).toBe(false);
    expect(data.rateLimiter).toBeDefined();
    expect(data.datastore).toBeDefined();
    expect(data.datastore.configured).toBe(false);
    expect(data.journal).toBeDefined();
    expect(data.journal.configured).toBe(false);
    expect(Array.isArray(data.latencyStats)).toBe(true);
    expect(Array.isArray(data.issues)).toBe(true);
  });

  it('reports degraded status when connectivity fails', async () => {
    const { server } = setup({
      getTicker: async () => { throw new Error('network timeout'); },
      store: null,
      journal: null,
    });

    const result = await server.callTool('get_exchange_health', {});
    const data = JSON.parse(result.content[0].text);

    expect(data.status).toBe('degraded');
    expect(data.connectivity.status).toBe('error');
    expect(data.issues.length).toBeGreaterThan(0);
    expect(data.issues.some((i: string) => i.includes('Connectivity test failed'))).toBe(true);
  });

  it('reports journal configured when present', async () => {
    const { server } = setup({
      getTicker: async (symbol: string) => ({
        symbol, last: 65000, bid: 64990, ask: 65010, timestamp: Date.now(),
      }),
      store: null,
      journal: { record: async () => {} },
    });

    const result = await server.callTool('get_exchange_health', {});
    const data = JSON.parse(result.content[0].text);

    expect(data.journal.configured).toBe(true);
  });
});

// ── aggregate_order_books ───────────────────────────────

describe('aggregate_order_books tool', () => {
  it('is registered as a tool', () => {
    const { server } = setup();
    expect(server.tools.has('aggregate_order_books')).toBe(true);
  });

  it('returns error for unknown exchanges', async () => {
    const { server } = setup();
    const result = await server.callTool('aggregate_order_books', {
      symbol: 'BTC/USDT',
      exchanges: 'fake_exchange_abc,fake_exchange_xyz',
      depth: 10,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.exchanges).toEqual(['fake_exchange_abc', 'fake_exchange_xyz']);
    expect(data.errors).toHaveLength(2);
    expect(data.errors[0].exchange).toBe('fake_exchange_abc');
    expect(data.errors[0].error).toBe('Unknown exchange');
    expect(data.errors[1].exchange).toBe('fake_exchange_xyz');
    expect(data.errors[1].error).toBe('Unknown exchange');
    // No valid order book data
    expect(data.aggregatedBids).toHaveLength(0);
    expect(data.aggregatedAsks).toHaveLength(0);
    expect(data.aggregateSpread).toBeNull();
    expect(data.bestBuyVenue).toBeNull();
    expect(data.bestSellVenue).toBeNull();
  });

  it('returns expected response structure fields', async () => {
    const { server } = setup();
    const result = await server.callTool('aggregate_order_books', {
      symbol: 'BTC/USDT',
      exchanges: 'not_real_1',
      depth: 5,
    });

    const data = JSON.parse(result.content[0].text);

    expect(data).toHaveProperty('symbol');
    expect(data).toHaveProperty('exchanges');
    expect(data).toHaveProperty('aggregatedBids');
    expect(data).toHaveProperty('aggregatedAsks');
    expect(data).toHaveProperty('aggregateSpread');
    expect(data).toHaveProperty('aggregateMid');
    expect(data).toHaveProperty('bestBuyVenue');
    expect(data).toHaveProperty('bestSellVenue');
    expect(data).toHaveProperty('totalBidDepth');
    expect(data).toHaveProperty('totalAskDepth');
    expect(Array.isArray(data.aggregatedBids)).toBe(true);
    expect(Array.isArray(data.aggregatedAsks)).toBe(true);
  });

  it('trims whitespace from exchange IDs', async () => {
    const { server } = setup();
    const result = await server.callTool('aggregate_order_books', {
      symbol: 'BTC/USDT',
      exchanges: ' fake1 , fake2 ',
    });

    const data = JSON.parse(result.content[0].text);

    expect(data.exchanges[0]).toBe('fake1');
    expect(data.exchanges[1]).toBe('fake2');
  });

  it('handles single unknown exchange gracefully', async () => {
    const { server } = setup();
    const result = await server.callTool('aggregate_order_books', {
      symbol: 'BTC/USDT',
      exchanges: 'unknown_only',
    });

    const data = JSON.parse(result.content[0].text);

    expect(data.errors).toHaveLength(1);
    expect(data.aggregatedBids).toHaveLength(0);
    expect(data.aggregatedAsks).toHaveLength(0);
    expect(data.totalBidDepth).toBe(0);
    expect(data.totalAskDepth).toBe(0);
  });
});
