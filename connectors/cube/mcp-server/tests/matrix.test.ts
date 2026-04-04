import { describe, it, expect } from 'vitest';
import {
  matTranspose, matMultiply, matVecMultiply,
  vecDot, vecNorm, vecScale, vecSub,
  matInverse, sampleCov,
  powerIteration, deflateMatrix,
  olsRegression, zScoreForConfidence,
} from '@ai-fund/lib/matrix';

// ── Matrix Operations ──────────────────────────────────────

describe('matTranspose', () => {
  it('transposes a square matrix', () => {
    const m = [[1, 2], [3, 4]];
    expect(matTranspose(m)).toEqual([[1, 3], [2, 4]]);
  });

  it('transposes a rectangular matrix', () => {
    const m = [[1, 2, 3], [4, 5, 6]];
    const t = matTranspose(m);
    expect(t).toEqual([[1, 4], [2, 5], [3, 6]]);
  });

  it('transpose of transpose returns original', () => {
    const m = [[1, 2], [3, 4], [5, 6]];
    expect(matTranspose(matTranspose(m))).toEqual(m);
  });

  it('transposes a 1x1 matrix', () => {
    expect(matTranspose([[7]])).toEqual([[7]]);
  });
});

describe('matMultiply', () => {
  it('multiplies two 2x2 matrices', () => {
    const a = [[1, 2], [3, 4]];
    const b = [[5, 6], [7, 8]];
    expect(matMultiply(a, b)).toEqual([[19, 22], [43, 50]]);
  });

  it('multiplies identity matrix returns original', () => {
    const m = [[1, 2], [3, 4]];
    const I = [[1, 0], [0, 1]];
    expect(matMultiply(I, m)).toEqual(m);
    expect(matMultiply(m, I)).toEqual(m);
  });

  it('multiplies rectangular matrices', () => {
    const a = [[1, 2, 3]]; // 1x3
    const b = [[4], [5], [6]]; // 3x1
    expect(matMultiply(a, b)).toEqual([[32]]); // 1x1
  });

  it('handles zero matrix', () => {
    const a = [[1, 2], [3, 4]];
    const z = [[0, 0], [0, 0]];
    expect(matMultiply(a, z)).toEqual(z);
  });
});

describe('matVecMultiply', () => {
  it('multiplies a matrix by a vector', () => {
    const m = [[1, 2], [3, 4]];
    const v = [5, 6];
    expect(matVecMultiply(m, v)).toEqual([17, 39]);
  });

  it('identity matrix preserves vector', () => {
    const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const v = [3, 7, 11];
    expect(matVecMultiply(I, v)).toEqual(v);
  });

  it('handles zero vector', () => {
    const m = [[1, 2], [3, 4]];
    expect(matVecMultiply(m, [0, 0])).toEqual([0, 0]);
  });
});

// ── Vector Operations ──────────────────────────────────────

describe('vecDot', () => {
  it('computes dot product', () => {
    expect(vecDot([1, 2, 3], [4, 5, 6])).toBe(32);
  });

  it('dot product of orthogonal vectors is 0', () => {
    expect(vecDot([1, 0], [0, 1])).toBe(0);
  });

  it('dot product with itself gives squared norm', () => {
    const v = [3, 4];
    expect(vecDot(v, v)).toBe(25);
  });
});

describe('vecNorm', () => {
  it('computes L2 norm', () => {
    expect(vecNorm([3, 4])).toBe(5);
  });

  it('norm of zero vector is 0', () => {
    expect(vecNorm([0, 0, 0])).toBe(0);
  });

  it('norm of unit vector is 1', () => {
    expect(vecNorm([1, 0, 0])).toBe(1);
    expect(vecNorm([0, 1, 0])).toBe(1);
  });
});

describe('vecScale', () => {
  it('scales a vector', () => {
    expect(vecScale([1, 2, 3], 2)).toEqual([2, 4, 6]);
  });

  it('scaling by 0 gives zero vector', () => {
    expect(vecScale([5, 10], 0)).toEqual([0, 0]);
  });

  it('scaling by -1 negates', () => {
    expect(vecScale([1, -2, 3], -1)).toEqual([-1, 2, -3]);
  });
});

describe('vecSub', () => {
  it('subtracts two vectors', () => {
    expect(vecSub([5, 3], [2, 1])).toEqual([3, 2]);
  });

  it('subtracting self gives zero vector', () => {
    const v = [7, 11, 13];
    expect(vecSub(v, v)).toEqual([0, 0, 0]);
  });
});

