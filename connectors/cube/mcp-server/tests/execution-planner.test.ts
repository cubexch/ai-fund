import { describe, it, expect } from 'vitest';
import {
  planTwap,
  planVwap,
  planIceberg,
  estimateMarketImpact,
  realizedVolatility,
  compareExecutionPlans,
  analyzeSniper,
  calculateImplementationShortfall,
} from '@ai-fund/lib/execution-planner';

// ── TWAP ──────────────────────────────────────────────────

describe('planTwap', () => {
  const base = {
    totalAmount: 10,
    durationMinutes: 60,
    numSlices: 12,
    currentPrice: 60000,
    dailyVolume: 1000,
    nowMs: 0,
  };

  it('splits order into equal slices', () => {
    const plan = planTwap(base);
    expect(plan.slices).toHaveLength(12);
    expect(plan.slices.every(s => s.amount === 10 / 12)).toBe(true);
  });

  it('spaces slices at equal intervals', () => {
    const plan = planTwap(base);
    const expectedInterval = (60 * 60 * 1000) / 12;
    expect(plan.intervalMs).toBe(expectedInterval);
    expect(plan.slices[0].scheduledTime).toBe(0);
    expect(plan.slices[1].scheduledTime).toBe(expectedInterval);
  });

  it('preserves total amount across slices', () => {
    const plan = planTwap(base);
    const total = plan.slices.reduce((s, sl) => s + sl.amount, 0);
    expect(total).toBeCloseTo(10);
  });

  it('estimates market impact from participation rate', () => {
    const plan = planTwap(base);
    expect(plan.estimatedImpact).toBeGreaterThan(0);
    // participation = 10/1000 = 0.01, impact = sqrt(0.01)*100 = 10
    expect(plan.estimatedImpact).toBeCloseTo(10, 0);
  });

  it('sequences slices starting from 1', () => {
    const plan = planTwap(base);
    expect(plan.slices[0].sequence).toBe(1);
    expect(plan.slices[11].sequence).toBe(12);
  });
});

// ── VWAP ──────────────────────────────────────────────────

describe('planVwap', () => {
  it('weights slices by volume', () => {
    const plan = planVwap({
      totalAmount: 10,
      durationMinutes: 30,
      numSlices: 3,
      bars: [
        { volume: 100 }, { volume: 100 },   // bucket 1: 200
        { volume: 300 }, { volume: 300 },   // bucket 2: 600
        { volume: 200 }, { volume: 200 },   // bucket 3: 400
      ],
      nowMs: 0,
    });

    expect(plan.slices).toHaveLength(3);
    // Total volume: 1200. Weights: 200/1200, 600/1200, 400/1200
    expect(plan.slices[1].amount).toBeGreaterThan(plan.slices[0].amount);
    expect(plan.slices[1].amount).toBeGreaterThan(plan.slices[2].amount);
  });

  it('preserves total amount', () => {
    const plan = planVwap({
      totalAmount: 5,
      durationMinutes: 30,
      numSlices: 3,
      bars: [{ volume: 10 }, { volume: 20 }, { volume: 30 }],
      nowMs: 0,
    });
    const total = plan.slices.reduce((s, sl) => s + sl.amount, 0);
    expect(total).toBeCloseTo(5);
  });

  it('handles empty volume bars gracefully', () => {
    const plan = planVwap({
      totalAmount: 5,
      durationMinutes: 10,
      numSlices: 2,
      bars: [{ volume: 0 }, { volume: 0 }],
      nowMs: 0,
    });
    // Should still produce slices with fallback minimum volume
    expect(plan.slices).toHaveLength(2);
    expect(plan.slices[0].amount).toBeGreaterThan(0);
  });

  it('volume weights sum to 1', () => {
    const plan = planVwap({
      totalAmount: 10,
      durationMinutes: 20,
      numSlices: 4,
      bars: [{ volume: 1 }, { volume: 2 }, { volume: 3 }, { volume: 4 }],
      nowMs: 0,
    });
    const totalWeight = plan.slices.reduce((s, sl) => s + sl.volumeWeight, 0);
    expect(totalWeight).toBeCloseTo(1);
  });
});

// ── Iceberg ───────────────────────────────────────────────

describe('planIceberg', () => {
  it('splits order into equal clips with remainder', () => {
    const plan = planIceberg({ totalAmount: 10, clipSize: 3 });
    expect(plan.numClips).toBe(4); // 3 full + 1 remainder
    expect(plan.clips[0].amount).toBe(3);
    expect(plan.clips[3].amount).toBeCloseTo(1);
  });

  it('handles exact division', () => {
    const plan = planIceberg({ totalAmount: 9, clipSize: 3 });
    expect(plan.numClips).toBe(3);
    expect(plan.clips.every(c => c.amount === 3)).toBe(true);
  });

  it('handles clipSize >= totalAmount', () => {
    const plan = planIceberg({ totalAmount: 5, clipSize: 10 });
    expect(plan.numClips).toBe(1);
    expect(plan.clips[0].amount).toBe(5);
  });

  it('sequences clips starting from 1', () => {
    const plan = planIceberg({ totalAmount: 6, clipSize: 2 });
    expect(plan.clips.map(c => c.sequence)).toEqual([1, 2, 3]);
  });
});

