/**
 * PCA-based factor extraction, multi-factor regression, performance attribution,
 * factor return construction, and style analysis.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import { mean, standardDeviation } from './math.js';
import {
  sampleCov,
  powerIteration,
  deflateMatrix,
  olsRegression,
} from './matrix.js';

// ── Types ────────────────────────────────────────────────

export interface PcaFactor {
  eigenvalue: number;
  varianceExplained: number;
  loadings: Record<string, number>;
}

export interface PcaResult {
  factors: PcaFactor[];
  totalVarianceExplained: number;
  residualVariance: Record<string, number>;
}

export interface FactorExposureResult {
  betas: number[];
  alpha: number;
  rSquared: number;
  residualVol: number;
  tStats: number[];
}

export interface FactorContribution {
  factor: string;
  contribution: number;
  pct: number;
}

export interface FactorAttributionResult {
  factorContributions: FactorContribution[];
  specificReturn: number;
  totalReturn: number;
}

export interface FactorReturnsSeries {
  market: number[];
  smb: number[];
  hml: number[];
  rmw: number[];
  cma: number[];
}

export interface StyleAnalysisResult {
  exposures: Record<string, number>;
  rSquared: number;
  trackingError: number;
  informationRatio: number;
  dominantStyle: string;
}

// ── Public Functions ─────────────────────────────────────

/**
 * PCA-based factor extraction from a set of return series.
 * Computes covariance matrix, extracts top N factors via power iteration.
 */
export function pcaFactors(
  returnsSeries: Record<string, number[]>,
  numFactors?: number
): PcaResult {
  const symbols = Object.keys(returnsSeries);
  const p = symbols.length;
  if (p === 0) {
    return { factors: [], totalVarianceExplained: 0, residualVariance: {} };
  }

  const series = symbols.map(s => returnsSeries[s]);
  const n = Math.min(...series.map(s => s.length));
  if (n < 2) {
    return { factors: [], totalVarianceExplained: 0, residualVariance: Object.fromEntries(symbols.map(s => [s, 0])) };
  }

  // Center data
  const centered: number[][] = series.map(s => {
    const slice = s.slice(0, n);
    const m = mean(slice);
    return slice.map(v => v - m);
  });

  const cov = sampleCov(centered, n);
  const totalVariance = cov.reduce((s, row, i) => s + row[i], 0);

  const nFactors = Math.min(numFactors ?? Math.min(p, 5), p);
  const factors: PcaFactor[] = [];
  let deflated = cov.map(row => [...row]);
  let explainedSum = 0;

  for (let f = 0; f < nFactors; f++) {
    const { eigenvalue, eigenvector } = powerIteration(deflated);
    if (eigenvalue <= 1e-12) break;

    const varianceExplained = totalVariance > 0 ? eigenvalue / totalVariance : 0;
    explainedSum += varianceExplained;

    const loadings: Record<string, number> = {};
    for (let i = 0; i < p; i++) {
      loadings[symbols[i]] = eigenvector[i];
    }

    factors.push({ eigenvalue, varianceExplained, loadings });
    deflated = deflateMatrix(deflated, eigenvalue, eigenvector);
  }

  // Residual variance per asset
  const residualVariance: Record<string, number> = {};
  for (let i = 0; i < p; i++) {
    let explained = 0;
    for (const factor of factors) {
      const loading = factor.loadings[symbols[i]];
      explained += loading * loading * factor.eigenvalue;
    }
    const assetVar = cov[i][i];
    residualVariance[symbols[i]] = Math.max(0, assetVar - explained);
  }

  return {
    factors,
    totalVarianceExplained: explainedSum,
    residualVariance,
  };
}

/**
 * Multi-factor regression (OLS) for a single asset against multiple factor return series.
 */
