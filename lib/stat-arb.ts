/**
 * Statistical arbitrage and pairs trading analytics.
 * Cointegration tests, hedge ratio estimation, spread analysis,
 * Kalman filter, and pair scoring.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import { correlation, mean, standardDeviation, zScore } from './math.js';

// ── Types ────────────────────────────────────────────────

export interface AdfTestResult {
  statistic: number;
  pValue: number;
  stationary: boolean;
  criticalValues: { '1%': number; '5%': number; '10%': number };
}

export interface EngleGrangerResult {
  cointegrated: boolean;
  pValue: number;
  hedgeRatio: number;
  residuals: number[];
  adfStat: number;
  criticalValues: { '1%': number; '5%': number; '10%': number };
}

export interface HedgeRatioResult {
  ratio: number;
  intercept: number;
  rSquared: number;
}

export interface SpreadZScoreResult {
  zScore: number;
  spread: number;
  mean: number;
  std: number;
  percentile: number;
}

export interface PairSignalResult {
  signal: 'long_spread' | 'short_spread' | 'exit' | 'stop' | 'neutral';
  strength: number;
}

export interface PairScore {
  symbolA: string;
  symbolB: string;
  correlation: number;
  cointegrated: boolean;
  adfStat: number;
  halfLife: number;
  score: number;
}

export interface KalmanHedgeResult {
  ratios: number[];
  currentRatio: number;
  confidence: number;
}

export interface JohansenResult {
  rank: number;
  eigenvalues: number[];
  traceStats: number[];
  criticalValues: number[];
}

export interface RollingSpreadStatsResult {
  means: number[];
  stds: number[];
  zScores: number[];
  halfLives: number[];
  timestamps: number[];
}

// ── Internal Helpers ─────────────────────────────────────

/**
 * Simple OLS regression: y = a + b*x.
 * Returns { slope, intercept, rSquared, residuals }.
 */
function olsSimple(y: number[], x: number[]): {
  slope: number;
  intercept: number;
  rSquared: number;
  residuals: number[];
} {
  const n = Math.min(y.length, x.length);
  if (n < 2) return { slope: 0, intercept: 0, rSquared: 0, residuals: [] };

  const xm = mean(x.slice(0, n));
  const ym = mean(y.slice(0, n));

  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - xm;
    sumXY += dx * (y[i] - ym);
    sumX2 += dx * dx;
  }

  const slope = sumX2 === 0 ? 0 : sumXY / sumX2;
  const intercept = ym - slope * xm;

  const residuals: number[] = [];
  let ssRes = 0;
  let ssTot = 0;

  for (let i = 0; i < n; i++) {
    const r = y[i] - (intercept + slope * x[i]);
    residuals.push(r);
    ssRes += r * r;
    ssTot += (y[i] - ym) ** 2;
  }

  const rSquared = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  return { slope, intercept, rSquared, residuals };
}

/**
 * MacKinnon critical values for ADF test (no trend, constant only).
 * Approximated for finite samples.
 */
function adfCriticalValues(n: number): { '1%': number; '5%': number; '10%': number } {
  // Asymptotic values with finite-sample corrections
  return {
    '1%': -3.43 - 6.0 / n,
    '5%': -2.86 - 2.74 / n,
    '10%': -2.57 - 1.67 / n,
  };
}

/**
 * Approximate p-value from ADF statistic using interpolation.
 */
function adfPValue(stat: number, n: number): number {
  const cv = adfCriticalValues(n);
  if (stat <= cv['1%']) return 0.005;
  if (stat <= cv['5%']) return 0.03;
  if (stat <= cv['10%']) return 0.07;
  // Linear interpolation beyond 10%
  const diff = stat - cv['10%'];
  return Math.min(1, 0.1 + diff * 0.15);
}

// ── Public Functions ─────────────────────────────────────

/**
 * Augmented Dickey-Fuller unit root test.
 * Tests H0: series has a unit root (non-stationary).
 */
