import { describe, it, expect } from 'vitest';
import {
  simulateOrderBookFill, analyzeDepthAtBands,
  computeOrderBookImbalance, analyzeOrderBookShape,
  computeWeightedMid, analyzeTradeFlow,
  computeMomentumScore, computeExecutionQuality, recommendEntry,
} from '@ai-fund/lib/execution-analytics';

// ── Order Book Fill Simulation ─────────────────────────────

describe('simulateOrderBookFill', () => {
  const asks: [number, number][] = [
    [100, 5], [101, 10], [102, 20],
  ];

  it('fills exactly at first level when amount <= top size', () => {
    const result = simulateOrderBookFill(asks, 3, 99.5);
    expect(result.filled).toBeCloseTo(3);
    expect(result.avgFillPrice).toBe(100);
  });

  it('walks the book for larger orders', () => {
    const result = simulateOrderBookFill(asks, 10, 99.5);
    // 5 @ 100 + 5 @ 101 = 1005, avg = 100.5
    expect(result.filled).toBeCloseTo(10);
    expect(result.avgFillPrice).toBe(100.5);
  });

  it('partial fill when book is thin', () => {
    const result = simulateOrderBookFill(asks, 50, 99.5);
    expect(result.filled).toBeCloseTo(35); // 5 + 10 + 20
  });

  it('slippage is positive for market orders walking the book', () => {
    const result = simulateOrderBookFill(asks, 15, 99.5);
    expect(result.slippagePct).toBeGreaterThan(0);
    expect(result.slippagePerUnit).toBeGreaterThan(0);
  });

  it('returns mid as avg price for empty book', () => {
    const result = simulateOrderBookFill([], 10, 100);
    expect(result.avgFillPrice).toBe(100);
    expect(result.filled).toBe(0);
  });
});

// ── Depth at Bands ─────────────────────────────────────────

describe('analyzeDepthAtBands', () => {
  const bids: [number, number][] = [
    [99, 10], [98, 20], [97, 30],
  ];
  const asks: [number, number][] = [
    [101, 15], [102, 25], [103, 35],
  ];
  const mid = 100;

  it('computes depth for each band', () => {
    const result = analyzeDepthAtBands(bids, asks, mid, [0.01, 0.02, 0.03]);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result['1.0%']).toBeDefined();
    expect(result['2.0%']).toBeDefined();
    expect(result['3.0%']).toBeDefined();
  });

  it('wider bands have more depth', () => {
    const result = analyzeDepthAtBands(bids, asks, mid, [0.01, 0.03]);
    expect(result['3.0%'].total).toBeGreaterThanOrEqual(result['1.0%'].total);
  });

  it('total is sum of bid and ask depth', () => {
    const result = analyzeDepthAtBands(bids, asks, mid, [0.02]);
    const band = result['2.0%'];
    expect(band.total).toBeCloseTo(band.bidDepth + band.askDepth);
  });
});

// ── Order Book Imbalance ───────────────────────────────────

describe('computeOrderBookImbalance', () => {
  it('returns positive imbalance when bids dominate', () => {
    const bids: [number, number][] = [[99, 100]];
    const asks: [number, number][] = [[101, 50]];
    const result = computeOrderBookImbalance(bids, asks);
    expect(result.imbalance).toBeGreaterThan(0);
    expect(result.bidVolume).toBeGreaterThan(result.askVolume);
  });

  it('returns negative imbalance when asks dominate', () => {
    const bids: [number, number][] = [[99, 10]];
    const asks: [number, number][] = [[101, 90]];
    const result = computeOrderBookImbalance(bids, asks);
    expect(result.imbalance).toBeLessThan(0);
  });

  it('returns 0 for balanced book', () => {
    const bids: [number, number][] = [[99, 50]];
    const asks: [number, number][] = [[101, 50]];
    const result = computeOrderBookImbalance(bids, asks);
    expect(result.imbalance).toBe(0);
  });

  it('returns 0 for empty book', () => {
    const result = computeOrderBookImbalance([], []);
    expect(result.imbalance).toBe(0);
  });
});

// ── Order Book Shape ───────────────────────────────────────

describe('analyzeOrderBookShape', () => {
  it('first level has ratioVsTop = 1', () => {
    const book: [number, number][] = [[100, 10], [101, 20], [102, 5]];
    const result = analyzeOrderBookShape(book);
    expect(result[0].ratioVsTop).toBe(1);
  });

  it('larger levels have ratio > 1', () => {
    const book: [number, number][] = [[100, 10], [101, 20]];
    const result = analyzeOrderBookShape(book);
    expect(result[1].ratioVsTop).toBe(2);
  });

  it('returns empty for empty book', () => {
    expect(analyzeOrderBookShape([])).toEqual([]);
  });
});

// ── Weighted Mid ───────────────────────────────────────────

describe('computeWeightedMid', () => {
  it('returns simple mid when sizes are equal', () => {
    expect(computeWeightedMid(99, 101, 10, 10)).toBe(100);
  });

  it('leans toward ask when bid size is larger', () => {
    const result = computeWeightedMid(99, 101, 100, 10);
    expect(result).toBeGreaterThan(100); // weighted toward ask
  });

  it('returns simple mid for zero sizes', () => {
    expect(computeWeightedMid(99, 101, 0, 0)).toBe(100);
  });
});

// ── Trade Flow Analysis ────────────────────────────────────

