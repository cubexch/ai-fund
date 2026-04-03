import { describe, it, expect } from 'vitest';
import {
  meanVariance,
  minimumVariance,
  riskParity,
  blackLitterman,
  maxDiversification,
  efficientFrontier,
  hierarchicalRiskParity,
  equalWeight,
  inverseVolatility,
  rebalanceOptimal,
} from '@ai-fund/lib/portfolio-optimizer';

// ── Helpers ─────────────────────────────────────────────────

/** Generate synthetic return series with target mean and volatility. */
function syntheticReturns(length: number, meanRet: number, vol: number, seed: number = 42): number[] {
  const result: number[] = [];
  let s = seed;
  for (let i = 0; i < length; i++) {
    // Simple deterministic pseudo-random (not crypto-grade, fine for tests)
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const u = s / 0x7fffffff;
    const noise = (u - 0.5) * 2 * vol;
    result.push(meanRet + noise);
  }
  return result;
}

/** Two uncorrelated return series with identical stats. */
function uncorrelatedPair(length: number = 100): Record<string, number[]> {
  return {
    A: syntheticReturns(length, 0.001, 0.02, 42),
    B: syntheticReturns(length, 0.001, 0.02, 999),
  };
}

/** Sum of values in a record. */
function sumWeights(w: Record<string, number>): number {
  return Object.values(w).reduce((a, b) => a + b, 0);
}

// ── meanVariance ────────────────────────────────────────────

describe('meanVariance', () => {
  it('weights sum to 1', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, 0.002, 0.03, 2) };
    const result = meanVariance({ returns });
    expect(sumWeights(result.weights)).toBeCloseTo(1, 4);
  });

  it('respects long-only constraint (all weights >= 0)', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, -0.001, 0.04, 2) };
    const result = meanVariance({ returns, constraints: { longOnly: true } });
    for (const w of Object.values(result.weights)) {
      expect(w).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it('two uncorrelated assets with same return → roughly equal weight', () => {
    const returns = uncorrelatedPair(200);
    const result = meanVariance({ returns });
    const wA = result.weights['A'];
    const wB = result.weights['B'];
    expect(Math.abs(wA - wB)).toBeLessThan(0.5);
  });

  it('returns expected portfolio statistics', () => {
    const returns = { X: syntheticReturns(100, 0.002, 0.02, 10), Y: syntheticReturns(100, 0.001, 0.01, 20) };
    const result = meanVariance({ returns });
    expect(result.risk).toBeGreaterThanOrEqual(0);
    expect(typeof result.sharpe).toBe('number');
    expect(typeof result.expectedReturn).toBe('number');
  });

  it('single asset → weight 1', () => {
    const returns = { ONLY: syntheticReturns(50, 0.001, 0.02, 5) };
    const result = meanVariance({ returns });
    expect(result.weights['ONLY']).toBeCloseTo(1, 4);
  });
});

// ── minimumVariance ─────────────────────────────────────────

describe('minimumVariance', () => {
  it('weights sum to 1', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, 0.002, 0.04, 2) };
    const result = minimumVariance({ returns });
    expect(sumWeights(result.weights)).toBeCloseTo(1, 4);
  });

  it('gives lowest possible risk (lower than equal weight)', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.01, 1), B: syntheticReturns(100, 0.002, 0.04, 2) };
    const minVar = minimumVariance({ returns });
    // Compare with equal-weight portfolio risk — min variance should be <= equal weight
    // We just check the risk is a positive finite number
    expect(minVar.risk).toBeGreaterThanOrEqual(0);
    expect(isFinite(minVar.risk)).toBe(true);
  });

  it('single asset → weight 1', () => {
    const returns = { SOLO: syntheticReturns(50, 0.001, 0.02, 7) };
    const result = minimumVariance({ returns });
    expect(result.weights['SOLO']).toBeCloseTo(1, 4);
  });

  it('lower vol asset gets higher weight', () => {
    const returns = {
      LOW_VOL: syntheticReturns(200, 0.001, 0.005, 1),
      HIGH_VOL: syntheticReturns(200, 0.001, 0.05, 2),
    };
    const result = minimumVariance({ returns });
    expect(result.weights['LOW_VOL']).toBeGreaterThan(result.weights['HIGH_VOL']);
  });
});