export function adfTest(series: number[]): AdfTestResult {
  const n = series.length;
  if (n < 4) {
    return {
      statistic: 0,
      pValue: 1,
      stationary: false,
      criticalValues: { '1%': -3.43, '5%': -2.86, '10%': -2.57 },
    };
  }

  // First differences
  const dy: number[] = [];
  const yLag: number[] = [];
  for (let i = 1; i < n; i++) {
    dy.push(series[i] - series[i - 1]);
    yLag.push(series[i - 1]);
  }

  // Regress dy on y_{t-1} (with augmented lags for serial correlation)
  const maxLag = Math.min(Math.floor(Math.sqrt(n)), 10);
  const usedN = dy.length - maxLag;
  if (usedN < 3) {
    return {
      statistic: 0,
      pValue: 1,
      stationary: false,
      criticalValues: adfCriticalValues(n),
    };
  }

  // Build regression: dy_t = alpha + gamma * y_{t-1} + sum(beta_i * dy_{t-i}) + e
  // Simplified: just use the basic DF test (dy on y_lag)
  const reg = olsSimple(dy, yLag);

  // t-statistic for gamma (slope)
  const ssRes = reg.residuals.reduce((s, r) => s + r * r, 0);
  const mse = ssRes / (dy.length - 2);
  const xm = mean(yLag);
  const sumX2 = yLag.reduce((s, x) => s + (x - xm) ** 2, 0);
  const seSlope = sumX2 === 0 ? Infinity : Math.sqrt(mse / sumX2);
  const tStat = seSlope === Infinity ? 0 : reg.slope / seSlope;

  const criticalValues = adfCriticalValues(n);
  const pValue = adfPValue(tStat, n);

  return {
    statistic: tStat,
    pValue,
    stationary: tStat < criticalValues['5%'],
    criticalValues,
  };
}

/**
 * Engle-Granger two-step cointegration test.
 * Step 1: OLS regression of seriesA on seriesB to get residuals.
 * Step 2: ADF test on residuals.
 */
export function engleGranger(seriesA: number[], seriesB: number[]): EngleGrangerResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 5) {
    return {
      cointegrated: false,
      pValue: 1,
      hedgeRatio: 0,
      residuals: [],
      adfStat: 0,
      criticalValues: { '1%': -3.43, '5%': -2.86, '10%': -2.57 },
    };
  }

  const a = seriesA.slice(0, n);
  const b = seriesB.slice(0, n);

  // Step 1: OLS regression A = alpha + beta * B + residuals
  const reg = olsSimple(a, b);

  // Step 2: ADF test on residuals
  const adf = adfTest(reg.residuals);

  // Use stricter critical values for cointegration (Engle-Granger)
  // Roughly 0.5 more negative than standard ADF
  const criticalValues = {
    '1%': adf.criticalValues['1%'] - 0.5,
    '5%': adf.criticalValues['5%'] - 0.3,
    '10%': adf.criticalValues['10%'] - 0.2,
  };

  return {
    cointegrated: adf.statistic < criticalValues['5%'],
    pValue: adf.pValue,
    hedgeRatio: reg.slope,
    residuals: reg.residuals,
    adfStat: adf.statistic,
    criticalValues,
  };
}

/**
 * Half-life of mean reversion via AR(1) on residuals.
 * halfLife = -log(2) / log(lambda) where lambda is AR(1) coefficient.
 */
export function halfLife(residuals: number[]): number {
  const n = residuals.length;
  if (n < 3) return Infinity;

  const y: number[] = [];
  const x: number[] = [];
  for (let i = 1; i < n; i++) {
    y.push(residuals[i] - residuals[i - 1]);
    x.push(residuals[i - 1]);
  }

  const reg = olsSimple(y, x);
  const lambda = reg.slope;

  // lambda should be negative for mean-reverting series
  if (lambda >= 0) return Infinity;

  return -Math.log(2) / Math.log(1 + lambda);
}

/**
 * Hedge ratio estimation via OLS or Total Least Squares.
 */
export function hedgeRatio(
  seriesA: number[],
  seriesB: number[],
  method: 'ols' | 'tls' = 'ols'
): HedgeRatioResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 2) return { ratio: 0, intercept: 0, rSquared: 0 };

  const a = seriesA.slice(0, n);
  const b = seriesB.slice(0, n);

  if (method === 'ols') {
    const reg = olsSimple(a, b);
    return { ratio: reg.slope, intercept: reg.intercept, rSquared: reg.rSquared };
  }

  // Total Least Squares (orthogonal regression)
  const am = mean(a);
  const bm = mean(b);

  let sAA = 0, sBB = 0, sAB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - am;
    const db = b[i] - bm;
    sAA += da * da;
    sBB += db * db;
    sAB += da * db;
  }

  // TLS slope via eigenvalue of 2x2 covariance matrix
  const diff = sBB - sAA;
  const ratio = (diff + Math.sqrt(diff * diff + 4 * sAB * sAB)) / (2 * sAB || 1);
  const intercept = am - ratio * bm;

  // Approximate R² from correlation
  const corr = correlation(a, b);
  const rSquared = corr * corr;

  return { ratio, intercept, rSquared };
}

/**
 * Current z-score of the spread between two series.
 */