describe('analyzeTradeFlow', () => {
  it('detects strong buy pressure', () => {
    const trades = [
      { side: 'buy' as const, amount: 100 },
      { side: 'buy' as const, amount: 80 },
      { side: 'sell' as const, amount: 20 },
    ];
    const result = analyzeTradeFlow(trades);
    expect(result.signal).toBe('strong_buy_pressure');
    expect(result.buyCount).toBe(2);
    expect(result.sellCount).toBe(1);
  });

  it('detects strong sell pressure', () => {
    const trades = [
      { side: 'sell' as const, amount: 100 },
      { side: 'sell' as const, amount: 80 },
      { side: 'buy' as const, amount: 10 },
    ];
    const result = analyzeTradeFlow(trades);
    expect(result.signal).toBe('strong_sell_pressure');
  });

  it('detects neutral flow', () => {
    const trades = [
      { side: 'buy' as const, amount: 50 },
      { side: 'sell' as const, amount: 50 },
    ];
    const result = analyzeTradeFlow(trades);
    expect(result.signal).toBe('neutral');
    expect(result.imbalancePct).toBe(0);
  });

  it('detects large trades', () => {
    const trades = [
      { side: 'buy' as const, amount: 10 },
      { side: 'buy' as const, amount: 10 },
      { side: 'buy' as const, amount: 100 }, // large
    ];
    const result = analyzeTradeFlow(trades);
    expect(result.largeTrades.count).toBeGreaterThan(0);
  });

  it('handles empty trades', () => {
    const result = analyzeTradeFlow([]);
    expect(result.buyVolume).toBe(0);
    expect(result.sellVolume).toBe(0);
    expect(result.signal).toBe('neutral');
  });
});

// ── Momentum Score ─────────────────────────────────────────

describe('computeMomentumScore', () => {
  it('returns nulls for insufficient data', () => {
    const result = computeMomentumScore([100], [1000]);
    expect(result.change1Bar).toBeNull();
    expect(result.momentumScore).toBe(0);
  });

  it('computes positive momentum for rising prices', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + i);
    const volumes = Array.from({ length: 25 }, () => 1000);
    const result = computeMomentumScore(closes, volumes);
    expect(result.change1Bar).toBeGreaterThan(0);
    expect(result.momentumScore).toBeGreaterThan(0);
  });

  it('detects volume surge', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    const volumes = [
      ...Array(25).fill(100),
      ...Array(5).fill(500), // 5x volume surge
    ];
    const result = computeMomentumScore(closes, volumes);
    expect(result.volumeSurge).toBeGreaterThan(1);
  });

  it('change bars are null when not enough data', () => {
    const result = computeMomentumScore([100, 101, 102], [100, 200, 300]);
    expect(result.change1Bar).not.toBeNull();
    expect(result.change5Bar).toBeNull(); // need 6+ bars
    expect(result.change20Bar).toBeNull();
  });
});

// ── Execution Quality ──────────────────────────────────────

describe('computeExecutionQuality', () => {
  it('computes VWAP from fills', () => {
    const fills = [
      { price: 100, amount: 10 },
      { price: 101, amount: 10 },
    ];
    const result = computeExecutionQuality(fills, 100.5);
    expect(result.vwap).toBeCloseTo(100.5, 1);
    expect(result.avgFillPrice).toBe(100.5);
  });

  it('computes slippage in bps', () => {
    const fills = [{ price: 101, amount: 10 }];
    const result = computeExecutionQuality(fills, 100);
    expect(result.slippageBps).toBeGreaterThan(0);
  });

  it('counts maker and taker fills', () => {
    const fills = [
      { price: 100, amount: 5, takerOrMaker: 'maker' },
      { price: 101, amount: 5, takerOrMaker: 'taker' },
      { price: 102, amount: 5, takerOrMaker: 'taker' },
    ];
    const result = computeExecutionQuality(fills, 101);
    expect(result.makerCount).toBe(1);
    expect(result.takerCount).toBe(2);
  });

  it('returns zeros for empty fills', () => {
    const result = computeExecutionQuality([], 100);
    expect(result.vwap).toBe(0);
    expect(result.slippageBps).toBeUndefined();
  });

  it('undefined slippage when no mid price', () => {
    const fills = [{ price: 100, amount: 10 }];
    const result = computeExecutionQuality(fills, undefined);
    expect(result.slippageBps).toBeUndefined();
  });
});

// ── Entry Recommendation ───────────────────────────────────

describe('recommendEntry', () => {
  it('recommends limit near bid for low urgency buy', () => {
    const result = recommendEntry('buy', 100, 99, 101, 2, 200, 0.001, 'low');
    expect(result.orderType).toBe('limit');
    expect(result.price).toBeGreaterThan(99);
    expect(result.price!).toBeLessThan(100);
  });

  it('recommends limit near ask for low urgency sell', () => {
    const result = recommendEntry('sell', 100, 99, 101, 2, 200, 0.001, 'low');
    expect(result.orderType).toBe('limit');
    expect(result.price).toBeLessThan(101);
    expect(result.price!).toBeGreaterThan(100);
  });

  it('recommends limit at mid for medium urgency', () => {
    const result = recommendEntry('buy', 100, 99, 101, 2, 200, 0.001, 'medium');
    expect(result.orderType).toBe('limit');
    expect(result.price).toBe(100);
  });

  it('recommends market for high urgency', () => {
    const result = recommendEntry('buy', 100, 99, 101, 2, 200, 0.001, 'high');
    expect(result.orderType).toBe('market');
    expect(result.price).toBeNull();
  });
});
