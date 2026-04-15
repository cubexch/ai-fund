import { describe, it, expect } from 'vitest';
import {
  marginalVaR, incrementalVaR, componentVaR,
  riskDecomposition, covarianceMatrix,
} from '@ai-fund/lib/factor-risk';

// ── Test Data ──────────────────────────────────────────────

/** Simple 2-asset covariance matrix. */
const cov2x2: number[][] = [
  [0.04, 0.01],  // asset 0: 20% vol
  [0.01, 0.09],  // asset 1: 30% vol, corr ≈ 0.167
];

const equalWeights = [0.5, 0.5];

// ── Marginal VaR ───────────────────────────────────────────

describe('marginalVaR', () => {
  it('returns entries for each asset', () => {
    const result = marginalVaR(equalWeights, cov2x2, 0.1);
    expect(result).toHaveLength(2);
    expect(result[0].index).toBe(0);
    expect(result[1].index).toBe(1);
  });

  it('component VaRs sum to portfolio VaR', () => {
    const portfolioVaR = 0.1;
    const result = marginalVaR(equalWeights, cov2x2, portfolioVaR);
    const sumComponentVaR = result.reduce((s, r) => s + r.componentVaR, 0);
    expect(sumComponentVaR).toBeCloseTo(portfolioVaR, 5);
  });

  it('percentage contributions sum to 1', () => {
    const result = marginalVaR(equalWeights, cov2x2, 0.1);
    const sumPct = result.reduce((s, r) => s + r.pctContribution, 0);
    expect(sumPct).toBeCloseTo(1, 5);
  });

  it('returns zeros for zero-weight portfolio', () => {
    const result = marginalVaR([0, 0], cov2x2, 0);
    expect(result[0].marginalVaR).toBe(0);
    expect(result[1].componentVaR).toBe(0);
  });
});

// ── Incremental VaR ────────────────────────────────────────

describe('incrementalVaR', () => {
  it('returns entries for each asset', () => {
    const result = incrementalVaR(equalWeights, cov2x2);
    expect(result).toHaveLength(2);
  });

  it('diversification benefit is non-negative', () => {
    const result = incrementalVaR(equalWeights, cov2x2);
    for (const entry of result) {
      expect(entry.diversificationBenefit).toBeGreaterThanOrEqual(-1e-10);
    }
  });

  it('removing an asset reduces VaR (incremental VaR > 0 for positive correlation)', () => {
    const result = incrementalVaR(equalWeights, cov2x2, 0.95);
    // Both assets have positive correlation and weight, so incremental should be positive
    expect(result[0].incrementalVaR).toBeGreaterThan(0);
    expect(result[1].incrementalVaR).toBeGreaterThan(0);
  });
});

// ── Component VaR ──────────────────────────────────────────

describe('componentVaR', () => {
  it('component VaRs sum to portfolio VaR', () => {
    const result = componentVaR(equalWeights, cov2x2, 0.95);
    const sumComp = result.components.reduce((s, c) => s + c.componentVaR, 0);
    expect(sumComp).toBeCloseTo(result.portfolioVaR, 5);
  });

  it('percentage contributions sum to 1', () => {
    const result = componentVaR(equalWeights, cov2x2, 0.95);
    const sumPct = result.components.reduce((s, c) => s + c.pctContribution, 0);
    expect(sumPct).toBeCloseTo(1, 5);
  });

  it('higher-vol asset contributes more to VaR', () => {
    // Asset 1 has 30% vol vs asset 0 at 20%
    const result = componentVaR(equalWeights, cov2x2, 0.95);
    expect(result.components[1].componentVaR).toBeGreaterThan(result.components[0].componentVaR);
  });

  it('portfolioVaR is zero for zero weights', () => {
    const result = componentVaR([0, 0], cov2x2);
    expect(result.portfolioVaR).toBe(0);
  });

  it('single-asset portfolio: component VaR = portfolio VaR', () => {
    const result = componentVaR([1, 0], cov2x2, 0.95);
    expect(result.components[0].componentVaR).toBeCloseTo(result.portfolioVaR, 10);
    expect(result.components[0].pctContribution).toBeCloseTo(1, 10);
  });
});

// ── Risk Decomposition ─────────────────────────────────────

