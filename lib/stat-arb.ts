/**
 * Statistical arbitrage and pairs trading utilities.
 * Cointegration tests, spread analysis, Kalman filtering, and pair scoring.
 */

import { correlation, mean, standardDeviation, zScore as mathZScore } from './math.js';

// ── Types ─────────────────────────────────────────────────

export interface AdfResult {
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

export interface KalmanHedgeRatioResult {
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

// ── OLS Helpers ───────────────────────────────────────────

function olsRegression(y: number[], x: number[]): { slope: number; intercept: number; residuals: number[]; rSquared: number } {
  const n = Math.min(y.length, x.length);
  if (n < 2) return { slope: 0, intercept: 0, residuals: [], rSquared: 0 };

  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);
  const xMean = mean(xSlice);
  const yMean = mean(ySlice);

  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - xMean;
    sumXY += dx * (ySlice[i] - yMean);
    sumX2 += dx * dx;
  }

  const slope = sumX2 === 0 ? 0 : sumXY / sumX2;
  const intercept = yMean - slope * xMean;

  const residuals: number[] = [];
  let ssRes = 0;
  let ssTot = 0;

  for (let i = 0; i < n; i++) {
    const predicted = slope * xSlice[i] + intercept;
    const resid = ySlice[i] - predicted;
    residuals.push(resid);
    ssRes += resid * resid;
    ssTot += (ySlice[i] - yMean) ** 2;
  }

  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slope, intercept, residuals, rSquared };
}

// ── MacKinnon Critical Values ─────────────────────────────

/**
 * Approximate MacKinnon critical values for the ADF test (no trend, constant only).
 * These are interpolated from standard tables for common sample sizes.
 */
function mackinnonCriticalValues(n: number): { '1%': number; '5%': number; '10%': number } {
  // MacKinnon (1994) response surface coefficients for tau (no trend, constant)
  // cv = tau_inf + tau_1/T + tau_2/T^2
  const coeffs = {
    '1%':  { inf: -3.4336, c1: -5.999, c2: -29.25 },
    '5%':  { inf: -2.8621, c1: -2.738, c2: -8.36 },
    '10%': { inf: -2.5671, c1: -1.438, c2: -4.48 },
  };

  const cv = (k: '1%' | '5%' | '10%'): number => {
    const c = coeffs[k];
    return c.inf + c.c1 / n + c.c2 / (n * n);
  };

  return { '1%': cv('1%'), '5%': cv('5%'), '10%': cv('10%') };
}

/**
 * Approximate p-value from ADF statistic using MacKinnon interpolation.
 */
function adfPValue(stat: number, n: number): number {
  const cv = mackinnonCriticalValues(n);
  // Linear interpolation between critical values
  if (stat <= cv['1%']) return 0.005;
  if (stat <= cv['5%']) {
    const frac = (stat - cv['1%']) / (cv['5%'] - cv['1%']);
    return 0.01 + frac * 0.04;
  }
  if (stat <= cv['10%']) {
    const frac = (stat - cv['5%']) / (cv['10%'] - cv['5%']);
    return 0.05 + frac * 0.05;
  }
  // Beyond 10% — extrapolate toward 1.0
  const dist = stat - cv['10%'];
  const range = cv['10%'] - cv['1%'];
  const extrapolated = 0.10 + (dist / Math.abs(range)) * 0.45;
  return Math.min(1.0, extrapolated);
}

// ── ADF Test ──────────────────────────────────────────────

/**
 * Augmented Dickey-Fuller unit root test.
 * Tests H0: series has a unit root (non-stationary).
 * Rejects when statistic < critical value (more negative).
 */
