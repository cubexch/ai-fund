/**
 * Portfolio optimization library.
 * Pure functions for Markowitz, risk parity, Black-Litterman, HRP, and more.
 * No async, no exchange clients, no MCP, no zod.
 */

import { mean, standardDeviation, correlation, sharpeRatio } from './math.js';

// ── Public Types ─────────────────────────────────────────

export interface OptimizationConstraints {
  minWeight?: number;
  maxWeight?: number;
  longOnly?: boolean;
}

export interface PortfolioResult {
  weights: Record<string, number>;
  expectedReturn: number;
  risk: number;
  sharpe: number;
}

export interface RiskParityResult {
  weights: Record<string, number>;
  riskContributions: Record<string, number>;
  totalRisk: number;
}

export interface BlackLittermanResult {
  weights: Record<string, number>;
  posteriorReturns: Record<string, number>;
  priorReturns: Record<string, number>;
}

export interface MaxDiversificationResult {
  weights: Record<string, number>;
  diversificationRatio: number;
  portfolioVol: number;
}

export interface EfficientFrontierResult {
  frontier: Array<{
    expectedReturn: number;
    risk: number;
    sharpe: number;
    weights: Record<string, number>;
  }>;
  tangencyPortfolio: {
    expectedReturn: number;
    risk: number;
    sharpe: number;
    weights: Record<string, number>;
  };
}

export interface DendrogramNode {
  left: string | number;
  right: string | number;
  distance: number;
}

export interface HRPResult {
  weights: Record<string, number>;
  dendrogram: DendrogramNode[];
  clusters: string[][];
}

export interface RebalanceResult {
  trades: Record<string, number>;
  newWeights: Record<string, number>;
  totalTurnover: number;
  estimatedCost: number;
  skippedSmallTrades: string[];
}

// ── Internal Matrix Helpers ──────────────────────────────

function matCreate(rows: number, cols: number, fill: number = 0): number[][] {
  return Array.from({ length: rows }, () => Array(cols).fill(fill));
}

function matMultiply(a: number[][], b: number[][]): number[][] {
  const rows = a.length;
  const cols = b[0].length;
  const inner = b.length;
  const result = matCreate(rows, cols);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      let sum = 0;
      for (let k = 0; k < inner; k++) {
        sum += a[i][k] * b[k][j];
      }
      result[i][j] = sum;
    }
  }
  return result;
}

function matTranspose(a: number[][]): number[][] {
  const rows = a.length;
  const cols = a[0].length;
  const result = matCreate(cols, rows);
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      result[j][i] = a[i][j];
    }
  }
  return result;
}

function matIdentity(n: number): number[][] {
  const result = matCreate(n, n);
  for (let i = 0; i < n; i++) result[i][i] = 1;
  return result;
}

/**
 * Matrix inverse via Gauss-Jordan elimination.
 */
function matInverse(m: number[][]): number[][] {
  const n = m.length;
  const aug = matCreate(n, 2 * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) aug[i][j] = m[i][j];
    aug[i][n + i] = 1;
  }

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(aug[row][col]) > Math.abs(aug[maxRow][col])) maxRow = row;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) {
      // Singular — add small regularization
      aug[col][col] += 1e-8;
    }
    const pivotVal = aug[col][col];
    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivotVal;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = aug[row][col];
      for (let j = 0; j < 2 * n; j++) {
        aug[row][j] -= factor * aug[col][j];
      }
    }
  }

  const inv = matCreate(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      inv[i][j] = aug[i][n + j];
    }
  }
  return inv;
}

/**
 * Matrix-vector multiply: M * v -> vector.
 */
function matVecMultiply(m: number[][], v: number[]): number[] {
  return m.map(row => row.reduce((s, val, j) => s + val * v[j], 0));
}

/**
 * Dot product of two vectors.
 */
function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Cholesky decomposition: returns lower triangular L such that A = L * L^T.
 * Assumes A is symmetric positive semi-definite; adds regularization if needed.
 */
