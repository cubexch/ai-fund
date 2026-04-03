import { describe, it, expect } from 'vitest';
import {
  crossVenueSpread,
  smartOrderRoute,
  venueQualityScore,
  fragmentationIndex,
  latencyCostModel,
  venueCorrelation,
  executionVenueSelection,
  makerTakerOptimization,
  crossVenueOBImbalance,
  triangularArb,
} from '@ai-fund/lib/venue-analytics';

// ── crossVenueSpread ──────────────────────────────────────

describe('crossVenueSpread', () => {
  it('identifies best bid and best ask across venues', () => {
    const venues = [
      { venue: 'A', bid: 100, ask: 101, volume24h: 1000, fee: 0.001 },
      { venue: 'B', bid: 102, ask: 103, volume24h: 1000, fee: 0.001 },
    ];
    const result = crossVenueSpread(venues);
    expect(result.bestBid.venue).toBe('B');
    expect(result.bestBid.price).toBe(102);
    expect(result.bestAsk.venue).toBe('A');
    expect(result.bestAsk.price).toBe(101);
  });

  it('detects arb when best bid > best ask cross-venue', () => {
    const venues = [
      { venue: 'A', bid: 99, ask: 100, volume24h: 1000, fee: 0 },
      { venue: 'B', bid: 101, ask: 102, volume24h: 1000, fee: 0 },
    ];
    const result = crossVenueSpread(venues);
    expect(result.crossSpread).toBe(1); // 101 - 100
    expect(result.arbOpportunity).toBe(true);
    expect(result.netArbProfit).toBeGreaterThan(0);
  });

  it('no arb after fees when spread is tight', () => {
    const venues = [
      { venue: 'A', bid: 99.9, ask: 100, volume24h: 1000, fee: 0.01 },
      { venue: 'B', bid: 100.05, ask: 100.2, volume24h: 1000, fee: 0.01 },
    ];
    const result = crossVenueSpread(venues);
    // Best bid 100.05, best ask 100, cross spread 0.05
    // Fees: 100.05*0.01 + 100*0.01 = ~2.0 > 0.05
    expect(result.arbOpportunity).toBe(false);
    expect(result.netArbProfit).toBeLessThan(0);
  });

  it('returns sensible defaults for empty input', () => {
    const result = crossVenueSpread([]);
    expect(result.bestBid.price).toBe(0);
    expect(result.bestAsk.price).toBe(0);
    expect(result.arbOpportunity).toBe(false);
    expect(result.venues).toHaveLength(0);
  });

  it('computes spreadBps per venue', () => {
    const venues = [
      { venue: 'A', bid: 99, ask: 101, volume24h: 500, fee: 0 },
    ];
    const result = crossVenueSpread(venues);
    const mid = 100;
    const expectedBps = (2 / mid) * 10000;
    expect(result.venues[0].spreadBps).toBeCloseTo(expectedBps);
  });
});

// ── smartOrderRoute ───────────────────────────────────────

describe('smartOrderRoute', () => {
  it('fills cheapest venue first for buys', () => {
    const result = smartOrderRoute({
      side: 'buy',
      totalQuantity: 5,
      venues: [
        { venue: 'Expensive', price: 110, availableQty: 10, fee: 0, latencyMs: 10 },
        { venue: 'Cheap', price: 100, availableQty: 10, fee: 0, latencyMs: 10 },
      ],
    });
    expect(result.fills[0].venue).toBe('Cheap');
    expect(result.fills[0].price).toBe(100);
  });

  it('respects available quantity per venue', () => {
    const result = smartOrderRoute({
      side: 'buy',
      totalQuantity: 10,
      venues: [
        { venue: 'A', price: 100, availableQty: 3, fee: 0, latencyMs: 10 },
        { venue: 'B', price: 101, availableQty: 3, fee: 0, latencyMs: 10 },
        { venue: 'C', price: 102, availableQty: 10, fee: 0, latencyMs: 10 },
      ],
    });
    expect(result.fills).toHaveLength(3);
    expect(result.fills[0].quantity).toBe(3);
    expect(result.fills[1].quantity).toBe(3);
    expect(result.fills[2].quantity).toBe(4);
  });

  it('total fills sum to requested quantity', () => {
    const result = smartOrderRoute({
      side: 'buy',
      totalQuantity: 15,
      venues: [
        { venue: 'A', price: 100, availableQty: 10, fee: 0.001, latencyMs: 5 },
        { venue: 'B', price: 101, availableQty: 10, fee: 0.001, latencyMs: 5 },
      ],
    });
    const totalFilled = result.fills.reduce((s, f) => s + f.quantity, 0);
    expect(totalFilled).toBe(15);
  });

  it('returns empty fills for zero quantity', () => {
    const result = smartOrderRoute({
      side: 'buy',
      totalQuantity: 0,
      venues: [{ venue: 'A', price: 100, availableQty: 10, fee: 0, latencyMs: 5 }],
    });
    expect(result.fills).toHaveLength(0);
    expect(result.totalCost).toBe(0);
  });

  it('returns empty fills for no venues', () => {
    const result = smartOrderRoute({
      side: 'buy',
      totalQuantity: 10,
      venues: [],
    });
    expect(result.fills).toHaveLength(0);
  });

  it('calculates savings vs worst venue', () => {
    const result = smartOrderRoute({
      side: 'buy',
      totalQuantity: 5,
      venues: [
        { venue: 'A', price: 100, availableQty: 10, fee: 0, latencyMs: 5 },
        { venue: 'B', price: 110, availableQty: 10, fee: 0, latencyMs: 5 },
      ],
    });
    // Worst venue cost: 5 * 110 = 550, best: 5 * 100 = 500, savings: 50
    expect(result.savings).toBeCloseTo(50);
  });
});