export function spreadZScore(
  seriesA: number[],
  seriesB: number[],
  ratio: number,
  lookback?: number
): SpreadZScoreResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 2) return { zScore: 0, spread: 0, mean: 0, std: 0, percentile: 50 };

  // Compute spread
  const spreads: number[] = [];
  for (let i = 0; i < n; i++) {
    spreads.push(seriesA[i] - ratio * seriesB[i]);
  }

  const window = lookback ? Math.min(lookback, n) : n;
  const recent = spreads.slice(n - window);
  const currentSpread = spreads[n - 1];
  const m = mean(recent);
  const s = standardDeviation(recent);

  const z = s === 0 ? 0 : (currentSpread - m) / s;

  // Percentile: count how many values are below current
  const below = recent.filter(v => v <= currentSpread).length;
  const percentile = (below / recent.length) * 100;

  return { zScore: z, spread: currentSpread, mean: m, std: s, percentile };
}

/**
 * Generate trading signal from z-score.
 */
export function pairSignal(params: {
  zScore: number;
  entryThreshold?: number;
  exitThreshold?: number;
  stopLoss?: number;
}): PairSignalResult {
  const entry = params.entryThreshold ?? 2.0;
  const exit = params.exitThreshold ?? 0.5;
  const stop = params.stopLoss ?? 4.0;
  const z = params.zScore;
  const absZ = Math.abs(z);

  if (absZ >= stop) {
    return { signal: 'stop', strength: Math.min(1, absZ / stop) };
  }

  if (absZ >= entry) {
    const signal = z > 0 ? 'short_spread' : 'long_spread';
    const strength = Math.min(1, (absZ - entry) / (stop - entry));
    return { signal, strength };
  }

  if (absZ <= exit) {
    return { signal: 'exit', strength: 1 - absZ / exit };
  }

  return { signal: 'neutral', strength: 0 };
}

/**
 * Score and rank pair candidates by cointegration, half-life, and correlation.
 */