function cholesky(a: number[][]): number[][] {
  const n = a.length;
  const L = matCreate(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        const diag = a[i][i] - sum;
        L[i][j] = Math.sqrt(Math.max(diag, 1e-10));
      } else {
        L[i][j] = (a[i][j] - sum) / (L[j][j] || 1e-10);
      }
    }
  }
  return L;
}

// ── Internal Helpers ─────────────────────────────────────

function buildCovarianceMatrix(returnSeries: number[][]): number[][] {
  const n = returnSeries.length;
  const cov = matCreate(n, n);
  const means = returnSeries.map(s => mean(s));
  const minLen = Math.min(...returnSeries.map(s => s.length));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let sum = 0;
      for (let t = 0; t < minLen; t++) {
        sum += (returnSeries[i][t] - means[i]) * (returnSeries[j][t] - means[j]);
      }
      const val = minLen > 1 ? sum / (minLen - 1) : 0;
      cov[i][j] = val;
      cov[j][i] = val;
    }
  }
  return cov;
}

function extractSymbolsAndReturns(returnsMap: Record<string, number[]>): { symbols: string[]; series: number[][] } {
  const symbols = Object.keys(returnsMap);
  const series = symbols.map(s => returnsMap[s]);
  return { symbols, series };
}

function projectWeights(w: number[], constraints?: OptimizationConstraints): number[] {
  const n = w.length;
  const result = [...w];
  const longOnly = constraints?.longOnly ?? true;
  const minW = constraints?.minWeight ?? (longOnly ? 0 : -1);
  const maxW = constraints?.maxWeight ?? 1;

  // Clamp to bounds
  for (let i = 0; i < n; i++) {
    result[i] = Math.max(minW, Math.min(maxW, result[i]));
  }

  // Normalize to sum to 1
  const sum = result.reduce((a, b) => a + b, 0);
  if (Math.abs(sum) > 1e-12) {
    for (let i = 0; i < n; i++) result[i] /= sum;
  } else {
    // Fallback: equal weight
    for (let i = 0; i < n; i++) result[i] = 1 / n;
  }

  // Re-clamp after normalization (iterate a few times to converge)
  for (let iter = 0; iter < 10; iter++) {
    let clipped = false;
    for (let i = 0; i < n; i++) {
      if (result[i] < minW) { result[i] = minW; clipped = true; }
      if (result[i] > maxW) { result[i] = maxW; clipped = true; }
    }
    if (!clipped) break;
    const s = result.reduce((a, b) => a + b, 0);
    if (Math.abs(s) > 1e-12) {
      for (let i = 0; i < n; i++) result[i] /= s;
    }
  }

  return result;
}

function portfolioReturn(weights: number[], meanReturns: number[]): number {
  return dot(weights, meanReturns);
}

function portfolioVariance(weights: number[], cov: number[][]): number {
  const wCov = matVecMultiply(cov, weights);
  return Math.max(0, dot(weights, wCov));
}

function portfolioVol(weights: number[], cov: number[][]): number {
  return Math.sqrt(portfolioVariance(weights, cov));
}