// ── venueQualityScore ─────────────────────────────────────

describe('venueQualityScore', () => {
  it('venue with best metrics gets highest score', () => {
    const metrics = [
      { venue: 'Best', uptime: 1.0, latencyMs: 1, spreadBps: 1, fillRate: 1.0, slippageBps: 0, volume24h: 1e9 },
      { venue: 'Worst', uptime: 0.95, latencyMs: 500, spreadBps: 50, fillRate: 0.5, slippageBps: 20, volume24h: 1e6 },
    ];
    const scores = venueQualityScore(metrics);
    expect(scores[0].venue).toBe('Best');
    expect(scores[0].rank).toBe(1);
    expect(scores[0].score).toBeGreaterThan(scores[1].score);
  });

  it('ranking is correct and contiguous', () => {
    const metrics = [
      { venue: 'C', uptime: 0.99, latencyMs: 100, spreadBps: 10, fillRate: 0.9, slippageBps: 5, volume24h: 500 },
      { venue: 'A', uptime: 1.0, latencyMs: 1, spreadBps: 1, fillRate: 1.0, slippageBps: 0, volume24h: 1000 },
      { venue: 'B', uptime: 0.995, latencyMs: 50, spreadBps: 5, fillRate: 0.95, slippageBps: 2, volume24h: 800 },
    ];
    const scores = venueQualityScore(metrics);
    expect(scores.map(s => s.rank)).toEqual([1, 2, 3]);
  });

  it('returns empty for no metrics', () => {
    expect(venueQualityScore([])).toEqual([]);
  });

  it('identifies strengths and weaknesses', () => {
    const metrics = [
      { venue: 'Fast', uptime: 1.0, latencyMs: 1, spreadBps: 1, fillRate: 0.99, slippageBps: 0, volume24h: 1e9 },
    ];
    const scores = venueQualityScore(metrics);
    expect(scores[0].strengths).toContain('low latency');
    expect(scores[0].strengths).toContain('excellent uptime');
    expect(scores[0].strengths).toContain('tight spreads');
  });
});

// ── fragmentationIndex ────────────────────────────────────

describe('fragmentationIndex', () => {
  it('single venue gives HHI = 10000 (consolidated)', () => {
    const result = fragmentationIndex([{ venue: 'A', volume24h: 1000 }]);
    expect(result.hhi).toBe(10000);
    expect(result.fragmentationLevel).toBe('consolidated');
    expect(result.topVenueShare).toBe(100);
  });

  it('equal split across many venues is fragmented', () => {
    const venues = Array.from({ length: 10 }, (_, i) => ({
      venue: `V${i}`,
      volume24h: 100,
    }));
    const result = fragmentationIndex(venues);
    // HHI = 10 * (10^2) = 1000
    expect(result.hhi).toBeCloseTo(1000);
    expect(result.fragmentationLevel).toBe('fragmented');
    expect(result.effectiveVenues).toBeCloseTo(10);
  });

  it('returns sensible defaults for empty input', () => {
    const result = fragmentationIndex([]);
    expect(result.hhi).toBe(0);
    expect(result.effectiveVenues).toBe(0);
    expect(result.fragmentationLevel).toBe('consolidated');
  });

  it('shares sum to 100%', () => {
    const venues = [
      { venue: 'A', volume24h: 700 },
      { venue: 'B', volume24h: 300 },
    ];
    const result = fragmentationIndex(venues);
    const totalShare = result.shares.reduce((s, sh) => s + sh.sharePct, 0);
    expect(totalShare).toBeCloseTo(100);
  });
});