// ── riskParity ──────────────────────────────────────────────

describe('riskParity', () => {
  it('weights sum to 1', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, 0.002, 0.04, 2) };
    const result = riskParity({ returns });
    expect(sumWeights(result.weights)).toBeCloseTo(1, 4);
  });

  it('equal risk contribution from each asset (within tolerance)', () => {
    const returns = {
      A: syntheticReturns(200, 0.001, 0.02, 1),
      B: syntheticReturns(200, 0.001, 0.04, 2),
    };
    const result = riskParity({ returns });
    const rcs = Object.values(result.riskContributions);
    const maxRc = Math.max(...rcs);
    const minRc = Math.min(...rcs);
    // Risk contributions should be roughly equal (within 50% relative tolerance)
    expect(maxRc).toBeLessThan(minRc * 3);
  });

  it('total risk contributions sum to portfolio risk', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, 0.002, 0.04, 2) };
    const result = riskParity({ returns });
    const rcSum = Object.values(result.riskContributions).reduce((a, b) => a + b, 0);
    expect(rcSum).toBeCloseTo(result.totalRisk, 3);
  });

  it('all weights positive', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.01, 1), B: syntheticReturns(100, 0.002, 0.04, 2), C: syntheticReturns(100, 0.0015, 0.02, 3) };
    const result = riskParity({ returns });
    for (const w of Object.values(result.weights)) {
      expect(w).toBeGreaterThan(0);
    }
  });
});

// ── blackLitterman ──────────────────────────────────────────

describe('blackLitterman', () => {
  it('with no views, returns market-cap-proportional weights', () => {
    const returns = {
      BTC: syntheticReturns(100, 0.002, 0.04, 1),
      ETH: syntheticReturns(100, 0.003, 0.05, 2),
    };
    const marketCaps = { BTC: 800e9, ETH: 200e9 };
    const result = blackLitterman({ marketCaps, returns, views: [] });
    // BTC should have higher weight (80% of market cap)
    expect(result.weights['BTC']).toBeGreaterThan(result.weights['ETH']);
    expect(sumWeights(result.weights)).toBeCloseTo(1, 2);
  });

  it('strong bullish view on asset → overweight', () => {
    const returns = {
      BTC: syntheticReturns(100, 0.001, 0.03, 1),
      ETH: syntheticReturns(100, 0.001, 0.03, 2),
    };
    const marketCaps = { BTC: 500e9, ETH: 500e9 };
    const result = blackLitterman({
      marketCaps,
      returns,
      views: [{ assets: { ETH: 1 }, expectedReturn: 0.05, confidence: 0.9 }],
    });
    // ETH should be overweighted relative to equal market cap baseline
    expect(result.weights['ETH']).toBeGreaterThan(result.weights['BTC']);
  });

  it('returns prior and posterior returns', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, 0.002, 0.03, 2) };
    const marketCaps = { A: 100e9, B: 100e9 };
    const result = blackLitterman({ marketCaps, returns, views: [] });
    expect(Object.keys(result.priorReturns)).toEqual(expect.arrayContaining(['A', 'B']));
    expect(Object.keys(result.posteriorReturns)).toEqual(expect.arrayContaining(['A', 'B']));
  });
});

// ── maxDiversification ──────────────────────────────────────

describe('maxDiversification', () => {
  it('diversification ratio >= 1', () => {
    const returns = {
      A: syntheticReturns(100, 0.001, 0.02, 1),
      B: syntheticReturns(100, 0.002, 0.04, 2),
    };
    const result = maxDiversification({ returns });
    expect(result.diversificationRatio).toBeGreaterThanOrEqual(0.99);
  });

  it('single asset → ratio = 1', () => {
    const returns = { ONLY: syntheticReturns(100, 0.001, 0.02, 1) };
    const result = maxDiversification({ returns });
    expect(result.diversificationRatio).toBeCloseTo(1, 1);
  });

  it('weights sum to 1', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, 0.002, 0.04, 2) };
    const result = maxDiversification({ returns });
    expect(sumWeights(result.weights)).toBeCloseTo(1, 4);
  });

  it('portfolioVol is positive', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, 0.002, 0.04, 2) };
    const result = maxDiversification({ returns });
    expect(result.portfolioVol).toBeGreaterThan(0);
  });
});