function weightsToRecord(symbols: string[], weights: number[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (let i = 0; i < symbols.length; i++) {
    result[symbols[i]] = weights[i];
  }
  return result;
}

function computeSharpe(ret: number, risk: number, rfRate: number): number {
  return risk === 0 ? 0 : (ret - rfRate) / risk;
}

// ── Public Functions ─────────────────────────────────────

/**
 * Markowitz mean-variance optimization.
 * Finds the portfolio maximizing the Sharpe ratio using iterative projected gradient ascent.
 */
export function meanVariance(params: {
  returns: Record<string, number[]>;
  riskFreeRate?: number;
  constraints?: OptimizationConstraints;
}): PortfolioResult {
  const { symbols, series } = extractSymbolsAndReturns(params.returns);
  const n = symbols.length;
  const rfRate = params.riskFreeRate ?? 0;
  const cov = buildCovarianceMatrix(series);
  const meanRets = series.map(s => mean(s));

  // Gradient ascent on Sharpe ratio
  let weights = Array(n).fill(1 / n);
  const lr = 0.01;
  const iterations = 2000;

  for (let iter = 0; iter < iterations; iter++) {
    const pRet = portfolioReturn(weights, meanRets);
    const pVar = portfolioVariance(weights, cov);
    const pVol = Math.sqrt(Math.max(pVar, 1e-12));
    const excess = pRet - rfRate;

    // Gradient of Sharpe = (mu * sigma - excess * d_sigma/dw) / sigma^2
    const covW = matVecMultiply(cov, weights);
    const grad = meanRets.map((mu, i) =>
      (mu * pVol - excess * covW[i] / pVol) / (pVol * pVol)
    );

    for (let i = 0; i < n; i++) {
      weights[i] += lr * grad[i];
    }
    weights = projectWeights(weights, params.constraints);
  }

  const expRet = portfolioReturn(weights, meanRets);
  const risk = portfolioVol(weights, cov);
  const sharpe = computeSharpe(expRet, risk, rfRate);

  return {
    weights: weightsToRecord(symbols, weights),
    expectedReturn: expRet,
    risk,
    sharpe,
  };
}

/**
 * Global minimum variance portfolio.
 * Analytical solution: w = (Sigma^-1 * 1) / (1^T * Sigma^-1 * 1), projected onto constraints.
 */
export function minimumVariance(params: {
  returns: Record<string, number[]>;
  constraints?: OptimizationConstraints;
}): PortfolioResult {
  const { symbols, series } = extractSymbolsAndReturns(params.returns);
  const n = symbols.length;
  const cov = buildCovarianceMatrix(series);
  const meanRets = series.map(s => mean(s));

  const invCov = matInverse(cov);
  const ones = Array(n).fill(1);
  const invCovOnes = matVecMultiply(invCov, ones);
  const denom = dot(ones, invCovOnes);

  let weights: number[];
  if (Math.abs(denom) < 1e-12) {
    weights = Array(n).fill(1 / n);
  } else {
    weights = invCovOnes.map(w => w / denom);
  }

  weights = projectWeights(weights, params.constraints);

  const expRet = portfolioReturn(weights, meanRets);
  const risk = portfolioVol(weights, cov);
  const sharpe = computeSharpe(expRet, risk, 0);

  return {
    weights: weightsToRecord(symbols, weights),
    expectedReturn: expRet,
    risk,
    sharpe,
  };
}

/**
 * Risk parity: each asset contributes equally (or proportionally) to portfolio risk.
 * Uses iterative optimization to match target risk budgets.
 */
export function riskParity(params: {
  returns: Record<string, number[]>;
  riskBudgets?: Record<string, number>;
}): RiskParityResult {
  const { symbols, series } = extractSymbolsAndReturns(params.returns);
  const n = symbols.length;
  const cov = buildCovarianceMatrix(series);

  // Default: equal risk budget
  const budgets = symbols.map(s => params.riskBudgets?.[s] ?? 1 / n);
  const budgetSum = budgets.reduce((a, b) => a + b, 0);
  const normBudgets = budgets.map(b => b / budgetSum);

  let weights = Array(n).fill(1 / n);
  const lr = 0.001;
  const iterations = 3000;

  for (let iter = 0; iter < iterations; iter++) {
    const covW = matVecMultiply(cov, weights);
    const pVol = Math.sqrt(Math.max(dot(weights, covW), 1e-12));

    // Risk contribution: RC_i = w_i * (Cov * w)_i / sigma_p
    const rc = weights.map((w, i) => w * covW[i] / pVol);
    const totalRc = rc.reduce((a, b) => a + b, 0);
    const rcPct = rc.map(r => r / (totalRc || 1));

    // Gradient: push toward target budget
    const grad = rcPct.map((r, i) => r - normBudgets[i]);

    for (let i = 0; i < n; i++) {
      weights[i] -= lr * grad[i];
      weights[i] = Math.max(1e-6, weights[i]);
    }
    const wSum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < n; i++) weights[i] /= wSum;
  }

  // Final risk contributions
  const covW = matVecMultiply(cov, weights);
  const totalRisk = Math.sqrt(Math.max(dot(weights, covW), 1e-12));
  const rcs: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    rcs[symbols[i]] = weights[i] * covW[i] / totalRisk;
  }

  return {
    weights: weightsToRecord(symbols, weights),
    riskContributions: rcs,
    totalRisk,
  };
}