// ── Market Impact ─────────────────────────────────────────

describe('estimateMarketImpact', () => {
  it('returns finite impact for valid inputs', () => {
    const result = estimateMarketImpact({
      amount: 10,
      dailyVolume: 1000,
      volatility: 0.02,
      price: 60000,
    });
    expect(result.temporaryImpactBps).toBeGreaterThan(0);
    expect(result.permanentImpactBps).toBeGreaterThan(0);
    expect(result.totalImpactBps).toBeCloseTo(result.temporaryImpactBps + result.permanentImpactBps, 1);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('returns NaN for zero daily volume', () => {
    const result = estimateMarketImpact({
      amount: 10,
      dailyVolume: 0,
      volatility: 0.02,
      price: 60000,
    });
    expect(result.temporaryImpactBps).toBeNaN();
  });

  it('higher participation means higher impact', () => {
    const small = estimateMarketImpact({ amount: 1, dailyVolume: 1000, volatility: 0.02, price: 100 });
    const large = estimateMarketImpact({ amount: 100, dailyVolume: 1000, volatility: 0.02, price: 100 });
    expect(large.totalImpactBps).toBeGreaterThan(small.totalImpactBps);
  });
});

// ── Realized Volatility ───────────────────────────────────

describe('realizedVolatility', () => {
  it('returns 0.02 default for insufficient data', () => {
    expect(realizedVolatility([])).toBe(0.02);
    expect(realizedVolatility([100])).toBe(0.02);
  });

  it('returns 0 for constant prices', () => {
    expect(realizedVolatility([100, 100, 100, 100])).toBe(0);
  });

  it('returns positive for varying prices', () => {
    expect(realizedVolatility([100, 105, 95, 102, 98])).toBeGreaterThan(0);
  });
});

// ── Execution Plan Comparison ─────────────────────────────

describe('compareExecutionPlans', () => {
  it('returns three plan estimates', () => {
    const result = compareExecutionPlans({
      totalAmount: 10,
      durationMinutes: 60,
      price: 60000,
      dailyVolume: 1000,
      spreadBps: 5,
    });
    expect(result.plans).toHaveLength(3);
    expect(result.plans.map(p => p.algorithm).sort()).toEqual(['iceberg', 'twap', 'vwap']);
  });

  it('recommends the lowest cost plan', () => {
    const result = compareExecutionPlans({
      totalAmount: 10,
      durationMinutes: 60,
      price: 60000,
      dailyVolume: 1000,
      spreadBps: 5,
    });
    const costs = result.plans.map(p => p.estimatedCost);
    // Plans are sorted by cost — first is recommended
    expect(result.recommended).toBe(result.plans[0].algorithm);
    expect(costs[0]).toBeLessThanOrEqual(costs[1]);
  });
});

// ── Sniper ────────────────────────────────────────────────

describe('analyzeSniper', () => {
  it('fills completely when book has enough depth', () => {
    const result = analyzeSniper({
      amount: 5,
      levels: [[100, 3], [101, 3], [102, 5]],
      bestPrice: 100,
    });
    expect(result.fillProbability).toBe(1);
    expect(result.expectedFillPrice).toBeGreaterThanOrEqual(100);
  });

  it('partial fill when book is thin', () => {
    const result = analyzeSniper({
      amount: 10,
      levels: [[100, 3], [101, 2]],
      bestPrice: 100,
    });
    expect(result.fillProbability).toBe(0.5); // 5/10
    expect(result.levelsConsumed).toBe(2);
  });

  it('computes price impact in bps', () => {
    const result = analyzeSniper({
      amount: 5,
      levels: [[100, 2], [105, 5]],
      bestPrice: 100,
    });
    expect(result.priceImpactBps).toBeGreaterThan(0);
  });
});

// ── Implementation Shortfall ──────────────────────────────

describe('calculateImplementationShortfall', () => {
  it('positive shortfall when buy execution is worse', () => {
    const result = calculateImplementationShortfall({
      side: 'buy',
      decisionPrice: 100,
      executionPrice: 102,
      amount: 10,
    });
    expect(result.shortfallBps).toBeGreaterThan(0);
    expect(result.shortfallCost).toBeGreaterThan(0);
  });

  it('negative shortfall when buy execution is better', () => {
    const result = calculateImplementationShortfall({
      side: 'buy',
      decisionPrice: 100,
      executionPrice: 98,
      amount: 10,
    });
    expect(result.shortfallBps).toBeLessThan(0);
  });

  it('positive shortfall when sell execution is worse', () => {
    const result = calculateImplementationShortfall({
      side: 'sell',
      decisionPrice: 100,
      executionPrice: 98,
      amount: 10,
    });
    expect(result.shortfallBps).toBeGreaterThan(0);
  });

  it('zero shortfall when prices match', () => {
    const result = calculateImplementationShortfall({
      side: 'buy',
      decisionPrice: 100,
      executionPrice: 100,
      amount: 10,
    });
    expect(result.shortfallBps).toBe(0);
    expect(result.shortfallCost).toBe(0);
  });
});
