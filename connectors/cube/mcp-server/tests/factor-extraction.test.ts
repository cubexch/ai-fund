import { describe, it, expect } from 'vitest';
import {
  pcaFactors, factorExposure, factorAttribution,
  computeFactorReturns, styleAnalysis,
} from '@ai-fund/lib/factor-extraction';

// ── PCA Factors ────────────────────────────────────────────

describe('pcaFactors', () => {
  it('returns empty result for empty input', () => {
    const result = pcaFactors({});
    expect(result.factors).toHaveLength(0);
    expect(result.totalVarianceExplained).toBe(0);
  });

  it('returns empty for single-observation series', () => {
    const result = pcaFactors({ A: [0.01], B: [0.02] });
    expect(result.factors).toHaveLength(0);
  });

  it('extracts factors from correlated series', () => {
    // Two highly correlated series should have one dominant factor
    const n = 50;
    const A = Array.from({ length: n }, (_, i) => Math.sin(i / 5) * 0.01);
    const B = A.map(v => v * 0.8 + 0.001); // correlated with A
    const result = pcaFactors({ A, B }, 2);
    expect(result.factors.length).toBeGreaterThan(0);
    expect(result.factors[0].eigenvalue).toBeGreaterThan(0);
    expect(result.factors[0].varianceExplained).toBeGreaterThan(0.5);
    expect(result.totalVarianceExplained).toBeGreaterThan(0);
    expect(result.totalVarianceExplained).toBeLessThanOrEqual(1.001); // small numerical tolerance
  });

  it('loadings have entries for all symbols', () => {
    const A = [0.01, -0.02, 0.03, 0.01, -0.01];
    const B = [-0.01, 0.02, -0.03, -0.01, 0.01];
    const result = pcaFactors({ A, B }, 1);
    expect(result.factors[0].loadings).toHaveProperty('A');
    expect(result.factors[0].loadings).toHaveProperty('B');
  });

  it('residual variance is non-negative for each asset', () => {
    const A = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02, -0.03];
    const B = [-0.01, 0.02, -0.01, 0.03, -0.02, 0.01, -0.01];
    const C = [0.02, 0.01, -0.01, 0.02, 0.03, -0.02, 0.01];
    const result = pcaFactors({ A, B, C }, 2);
    for (const sym of ['A', 'B', 'C']) {
      expect(result.residualVariance[sym]).toBeGreaterThanOrEqual(0);
    }
  });

  it('limits factors to numFactors parameter', () => {
    const data: Record<string, number[]> = {};
    for (let i = 0; i < 5; i++) {
      data[`S${i}`] = Array.from({ length: 20 }, () => Math.random() * 0.02 - 0.01);
    }
    const result = pcaFactors(data, 2);
    expect(result.factors.length).toBeLessThanOrEqual(2);
  });
});

// ── Factor Exposure ────────────────────────────────────────

describe('factorExposure', () => {
  it('returns empty for empty inputs', () => {
    const result = factorExposure([], []);
    expect(result.betas).toHaveLength(0);
    expect(result.rSquared).toBe(0);
  });

  it('computes beta for a single factor', () => {
    // Asset = 2 * market + noise
    const market = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.01, 0.02, -0.01, 0.03];
    const asset = market.map(m => 2 * m + 0.001);
    const result = factorExposure(asset, [market]);
    expect(result.betas[0]).toBeCloseTo(2, 1);
    expect(result.rSquared).toBeGreaterThan(0.9);
  });

  it('alpha is non-zero for asset with excess return', () => {
    const market = [0.01, -0.01, 0.02, -0.02, 0.01, 0.03, -0.01, 0.02, -0.03, 0.01];
    const asset = market.map(m => m + 0.005); // constant alpha
    const result = factorExposure(asset, [market]);
    expect(result.alpha).toBeGreaterThan(0);
  });

  it('rSquared is between 0 and 1', () => {
    const factor1 = [0.01, -0.02, 0.03, -0.01, 0.02, -0.01, 0.01, -0.02];
    const factor2 = [-0.01, 0.01, 0.02, -0.03, 0.01, 0.02, -0.01, 0.01];
    const asset = [0.02, -0.01, 0.04, -0.02, 0.03, 0.01, 0.00, -0.01];
    const result = factorExposure(asset, [factor1, factor2]);
    expect(result.rSquared).toBeGreaterThanOrEqual(0);
    expect(result.rSquared).toBeLessThanOrEqual(1);
  });
});

// ── Factor Attribution ─────────────────────────────────────