/**
 * Black-Litterman model.
 * Blends market-implied equilibrium returns with subjective views.
 */
export function blackLitterman(params: {
  marketCaps: Record<string, number>;
  returns: Record<string, number[]>;
  views: Array<{ assets: Record<string, number>; expectedReturn: number; confidence: number }>;
  riskAversion?: number;
  tau?: number;
}): BlackLittermanResult {
  const { symbols, series } = extractSymbolsAndReturns(params.returns);
  const n = symbols.length;
  const delta = params.riskAversion ?? 2.5;
  const tau = params.tau ?? 0.05;
  const cov = buildCovarianceMatrix(series);

  // Market-cap weights
  const totalCap = symbols.reduce((s, sym) => s + (params.marketCaps[sym] ?? 0), 0);
  const mktWeights = symbols.map(sym => (params.marketCaps[sym] ?? 0) / (totalCap || 1));

  // Equilibrium (prior) returns: pi = delta * Sigma * w_mkt
  const pi = matVecMultiply(cov, mktWeights).map(v => v * delta);
  const priorReturns: Record<string, number> = {};
  for (let i = 0; i < n; i++) priorReturns[symbols[i]] = pi[i];

  const views = params.views;
  if (views.length === 0) {
    // No views — return equilibrium portfolio
    const invCov = matInverse(cov);
    const rawW = matVecMultiply(invCov, pi);
    const wSum = rawW.reduce((a, b) => a + b, 0);
    const weights = rawW.map(w => w / (wSum || 1));
    return {
      weights: weightsToRecord(symbols, weights),
      posteriorReturns: { ...priorReturns },
      priorReturns,
    };
  }

  // Build P (pick matrix) and Q (view returns)
  const k = views.length;
  const P = matCreate(k, n);
  const Q: number[] = [];
  const omega = matCreate(k, k);

  for (let v = 0; v < k; v++) {
    const view = views[v];
    Q.push(view.expectedReturn);
    for (let i = 0; i < n; i++) {
      P[v][i] = view.assets[symbols[i]] ?? 0;
    }
    // Omega: uncertainty of view. Lower confidence -> higher uncertainty.
    const conf = Math.max(0.01, Math.min(1, view.confidence));
    // Omega_ii = tau * P * Sigma * P' / confidence
    const pSigma = matVecMultiply(cov, P[v]);
    const pSigmaPt = dot(P[v], pSigma);
    omega[v][v] = tau * pSigmaPt / conf;
  }

  // Posterior returns: mu_BL = [(tau*Sigma)^-1 + P'*Omega^-1*P]^-1 * [(tau*Sigma)^-1*pi + P'*Omega^-1*Q]
  const tauSigma = cov.map(row => row.map(v => v * tau));
  const tauSigmaInv = matInverse(tauSigma);
  const omegaInv = matInverse(omega);
  const Pt = matTranspose(P);
  const PtOmegaInv = matMultiply(Pt, omegaInv);
  const PtOmegaInvP = matMultiply(PtOmegaInv, P);

  // A = tauSigmaInv + PtOmegaInvP
  const A = tauSigmaInv.map((row, i) => row.map((v, j) => v + PtOmegaInvP[i][j]));
  const Ainv = matInverse(A);

  // b = tauSigmaInv * pi + PtOmegaInv * Q
  const b1 = matVecMultiply(tauSigmaInv, pi);
  const b2 = matVecMultiply(PtOmegaInv, Q);
  const b = b1.map((v, i) => v + b2[i]);

  const posteriorMu = matVecMultiply(Ainv, b);
  const posteriorReturns: Record<string, number> = {};
  for (let i = 0; i < n; i++) posteriorReturns[symbols[i]] = posteriorMu[i];

  // Optimal weights from posterior
  const invCov = matInverse(cov);
  const rawW = matVecMultiply(invCov, posteriorMu);
  const wSum = rawW.reduce((a, b) => a + b, 0);
  const weights = rawW.map(w => w / (wSum || 1));

  return {
    weights: weightsToRecord(symbols, weights),
    posteriorReturns,
    priorReturns,
  };
}