// ── Matrix Inversion ───────────────────────────────────────

describe('matInverse', () => {
  it('inverts a 2x2 matrix', () => {
    const m = [[4, 7], [2, 6]];
    const inv = matInverse(m);
    // m * inv should ≈ identity
    const product = matMultiply(m, inv);
    expect(product[0][0]).toBeCloseTo(1);
    expect(product[0][1]).toBeCloseTo(0);
    expect(product[1][0]).toBeCloseTo(0);
    expect(product[1][1]).toBeCloseTo(1);
  });

  it('inverts a 3x3 matrix', () => {
    const m = [[1, 2, 3], [0, 1, 4], [5, 6, 0]];
    const inv = matInverse(m);
    const product = matMultiply(m, inv);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(product[i][j]).toBeCloseTo(i === j ? 1 : 0, 10);
      }
    }
  });

  it('inverse of identity is identity', () => {
    const I = [[1, 0], [0, 1]];
    const inv = matInverse(I);
    expect(inv[0][0]).toBeCloseTo(1);
    expect(inv[0][1]).toBeCloseTo(0);
    expect(inv[1][0]).toBeCloseTo(0);
    expect(inv[1][1]).toBeCloseTo(1);
  });

  it('returns identity for singular matrix', () => {
    const singular = [[1, 2], [2, 4]]; // det = 0
    const inv = matInverse(singular);
    // Fallback: returns identity
    expect(inv).toEqual([[1, 0], [0, 1]]);
  });

  it('handles near-singular matrix gracefully', () => {
    const m = [[1e-16, 0], [0, 1]];
    const inv = matInverse(m);
    // Should return identity fallback since first pivot < 1e-15
    expect(inv[0][0]).toBe(1);
    expect(inv[1][1]).toBe(1);
  });
});

// ── Covariance ─────────────────────────────────────────────

describe('sampleCov', () => {
  it('computes sample covariance for 2 variables', () => {
    // Two centered columns: x=[1,-1], y=[2,-2] → cov(x,y) = (1*2 + (-1)*(-2)) / (2-1) = 4
    const cols = [[1, -1], [2, -2]];
    const cov = sampleCov(cols, 2);
    expect(cov[0][0]).toBeCloseTo(2);   // var(x) = (1+1)/1 = 2
    expect(cov[0][1]).toBeCloseTo(4);   // cov(x,y) = 4
    expect(cov[1][0]).toBeCloseTo(4);   // symmetric
    expect(cov[1][1]).toBeCloseTo(8);   // var(y) = (4+4)/1 = 8
  });

  it('produces symmetric matrix', () => {
    const cols = [[1, -1, 0.5], [0.3, -0.5, 0.2], [0.1, 0.4, -0.3]];
    const cov = sampleCov(cols, 3);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(cov[i][j]).toBeCloseTo(cov[j][i]);
      }
    }
  });

  it('diagonal entries are non-negative (variances)', () => {
    const cols = [[0.1, -0.3, 0.2], [-0.5, 0.1, 0.4]];
    const cov = sampleCov(cols, 3);
    expect(cov[0][0]).toBeGreaterThanOrEqual(0);
    expect(cov[1][1]).toBeGreaterThanOrEqual(0);
  });
});

// ── Power Iteration & Deflation ────────────────────────────

describe('powerIteration', () => {
  it('finds dominant eigenvalue of a diagonal matrix', () => {
    const m = [[3, 0], [0, 1]];
    const { eigenvalue, eigenvector } = powerIteration(m);
    expect(eigenvalue).toBeCloseTo(3, 5);
    // Eigenvector should be approximately [1, 0] or [-1, 0]
    expect(Math.abs(eigenvector[0])).toBeCloseTo(1, 5);
    expect(Math.abs(eigenvector[1])).toBeCloseTo(0, 5);
  });

  it('finds dominant eigenvalue of a symmetric matrix', () => {
    // [[2, 1], [1, 2]] has eigenvalues 3 and 1
    const m = [[2, 1], [1, 2]];
    const { eigenvalue } = powerIteration(m);
    expect(eigenvalue).toBeCloseTo(3, 5);
  });

  it('returns unit eigenvector', () => {
    const m = [[5, 0, 0], [0, 2, 0], [0, 0, 1]];
    const { eigenvector } = powerIteration(m);
    expect(vecNorm(eigenvector)).toBeCloseTo(1, 10);
  });
});

