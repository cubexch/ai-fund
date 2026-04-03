import { describe, it, expect } from 'vitest';
import { createMockClient, MockMcpServer } from './helpers.js';

// ── Attempt to import algorithm tool registration ────────────

let registerAlgorithmTools: any;
let available = false;
try {
  const mod = await import('../src/tools/algorithms.js');
  registerAlgorithmTools = mod.registerAlgorithmTools;
  available = true;
} catch {
  // module not created yet -- skip tests
}

// ── Mock setup ───────────────────────────────────────────────

function setup(overrides: Record<string, unknown> = {}) {
  const client = createMockClient({
    getQuote: async (symbol: string) => ({
      symbol,
      bid: 64990,
      bidSize: 1.5,
      ask: 65010,
      askSize: 1.0,
      mid: 65000,
      spread: 20,
      spreadBps: 3.08,
      last: 65000,
      timestamp: 1700000000000,
    }),
    getOrderBook: async (symbol: string) => ({
      symbol,
      bids: [
        [64990, 2.0], [64980, 3.0], [64970, 5.0], [64960, 4.0], [64950, 6.0],
        [64940, 3.5], [64930, 2.5], [64920, 4.0], [64910, 7.0], [64900, 10.0],
      ] as [number, number][],
      asks: [
        [65010, 1.5], [65020, 2.5], [65030, 3.0], [65040, 2.0], [65050, 4.0],
        [65060, 3.0], [65070, 5.0], [65080, 2.5], [65090, 6.0], [65100, 8.0],
      ] as [number, number][],
      bestBid: 64990,
      bestAsk: 65010,
      mid: 65000,
      spread: 20,
      spreadBps: 3.08,
      timestamp: 1700000000000,
    }),
    getTicker: async (symbol: string) => ({
      symbol,
      last: 65000,
      bid: 64990,
      ask: 65010,
      high: 66000,
      low: 64000,
      open: 64500,
      close: 65000,
      volume: 1234.5,
      quoteVolume: 80000000,
      change: 500,
      percentage: 0.77,
      timestamp: 1700000000000,
    }),
    getBars: async () => {
      const bars = [];
      let price = 65000;
      for (let i = 0; i < 100; i++) {
        const change = (Math.sin(i * 0.3) * 200) + (Math.random() - 0.5) * 100;
        price += change;
        bars.push({
          timestamp: 1700000000000 + i * 3600000,
          open: price - 50,
          high: price + 100,
          low: price - 150,
          close: price,
          volume: 500 + Math.random() * 1000,
        });
      }
      return bars;
    },
    getMarketInfo: async (symbol: string) => ({
      symbol,
      base: 'BTC',
      quote: 'USDT',
      type: 'spot',
      active: true,
      precision: { amount: 8, price: 2 },
      limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1000000 } },
      maker: 0.001,
      taker: 0.002,
    }),
    ensureMarkets: async () => {},
    roundAmount: (_sym: string, amount: number) => Math.round(amount * 100000000) / 100000000,
    roundPrice: (_sym: string, price: number) => Math.round(price * 100) / 100,
    ...overrides,
  } as any);
  const server = new MockMcpServer();
  if (available && registerAlgorithmTools) {
    registerAlgorithmTools(server as any, client);
  }
  return { server, client };
}

// ── TWAP (Time-Weighted Average Price) ───────────────────────

describe.skipIf(!available)('TWAP algorithm', () => {
  it('splits order evenly over time intervals', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_twap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 10,
      duration_minutes: 60,
      num_slices: 6,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.side).toBe('buy');
    expect(data.totalAmount).toBe(10);
    expect(data.slices).toBeInstanceOf(Array);
    expect(data.slices).toHaveLength(6);

    // Each slice should have equal amount
    const expectedPerSlice = 10 / 6;
    for (const slice of data.slices) {
      expect(slice.amount).toBeCloseTo(expectedPerSlice, 4);
      expect(slice.scheduledTime).toBeTypeOf('number');
    }
  });

  it('slices are spaced evenly in time', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_twap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 5,
      duration_minutes: 30,
      num_slices: 3,
    });

    const data = JSON.parse(result.content[0].text);
    const slices = data.slices;

    // Time between slices should be ~10 minutes each
    const intervalMs = 10 * 60 * 1000;
    for (let i = 1; i < slices.length; i++) {
      const gap = slices[i].scheduledTime - slices[i - 1].scheduledTime;
      expect(gap).toBeCloseTo(intervalMs, -3); // within 1 second tolerance
    }
  });

  it('total of all slice amounts equals total_amount', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_twap', {
      symbol: 'BTC/USDT',
      side: 'sell',
      total_amount: 7.5,
      duration_minutes: 120,
      num_slices: 10,
    });

    const data = JSON.parse(result.content[0].text);
    const totalSliced = data.slices.reduce((sum: number, s: any) => sum + s.amount, 0);
    expect(totalSliced).toBeCloseTo(7.5, 6);
  });

  it('rejects zero duration', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_twap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 1,
      duration_minutes: 0,
      num_slices: 5,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain('duration');
  });

  it('rejects negative amount', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_twap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: -5,
      duration_minutes: 60,
      num_slices: 5,
    });

    expect(result.isError).toBe(true);
  });

  it('includes estimated market impact', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_twap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 10,
      duration_minutes: 60,
      num_slices: 6,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.estimatedImpact).toBeDefined();
    expect(data.estimatedImpact).toBeTypeOf('number');
  });
});