export function factorExposure(
  assetReturns: number[],
  factorReturns: number[][]
): FactorExposureResult {
  const nFactors = factorReturns.length;
  if (nFactors === 0 || assetReturns.length === 0) {
    return { betas: [], alpha: 0, rSquared: 0, residualVol: 0, tStats: [] };
  }

  const n = Math.min(assetReturns.length, ...factorReturns.map(f => f.length));
  if (n < 2) {
    return { betas: Array(nFactors).fill(0), alpha: 0, rSquared: 0, residualVol: 0, tStats: Array(nFactors).fill(0) };
  }

  const y = assetReturns.slice(0, n);
  const X: number[][] = Array.from({ length: n }, (_, i) =>
    factorReturns.map(f => f[i])
  );

  const result = olsRegression(y, X);
  const residualVol = standardDeviation(result.residuals);

  return {
    betas: result.betas,
    alpha: result.alpha,
    rSquared: Math.max(0, Math.min(1, result.rSquared)),
    residualVol,
    tStats: result.tStats,
  };
}

/**
 * Performance attribution: decompose portfolio returns into factor contributions.
 */
export function factorAttribution(
  portfolioReturns: number[],
  factorReturns: number[][],
  factorNames: string[]
): FactorAttributionResult {
  const exposure = factorExposure(portfolioReturns, factorReturns);
  const n = Math.min(portfolioReturns.length, ...factorReturns.map(f => f.length));
  const totalReturn = portfolioReturns.slice(0, n).reduce((s, r) => s + r, 0);

  const factorContributions: FactorContribution[] = factorNames.map((name, i) => {
    const factorMeanReturn = mean(factorReturns[i].slice(0, n));
    const contribution = exposure.betas[i] * factorMeanReturn * n;
    return {
      factor: name,
      contribution,
      pct: totalReturn === 0 ? 0 : contribution / totalReturn,
    };
  });

  const factorTotal = factorContributions.reduce((s, fc) => s + fc.contribution, 0);
  const specificReturn = totalReturn - factorTotal;

  return {
    factorContributions,
    specificReturn,
    totalReturn,
  };
}

/**
 * Build Fama-French factor return series from cross-sectional sorts.
 * Sorts assets by characteristics, forms long-short portfolios.
 */
export function computeFactorReturns(
  returns: Record<string, number[]>,
  characteristics: Record<string, {
    marketCap?: number;
    bookToMarket?: number;
    profitability?: number;
    investment?: number;
  }>,
  marketReturn: number[]
): FactorReturnsSeries {
  const symbols = Object.keys(returns).filter(s => characteristics[s]);
  const n = Math.min(marketReturn.length, ...symbols.map(s => returns[s].length));

  if (symbols.length < 2 || n < 1) {
    const empty = Array(n > 0 ? n : 0).fill(0);
    return { market: marketReturn.slice(0, n), smb: [...empty], hml: [...empty], rmw: [...empty], cma: [...empty] };
  }

  // Helper: sort symbols by a characteristic, split into top/bottom halves,
  // compute equal-weight long-short return series
  function longShortFactor(
    sortKey: (sym: string) => number | undefined,
    longHighValues: boolean
  ): number[] {
    const withVal = symbols.filter(s => sortKey(s) !== undefined);
    if (withVal.length < 2) return Array(n).fill(0);

    const sorted = [...withVal].sort((a, b) => (sortKey(a)! - sortKey(b)!));
    const mid = Math.floor(sorted.length / 2);
    const bottom = sorted.slice(0, mid);
    const top = sorted.slice(mid);

    const longGroup = longHighValues ? top : bottom;
    const shortGroup = longHighValues ? bottom : top;

    const factorRets: number[] = [];
    for (let t = 0; t < n; t++) {
      const longRet = longGroup.length > 0
        ? mean(longGroup.map(s => returns[s][t] ?? 0))
        : 0;
      const shortRet = shortGroup.length > 0
        ? mean(shortGroup.map(s => returns[s][t] ?? 0))
        : 0;
      factorRets.push(longRet - shortRet);
    }
    return factorRets;
  }

  // SMB: small minus big (long small cap, short big cap)
  const smb = longShortFactor(s => characteristics[s].marketCap, false);

  // HML: high minus low book-to-market (long high B/M, short low B/M)
  const hml = longShortFactor(s => characteristics[s].bookToMarket, true);

  // RMW: robust minus weak profitability (long high profitability, short low)
  const rmw = longShortFactor(s => characteristics[s].profitability, true);

  // CMA: conservative minus aggressive investment (long low investment, short high investment)
  const cma = longShortFactor(s => characteristics[s].investment, false);

  return {
    market: marketReturn.slice(0, n),
    smb,
    hml,
    rmw,
    cma,
  };
}

