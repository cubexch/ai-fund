/**
 * Internal matrix and linear-algebra utilities.
 * Used by factor-extraction, factor-risk, and factor-models submodules.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import { mean } from './math.js';

// ── Matrix Operations ───────────────────────────────────

export function matTranspose(m: number[][]): number[][] {
  const rows = m.length;
  const cols = m[0].length;
  const t: number[][] = Array.from({ length: cols }, () => Array(rows).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      t[j][i] = m[i][j];
    }
  }
  return t;
}

export function matMultiply(a: number[][], b: number[][]): number[][] {
  const rows = a.length;
  const cols = b[0].length;
  const inner = b.length;
  const result: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      let s = 0;
      for (let k = 0; k < inner; k++) {
        s += a[i][k] * b[k][j];
      }
      result[i][j] = s;
    }
  }
  return result;
}

export function matVecMultiply(m: number[][], v: number[]): number[] {
  const n = m.length;
  const result: number[] = Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < v.length; j++) {
      s += m[i][j] * v[j];
    }
    result[i] = s;
  }
  return result;
}

// ── Vector Operations ───────────────────────────────────

export function vecDot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
  }
  return s;
}

export function vecNorm(v: number[]): number {
  return Math.sqrt(vecDot(v, v));
}

export function vecScale(v: number[], s: number): number[] {
  return v.map(x => x * s);
}

export function vecSub(a: number[], b: number[]): number[] {
  return a.map((x, i) => x - b[i]);
}

// ── Matrix Inversion ────────────────────────────────────

/**
 * Matrix inversion via Gauss-Jordan elimination for small matrices.
 */
export function matInverse(m: number[][]): number[][] {
  const n = m.length;
  // Augmented matrix [m | I]
  const aug: number[][] = m.map((row, i) => {
    const ext = Array(n).fill(0);
    ext[i] = 1;
    return [...row, ...ext];
  });

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    let maxVal = Math.abs(aug[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > maxVal) {
        maxVal = Math.abs(aug[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-15) {
      // Singular — return identity as fallback
      return Array.from({ length: n }, (_, i) => {
        const row = Array(n).fill(0);
        row[i] = 1;
        return row;
      });
    }
    if (maxRow !== col) {
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
    }

    const pivot = aug[col][col];
    for (let j = 0; j < 2 * n; j++) {
      aug[col][j] /= pivot;
    }

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  return aug.map(row => row.slice(n));
}

// ── Covariance & Eigen ──────────────────────────────────

/**
 * Build sample covariance matrix from centered data columns.
 */
export function sampleCov(centeredColumns: number[][], n: number): number[][] {
  const p = centeredColumns.length;
  const cov: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) {
        s += centeredColumns[i][k] * centeredColumns[j][k];
      }
      const val = s / (n - 1);
      cov[i][j] = val;
      cov[j][i] = val;
    }
  }
  return cov;
}

/**
 * Power iteration to find the dominant eigenvector of a symmetric matrix.
 */
export function powerIteration(m: number[][], maxIter: number = 200, tol: number = 1e-10): { eigenvalue: number; eigenvector: number[] } {
  const n = m.length;
  let v: number[] = Array.from({ length: n }, () => Math.random() - 0.5);
  let norm = vecNorm(v);
  v = vecScale(v, 1 / norm);

  let eigenvalue = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const mv = matVecMultiply(m, v);
    eigenvalue = vecDot(v, mv);
    norm = vecNorm(mv);
    if (norm < tol) break;
    const vNew = vecScale(mv, 1 / norm);
    const diff = vecNorm(vecSub(vNew, v));
    v = vNew;
    if (diff < tol) break;
  }

  return { eigenvalue, eigenvector: v };
}

/**
 * Deflate a symmetric matrix by removing the contribution of a given eigenpair.
 */
export function deflateMatrix(m: number[][], eigenvalue: number, eigenvector: number[]): number[][] {
  const n = m.length;
  const result: number[][] = m.map(row => [...row]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      result[i][j] -= eigenvalue * eigenvector[i] * eigenvector[j];
    }
  }
  return result;
}

// ── OLS Regression ──────────────────────────────────────

/**
 * OLS regression: y = X * beta + epsilon.
 * X should be [nObs x nFactors], y is [nObs].
 * Returns betas, intercept (alpha), residuals.
 */
export function olsRegression(y: number[], X: number[][]): {
  betas: number[];
  alpha: number;
  residuals: number[];
  rSquared: number;
  tStats: number[];
} {
  const n = y.length;
  const k = X[0].length;

  // Build design matrix with intercept column
  const Xd: number[][] = y.map((_, i) => [1, ...X[i]]);
  const Xt = matTranspose(Xd);
  const XtX = matMultiply(Xt, Xd);
  const XtXinv = matInverse(XtX);
  const Xty = Xt.map(row => {
    let s = 0;
    for (let i = 0; i < n; i++) s += row[i] * y[i];
    return s;
  });

  // coefficients = (X'X)^-1 * X'y
  const coeffs: number[] = XtXinv.map(row => {
    let s = 0;
    for (let j = 0; j < row.length; j++) s += row[j] * Xty[j];
    return s;
  });

  const alpha = coeffs[0];
  const betas = coeffs.slice(1);

  // Residuals
  const residuals: number[] = y.map((yi, i) => {
    let pred = alpha;
    for (let j = 0; j < k; j++) pred += betas[j] * X[i][j];
    return yi - pred;
  });

  // R-squared
  const yMean = mean(y);
  const ssTot = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const ssRes = residuals.reduce((s, v) => s + v * v, 0);
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  // t-statistics
  const sigmaSquared = n > k + 1 ? ssRes / (n - k - 1) : 0;
  const tStats = coeffs.map((c, i) => {
    const se = Math.sqrt(Math.max(0, sigmaSquared * XtXinv[i][i]));
    return se === 0 ? 0 : c / se;
  });

  return {
    betas,
    alpha,
    residuals,
    rSquared,
    tStats: tStats.slice(1), // exclude intercept t-stat
  };
}

// ── Z-score lookup ──────────────────────────────────────

export function zScoreForConfidence(confidence: number): number {
  if (confidence >= 0.99) return 2.326;
  if (confidence >= 0.975) return 1.960;
  if (confidence >= 0.95) return 1.645;
  if (confidence >= 0.90) return 1.282;
  return 1.645;
}