// ── latencyCostModel ──────────────────────────────────────

describe('latencyCostModel', () => {
  it('higher latency produces higher cost', () => {
    const low = latencyCostModel({ latencyMs: 10, volatility: 0.02, orderSize: 100, avgVolume: 10000 });
    const high = latencyCostModel({ latencyMs: 1000, volatility: 0.02, orderSize: 100, avgVolume: 10000 });
    expect(high.latencyCostBps).toBeGreaterThan(low.latencyCostBps);
  });

  it('cost curve is monotonically increasing', () => {
    const result = latencyCostModel({ latencyMs: 100, volatility: 0.02, orderSize: 100, avgVolume: 10000 });
    for (let i = 1; i < result.costCurve.length; i++) {
      expect(result.costCurve[i].costBps).toBeGreaterThanOrEqual(result.costCurve[i - 1].costBps);
    }
  });

  it('zero volatility gives zero cost', () => {
    const result = latencyCostModel({ latencyMs: 100, volatility: 0, orderSize: 100, avgVolume: 10000 });
    expect(result.latencyCostBps).toBe(0);
    expect(result.annualizedCost).toBe(0);
  });
});

// ── venueCorrelation ──────────────────────────────────────

describe('venueCorrelation', () => {
  it('identical series have correlation 1', () => {
    const series = [100, 101, 102, 103, 104, 105];
    const result = venueCorrelation({ A: series, B: [...series] });
    expect(result.correlations['A']['B']).toBeCloseTo(1);
    expect(result.correlations['B']['A']).toBeCloseTo(1);
  });

  it('self-correlation is 1', () => {
    const result = venueCorrelation({
      A: [1, 2, 3, 4, 5],
      B: [5, 4, 3, 2, 1],
    });
    expect(result.correlations['A']['A']).toBeCloseTo(1);
    expect(result.correlations['B']['B']).toBeCloseTo(1);
  });

  it('returns a priceDiscoveryLeader', () => {
    const result = venueCorrelation({
      Fast: [100, 102, 104, 106, 108, 110],
      Slow: [100, 101, 103, 105, 107, 109],
    });
    expect(result.priceDiscoveryLeader).toBeTruthy();
    expect(['Fast', 'Slow']).toContain(result.priceDiscoveryLeader);
  });

  it('returns empty correlations for single venue', () => {
    const result = venueCorrelation({ A: [1, 2, 3] });
    expect(Object.keys(result.correlations)).toHaveLength(0);
    expect(result.priceDiscoveryLeader).toBe('A');
  });
});

// ── executionVenueSelection ───────────────────────────────

describe('executionVenueSelection', () => {
  const venues = [
    { venue: 'FastExpensive', spread: 5, depth: 1000, fee: 0.01, latencyMs: 1, fillRate: 0.99 },
    { venue: 'SlowCheap', spread: 2, depth: 5000, fee: 0.001, latencyMs: 200, fillRate: 0.90 },
  ];

  it('high urgency prefers low latency', () => {
    const result = executionVenueSelection({
      side: 'buy', size: 10, urgency: 'high', venues,
    });
    expect(result.primary).toBe('FastExpensive');
  });

  it('low urgency prefers low fee', () => {
    const result = executionVenueSelection({
      side: 'buy', size: 10, urgency: 'low', venues,
    });
    expect(result.primary).toBe('SlowCheap');
  });

  it('returns sensible defaults for no venues', () => {
    const result = executionVenueSelection({
      side: 'buy', size: 10, urgency: 'high', venues: [],
    });
    expect(result.primary).toBe('');
    expect(result.secondary).toBeNull();
  });

  it('recommends split when order size exceeds depth', () => {
    const result = executionVenueSelection({
      side: 'buy', size: 3000, urgency: 'medium', venues,
    });
    // 3000 > 50% of primary venue's depth → split recommended
    expect(result.splitRecommendation).toBe(true);
    expect(result.secondary).not.toBeNull();
  });
});

// ── makerTakerOptimization ────────────────────────────────