/**
 * Maximum diversification portfolio.
 * Maximizes the diversification ratio: weighted average volatility / portfolio volatility.
 */
export function maxDiversification(params: {
  returns: Record<string, number[]>;
  constraints?: { minWeight?: number; maxWeight?: number };
}): MaxDiversificationResult {
  const { symbols, series } = extractSymbolsAndReturns(params.returns);
  const n = symbols.length;
  const cov = buildCovarianceMatrix(series);
  const vols = series.map(s => standardDeviation(s));

  let weights = Array(n).fill(1 / n);
  const lr = 0.005;
  const iterations = 2000;
  const minW = params.constraints?.minWeight ?? 0;
  const maxW = params.constraints?.maxWeight ?? 1;

  for (let iter = 0; iter < iterations; iter++) {
    const covW = matVecMultiply(cov, weights);
    const pVar = Math.max(dot(weights, covW), 1e-12);
    const pVol = Math.sqrt(pVar);
    const wAvgVol = dot(weights, vols);

    // Gradient of diversification ratio = (vol_i * pVol - wAvgVol * covW_i / pVol) / pVar
    const grad = vols.map((v, i) =>
      (v * pVol - wAvgVol * covW[i] / pVol) / pVar
    );

    for (let i = 0; i < n; i++) {
      weights[i] += lr * grad[i];
      weights[i] = Math.max(minW, Math.min(maxW, weights[i]));
    }
    const wSum = weights.reduce((a, b) => a + b, 0);
    if (wSum > 1e-12) {
      for (let i = 0; i < n; i++) weights[i] /= wSum;
    }
  }

  const covW = matVecMultiply(cov, weights);
  const pVol = Math.sqrt(Math.max(dot(weights, covW), 1e-12));
  const wAvgVol = dot(weights, vols);
  const divRatio = pVol > 0 ? wAvgVol / pVol : 1;

  return {
    weights: weightsToRecord(symbols, weights),
    diversificationRatio: divRatio,
    portfolioVol: pVol,
  };
}

/**
 * Generate points along the efficient frontier.
 * Returns frontier points and the tangency (max Sharpe) portfolio.
 */
export function efficientFrontier(params: {
  returns: Record<string, number[]>;
  points?: number;
  riskFreeRate?: number;
  constraints?: OptimizationConstraints;
}): EfficientFrontierResult {
  const { symbols, series } = extractSymbolsAndReturns(params.returns);
  const n = symbols.length;
  const numPoints = params.points ?? 20;
  const rfRate = params.riskFreeRate ?? 0;
  const cov = buildCovarianceMatrix(series);
  const meanRets = series.map(s => mean(s));

  // Find min and max feasible returns
  const minRet = Math.min(...meanRets);
  const maxRet = Math.max(...meanRets);

  const frontier: Array<{
    expectedReturn: number;
    risk: number;
    sharpe: number;
    weights: Record<string, number>;
  }> = [];

  let bestSharpe = -Infinity;
  let tangency = {
    expectedReturn: 0,
    risk: 0,
    sharpe: 0,
    weights: {} as Record<string, number>,
  };

  for (let p = 0; p < numPoints; p++) {
    const targetRet = minRet + (maxRet - minRet) * p / (numPoints - 1);

    // Minimize variance subject to target return using gradient descent
    let weights = Array(n).fill(1 / n);
    const lr = 0.005;
    const penalty = 100;

    for (let iter = 0; iter < 1500; iter++) {
      const covW = matVecMultiply(cov, weights);
      const pRet = portfolioReturn(weights, meanRets);
      const retDiff = pRet - targetRet;

      // Gradient of variance + penalty for return constraint
      const grad = covW.map((v, i) => 2 * v + penalty * 2 * retDiff * meanRets[i]);

      for (let i = 0; i < n; i++) {
        weights[i] -= lr * grad[i];
      }
      weights = projectWeights(weights, params.constraints);
    }

    const expRet = portfolioReturn(weights, meanRets);
    const risk = portfolioVol(weights, cov);
    const sharpe = computeSharpe(expRet, risk, rfRate);

    const point = {
      expectedReturn: expRet,
      risk,
      sharpe,
      weights: weightsToRecord(symbols, weights),
    };
    frontier.push(point);

    if (sharpe > bestSharpe) {
      bestSharpe = sharpe;
      tangency = point;
    }
  }

  return { frontier, tangencyPortfolio: tangency };
}