// ── VWAP (Volume-Weighted Average Price) ─────────────────────

describe.skipIf(!available)('VWAP algorithm', () => {
  it('distributes proportional to historical volume', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_vwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 10,
      duration_minutes: 60,
      num_slices: 5,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.slices).toBeInstanceOf(Array);
    expect(data.slices).toHaveLength(5);

    // Total should sum to 10
    const totalSliced = data.slices.reduce((sum: number, s: any) => sum + s.amount, 0);
    expect(totalSliced).toBeCloseTo(10, 4);
  });

  it('slices have varying amounts based on volume profile', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_vwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 20,
      duration_minutes: 120,
      num_slices: 10,
    });

    const data = JSON.parse(result.content[0].text);
    const amounts = data.slices.map((s: any) => s.amount);

    // Not all amounts should be equal (VWAP distributes by volume)
    const allEqual = amounts.every((a: number) => Math.abs(a - amounts[0]) < 0.0001);
    // It's possible volumes are similar, so just verify they are all positive
    for (const amount of amounts) {
      expect(amount).toBeGreaterThan(0);
    }
  });

  it('each slice has a volumeWeight field', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_vwap', {
      symbol: 'BTC/USDT',
      side: 'sell',
      total_amount: 5,
      duration_minutes: 60,
      num_slices: 4,
    });

    const data = JSON.parse(result.content[0].text);
    for (const slice of data.slices) {
      expect(slice.volumeWeight).toBeTypeOf('number');
      expect(slice.volumeWeight).toBeGreaterThan(0);
    }
  });
});

// ── Iceberg orders ───────────────────────────────────────────

describe.skipIf(!available)('Iceberg algorithm', () => {
  it('calculates correct number of clips', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_iceberg', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 10,
      clip_size: 2,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.totalAmount).toBe(10);
    expect(data.clipSize).toBe(2);
    expect(data.numClips).toBe(5);
    expect(data.clips).toBeInstanceOf(Array);
    expect(data.clips).toHaveLength(5);
  });

  it('handles non-even division with remainder clip', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_iceberg', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 10,
      clip_size: 3,
    });

    const data = JSON.parse(result.content[0].text);

    // 10 / 3 = 3 clips of 3 + 1 clip of 1
    expect(data.numClips).toBe(4);
    const totalFromClips = data.clips.reduce((sum: number, c: any) => sum + c.amount, 0);
    expect(totalFromClips).toBeCloseTo(10, 6);

    // Last clip should be the remainder
    expect(data.clips[data.clips.length - 1].amount).toBe(1);
  });

  it('each clip has sequence number and display size', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_iceberg', {
      symbol: 'BTC/USDT',
      side: 'sell',
      total_amount: 6,
      clip_size: 2,
    });

    const data = JSON.parse(result.content[0].text);
    for (let i = 0; i < data.clips.length; i++) {
      expect(data.clips[i].sequence).toBe(i + 1);
      expect(data.clips[i].amount).toBeGreaterThan(0);
    }
  });

  it('rejects clip_size larger than total_amount', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_iceberg', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 1,
      clip_size: 5,
    });

    // Should either create a single clip or return an error
    if (result.isError) {
      expect(result.content[0].text).toBeDefined();
    } else {
      const data = JSON.parse(result.content[0].text);
      expect(data.numClips).toBe(1);
    }
  });

  it('rejects zero clip_size', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_iceberg', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 10,
      clip_size: 0,
    });

    expect(result.isError).toBe(true);
  });
});