export function adfTest(series: number[]): AdfResult {
  const n = series.length;
  if (n < 10) {
    const cv = mackinnonCriticalValues(n);
    return { statistic: 0, pValue: 1, stationary: false, criticalValues: cv };
  }

  // First differences: dy[t] = y[t] - y[t-1]
  const dy: number[] = [];
  const yLag: number[] = [];
  for (let i = 1; i < n; i++) {
    dy.push(series[i] - series[i - 1]);
    yLag.push(series[i - 1]);
  }

  // OLS: dy = alpha + gamma * y_lag + e
  // The t-statistic on gamma is the ADF statistic
  const reg = olsRegression(dy, yLag);
  const gamma = reg.slope;

  // Standard error of gamma
  const m = dy.length;
  let ssRes = 0;
  for (const r of reg.residuals) {
    ssRes += r * r;
  }
  const sigmaSquared = ssRes / (m - 2);

  const yLagMean = mean(yLag);
  let sumYLagDev = 0;
  for (const y of yLag) {
    sumYLagDev += (y - yLagMean) ** 2;
  }

  const seGamma = sumYLagDev === 0 ? Infinity : Math.sqrt(sigmaSquared / sumYLagDev);
  const tStat = seGamma === Infinity ? 0 : gamma / seGamma;

  const criticalValues = mackinnonCriticalValues(n);
  const pValue = adfPValue(tStat, n);

  return {
    statistic: tStat,
    pValue,
    stationary: tStat < criticalValues['5%'],
    criticalValues,
  };
}

// ── Engle-Granger Cointegration ───────────────────────────

/**
 * Engle-Granger two-step cointegration test.
 * Step 1: OLS regression of seriesA on seriesB to get residuals.
 * Step 2: ADF test on residuals — if stationary, the series are cointegrated.
 */
export function engleGranger(seriesA: number[], seriesB: number[]): EngleGrangerResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 10) {
    const cv = mackinnonCriticalValues(n);
    return {
      cointegrated: false,
      pValue: 1,
      hedgeRatio: 0,
      residuals: [],
      adfStat: 0,
      criticalValues: cv,
    };
  }

  const a = seriesA.slice(0, n);
  const b = seriesB.slice(0, n);

  // Step 1: OLS regression A = beta * B + alpha + epsilon
  const reg = olsRegression(a, b);

  // Step 2: ADF test on residuals
  const adf = adfTest(reg.residuals);

  // For cointegration residuals, use slightly more conservative critical values
  // (Engle-Granger CVs are more negative than standard ADF)
  const egCriticalValues = {
    '1%': adf.criticalValues['1%'] - 0.30,
    '5%': adf.criticalValues['5%'] - 0.25,
    '10%': adf.criticalValues['10%'] - 0.20,
  };

  return {
    cointegrated: adf.statistic < egCriticalValues['5%'],
    pValue: adf.pValue,
    hedgeRatio: reg.slope,
    residuals: reg.residuals,
    adfStat: adf.statistic,
    criticalValues: egCriticalValues,
  };
}

// ── Half-Life ─────────────────────────────────────────────

/**
 * Half-life of mean reversion via Ornstein-Uhlenbeck process.
 * Fits OLS: delta_y = lambda * y_lag + epsilon
 * Half-life = -ln(2) / lambda
 */
export function halfLife(residuals: number[]): number {
  if (residuals.length < 3) return Infinity;

  const dy: number[] = [];
  const yLag: number[] = [];

  for (let i = 1; i < residuals.length; i++) {
    dy.push(residuals[i] - residuals[i - 1]);
    yLag.push(residuals[i - 1]);
  }

  const reg = olsRegression(dy, yLag);
  const lambda = reg.slope;

  if (lambda >= 0) return Infinity; // No mean reversion
  return -Math.log(2) / Math.log(1 + lambda);
}

// ── Hedge Ratio ───────────────────────────────────────────

/**
 * Compute hedge ratio between two price series.
 * @param method - 'ols' (default) or 'tls' (Total Least Squares / Deming regression)
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
    const reg = olsRegression(a, b);
    return { ratio: reg.slope, intercept: reg.intercept, rSquared: reg.rSquared };
  }

  // Total Least Squares (orthogonal regression / Deming regression with delta=1)
  const aMean = mean(a);
  const bMean = mean(b);

  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = b[i] - bMean;
    const dy = a[i] - aMean;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  // TLS slope: (syy - sxx + sqrt((syy - sxx)^2 + 4*sxy^2)) / (2*sxy)
  const diff = syy - sxx;
  const denom = 2 * sxy;
  const ratio = denom === 0 ? 0 : (diff + Math.sqrt(diff * diff + 4 * sxy * sxy)) / denom;
  const intercept = aMean - ratio * bMean;

  // R-squared approximation
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const predicted = ratio * b[i] + intercept;
    ssRes += (a[i] - predicted) ** 2;
    ssTot += (a[i] - aMean) ** 2;
  }
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { ratio, intercept, rSquared };
}

// ── Spread Z-Score ────────────────────────────────────────

/**
 * Compute the z-score of the current spread between two series.
 * spread = seriesA - hedgeRatio * seriesB
 */