describe('riskDecomposition', () => {
  it('total risk is non-negative', () => {
    const result = riskDecomposition(equalWeights, cov2x2);
    expect(result.totalRisk).toBeGreaterThan(0);
  });

  it('systematic + idiosyncratic components relate to total risk', () => {
    const result = riskDecomposition(equalWeights, cov2x2);
    // systematic^2 + idiosyncratic^2 ≈ total^2
    const sumSquared = result.systematicRisk ** 2 + result.idiosyncraticRisk ** 2;
    expect(sumSquared).toBeCloseTo(result.totalRisk ** 2, 10);
  });

  it('risk contributions sum to total risk', () => {
    const result = riskDecomposition(equalWeights, cov2x2);
    const sumRC = result.riskContributions.reduce((s, r) => s + r, 0);
    expect(sumRC).toBeCloseTo(result.totalRisk, 10);
  });

  it('diversification ratio >= 1 for positive correlations', () => {
    const result = riskDecomposition(equalWeights, cov2x2);
    expect(result.diversificationRatio).toBeGreaterThanOrEqual(1);
  });

  it('diversification ratio = 1 for single asset', () => {
    const result = riskDecomposition([1, 0], cov2x2);
    expect(result.diversificationRatio).toBeCloseTo(1, 10);
  });

  it('handles zero weights', () => {
    const result = riskDecomposition([0, 0], cov2x2);
    expect(result.totalRisk).toBe(0);
    expect(result.diversificationRatio).toBe(1); // fallback
  });
});

// ── Covariance Matrix ──────────────────────────────────────

describe('covarianceMatrix', () => {
  const testSeries = {
    A: [0.01, -0.02, 0.03, 0.01, -0.01, 0.02, -0.03, 0.01, 0.02, -0.01],
    B: [0.02, -0.01, 0.02, -0.01, 0.01, 0.03, -0.02, 0.01, 0.01, -0.02],
  };

  it('sample method returns symmetric matrix', () => {
    const result = covarianceMatrix(testSeries, 'sample');
    expect(result.matrix[0][1]).toBeCloseTo(result.matrix[1][0], 15);
    expect(result.method).toBe('sample');
  });

  it('diagonal entries are non-negative (variances)', () => {
    const result = covarianceMatrix(testSeries, 'sample');
    expect(result.matrix[0][0]).toBeGreaterThanOrEqual(0);
    expect(result.matrix[1][1]).toBeGreaterThanOrEqual(0);
  });

  it('symbols are preserved', () => {
    const result = covarianceMatrix(testSeries, 'sample');
    expect(result.symbols).toEqual(['A', 'B']);
  });

  it('returns empty for empty input', () => {
    const result = covarianceMatrix({});
    expect(result.matrix).toEqual([]);
    expect(result.symbols).toEqual([]);
  });

  it('returns zero matrix for insufficient data', () => {
    const result = covarianceMatrix({ A: [0.01], B: [0.02] }, 'sample');
    expect(result.matrix[0][0]).toBe(0);
  });

  it('exponential method produces valid covariance', () => {
    const result = covarianceMatrix(testSeries, 'exponential', { halfLife: 5 });
    expect(result.method).toBe('exponential');
    expect(result.matrix[0][0]).toBeGreaterThanOrEqual(0);
    expect(result.matrix[1][1]).toBeGreaterThanOrEqual(0);
    // Symmetric
    expect(result.matrix[0][1]).toBeCloseTo(result.matrix[1][0], 15);
  });

  it('shrinkage method with identity target', () => {
    const result = covarianceMatrix(testSeries, 'shrinkage', { shrinkageTarget: 'identity' });
    expect(result.method).toContain('shrinkage');
    expect(result.matrix[0][0]).toBeGreaterThanOrEqual(0);
    // Shrinkage should pull off-diagonals toward zero
    expect(Math.abs(result.matrix[0][1])).toBeLessThanOrEqual(
      Math.abs(covarianceMatrix(testSeries, 'sample').matrix[0][1]) + 0.001
    );
  });

  it('shrinkage method with constant_correlation target', () => {
    const result = covarianceMatrix(testSeries, 'shrinkage', { shrinkageTarget: 'constant_correlation' });
    expect(result.method).toContain('shrinkage');
    expect(result.matrix[0][0]).toBeGreaterThanOrEqual(0);
  });
});