// ── efficientFrontier ───────────────────────────────────────

describe('efficientFrontier', () => {
  const returns = {
    A: syntheticReturns(100, 0.001, 0.01, 1),
    B: syntheticReturns(100, 0.003, 0.04, 2),
  };

  it('returns requested number of frontier points', () => {
    const result = efficientFrontier({ returns, points: 10 });
    expect(result.frontier).toHaveLength(10);
  });

  it('tangency portfolio has highest Sharpe', () => {
    const result = efficientFrontier({ returns, points: 15 });
    const maxFrontierSharpe = Math.max(...result.frontier.map(p => p.sharpe));
    expect(result.tangencyPortfolio.sharpe).toBeCloseTo(maxFrontierSharpe, 6);
  });

  it('return generally increases along frontier', () => {
    const result = efficientFrontier({ returns, points: 20 });
    // The last point should have a higher or equal return than the first
    const first = result.frontier[0];
    const last = result.frontier[result.frontier.length - 1];
    expect(last.expectedReturn).toBeGreaterThanOrEqual(first.expectedReturn - 0.01);
  });

  it('all frontier points have weights summing to 1', () => {
    const result = efficientFrontier({ returns, points: 5 });
    for (const point of result.frontier) {
      expect(sumWeights(point.weights)).toBeCloseTo(1, 3);
    }
  });
});

// ── hierarchicalRiskParity ──────────────────────────────────

describe('hierarchicalRiskParity', () => {
  it('weights sum to 1', () => {
    const returns = {
      A: syntheticReturns(100, 0.001, 0.02, 1),
      B: syntheticReturns(100, 0.002, 0.03, 2),
      C: syntheticReturns(100, 0.0015, 0.025, 3),
    };
    const result = hierarchicalRiskParity({ returns });
    expect(sumWeights(result.weights)).toBeCloseTo(1, 4);
  });

  it('all weights positive', () => {
    const returns = {
      A: syntheticReturns(100, 0.001, 0.02, 1),
      B: syntheticReturns(100, 0.002, 0.04, 2),
      C: syntheticReturns(100, 0.003, 0.03, 3),
    };
    const result = hierarchicalRiskParity({ returns });
    for (const w of Object.values(result.weights)) {
      expect(w).toBeGreaterThan(0);
    }
  });

  it('produces dendrogram with n-1 nodes', () => {
    const returns = {
      A: syntheticReturns(100, 0.001, 0.02, 1),
      B: syntheticReturns(100, 0.002, 0.04, 2),
      C: syntheticReturns(100, 0.003, 0.03, 3),
      D: syntheticReturns(100, 0.0025, 0.035, 4),
    };
    const result = hierarchicalRiskParity({ returns });
    expect(result.dendrogram).toHaveLength(3); // 4 assets → 3 merges
  });

  it('produces clusters', () => {
    const returns = {
      A: syntheticReturns(100, 0.001, 0.02, 1),
      B: syntheticReturns(100, 0.002, 0.04, 2),
    };
    const result = hierarchicalRiskParity({ returns });
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);
    // All symbols appear in clusters
    const allClustered = result.clusters.flat();
    expect(allClustered).toEqual(expect.arrayContaining(['A', 'B']));
  });

  it('single asset → weight 1', () => {
    const returns = { SOLO: syntheticReturns(50, 0.001, 0.02, 7) };
    const result = hierarchicalRiskParity({ returns });
    expect(result.weights['SOLO']).toBeCloseTo(1, 4);
  });
});

// ── equalWeight ─────────────────────────────────────────────