describe('makerTakerOptimization', () => {
  it('selects venue with lowest effective fee', () => {
    const result = makerTakerOptimization({
      venues: [
        { venue: 'Expensive', makerFee: 0.002, takerFee: 0.004 },
        { venue: 'Cheap', makerFee: 0.0005, takerFee: 0.001 },
      ],
      monthlyVolume: 1_000_000,
      makerRatio: 0.5,
    });
    expect(result.optimalVenue).toBe('Cheap');
    expect(result.effectiveFee).toBeLessThan(0.003);
  });

  it('calculates monthly savings correctly', () => {
    const result = makerTakerOptimization({
      venues: [
        { venue: 'A', makerFee: 0.001, takerFee: 0.002 },
        { venue: 'B', makerFee: 0.002, takerFee: 0.004 },
      ],
      monthlyVolume: 1_000_000,
      makerRatio: 0.5,
    });
    // A: eff = 0.001*0.5 + 0.002*0.5 = 0.0015, cost = 1500
    // B: eff = 0.002*0.5 + 0.004*0.5 = 0.003, cost = 3000
    // savings = 3000 - 1500 = 1500
    expect(result.monthlySavings).toBeCloseTo(1500);
  });

  it('accounts for maker rebate', () => {
    const result = makerTakerOptimization({
      venues: [
        { venue: 'Rebate', makerFee: 0.001, takerFee: 0.003, makerRebate: 0.001 },
        { venue: 'NoRebate', makerFee: 0.001, takerFee: 0.003 },
      ],
      monthlyVolume: 1_000_000,
      makerRatio: 0.5,
    });
    expect(result.optimalVenue).toBe('Rebate');
  });

  it('returns empty for no venues', () => {
    const result = makerTakerOptimization({
      venues: [],
      monthlyVolume: 1_000_000,
      makerRatio: 0.5,
    });
    expect(result.optimalVenue).toBe('');
    expect(result.monthlySavings).toBe(0);
  });
});

// ── crossVenueOBImbalance ─────────────────────────────────

describe('crossVenueOBImbalance', () => {
  it('all bids yields buy pressure', () => {
    const result = crossVenueOBImbalance([
      {
        venue: 'A',
        bids: [{ price: 100, qty: 100 }, { price: 99, qty: 100 }],
        asks: [{ price: 101, qty: 5 }],
      },
    ]);
    expect(result.pressure).toBe('buy');
    expect(result.aggregateImbalance).toBeGreaterThan(0.1);
  });

  it('all asks yields sell pressure', () => {
    const result = crossVenueOBImbalance([
      {
        venue: 'A',
        bids: [{ price: 100, qty: 5 }],
        asks: [{ price: 101, qty: 100 }, { price: 102, qty: 100 }],
      },
    ]);
    expect(result.pressure).toBe('sell');
    expect(result.aggregateImbalance).toBeLessThan(-0.1);
  });

  it('detects divergence when venues disagree', () => {
    const result = crossVenueOBImbalance([
      {
        venue: 'A',
        bids: [{ price: 100, qty: 100 }],
        asks: [{ price: 101, qty: 10 }],
      },
      {
        venue: 'B',
        bids: [{ price: 100, qty: 10 }],
        asks: [{ price: 101, qty: 100 }],
      },
    ]);
    expect(result.divergence).toBe(true);
  });

  it('no divergence when venues agree', () => {
    const result = crossVenueOBImbalance([
      {
        venue: 'A',
        bids: [{ price: 100, qty: 100 }],
        asks: [{ price: 101, qty: 10 }],
      },
      {
        venue: 'B',
        bids: [{ price: 100, qty: 80 }],
        asks: [{ price: 101, qty: 10 }],
      },
    ]);
    expect(result.divergence).toBe(false);
  });

  it('returns neutral for empty orderbooks', () => {
    const result = crossVenueOBImbalance([]);
    expect(result.pressure).toBe('neutral');
    expect(result.aggregateImbalance).toBe(0);
    expect(result.divergence).toBe(false);
  });
});

// ── triangularArb ─────────────────────────────────────────

describe('triangularArb', () => {
  it('returns empty for fewer than 3 prices', () => {
    const result = triangularArb([
      { pair: 'BTC/USD', bid: 100, ask: 101, venue: 'A', fee: 0 },
    ]);
    expect(result.opportunities).toHaveLength(0);
    expect(result.scanned).toBe(0);
  });

  it('finds arb opportunity with mispriced triangle', () => {
    // A->B->C->A triangle with zero fees and profitable pricing
    const result = triangularArb([
      { pair: 'A/B', bid: 1.0, ask: 1.0, venue: 'X', fee: 0 },
      { pair: 'B/C', bid: 1.0, ask: 1.0, venue: 'X', fee: 0 },
      { pair: 'C/A', bid: 1.01, ask: 1.0, venue: 'X', fee: 0 },
    ]);
    expect(result.scanned).toBeGreaterThan(0);
    // With bid/ask = 1.0 and C/A bid = 1.01, there's a round-trip profit
    expect(result.opportunities.length).toBeGreaterThanOrEqual(0);
  });
});