/**
 * Hierarchical Risk Parity (Lopez de Prado).
 * 1. Cluster correlated assets via single-linkage.
 * 2. Quasi-diagonalize the covariance matrix.
 * 3. Recursive bisection allocation inversely proportional to cluster variance.
 */
export function hierarchicalRiskParity(params: {
  returns: Record<string, number[]>;
}): HRPResult {
  const { symbols, series } = extractSymbolsAndReturns(params.returns);
  const n = symbols.length;
  const cov = buildCovarianceMatrix(series);

  // Distance matrix from correlation
  const dist = matCreate(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const corr = n > 1 ? correlation(series[i], series[j]) : 0;
      const d = Math.sqrt(0.5 * (1 - corr));
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  // Single-linkage agglomerative clustering
  const dendrogram: DendrogramNode[] = [];
  const clusterMap = new Map<number, number[]>(); // cluster id -> list of original indices
  for (let i = 0; i < n; i++) clusterMap.set(i, [i]);

  const activeIds = new Set<number>(Array.from({ length: n }, (_, i) => i));
  let nextId = n;

  for (let step = 0; step < n - 1; step++) {
    // Find closest pair
    let minDist = Infinity;
    let bestA = -1;
    let bestB = -1;

    const ids = Array.from(activeIds);
    for (let ai = 0; ai < ids.length; ai++) {
      for (let bi = ai + 1; bi < ids.length; bi++) {
        const a = ids[ai];
        const b = ids[bi];
        const membersA = clusterMap.get(a)!;
        const membersB = clusterMap.get(b)!;
        // Single linkage: min distance between any pair
        let d = Infinity;
        for (const ma of membersA) {
          for (const mb of membersB) {
            if (dist[ma][mb] < d) d = dist[ma][mb];
          }
        }
        if (d < minDist) {
          minDist = d;
          bestA = a;
          bestB = b;
        }
      }
    }

    const merged = [...clusterMap.get(bestA)!, ...clusterMap.get(bestB)!];
    dendrogram.push({
      left: bestA < n ? symbols[bestA] : bestA - n,
      right: bestB < n ? symbols[bestB] : bestB - n,
      distance: minDist,
    });

    clusterMap.set(nextId, merged);
    activeIds.delete(bestA);
    activeIds.delete(bestB);
    activeIds.add(nextId);
    nextId++;
  }

  // Get ordering from dendrogram (quasi-diagonalization)
  const rootId = nextId - 1;
  function getOrder(id: number): number[] {
    const members = clusterMap.get(id);
    if (!members || members.length === 1) return members ?? [];
    // Find which dendrogram step merged this cluster
    const stepIdx = id - n;
    if (stepIdx < 0 || stepIdx >= dendrogram.length) return members;
    const node = dendrogram[stepIdx];
    const leftId = typeof node.left === 'string' ? symbols.indexOf(node.left) : node.left + n;
    const rightId = typeof node.right === 'string' ? symbols.indexOf(node.right) : node.right + n;
    return [...getOrder(leftId), ...getOrder(rightId)];
  }
  const order = getOrder(rootId);

  // Recursive bisection
  const weights = Array(n).fill(1);

  function bisect(indices: number[]): void {
    if (indices.length <= 1) return;
    const mid = Math.floor(indices.length / 2);
    const left = indices.slice(0, mid);
    const right = indices.slice(mid);

    // Cluster variance for each half
    function clusterVar(idx: number[]): number {
      if (idx.length === 1) return cov[idx[0]][idx[0]];
      const subCov: number[][] = idx.map(i => idx.map(j => cov[i][j]));
      const invSubCov = matInverse(subCov);
      const ones = Array(idx.length).fill(1);
      const invOnes = matVecMultiply(invSubCov, ones);
      const denom = dot(ones, invOnes);
      return denom > 0 ? 1 / denom : 1;
    }

    const vL = clusterVar(left);
    const vR = clusterVar(right);
    const alpha = 1 - vL / (vL + vR);

    for (const i of left) weights[i] *= alpha;
    for (const i of right) weights[i] *= (1 - alpha);

    bisect(left);
    bisect(right);
  }

  bisect(order);

  // Normalize
  const wSum = weights.reduce((a: number, b: number) => a + b, 0);
  for (let i = 0; i < n; i++) weights[i] /= wSum || 1;

  // Extract clusters (2 main clusters from root split)
  const clusters: string[][] = [];
  if (order.length > 1) {
    const mid = Math.floor(order.length / 2);
    clusters.push(order.slice(0, mid).map(i => symbols[i]));
    clusters.push(order.slice(mid).map(i => symbols[i]));
  } else {
    clusters.push(symbols.slice());
  }

  return {
    weights: weightsToRecord(symbols, weights),
    dendrogram,
    clusters,
  };
}

/**
 * Simple 1/N equal weight allocation.
 */
export function equalWeight(symbols: string[]): Record<string, number> {
  const w = 1 / symbols.length;
  const result: Record<string, number> = {};
  for (const s of symbols) result[s] = w;
  return result;
}

/**
 * Inverse volatility weighting: allocate inversely proportional to each asset's volatility.
 */
export function inverseVolatility(params: {
  returns: Record<string, number[]>;
}): { weights: Record<string, number>; volatilities: Record<string, number> } {
  const { symbols, series } = extractSymbolsAndReturns(params.returns);
  const vols = series.map(s => standardDeviation(s));
  const invVols = vols.map(v => (v > 0 ? 1 / v : 0));
  const totalInvVol = invVols.reduce((a, b) => a + b, 0);

  const weights: Record<string, number> = {};
  const volatilities: Record<string, number> = {};
  for (let i = 0; i < symbols.length; i++) {
    weights[symbols[i]] = totalInvVol > 0 ? invVols[i] / totalInvVol : 1 / symbols.length;
    volatilities[symbols[i]] = vols[i];
  }

  return { weights, volatilities };
}

/**
 * Optimal rebalance considering transaction costs.
 * Only rebalances positions where the benefit exceeds the cost.
 */
export function rebalanceOptimal(params: {
  currentWeights: Record<string, number>;
  targetWeights: Record<string, number>;
  transactionCost?: number;
  minTradeSize?: number;
}): RebalanceResult {
  const txCost = params.transactionCost ?? 0.001; // 10 bps default
  const minTrade = params.minTradeSize ?? 0.005;  // 0.5% minimum trade

  const allSymbols = new Set([
    ...Object.keys(params.currentWeights),
    ...Object.keys(params.targetWeights),
  ]);

  const trades: Record<string, number> = {};
  const newWeights: Record<string, number> = {};
  const skippedSmallTrades: string[] = [];
  let totalTurnover = 0;

  for (const sym of allSymbols) {
    const current = params.currentWeights[sym] ?? 0;
    const target = params.targetWeights[sym] ?? 0;
    const diff = target - current;
    const absDiff = Math.abs(diff);

    // Skip if trade is too small or cost exceeds benefit
    if (absDiff < minTrade) {
      skippedSmallTrades.push(sym);
      newWeights[sym] = current;
      continue;
    }

    // Cost-benefit: the tracking error reduction from trading must exceed the cost
    // Simple heuristic: trade if |diff| * (1 - txCost) > txCost
    const benefit = absDiff;
    const cost = absDiff * txCost;
    if (benefit <= cost * 2) {
      skippedSmallTrades.push(sym);
      newWeights[sym] = current;
      continue;
    }

    trades[sym] = diff;
    newWeights[sym] = target;
    totalTurnover += absDiff;
  }

  const estimatedCost = totalTurnover * txCost;

  return {
    trades,
    newWeights,
    totalTurnover,
    estimatedCost,
    skippedSmallTrades,
  };
}