export function spreadZScore(
  seriesA: number[],
  seriesB: number[],
  hr: number,
  lookback?: number
): SpreadZScoreResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 2) return { zScore: 0, spread: 0, mean: 0, std: 0, percentile: 50 };

  const a = seriesA.slice(0, n);
  const b = seriesB.slice(0, n);

  // Compute spread series
  const spreads: number[] = [];
  for (let i = 0; i < n; i++) {
    spreads.push(a[i] - hr * b[i]);
  }

  // Use lookback window if specified
  const window = lookback && lookback > 0 ? Math.min(lookback, n) : n;
  const windowSpreads = spreads.slice(-window);
  const currentSpread = spreads[spreads.length - 1];

  const spreadMean = mean(windowSpreads);
  const spreadStd = standardDeviation(windowSpreads);
  const z = spreadStd === 0 ? 0 : (currentSpread - spreadMean) / spreadStd;

  // Percentile: percentage of window spreads at or below current (0-100)
  const below = windowSpreads.filter(s => s <= currentSpread).length;
  const percentile = windowSpreads.length === 0 ? 50 : (below / windowSpreads.length) * 100;

  return {
    zScore: z,
    spread: currentSpread,
    mean: spreadMean,
    std: spreadStd,
    percentile,
  };
}

// ── Pair Signal ───────────────────────────────────────────

/**
 * Generate a pairs trading signal from the current z-score.
 */
export function pairSignal(params: {
  zScore: number;
  entryThreshold?: number;
  exitThreshold?: number;
  stopLoss?: number;
}): PairSignalResult {
  const {
    zScore: z,
    entryThreshold = 2.0,
    exitThreshold = 0.5,
    stopLoss = 4.0,
  } = params;

  const absZ = Math.abs(z);

  // Stop loss — spread has blown out
  if (absZ >= stopLoss) {
    return { signal: 'stop', strength: Math.min(1, absZ / stopLoss) };
  }

  // Entry signals
  if (z >= entryThreshold) {
    // Spread is wide positive — short the spread (short A, long B)
    const strength = Math.min(1, (absZ - entryThreshold) / (stopLoss - entryThreshold) + 0.5);
    return { signal: 'short_spread', strength };
  }

  if (z <= -entryThreshold) {
    // Spread is wide negative — long the spread (long A, short B)
    const strength = Math.min(1, (absZ - entryThreshold) / (stopLoss - entryThreshold) + 0.5);
    return { signal: 'long_spread', strength };
  }

  // Exit signal — spread has reverted
  if (absZ <= exitThreshold) {
    return { signal: 'exit', strength: 1 - absZ / exitThreshold };
  }

  // Between exit and entry thresholds — neutral
  return { signal: 'neutral', strength: 0 };
}

// ── Score Pairs ───────────────────────────────────────────

/**
 * Rank candidate pairs by cointegration strength, half-life, and correlation.
 * Returns sorted array (best first).
 */