export function scorePairs(
  candidates: Array<{
    symbolA: string;
    symbolB: string;
    pricesA: number[];
    pricesB: number[];
  }>
): PairScore[] {
  const results: PairScore[] = [];

  for (const c of candidates) {
    const n = Math.min(c.pricesA.length, c.pricesB.length);
    if (n < 10) continue;

    const a = c.pricesA.slice(0, n);
    const b = c.pricesB.slice(0, n);

    const corr = correlation(a, b);
    const eg = engleGranger(a, b);
    const hl = halfLife(eg.residuals);

    // Score: higher for cointegrated, good half-life (5-100), high correlation
    let score = 0;
    if (eg.cointegrated) score += 40;
    score += Math.abs(corr) * 20;

    // Half-life scoring: prefer 5-100 periods
    if (hl > 0 && hl < Infinity) {
      if (hl >= 5 && hl <= 100) {
        score += 30 * (1 - Math.abs(hl - 30) / 70); // peak at ~30
      } else if (hl < 5) {
        score += 10;
      } else {
        score += 5;
      }
    }

    // ADF stat bonus (more negative = better)
    score += Math.max(0, Math.min(10, -eg.adfStat - 2));

    results.push({
      symbolA: c.symbolA,
      symbolB: c.symbolB,
      correlation: corr,
      cointegrated: eg.cointegrated,
      adfStat: eg.adfStat,
      halfLife: hl,
      score,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Kalman filter for time-varying hedge ratio.
 */
export function kalmanHedgeRatio(
  seriesA: number[],
  seriesB: number[],
  params?: { processNoise?: number; measurementNoise?: number }
): KalmanHedgeResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 2) return { ratios: [], currentRatio: 0, confidence: 0 };

  const Q = params?.processNoise ?? 1e-5;  // Process noise (state evolution)
  const R = params?.measurementNoise ?? 1e-3;  // Measurement noise

  // State: hedge ratio (beta)
  // Observation: seriesA[t] = beta * seriesB[t] + noise
  let beta = 0;
  let P = 1;  // State covariance

  // Initialize with OLS on first 10 points
  const initN = Math.min(10, n);
  const initReg = olsSimple(seriesA.slice(0, initN), seriesB.slice(0, initN));
  beta = initReg.slope;

  const ratios: number[] = [];

  for (let t = 0; t < n; t++) {
    // Prediction step
    const betaPred = beta;
    const PPred = P + Q;

    // Update step
    const y = seriesA[t];  // observation
    const H = seriesB[t];  // observation matrix (scalar)
    const innovation = y - H * betaPred;
    const S = H * PPred * H + R;  // Innovation covariance
    const K = S === 0 ? 0 : PPred * H / S;  // Kalman gain

    beta = betaPred + K * innovation;
    P = (1 - K * H) * PPred;

    ratios.push(beta);
  }

  // Confidence from final state covariance
  const confidence = Math.max(0, Math.min(1, 1 - Math.sqrt(P)));

  return {
    ratios,
    currentRatio: beta,
    confidence,
  };
}

/**
 * Simplified Johansen trace test for cointegration rank among multiple series.
 */
export function johansen(series: number[][], maxLag: number = 1): JohansenResult {
  const p = series.length;  // number of series
  if (p < 2) return { rank: 0, eigenvalues: [], traceStats: [], criticalValues: [] };

  const n = Math.min(...series.map(s => s.length));
  if (n < p + 3) return { rank: 0, eigenvalues: [], traceStats: [], criticalValues: [] };

  // Compute first differences and levels
  const diffs: number[][] = series.map(s => {
    const d: number[] = [];
    for (let i = 1; i < n; i++) d.push(s[i] - s[i - 1]);
    return d;
  });

  const T = diffs[0].length;

  // Build cross-product matrices for reduced rank regression
  // Simplified: use eigenvalues of the correlation matrix of levels
  // as a proxy for cointegration rank
  const levels = series.map(s => s.slice(0, n));

  // Compute correlation matrix of levels
  const corrMatrix: number[][] = Array.from({ length: p }, () => Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = i; j < p; j++) {
      const c = correlation(levels[i], levels[j]);
      corrMatrix[i][j] = c;
      corrMatrix[j][i] = c;
    }
  }

  // Power iteration for eigenvalues (simplified)
  const eigenvalues: number[] = [];
  let mat = corrMatrix.map(r => [...r]);

  for (let f = 0; f < p; f++) {
    let v = Array(p).fill(1 / Math.sqrt(p));
    let eigenvalue = 0;

    for (let iter = 0; iter < 100; iter++) {
      const mv = mat.map(row => row.reduce((s, val, j) => s + val * v[j], 0));
      eigenvalue = Math.sqrt(mv.reduce((s, x) => s + x * x, 0));
      if (eigenvalue < 1e-12) break;
      v = mv.map(x => x / eigenvalue);
    }

    eigenvalues.push(eigenvalue);

    // Deflate
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        mat[i][j] -= eigenvalue * v[i] * v[j];
      }
    }
  }

  eigenvalues.sort((a, b) => b - a);

  // Trace statistics: -T * sum(log(1 - lambda_i)) for i = r+1..p
  const traceStats: number[] = [];
  for (let r = 0; r < p; r++) {
    let trace = 0;
    for (let i = r; i < p; i++) {
      const lambda = Math.max(0, Math.min(1 - 1e-10, eigenvalues[i] / (eigenvalues[0] + 1)));
      trace += -T * Math.log(1 - lambda);
    }
    traceStats.push(trace);
  }

  // Critical values for trace test (approximate, from Osterwald-Lenum tables)
  const critTable: Record<number, number[]> = {
    2: [15.41, 3.76],
    3: [29.68, 15.41, 3.76],
    4: [47.21, 29.68, 15.41, 3.76],
    5: [68.52, 47.21, 29.68, 15.41, 3.76],
  };
  const criticalValues = critTable[p] ?? Array(p).fill(15.41);

  // Determine rank
  let rank = 0;
  for (let r = 0; r < p; r++) {
    if (r < traceStats.length && r < criticalValues.length && traceStats[r] > criticalValues[r]) {
      rank = r + 1;
    } else {
      break;
    }
  }

  return { rank, eigenvalues, traceStats, criticalValues };
}

/**
 * Rolling spread statistics: mean, std, z-score, and half-life over rolling windows.
 */
export function rollingSpreadStats(
  seriesA: number[],
  seriesB: number[],
  ratio: number,
  window: number
): RollingSpreadStatsResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < window || window < 3) {
    return { means: [], stds: [], zScores: [], halfLives: [], timestamps: [] };
  }

  const spreads: number[] = [];
  for (let i = 0; i < n; i++) {
    spreads.push(seriesA[i] - ratio * seriesB[i]);
  }

  const means: number[] = [];
  const stds: number[] = [];
  const zScores: number[] = [];
  const halfLives: number[] = [];
  const timestamps: number[] = [];

  for (let i = window - 1; i < n; i++) {
    const windowSlice = spreads.slice(i - window + 1, i + 1);
    const m = mean(windowSlice);
    const s = standardDeviation(windowSlice);

    means.push(m);
    stds.push(s);
    zScores.push(s === 0 ? 0 : (spreads[i] - m) / s);
    halfLives.push(halfLife(windowSlice));
    timestamps.push(i);
  }

  return { means, stds, zScores, halfLives, timestamps };
}