/**
 * Sharpe style analysis.
 * Regresses fund returns against benchmark/style indices.
 * If constrainWeights is true (default), constrains weights to be non-negative and sum to 1.
 */
export function styleAnalysis(
  fundReturns: number[],
  benchmarkReturns: Record<string, number[]>,
  params?: { constrainWeights?: boolean }
): StyleAnalysisResult {
  const constrainWeights = params?.constrainWeights ?? true;
  const benchNames = Object.keys(benchmarkReturns);

  if (benchNames.length === 0 || fundReturns.length === 0) {
    return {
      exposures: {},
      rSquared: 0,
      trackingError: 0,
      informationRatio: 0,
      dominantStyle: '',
    };
  }

  const benchSeries = benchNames.map(b => benchmarkReturns[b]);
  const n = Math.min(fundReturns.length, ...benchSeries.map(s => s.length));
  if (n < 2) {
    return {
      exposures: Object.fromEntries(benchNames.map(b => [b, 0])),
      rSquared: 0,
      trackingError: 0,
      informationRatio: 0,
      dominantStyle: benchNames[0] ?? '',
    };
  }

  const y = fundReturns.slice(0, n);
  const X: number[][] = Array.from({ length: n }, (_, i) =>
    benchSeries.map(s => s[i])
  );

  let exposures: Record<string, number>;

  if (!constrainWeights) {
    // Unconstrained OLS
    const reg = olsRegression(y, X);
    exposures = Object.fromEntries(benchNames.map((b, i) => [b, reg.betas[i]]));
  } else {
    // Constrained: weights >= 0, sum to 1
    // Use iterative projection onto simplex after OLS
    const k = benchNames.length;
    let weights = Array(k).fill(1 / k);

    // Iterative projected gradient descent
    const maxIter = 500;
    const lr = 0.01;

    for (let iter = 0; iter < maxIter; iter++) {
      // Compute gradient of sum-of-squared residuals
      const gradient = Array(k).fill(0);
      for (let t = 0; t < n; t++) {
        let pred = 0;
        for (let j = 0; j < k; j++) {
          pred += weights[j] * X[t][j];
        }
        const residual = y[t] - pred;
        for (let j = 0; j < k; j++) {
          gradient[j] -= 2 * residual * X[t][j];
        }
      }

      // Gradient step
      for (let j = 0; j < k; j++) {
        weights[j] -= lr * gradient[j] / n;
      }

      // Project onto simplex: clamp negatives to 0, then normalize to sum to 1
      for (let j = 0; j < k; j++) {
        weights[j] = Math.max(0, weights[j]);
      }
      const wSum = weights.reduce((s, w) => s + w, 0);
      if (wSum > 0) {
        for (let j = 0; j < k; j++) {
          weights[j] /= wSum;
        }
      } else {
        weights = Array(k).fill(1 / k);
      }
    }

    exposures = Object.fromEntries(benchNames.map((b, i) => [b, weights[i]]));
  }

  // Compute fitted values and residuals
  const weights = benchNames.map(b => exposures[b]);
  const residuals: number[] = [];
  let ssTot = 0;
  let ssRes = 0;
  const yMean = mean(y);

  for (let t = 0; t < n; t++) {
    let pred = 0;
    for (let j = 0; j < benchNames.length; j++) {
      pred += weights[j] * X[t][j];
    }
    const res = y[t] - pred;
    residuals.push(res);
    ssRes += res * res;
    ssTot += (y[t] - yMean) ** 2;
  }

  const rSquared = ssTot === 0 ? 0 : Math.max(0, Math.min(1, 1 - ssRes / ssTot));
  const trackingError = standardDeviation(residuals);
  const meanResidual = mean(residuals);
  const informationRatio = trackingError === 0 ? 0 : meanResidual / trackingError;

  // Dominant style: highest exposure
  let dominantStyle = benchNames[0] ?? '';
  let maxExposure = -Infinity;
  for (const b of benchNames) {
    if (exposures[b] > maxExposure) {
      maxExposure = exposures[b];
      dominantStyle = b;
    }
  }

  return {
    exposures,
    rSquared,
    trackingError,
    informationRatio,
    dominantStyle,
  };
}