export function scorePairs(
  candidates: Array<{ symbolA: string; symbolB: string; pricesA: number[]; pricesB: number[] }>
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

// ── Kalman Filter Hedge Ratio ─────────────────────────────

/**
 * Time-varying hedge ratio via Kalman filter.
 * Models: seriesA[t] = beta[t] * seriesB[t] + epsilon[t]
 * where beta[t] evolves as a random walk.
 */
export function kalmanHedgeRatio(
  seriesA: number[],
  seriesB: number[],
  params?: { processNoise?: number; measurementNoise?: number }
): KalmanHedgeRatioResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < 2) return { ratios: [], currentRatio: 0, confidence: 0 };

  const a = seriesA.slice(0, n);
  const b = seriesB.slice(0, n);

  const Q = params?.processNoise ?? 1e-5;   // Process noise (state transition)
  const R = params?.measurementNoise ?? 1e-3; // Measurement noise

  // Initialize state with OLS estimate
  const initReg = olsRegression(a.slice(0, Math.min(20, n)), b.slice(0, Math.min(20, n)));
  let betaHat = initReg.slope;
  let P = 1.0; // Error covariance

  const ratios: number[] = [];

  for (let i = 0; i < n; i++) {
    // Prediction step
    // beta_hat stays the same (random walk)
    P = P + Q;

    // Update step
    const H = b[i]; // Observation matrix element
    const innovation = a[i] - betaHat * H;
    const S = H * P * H + R; // Innovation covariance
    const K = S === 0 ? 0 : (P * H) / S; // Kalman gain

    betaHat = betaHat + K * innovation;
    P = (1 - K * H) * P;

    ratios.push(betaHat);
  }

  // Confidence from final error covariance — lower P = higher confidence
  const confidence = Math.max(0, Math.min(1, 1 - Math.sqrt(P)));

  return {
    ratios,
    currentRatio: ratios[ratios.length - 1],
    confidence,
  };
}

// ── Johansen Trace Test (Simplified) ──────────────────────

/**
 * Simplified Johansen trace test for cointegration rank among multiple series.
 * Uses eigenvalue decomposition of the concentrated product moment matrices.
 *
 * This is a simplified implementation that computes trace statistics from
 * the canonical correlations between first differences and lagged levels.
 */