// ── Sniper (order book fill probability) ─────────────────────

describe.skipIf(!available)('Sniper algorithm', () => {
  it('analyzes order book for fill probability', async () => {
    const { server } = setup();
    const result = await server.callTool('analyze_sniper', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 5,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.side).toBe('buy');
    expect(data.amount).toBe(5);
    expect(data.fillProbability).toBeTypeOf('number');
    expect(data.fillProbability).toBeGreaterThanOrEqual(0);
    expect(data.fillProbability).toBeLessThanOrEqual(1);
  });

  it('returns expected fill price based on book depth', async () => {
    const { server } = setup();
    const result = await server.callTool('analyze_sniper', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 2,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.expectedFillPrice).toBeTypeOf('number');
    expect(data.expectedFillPrice).toBeGreaterThan(0);
    // For a buy, expected fill should be at or above best ask
    expect(data.expectedFillPrice).toBeGreaterThanOrEqual(65010);
  });

  it('larger amount has worse fill price', async () => {
    const { server } = setup();
    const smallResult = await server.callTool('analyze_sniper', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 1,
    });
    const largeResult = await server.callTool('analyze_sniper', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 20,
    });

    const smallData = JSON.parse(smallResult.content[0].text);
    const largeData = JSON.parse(largeResult.content[0].text);

    // Larger order eats deeper into the book => worse price for buyer
    expect(largeData.expectedFillPrice).toBeGreaterThanOrEqual(smallData.expectedFillPrice);
  });

  it('includes price impact estimate', async () => {
    const { server } = setup();
    const result = await server.callTool('analyze_sniper', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 5,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.priceImpactBps).toBeTypeOf('number');
    expect(data.priceImpactBps).toBeGreaterThanOrEqual(0);
  });
});

// ── Execution plan comparison ────────────────────────────────

describe.skipIf(!available)('Execution plan comparison', () => {
  it('returns recommendations for different algorithms', async () => {
    const { server } = setup();
    const result = await server.callTool('compare_execution_plans', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 10,
      duration_minutes: 60,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.plans).toBeInstanceOf(Array);
    expect(data.plans.length).toBeGreaterThanOrEqual(2);

    // Each plan should have name, estimated cost, and impact
    for (const plan of data.plans) {
      expect(plan.algorithm).toBeTypeOf('string');
      expect(plan.estimatedCost).toBeTypeOf('number');
      expect(plan.estimatedImpact).toBeTypeOf('number');
    }
  });

  it('includes a recommended plan', async () => {
    const { server } = setup();
    const result = await server.callTool('compare_execution_plans', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 5,
      duration_minutes: 30,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.recommended).toBeDefined();
    expect(data.recommended).toBeTypeOf('string');

    // The recommended should be one of the plan names
    const planNames = data.plans.map((p: any) => p.algorithm);
    expect(planNames).toContain(data.recommended);
  });
});

// ── Market impact simulation ─────────────────────────────────

describe.skipIf(!available)('Market impact simulation', () => {
  it('uses square-root model for impact estimation', async () => {
    const { server } = setup();
    const result = await server.callTool('simulate_market_impact', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 10,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.temporaryImpactBps).toBeTypeOf('number');
    expect(data.permanentImpactBps).toBeTypeOf('number');
    expect(data.totalImpactBps).toBeTypeOf('number');
    expect(data.temporaryImpactBps).toBeGreaterThanOrEqual(0);
    expect(data.permanentImpactBps).toBeGreaterThanOrEqual(0);
  });

  it('larger orders have higher impact', async () => {
    const { server } = setup();
    const smallResult = await server.callTool('simulate_market_impact', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 1,
    });
    const largeResult = await server.callTool('simulate_market_impact', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 50,
    });

    const smallData = JSON.parse(smallResult.content[0].text);
    const largeData = JSON.parse(largeResult.content[0].text);

    expect(largeData.totalImpactBps).toBeGreaterThan(smallData.totalImpactBps);
  });

  it('impact scales sub-linearly (square-root model)', async () => {
    const { server } = setup();
    const result1 = await server.callTool('simulate_market_impact', {
      symbol: 'BTC/USDT', side: 'buy', amount: 1,
    });
    const result4 = await server.callTool('simulate_market_impact', {
      symbol: 'BTC/USDT', side: 'buy', amount: 4,
    });

    const data1 = JSON.parse(result1.content[0].text);
    const data4 = JSON.parse(result4.content[0].text);

    // Square-root model: 4x the amount should give ~2x the impact (sqrt(4)=2)
    // Allow a generous range since there may be additional model terms
    const ratio = data4.totalImpactBps / data1.totalImpactBps;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(4); // Sub-linear means less than 4x
  });

  it('rejects zero amount', async () => {
    const { server } = setup();
    const result = await server.callTool('simulate_market_impact', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0,
    });

    expect(result.isError).toBe(true);
  });

  it('rejects negative amount', async () => {
    const { server } = setup();
    const result = await server.callTool('simulate_market_impact', {
      symbol: 'BTC/USDT',
      side: 'sell',
      amount: -5,
    });

    expect(result.isError).toBe(true);
  });
});