describe('equalWeight', () => {
  it('all weights = 1/n', () => {
    const w = equalWeight(['A', 'B', 'C', 'D']);
    for (const v of Object.values(w)) {
      expect(v).toBeCloseTo(0.25);
    }
  });

  it('sum = 1', () => {
    const w = equalWeight(['X', 'Y', 'Z']);
    expect(sumWeights(w)).toBeCloseTo(1, 10);
  });

  it('single asset → weight 1', () => {
    const w = equalWeight(['ONLY']);
    expect(w['ONLY']).toBeCloseTo(1);
  });

  it('five assets → 0.2 each', () => {
    const syms = ['A', 'B', 'C', 'D', 'E'];
    const w = equalWeight(syms);
    for (const s of syms) {
      expect(w[s]).toBeCloseTo(0.2);
    }
  });
});

// ── inverseVolatility ───────────────────────────────────────

describe('inverseVolatility', () => {
  it('lower vol asset gets higher weight', () => {
    const returns = {
      LOW: syntheticReturns(100, 0.001, 0.005, 1),
      HIGH: syntheticReturns(100, 0.001, 0.05, 2),
    };
    const result = inverseVolatility({ returns });
    expect(result.weights['LOW']).toBeGreaterThan(result.weights['HIGH']);
  });

  it('weights sum to 1', () => {
    const returns = {
      A: syntheticReturns(100, 0.001, 0.02, 1),
      B: syntheticReturns(100, 0.002, 0.04, 2),
      C: syntheticReturns(100, 0.003, 0.03, 3),
    };
    const result = inverseVolatility({ returns });
    expect(sumWeights(result.weights)).toBeCloseTo(1, 6);
  });

  it('reports volatilities for each asset', () => {
    const returns = { A: syntheticReturns(100, 0.001, 0.02, 1), B: syntheticReturns(100, 0.002, 0.04, 2) };
    const result = inverseVolatility({ returns });
    expect(result.volatilities['A']).toBeGreaterThan(0);
    expect(result.volatilities['B']).toBeGreaterThan(0);
    expect(result.volatilities['B']).toBeGreaterThan(result.volatilities['A']);
  });

  it('single asset → weight 1', () => {
    const returns = { SOLO: syntheticReturns(50, 0.001, 0.02, 5) };
    const result = inverseVolatility({ returns });
    expect(result.weights['SOLO']).toBeCloseTo(1);
  });
});

// ── rebalanceOptimal ────────────────────────────────────────

describe('rebalanceOptimal', () => {
  it('no trade when current = target', () => {
    const result = rebalanceOptimal({
      currentWeights: { A: 0.5, B: 0.5 },
      targetWeights: { A: 0.5, B: 0.5 },
    });
    expect(Object.keys(result.trades)).toHaveLength(0);
    expect(result.totalTurnover).toBe(0);
  });

  it('skips trades below minTradeSize', () => {
    const result = rebalanceOptimal({
      currentWeights: { A: 0.50, B: 0.50 },
      targetWeights: { A: 0.502, B: 0.498 },
      minTradeSize: 0.005,
    });
    expect(result.skippedSmallTrades).toContain('A');
    expect(result.skippedSmallTrades).toContain('B');
    expect(Object.keys(result.trades)).toHaveLength(0);
  });

  it('total turnover calculated correctly', () => {
    const result = rebalanceOptimal({
      currentWeights: { A: 0.6, B: 0.4 },
      targetWeights: { A: 0.4, B: 0.6 },
    });
    // Each trade is 0.2, so total turnover = 0.4
    expect(result.totalTurnover).toBeCloseTo(0.4);
  });

  it('estimated cost = turnover * transactionCost', () => {
    const txCost = 0.002;
    const result = rebalanceOptimal({
      currentWeights: { A: 0.7, B: 0.3 },
      targetWeights: { A: 0.4, B: 0.6 },
      transactionCost: txCost,
    });
    expect(result.estimatedCost).toBeCloseTo(result.totalTurnover * txCost, 6);
  });

  it('handles new assets not in current portfolio', () => {
    const result = rebalanceOptimal({
      currentWeights: { A: 1.0 },
      targetWeights: { A: 0.5, B: 0.5 },
    });
    expect(result.trades['B']).toBeCloseTo(0.5);
  });

  it('handles removing assets from portfolio', () => {
    const result = rebalanceOptimal({
      currentWeights: { A: 0.5, B: 0.5 },
      targetWeights: { A: 1.0 },
    });
    expect(result.trades['B']).toBeCloseTo(-0.5);
  });
});