export function johansen(series: number[][], maxLag: number = 1): JohansenResult {
  const k = series.length; // Number of series
  if (k < 2) return { rank: 0, eigenvalues: [], traceStats: [], criticalValues: [] };

  const n = Math.min(...series.map(s => s.length));
  if (n < k + maxLag + 10) {
    return { rank: 0, eigenvalues: Array(k).fill(0), traceStats: Array(k).fill(0), criticalValues: Array(k).fill(0) };
  }

  // Compute first differences and lagged levels
  const T = n - maxLag;
  const dY: number[][] = Array.from({ length: k }, () => []);
  const yLag: number[][] = Array.from({ length: k }, () => []);

  for (let t = maxLag; t < n; t++) {
    for (let j = 0; j < k; j++) {
      dY[j].push(series[j][t] - series[j][t - 1]);
      yLag[j].push(series[j][t - 1]);
    }
  }

  // Compute S00, S01, S10, S11 matrices (k x k)
  // S00 = (1/T) * dY' * dY (after demeaning)
  // S11 = (1/T) * yLag' * yLag (after demeaning)
  // S01 = (1/T) * dY' * yLag (after demeaning)

  const dYMeans = dY.map(d => mean(d));
  const yLagMeans = yLag.map(y => mean(y));

  const computeMatrix = (a: number[][], aMeans: number[], b: number[][], bMeans: number[]): number[][] => {
    const m: number[][] = Array.from({ length: k }, () => Array(k).fill(0));
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        let s = 0;
        for (let t = 0; t < T; t++) {
          s += (a[i][t] - aMeans[i]) * (b[j][t] - bMeans[j]);
        }
        m[i][j] = s / T;
      }
    }
    return m;
  };

  const S00 = computeMatrix(dY, dYMeans, dY, dYMeans);
  const S11 = computeMatrix(yLag, yLagMeans, yLag, yLagMeans);
  const S01 = computeMatrix(dY, dYMeans, yLag, yLagMeans);
  const S10 = computeMatrix(yLag, yLagMeans, dY, dYMeans);

  // For a simplified approach, compute eigenvalues of S11^{-1} * S10 * S00^{-1} * S01
  // For 2x2, we can compute analytically; for larger, use power iteration approximation
  const eigenvalues: number[] = [];

  if (k === 2) {
    // 2x2 case: analytical eigenvalue computation
    // Compute S11^{-1} * S10 * S00^{-1} * S01
    const detS00 = S00[0][0] * S00[1][1] - S00[0][1] * S00[1][0];
    const detS11 = S11[0][0] * S11[1][1] - S11[0][1] * S11[1][0];

    if (Math.abs(detS00) < 1e-15 || Math.abs(detS11) < 1e-15) {
      return { rank: 0, eigenvalues: [0, 0], traceStats: [0, 0], criticalValues: [15.41, 3.76] };
    }

    // S00^{-1}
    const s00Inv: number[][] = [
      [S00[1][1] / detS00, -S00[0][1] / detS00],
      [-S00[1][0] / detS00, S00[0][0] / detS00],
    ];

    // S11^{-1}
    const s11Inv: number[][] = [
      [S11[1][1] / detS11, -S11[0][1] / detS11],
      [-S11[1][0] / detS11, S11[0][0] / detS11],
    ];

    // M = S11^{-1} * S10 * S00^{-1} * S01
    const matMul = (A: number[][], B: number[][]): number[][] => {
      const r: number[][] = [[0, 0], [0, 0]];
      for (let i = 0; i < 2; i++)
        for (let j = 0; j < 2; j++)
          for (let p = 0; p < 2; p++)
            r[i][j] += A[i][p] * B[p][j];
      return r;
    };

    const temp1 = matMul(s11Inv, S10);
    const temp2 = matMul(s00Inv, S01);
    const M = matMul(temp1, temp2);

    // Eigenvalues of 2x2 matrix
    const trace = M[0][0] + M[1][1];
    const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
    const disc = trace * trace - 4 * det;
    const sqrtDisc = Math.sqrt(Math.max(0, disc));

    const e1 = Math.max(0, Math.min(1, (trace + sqrtDisc) / 2));
    const e2 = Math.max(0, Math.min(1, (trace - sqrtDisc) / 2));
    eigenvalues.push(e1, e2);
  } else {
    // General case: approximate eigenvalues via squared canonical correlations
    // Use correlation between each pair of dY and yLag as rough proxy
    for (let j = 0; j < k; j++) {
      const corr = correlation(dY[j], yLag[j]);
      eigenvalues.push(Math.max(0, Math.min(1, corr * corr)));
    }
    eigenvalues.sort((a, b) => b - a);
  }

  // Trace statistics: -T * sum_{i=r+1}^{k} ln(1 - lambda_i)
  const traceStats: number[] = [];
  for (let r = 0; r < k; r++) {
    let stat = 0;
    for (let i = r; i < k; i++) {
      stat += Math.log(1 - Math.min(0.9999, eigenvalues[i]));
    }
    traceStats.push(-T * stat);
  }

  // Critical values (Osterwald-Lenum 95% tables, commonly used values)
  // For k variables: trace test critical values at 5%
  const traceCV: Record<number, number[]> = {
    2: [15.41, 3.76],
    3: [29.68, 15.41, 3.76],
    4: [47.21, 29.68, 15.41, 3.76],
    5: [68.52, 47.21, 29.68, 15.41, 3.76],
  };
  const criticalValues = traceCV[k] ?? Array.from({ length: k }, (_, i) => 3.76 + (k - i - 1) * 15);

  // Determine rank: number of trace stats exceeding critical values
  let rank = 0;
  for (let r = 0; r < k; r++) {
    if (traceStats[r] > criticalValues[r]) {
      rank = r + 1;
    } else {
      break;
    }
  }

  return { rank, eigenvalues, traceStats, criticalValues };
}

// ── Rolling Spread Stats ──────────────────────────────────

/**
 * Compute rolling statistics of the spread between two series.
 * Returns arrays of rolling mean, std, z-score, and half-life.
 */
export function rollingSpreadStats(
  seriesA: number[],
  seriesB: number[],
  hr: number,
  window: number
): RollingSpreadStatsResult {
  const n = Math.min(seriesA.length, seriesB.length);
  if (n < window || window < 3) {
    return { means: [], stds: [], zScores: [], halfLives: [], timestamps: [] };
  }

  const a = seriesA.slice(0, n);
  const b = seriesB.slice(0, n);

  // Compute full spread series
  const spreads: number[] = [];
  for (let i = 0; i < n; i++) {
    spreads.push(a[i] - hr * b[i]);
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