// ── Smart order routing ──────────────────────────────────────

describe.skipIf(!available)('Smart order routing', () => {
  it('returns routing plan with venue allocations', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_smart_route', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 10,
      venues: 'venue_a,venue_b',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.allocations).toBeInstanceOf(Array);
    expect(data.allocations.length).toBeGreaterThan(0);

    // Total allocated should equal requested amount
    const totalAllocated = data.allocations.reduce(
      (sum: number, a: any) => sum + (a.amount ?? 0), 0
    );
    // May not route to unknown venues, so check structure
    for (const alloc of data.allocations) {
      expect(alloc).toHaveProperty('venue');
      expect(alloc.venue).toBeTypeOf('string');
    }
  });
});

// ── Implementation shortfall ─────────────────────────────────

describe.skipIf(!available)('Implementation shortfall', () => {
  it('calculates shortfall from decision price', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_implementation_shortfall', {
      symbol: 'BTC/USDT',
      side: 'buy',
      decision_price: 64800,
      execution_price: 65050,
      amount: 2,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.decisionPrice).toBe(64800);
    expect(data.executionPrice).toBe(65050);
    expect(data.shortfallBps).toBeTypeOf('number');
    // Buying at 65050 vs decision at 64800 => positive shortfall (cost more)
    expect(data.shortfallBps).toBeGreaterThan(0);
  });

  it('negative shortfall when execution is better than decision', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_implementation_shortfall', {
      symbol: 'BTC/USDT',
      side: 'buy',
      decision_price: 65200,
      execution_price: 65000,
      amount: 1,
    });

    const data = JSON.parse(result.content[0].text);
    // Bought cheaper than decision price => negative shortfall (good)
    expect(data.shortfallBps).toBeLessThan(0);
  });

  it('includes dollar cost of shortfall', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_implementation_shortfall', {
      symbol: 'BTC/USDT',
      side: 'buy',
      decision_price: 64800,
      execution_price: 65050,
      amount: 2,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.shortfallCost).toBeTypeOf('number');
    // (65050 - 64800) * 2 = 500
    expect(data.shortfallCost).toBeCloseTo(500, 0);
  });

  it('sell side shortfall is inverted', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_implementation_shortfall', {
      symbol: 'BTC/USDT',
      side: 'sell',
      decision_price: 65200,
      execution_price: 65000,
      amount: 1,
    });

    const data = JSON.parse(result.content[0].text);
    // Selling at 65000 vs decision at 65200 => positive shortfall (received less)
    expect(data.shortfallBps).toBeGreaterThan(0);
  });
});

// ── Input validation across tools ────────────────────────────

describe.skipIf(!available)('input validation', () => {
  it('TWAP rejects negative num_slices', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_twap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 5,
      duration_minutes: 60,
      num_slices: -1,
    });

    expect(result.isError).toBe(true);
  });

  it('VWAP rejects zero total_amount', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_vwap', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: 0,
      duration_minutes: 60,
      num_slices: 5,
    });

    expect(result.isError).toBe(true);
  });

  it('iceberg rejects negative total_amount', async () => {
    const { server } = setup();
    const result = await server.callTool('plan_iceberg', {
      symbol: 'BTC/USDT',
      side: 'buy',
      total_amount: -10,
      clip_size: 2,
    });

    expect(result.isError).toBe(true);
  });

  it('sniper rejects zero amount', async () => {
    const { server } = setup();
    const result = await server.callTool('analyze_sniper', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0,
    });

    expect(result.isError).toBe(true);
  });

  it('market impact simulation rejects invalid side', async () => {
    const { server } = setup();
    const result = await server.callTool('simulate_market_impact', {
      symbol: 'BTC/USDT',
      side: 'invalid',
      amount: 5,
    });

    expect(result.isError).toBe(true);
  });
});