describe('factorAttribution', () => {
  it('decomposes return into factor + specific', () => {
    const portfolio = [0.01, 0.02, -0.01, 0.03, 0.01];
    const market = [0.005, 0.01, -0.005, 0.015, 0.005];
    const result = factorAttribution(portfolio, [market], ['market']);
    expect(result.factorContributions).toHaveLength(1);
    expect(result.factorContributions[0].factor).toBe('market');
    expect(typeof result.specificReturn).toBe('number');
    // totalReturn = sum of portfolio returns
    const expectedTotal = 0.01 + 0.02 - 0.01 + 0.03 + 0.01;
    expect(result.totalReturn).toBeCloseTo(expectedTotal, 10);
  });

  it('specific return + factor contributions ≈ total return', () => {
    const portfolio = [0.02, -0.01, 0.03, 0.01, -0.02, 0.04];
    const f1 = [0.01, -0.005, 0.02, 0.005, -0.01, 0.02];
    const f2 = [0.005, 0.01, -0.01, 0.02, 0.005, -0.005];
    const result = factorAttribution(portfolio, [f1, f2], ['f1', 'f2']);
    const factorTotal = result.factorContributions.reduce((s, fc) => s + fc.contribution, 0);
    expect(factorTotal + result.specificReturn).toBeCloseTo(result.totalReturn, 5);
  });
});

// ── Compute Factor Returns ─────────────────────────────────

describe('computeFactorReturns', () => {
  it('returns market factor unchanged', () => {
    const returns = {
      A: [0.01, 0.02, 0.03],
      B: [-0.01, 0.01, -0.02],
    };
    const chars = {
      A: { marketCap: 1000, bookToMarket: 0.5 },
      B: { marketCap: 100, bookToMarket: 1.5 },
    };
    const market = [0.005, 0.015, 0.005];
    const result = computeFactorReturns(returns, chars, market);
    expect(result.market).toEqual(market);
  });

  it('SMB factor: small minus big', () => {
    const returns = {
      Small: [0.10, 0.05],
      Big: [0.02, 0.01],
    };
    const chars = {
      Small: { marketCap: 100 },
      Big: { marketCap: 10000 },
    };
    const market = [0.06, 0.03];
    const result = computeFactorReturns(returns, chars, market);
    // SMB = Small - Big = [0.10-0.02, 0.05-0.01] = [0.08, 0.04]
    expect(result.smb[0]).toBeCloseTo(0.08, 10);
    expect(result.smb[1]).toBeCloseTo(0.04, 10);
  });

  it('returns zeros for insufficient data', () => {
    const result = computeFactorReturns({ A: [0.01] }, { A: { marketCap: 100 } }, [0.01]);
    expect(result.smb).toEqual([0]);
    expect(result.hml).toEqual([0]);
  });
});

// ── Style Analysis ─────────────────────────────────────────

describe('styleAnalysis', () => {
  it('returns empty for no benchmarks', () => {
    const result = styleAnalysis([0.01, 0.02], {});
    expect(result.rSquared).toBe(0);
    expect(result.dominantStyle).toBe('');
  });

  it('identifies dominant style', () => {
    // Fund that perfectly tracks "growth" benchmark
    const growth = [0.01, 0.02, -0.01, 0.03, 0.01, -0.02, 0.02, 0.01, 0.03, -0.01];
    const value = [0.005, -0.01, 0.02, -0.005, 0.01, 0.005, -0.01, 0.02, -0.01, 0.01];
    const fund = growth.map(g => g + 0.001); // small tracking error
    const result = styleAnalysis(fund, { growth, value });
    expect(result.dominantStyle).toBe('growth');
    expect(result.rSquared).toBeGreaterThan(0.2);
  });

  it('constrained weights are non-negative', () => {
    const fund = [0.01, 0.02, -0.01, 0.03, 0.01];
    const b1 = [0.005, 0.01, -0.005, 0.015, 0.005];
    const b2 = [0.01, 0.015, 0.005, 0.02, 0.01];
    const result = styleAnalysis(fund, { b1, b2 }, { constrainWeights: true });
    expect(result.exposures['b1']).toBeGreaterThanOrEqual(0);
    expect(result.exposures['b2']).toBeGreaterThanOrEqual(0);
    // Sum to ~1
    const weightSum = result.exposures['b1'] + result.exposures['b2'];
    expect(weightSum).toBeCloseTo(1, 5);
  });

  it('unconstrained allows negative weights', () => {
    const fund = [0.01, -0.02, 0.03, -0.01, 0.02];
    const b1 = [0.02, -0.01, 0.02, 0.01, 0.01];
    const b2 = [-0.01, 0.01, -0.02, 0.02, -0.01];
    const result = styleAnalysis(fund, { b1, b2 }, { constrainWeights: false });
    // Just verify it runs and produces valid output
    expect(typeof result.rSquared).toBe('number');
    expect(result.rSquared).toBeGreaterThanOrEqual(0);
    expect(result.rSquared).toBeLessThanOrEqual(1);
  });
});
