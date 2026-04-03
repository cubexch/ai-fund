/**
 * Risk factor models and factor decomposition.
 * PCA-based factor extraction, multi-factor regression, VaR decomposition,
 * crypto factor models, and robust covariance estimation.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import { correlation, mean, standardDeviation, beta as mathBeta } from './math.js';

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

export interface MarginalVaREntry {
  index: number;
  marginalVaR: number;
  componentVaR: number;
  pctContribution: number;
}

export interface IncrementalVaREntry {
  index: number;
  incrementalVaR: number;
  diversificationBenefit: number;
}

export interface ComponentVaRResult {
  portfolioVaR: number;
  components: Array<{
    index: number;
    componentVaR: number;
    pctContribution: number;
  }>;
}

export interface CryptoFactorEntry {
  btcBeta: number;
  ethBeta: number;
  alpha: number;
  rSquared: number;
  idiosyncraticVol: number;
}

export interface SectorEntry {
  sector: string;
  weight: number;
  contribution: number;
}

export interface SectorExposureResult {
  sectors: SectorEntry[];
  concentration: number;
  herfindahl: number;
}

export interface RiskDecompositionResult {
  totalRisk: number;
  systematicRisk: number;
  idiosyncraticRisk: number;
  diversificationRatio: number;
  riskContributions: number[];
  marginalRiskContributions: number[];
}

export interface CovarianceMatrixResult {
  matrix: number[][];
  symbols: string[];
  method: string;
}

// ── Internal Matrix Helpers ──────────────────────────────

function matTranspose(m: number[][]): number[][] {
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

function matMultiply(a: number[][], b: number[][]): number[][] {
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

function matVecMultiply(m: number[][], v: number[]): number[] {
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

function vecDot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i] * b[i];
  }
  return s;
}

function vecNorm(v: number[]): number {
  return Math.sqrt(vecDot(v, v));
}

function vecScale(v: number[], s: number): number[] {
  return v.map(x => x * s);
}

function vecSub(a: number[], b: number[]): number[] {
  return a.map((x, i) => x - b[i]);
}

/**
 * Matrix inversion via Gauss-Jordan elimination for small matrices.
 */