describe('deflateMatrix', () => {
  it('removes dominant eigenvalue contribution', () => {
    const m = [[2, 1], [1, 2]]; // eigenvalues 3 and 1
    const { eigenvalue, eigenvector } = powerIteration(m);
    const deflated = deflateMatrix(m, eigenvalue, eigenvector);
    // After deflation, dominant eigenvalue should be ~1
    const { eigenvalue: second } = powerIteration(deflated);
    expect(second).toBeCloseTo(1, 3);
  });

  it('deflated matrix has reduced trace', () => {
    const m = [[4, 1], [1, 3]]; // trace = 7
    const { eigenvalue, eigenvector } = powerIteration(m);
    const deflated = deflateMatrix(m, eigenvalue, eigenvector);
    const deflatedTrace = deflated[0][0] + deflated[1][1];
    // trace should decrease by eigenvalue
    expect(deflatedTrace).toBeCloseTo(7 - eigenvalue, 3);
  });
});

// ── OLS Regression ─────────────────────────────────────────

describe('olsRegression', () => {
  it('fits a simple linear relationship y = 2x + 1', () => {
    const y = [3, 5, 7, 9, 11];
    const X = [[1], [2], [3], [4], [5]];
    const result = olsRegression(y, X);
    expect(result.alpha).toBeCloseTo(1, 10);
    expect(result.betas[0]).toBeCloseTo(2, 10);
    expect(result.rSquared).toBeCloseTo(1, 10);
  });

  it('fits a multivariate regression', () => {
    // y = 1 + 2*x1 + 3*x2
    const X = [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3]];
    const y = X.map(x => 1 + 2 * x[0] + 3 * x[1]);
    const result = olsRegression(y, X);
    expect(result.alpha).toBeCloseTo(1, 8);
    expect(result.betas[0]).toBeCloseTo(2, 8);
    expect(result.betas[1]).toBeCloseTo(3, 8);
    expect(result.rSquared).toBeCloseTo(1, 8);
  });

  it('returns residuals that sum to ~0', () => {
    const y = [2.1, 3.9, 6.2, 7.8, 10.1];
    const X = [[1], [2], [3], [4], [5]];
    const result = olsRegression(y, X);
    const residualSum = result.residuals.reduce((a, b) => a + b, 0);
    expect(residualSum).toBeCloseTo(0, 10);
  });

  it('r-squared is between 0 and 1 for noisy data', () => {
    const y = [2.1, 4.3, 5.8, 8.2, 9.9];
    const X = [[1], [2], [3], [4], [5]];
    const result = olsRegression(y, X);
    expect(result.rSquared).toBeGreaterThan(0);
    expect(result.rSquared).toBeLessThanOrEqual(1);
  });

  it('produces t-statistics for each beta', () => {
    const y = [3, 5, 7, 9, 11];
    const X = [[1], [2], [3], [4], [5]];
    const result = olsRegression(y, X);
    expect(result.tStats).toHaveLength(1);
    // Perfect fit → residuals are 0 → sigmaSquared is 0 → tStats are 0
    // (degenerate case — t-stat undefined for perfect fit)
    expect(typeof result.tStats[0]).toBe('number');
  });

  it('handles constant y (rSquared = 0)', () => {
    const y = [5, 5, 5, 5, 5];
    const X = [[1], [2], [3], [4], [5]];
    const result = olsRegression(y, X);
    expect(result.rSquared).toBe(0);
    expect(result.betas[0]).toBeCloseTo(0, 10);
    expect(result.alpha).toBeCloseTo(5, 10);
  });
});

// ── Z-Score Lookup ─────────────────────────────────────────

describe('zScoreForConfidence', () => {
  it('returns 2.326 for 99%', () => {
    expect(zScoreForConfidence(0.99)).toBe(2.326);
  });

  it('returns 1.960 for 97.5%', () => {
    expect(zScoreForConfidence(0.975)).toBe(1.960);
  });

  it('returns 1.645 for 95%', () => {
    expect(zScoreForConfidence(0.95)).toBe(1.645);
  });

  it('returns 1.282 for 90%', () => {
    expect(zScoreForConfidence(0.90)).toBe(1.282);
  });

  it('defaults to 1.645 for unrecognized confidence', () => {
    expect(zScoreForConfidence(0.80)).toBe(1.645);
    expect(zScoreForConfidence(0.50)).toBe(1.645);
  });

  it('returns 2.326 for confidence above 99%', () => {
    expect(zScoreForConfidence(0.999)).toBe(2.326);
  });
});