function matInverse(m: number[][]): number[][] {
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

/**
 * Build sample covariance matrix from centered data columns.
 */
function sampleCov(centeredColumns: number[][], n: number): number[][] {
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
function powerIteration(m: number[][], maxIter: number = 200, tol: number = 1e-10): { eigenvalue: number; eigenvector: number[] } {
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
function deflateMatrix(m: number[][], eigenvalue: number, eigenvector: number[]): number[][] {
  const n = m.length;
  const result: number[][] = m.map(row => [...row]);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      result[i][j] -= eigenvalue * eigenvector[i] * eigenvector[j];
    }
  }
  return result;
}

/**
 * OLS regression: y = X * beta + epsilon.
 * X should be [nObs x nFactors], y is [nObs].
 * Returns betas, intercept (alpha), residuals.
 */
function olsRegression(y: number[], X: number[][]): {
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

// ── Z-score lookup ───────────────────────────────────────

function zScoreForConfidence(confidence: number): number {
  if (confidence >= 0.99) return 2.326;
  if (confidence >= 0.975) return 1.960;
  if (confidence >= 0.95) return 1.645;
  if (confidence >= 0.90) return 1.282;
  return 1.645;
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
 * Marginal contribution to VaR per asset.
 * Marginal VaR = d(portfolioVaR) / d(weight_i).
 */
export function marginalVaR(
  weights: number[],
  covMatrix: number[][],
  portfolioVaR: number
): MarginalVaREntry[] {
  const n = weights.length;
  const covW = matVecMultiply(covMatrix, weights);
  const portVariance = vecDot(weights, covW);
  const portSigma = Math.sqrt(Math.max(0, portVariance));

  if (portSigma === 0) {
    return weights.map((_, i) => ({
      index: i,
      marginalVaR: 0,
      componentVaR: 0,
      pctContribution: 0,
    }));
  }

  // Scale factor: portfolioVaR = z * sigma * value, so z*value = portfolioVaR/sigma
  const scaleFactor = portfolioVaR / portSigma;

  return weights.map((w, i) => {
    const mVaR = (covW[i] / portSigma) * scaleFactor;
    const cVaR = w * mVaR;
    return {
      index: i,
      marginalVaR: mVaR,
      componentVaR: cVaR,
      pctContribution: portfolioVaR === 0 ? 0 : cVaR / portfolioVaR,
    };
  });
}

/**
 * Incremental VaR: change in portfolio VaR from adding/removing each position.
 */
export function incrementalVaR(
  weights: number[],
  covMatrix: number[][],
  confidenceLevel: number = 0.95
): IncrementalVaREntry[] {
  const z = zScoreForConfidence(confidenceLevel);
  const n = weights.length;

  // Full portfolio VaR
  const covW = matVecMultiply(covMatrix, weights);
  const fullVariance = vecDot(weights, covW);
  const fullVaR = z * Math.sqrt(Math.max(0, fullVariance));

  return weights.map((_, i) => {
    // Portfolio without asset i
    const reducedWeights = weights.map((w, j) => j === i ? 0 : w);
    const reducedCovW = matVecMultiply(covMatrix, reducedWeights);
    const reducedVariance = vecDot(reducedWeights, reducedCovW);
    const reducedVaR = z * Math.sqrt(Math.max(0, reducedVariance));

    const incVaR = fullVaR - reducedVaR;
    // Standalone VaR of position i
    const standaloneVar = weights[i] * weights[i] * covMatrix[i][i];
    const standaloneVaR = z * Math.abs(weights[i]) * Math.sqrt(Math.max(0, covMatrix[i][i]));

    return {
      index: i,
      incrementalVaR: incVaR,
      diversificationBenefit: standaloneVaR - incVaR,
    };
  });
}

/**
 * Component VaR: decompose portfolio VaR into per-asset contributions that sum to total.
 */
export function componentVaR(
  weights: number[],
  covMatrix: number[][],
  confidenceLevel: number = 0.95
): ComponentVaRResult {
  const z = zScoreForConfidence(confidenceLevel);
  const covW = matVecMultiply(covMatrix, weights);
  const portVariance = vecDot(weights, covW);
  const portSigma = Math.sqrt(Math.max(0, portVariance));
  const portfolioVaRVal = z * portSigma;

  if (portSigma === 0) {
    return {
      portfolioVaR: 0,
      components: weights.map((_, i) => ({
        index: i,
        componentVaR: 0,
        pctContribution: 0,
      })),
    };
  }

  const components = weights.map((w, i) => {
    const cVaR = z * w * covW[i] / portSigma;
    return {
      index: i,
      componentVaR: cVaR,
      pctContribution: portfolioVaRVal === 0 ? 0 : cVaR / portfolioVaRVal,
    };
  });

  return { portfolioVaR: portfolioVaRVal, components };
}

/**
 * Crypto-specific two-factor model: BTC beta, orthogonalized ETH beta, and idiosyncratic.
 */
export function cryptoFactorModel(
  returns: Record<string, number[]>,
  benchmarks: { btc: number[]; eth: number[] }
): Record<string, CryptoFactorEntry> {
  const result: Record<string, CryptoFactorEntry> = {};

  // Orthogonalize ETH against BTC
  const n0 = Math.min(benchmarks.btc.length, benchmarks.eth.length);
  const btc = benchmarks.btc.slice(0, n0);
  const eth = benchmarks.eth.slice(0, n0);

  // Regress ETH on BTC to get residual (orthogonalized ETH factor)
  const ethOnBtc = olsRegression(eth, btc.map(b => [b]));
  const ethOrtho = ethOnBtc.residuals;

  for (const [symbol, assetRet] of Object.entries(returns)) {
    const n = Math.min(assetRet.length, btc.length, ethOrtho.length);
    if (n < 3) {
      result[symbol] = { btcBeta: 0, ethBeta: 0, alpha: 0, rSquared: 0, idiosyncraticVol: 0 };
      continue;
    }

    const y = assetRet.slice(0, n);
    const X: number[][] = Array.from({ length: n }, (_, i) => [btc[i], ethOrtho[i]]);
    const reg = olsRegression(y, X);

    result[symbol] = {
      btcBeta: reg.betas[0],
      ethBeta: reg.betas[1],
      alpha: reg.alpha,
      rSquared: Math.max(0, Math.min(1, reg.rSquared)),
      idiosyncraticVol: standardDeviation(reg.residuals),
    };
  }

  return result;
}

/**
 * Sector-level exposure and attribution.
 */
export function sectorExposure(
  holdings: Array<{ symbol: string; weight: number; sector: string }>,
  sectorReturns: Record<string, number[]>
): SectorExposureResult {
  // Aggregate weights by sector
  const sectorWeights: Record<string, number> = {};
  for (const h of holdings) {
    sectorWeights[h.sector] = (sectorWeights[h.sector] ?? 0) + h.weight;
  }

  const sectors: SectorEntry[] = Object.entries(sectorWeights).map(([sector, weight]) => {
    const rets = sectorReturns[sector];
    const contribution = rets && rets.length > 0
      ? weight * rets.reduce((s, r) => s + r, 0)
      : 0;
    return { sector, weight, contribution };
  });

  // Concentration: weight of the largest sector
  const concentration = sectors.length > 0
    ? Math.max(...sectors.map(s => Math.abs(s.weight)))
    : 0;

  // Herfindahl-Hirschman index
  const herfindahl = sectors.reduce((s, sec) => s + sec.weight * sec.weight, 0);

  return { sectors, concentration, herfindahl };
}

/**
 * Full risk decomposition: total, systematic, idiosyncratic, diversification ratio.
 */
export function riskDecomposition(
  weights: number[],
  covMatrix: number[][]
): RiskDecompositionResult {
  const n = weights.length;
  const covW = matVecMultiply(covMatrix, weights);
  const portVariance = vecDot(weights, covW);
  const totalRisk = Math.sqrt(Math.max(0, portVariance));

  // Individual asset volatilities
  const assetVols = covMatrix.map((row, i) => Math.sqrt(Math.max(0, row[i])));

  // Weighted sum of individual volatilities (undiversified risk)
  const undiversifiedRisk = weights.reduce((s, w, i) => s + Math.abs(w) * assetVols[i], 0);

  // Diversification ratio
  const diversificationRatio = totalRisk === 0 ? 1 : undiversifiedRisk / totalRisk;

  // Risk contributions: w_i * (Sigma * w)_i / sigma_p
  const riskContributions: number[] = weights.map((w, i) =>
    totalRisk === 0 ? 0 : w * covW[i] / totalRisk
  );

  // Marginal risk contributions: (Sigma * w)_i / sigma_p
  const marginalRiskContributions: number[] = covW.map(c =>
    totalRisk === 0 ? 0 : c / totalRisk
  );

  // Systematic risk: from cross-asset covariances
  // Idiosyncratic risk: from diagonal-only variance
  let diagonalVariance = 0;
  for (let i = 0; i < n; i++) {
    diagonalVariance += weights[i] * weights[i] * covMatrix[i][i];
  }
  const idiosyncraticRisk = Math.sqrt(Math.max(0, diagonalVariance));
  const systematicRisk = Math.sqrt(Math.max(0, portVariance - diagonalVariance));

  return {
    totalRisk,
    systematicRisk,
    idiosyncraticRisk,
    diversificationRatio,
    riskContributions,
    marginalRiskContributions,
  };
}

/**
 * Robust covariance estimation: sample, Ledoit-Wolf shrinkage, or exponential weighting.
 */
export function covarianceMatrix(
  returnsSeries: Record<string, number[]>,
  method: 'sample' | 'shrinkage' | 'exponential' = 'sample',
  params?: { shrinkageTarget?: 'identity' | 'constant_correlation'; halfLife?: number }
): CovarianceMatrixResult {
  const symbols = Object.keys(returnsSeries);
  const p = symbols.length;
  if (p === 0) return { matrix: [], symbols: [], method };

  const series = symbols.map(s => returnsSeries[s]);
  const n = Math.min(...series.map(s => s.length));
  if (n < 2) {
    return {
      matrix: Array.from({ length: p }, () => Array(p).fill(0)),
      symbols,
      method,
    };
  }

  // Center data
  const centered: number[][] = series.map(s => {
    const slice = s.slice(0, n);
    const m = mean(slice);
    return slice.map(v => v - m);
  });

  if (method === 'exponential') {
    const halfLife = params?.halfLife ?? 30;
    const lambda = Math.log(2) / halfLife;
    // Exponentially weighted covariance
    let totalWeight = 0;
    const cov: number[][] = Array.from({ length: p }, () => Array(p).fill(0));

    for (let t = 0; t < n; t++) {
      const w = Math.exp(-lambda * (n - 1 - t));
      totalWeight += w;
      for (let i = 0; i < p; i++) {
        for (let j = i; j < p; j++) {
          cov[i][j] += w * centered[i][t] * centered[j][t];
        }
      }
    }

    for (let i = 0; i < p; i++) {
      for (let j = i; j < p; j++) {
        const val = totalWeight > 0 ? cov[i][j] / totalWeight : 0;
        cov[i][j] = val;
        cov[j][i] = val;
      }
    }

    return { matrix: cov, symbols, method: 'exponential' };
  }

  // Sample covariance
  const S = sampleCov(centered, n);

  if (method === 'sample') {
    return { matrix: S, symbols, method: 'sample' };
  }

  // Ledoit-Wolf shrinkage
  const target = params?.shrinkageTarget ?? 'identity';
  let F: number[][];

  if (target === 'identity') {
    // Target = average variance * identity
    const avgVar = S.reduce((s, row, i) => s + row[i], 0) / p;
    F = Array.from({ length: p }, (_, i) => {
      const row = Array(p).fill(0);
      row[i] = avgVar;
      return row;
    });
  } else {
    // Constant correlation target
    const variances = S.map((row, i) => row[i]);
    let sumCorr = 0;
    let countCorr = 0;
    for (let i = 0; i < p; i++) {
      for (let j = i + 1; j < p; j++) {
        const si = Math.sqrt(variances[i]);
        const sj = Math.sqrt(variances[j]);
        if (si > 0 && sj > 0) {
          sumCorr += S[i][j] / (si * sj);
          countCorr++;
        }
      }
    }
    const avgCorr = countCorr > 0 ? sumCorr / countCorr : 0;
    F = Array.from({ length: p }, (_, i) => {
      return Array.from({ length: p }, (_, j) => {
        if (i === j) return variances[i];
        return avgCorr * Math.sqrt(variances[i]) * Math.sqrt(variances[j]);
      });
    });
  }

  // Compute optimal shrinkage intensity (Ledoit-Wolf formula)
  // Simplified: use Frobenius norm approach
  let sumPi = 0; // sum of asymptotic variances of s_ij scaled by n
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let piij = 0;
      for (let t = 0; t < n; t++) {
        piij += (centered[i][t] * centered[j][t] - S[i][j]) ** 2;
      }
      piij /= n;
      sumPi += piij;
    }
  }

  let sumGamma = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      sumGamma += (F[i][j] - S[i][j]) ** 2;
    }
  }

  const shrinkageIntensity = sumGamma === 0 ? 0 : Math.max(0, Math.min(1, sumPi / (n * sumGamma)));

  // Shrunk matrix = delta * F + (1 - delta) * S
  const matrix: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) =>
      shrinkageIntensity * F[i][j] + (1 - shrinkageIntensity) * S[i][j]
    )
  );

  return { matrix, symbols, method: `shrinkage(${target}, intensity=${shrinkageIntensity.toFixed(4)})` };
}
