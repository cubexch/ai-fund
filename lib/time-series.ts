/**
 * Time series analysis: GARCH, ADF, ACF/PACF, Hurst exponent,
 * structural breaks, EWMA volatility, variance ratio, and regime detection.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import { mean, standardDeviation } from './math.js';

// ── Types ────────────────────────────────────────────────

export interface Garch11Result {
  conditionalVol: number[];
  forecastVol: number;
  omega: number;
  alpha: number;
  beta: number;
  persistence: number;
  longRunVar: number;
  logLikelihood: number;
}

export interface AdfTestResult {
  statistic: number;
  pValue: number;
  stationary: boolean;
  usedLag: number;
  criticalValues: { '1%': number; '5%': number; '10%': number };
}

export interface AcfResult {
  acf: number[];
  confidenceBand: number;
  significantLags: number[];
}

export interface PacfResult {
  pacf: number[];
  confidenceBand: number;
  significantLags: number[];
}

export interface HurstResult {
  hurst: number;
  method: string;
  regime: 'trending' | 'mean_reverting' | 'random_walk';
  confidence: number;
  rSquared: number;
}

export interface HalfLifeResult {
  halfLife: number;
  lambda: number;
  meanRevertSpeed: number;
  stationary: boolean;
}

export interface StructuralBreakResult {
  breaks: Array<{ index: number; significance: number }>;
  cusumStats?: number[];
  threshold: number;
  hasBreak: boolean;
}

export interface EwmaVolResult {
  volatility: number[];
  currentVol: number;
  lambda: number;
}

export interface VarianceRatioEntry {
  period: number;
  ratio: number;
  zStat: number;
  pValue: number;
}

export interface VarianceRatioResult {
  ratios: VarianceRatioEntry[];
  randomWalk: boolean;
}

export interface RegimeEntry {
  start: number;
  end: number;
  mean: number;
  vol: number;
  label: 'low_vol' | 'high_vol' | 'trending' | 'mean_reverting';
}

export interface RegimeChangeResult {
  regimes: RegimeEntry[];
  currentRegime: string;
  changePoints: number[];
}

// ── Internal Helpers ─────────────────────────────────────

function olsSimple(y: number[], x: number[]): { slope: number; intercept: number; residuals: number[] } {
  const n = Math.min(y.length, x.length);
  if (n < 2) return { slope: 0, intercept: 0, residuals: [] };
  const xm = mean(x.slice(0, n));
  const ym = mean(y.slice(0, n));
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - xm;
    sxy += dx * (y[i] - ym);
    sxx += dx * dx;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = ym - slope * xm;
  const residuals = [];
  for (let i = 0; i < n; i++) residuals.push(y[i] - intercept - slope * x[i]);
  return { slope, intercept, residuals };
}

function normCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

// ── Public Functions ─────────────────────────────────────

/**
 * GARCH(1,1) volatility model.
 * sigma²_t = omega + alpha * r²_{t-1} + beta * sigma²_{t-1}
 */
export function garch11(
  returns: number[],
  params?: { omega?: number; alpha?: number; beta?: number; maxIter?: number }
): Garch11Result {
  const n = returns.length;
  if (n < 5) {
    return {
      conditionalVol: [], forecastVol: 0, omega: 0, alpha: 0, beta: 0,
      persistence: 0, longRunVar: 0, logLikelihood: 0,
    };
  }

  const unconditionalVar = returns.reduce((s, r) => s + r * r, 0) / n;

  let alpha = params?.alpha ?? 0.1;
  let beta = params?.beta ?? 0.85;
  let omega = params?.omega ?? unconditionalVar * (1 - alpha - beta);
  if (omega <= 0) omega = unconditionalVar * 0.05;

  // If all params provided, skip optimization
  if (!params?.omega || !params?.alpha || !params?.beta) {
    // Grid search for best log-likelihood
    const maxIter = params?.maxIter ?? 20;
    let bestLL = -Infinity;
    let bestA = alpha, bestB = beta, bestO = omega;

    for (let ai = 1; ai <= maxIter; ai++) {
      for (let bi = 1; bi <= maxIter; bi++) {
        const a = ai * 0.02; // 0.02 to 0.40
        const b = bi * 0.04; // 0.04 to 0.80
        if (a + b >= 1) continue;
        const o = unconditionalVar * (1 - a - b);
        if (o <= 0) continue;

        let ll = 0;
        let sigmaSquared = unconditionalVar;
        for (let t = 0; t < n; t++) {
          if (sigmaSquared <= 0) sigmaSquared = unconditionalVar;
          ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(sigmaSquared) + returns[t] ** 2 / sigmaSquared);
          sigmaSquared = o + a * returns[t] ** 2 + b * sigmaSquared;
        }

        if (ll > bestLL) {
          bestLL = ll;
          bestA = a;
          bestB = b;
          bestO = o;
        }
      }
    }

    alpha = bestA;
    beta = bestB;
    omega = bestO;
  }

  // Compute conditional volatilities
  const conditionalVol: number[] = [];
  let sigmaSquared = unconditionalVar;
  let logLikelihood = 0;

  for (let t = 0; t < n; t++) {
    if (sigmaSquared <= 0) sigmaSquared = unconditionalVar;
    conditionalVol.push(Math.sqrt(sigmaSquared));
    logLikelihood += -0.5 * (Math.log(2 * Math.PI) + Math.log(sigmaSquared) + returns[t] ** 2 / sigmaSquared);
    sigmaSquared = omega + alpha * returns[t] ** 2 + beta * sigmaSquared;
  }

  const persistence = alpha + beta;
  const longRunVar = persistence >= 1 ? unconditionalVar : omega / (1 - persistence);
  const forecastVol = Math.sqrt(Math.max(0, sigmaSquared));

  return { conditionalVol, forecastVol, omega, alpha, beta, persistence, longRunVar, logLikelihood };
}

/**
 * Augmented Dickey-Fuller stationarity test.
 */
export function adfTest(
  series: number[],
  params?: { maxLag?: number; trend?: 'none' | 'constant' | 'trend' }
): AdfTestResult {
  const n = series.length;
  if (n < 4) {
    return { statistic: 0, pValue: 1, stationary: false, usedLag: 0, criticalValues: { '1%': -3.43, '5%': -2.86, '10%': -2.57 } };
  }

  const maxLag = params?.maxLag ?? Math.min(Math.floor(Math.pow(n - 1, 1 / 3)), 12);
  const usedLag = Math.min(maxLag, Math.floor(n / 3));

  const dy: number[] = [];
  const yLag: number[] = [];
  for (let i = 1; i < n; i++) {
    dy.push(series[i] - series[i - 1]);
    yLag.push(series[i - 1]);
  }

  const reg = olsSimple(dy, yLag);
  const ssRes = reg.residuals.reduce((s, r) => s + r * r, 0);
  const mse = ssRes / Math.max(1, dy.length - 2);
  const xm = mean(yLag);
  const sxx = yLag.reduce((s, x) => s + (x - xm) ** 2, 0);
  const se = sxx === 0 ? Infinity : Math.sqrt(mse / sxx);
  const tStat = se === Infinity ? 0 : reg.slope / se;

  const criticalValues = {
    '1%': -3.43 - 6.0 / n,
    '5%': -2.86 - 2.74 / n,
    '10%': -2.57 - 1.67 / n,
  };

  let pValue: number;
  if (tStat <= criticalValues['1%']) pValue = 0.005;
  else if (tStat <= criticalValues['5%']) pValue = 0.03;
  else if (tStat <= criticalValues['10%']) pValue = 0.07;
  else pValue = Math.min(1, 0.1 + (tStat - criticalValues['10%']) * 0.15);

  return { statistic: tStat, pValue, stationary: tStat < criticalValues['5%'], usedLag, criticalValues };
}

/**
 * Sample autocorrelation function (ACF).
 */
export function autocorrelation(series: number[], maxLag?: number): AcfResult {
  const n = series.length;
  if (n < 3) return { acf: [], confidenceBand: 0, significantLags: [] };

  const lag = maxLag ?? Math.min(Math.floor(n / 4), 40);
  const m = mean(series);
  let c0 = 0;
  for (let i = 0; i < n; i++) c0 += (series[i] - m) ** 2;
  c0 /= n;

  if (c0 === 0) return { acf: Array(lag + 1).fill(0), confidenceBand: 0, significantLags: [] };

  const acf: number[] = [1]; // lag 0 = 1
  const confidenceBand = 1.96 / Math.sqrt(n);
  const significantLags: number[] = [];

  for (let k = 1; k <= lag; k++) {
    let ck = 0;
    for (let i = 0; i < n - k; i++) {
      ck += (series[i] - m) * (series[i + k] - m);
    }
    ck /= n;
    const rk = ck / c0;
    acf.push(rk);
    if (Math.abs(rk) > confidenceBand) significantLags.push(k);
  }

  return { acf, confidenceBand, significantLags };
}

/**
 * Partial autocorrelation function (PACF) via Durbin-Levinson recursion.
 */
export function partialAutocorrelation(series: number[], maxLag?: number): PacfResult {
  const { acf, confidenceBand } = autocorrelation(series, maxLag);
  if (acf.length < 2) return { pacf: [], confidenceBand, significantLags: [] };

  const lag = acf.length - 1;
  const pacf: number[] = [1]; // lag 0
  const significantLags: number[] = [];

  // Durbin-Levinson algorithm
  let phi: number[] = [acf[1]];
  pacf.push(acf[1]);
  if (Math.abs(acf[1]) > confidenceBand) significantLags.push(1);

  for (let k = 2; k <= lag; k++) {
    let num = acf[k];
    for (let j = 0; j < phi.length; j++) {
      num -= phi[j] * acf[k - 1 - j];
    }

    let den = 1;
    for (let j = 0; j < phi.length; j++) {
      den -= phi[j] * acf[j + 1];
    }

    const phiKK = den === 0 ? 0 : num / den;
    pacf.push(phiKK);
    if (Math.abs(phiKK) > confidenceBand) significantLags.push(k);

    // Update phi coefficients
    const newPhi: number[] = [];
    for (let j = 0; j < phi.length; j++) {
      newPhi.push(phi[j] - phiKK * phi[phi.length - 1 - j]);
    }
    newPhi.push(phiKK);
    phi = newPhi;
  }

  return { pacf, confidenceBand, significantLags };
}

/**
 * Hurst exponent via R/S analysis or DFA.
 */
export function hurstExponent(
  series: number[],
  params?: { method?: 'rs' | 'dfa'; minWindow?: number; maxWindow?: number }
): HurstResult {
  const n = series.length;
  const method = params?.method ?? 'rs';
  const minW = params?.minWindow ?? 10;
  const maxW = params?.maxWindow ?? Math.floor(n / 2);

  if (n < minW * 2) {
    return { hurst: 0.5, method, regime: 'random_walk', confidence: 0, rSquared: 0 };
  }

  const logN: number[] = [];
  const logRS: number[] = [];

  if (method === 'rs') {
    // R/S analysis
    for (let w = minW; w <= maxW; w = Math.floor(w * 1.5)) {
      const numBlocks = Math.floor(n / w);
      if (numBlocks < 1) continue;

      let rsSum = 0;
      for (let b = 0; b < numBlocks; b++) {
        const block = series.slice(b * w, (b + 1) * w);
        const m = mean(block);
        const s = standardDeviation(block);
        if (s === 0) continue;

        // Cumulative deviation from mean
        let cumSum = 0;
        let maxCum = -Infinity;
        let minCum = Infinity;
        for (const val of block) {
          cumSum += val - m;
          maxCum = Math.max(maxCum, cumSum);
          minCum = Math.min(minCum, cumSum);
        }

        rsSum += (maxCum - minCum) / s;
      }

      if (numBlocks > 0) {
        logN.push(Math.log(w));
        logRS.push(Math.log(rsSum / numBlocks));
      }
    }
  } else {
    // DFA (Detrended Fluctuation Analysis)
    // Cumulative sum of deviations
    const m = mean(series);
    const Y: number[] = [];
    let cum = 0;
    for (const val of series) {
      cum += val - m;
      Y.push(cum);
    }

    for (let w = minW; w <= maxW; w = Math.floor(w * 1.5)) {
      const numBlocks = Math.floor(n / w);
      if (numBlocks < 1) continue;

      let F2sum = 0;
      for (let b = 0; b < numBlocks; b++) {
        const blockY = Y.slice(b * w, (b + 1) * w);
        const x = Array.from({ length: w }, (_, i) => i);
        const reg = olsSimple(blockY, x);
        const ssRes = reg.residuals.reduce((s, r) => s + r * r, 0);
        F2sum += ssRes / w;
      }

      logN.push(Math.log(w));
      logRS.push(0.5 * Math.log(F2sum / numBlocks));
    }
  }

  if (logN.length < 2) {
    return { hurst: 0.5, method, regime: 'random_walk', confidence: 0, rSquared: 0 };
  }

  // Linear regression: log(RS) = H * log(N) + c
  const reg = olsSimple(logRS, logN);
  const hurst = Math.max(0, Math.min(1, reg.slope));

  const ssRes = reg.residuals.reduce((s, r) => s + r * r, 0);
  const ssTot = logRS.reduce((s, v) => {
    const m = mean(logRS);
    return s + (v - m) ** 2;
  }, 0);
  const rSquared = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  let regime: 'trending' | 'mean_reverting' | 'random_walk';
  if (hurst > 0.55) regime = 'trending';
  else if (hurst < 0.45) regime = 'mean_reverting';
  else regime = 'random_walk';

  return { hurst, method, regime, confidence: rSquared, rSquared };
}

/**
 * Half-life of mean reversion via AR(1) regression.
 */
export function halfLife(series: number[]): HalfLifeResult {
  const n = series.length;
  if (n < 3) return { halfLife: Infinity, lambda: 0, meanRevertSpeed: 0, stationary: false };

  const y: number[] = [];
  const x: number[] = [];
  for (let i = 1; i < n; i++) {
    y.push(series[i] - series[i - 1]);
    x.push(series[i - 1]);
  }

  const reg = olsSimple(y, x);
  const lambda = reg.slope;

  if (lambda >= 0) {
    return { halfLife: Infinity, lambda, meanRevertSpeed: 0, stationary: false };
  }

  const hl = -Math.log(2) / Math.log(1 + lambda);
  return {
    halfLife: hl,
    lambda,
    meanRevertSpeed: -lambda,
    stationary: lambda < 0,
  };
}

/**
 * Detect structural breaks via CUSUM test.
 */
export function structuralBreak(
  series: number[],
  params?: { method?: 'cusum' | 'chow'; windowSize?: number }
): StructuralBreakResult {
  const n = series.length;
  if (n < 10) return { breaks: [], threshold: 0, hasBreak: false };

  const m = mean(series);
  const s = standardDeviation(series);
  if (s === 0) return { breaks: [], threshold: 0, hasBreak: false };

  // CUSUM: cumulative sum of standardized residuals
  const cusumStats: number[] = [];
  let cumSum = 0;
  for (let i = 0; i < n; i++) {
    cumSum += (series[i] - m) / s;
    cusumStats.push(cumSum / Math.sqrt(n));
  }

  // Threshold: ~1.36 for 5% significance (Brownian bridge)
  const threshold = 1.36;
  const breaks: Array<{ index: number; significance: number }> = [];

  // Find peaks above threshold
  for (let i = 1; i < n - 1; i++) {
    const absC = Math.abs(cusumStats[i]);
    if (absC > threshold &&
        Math.abs(cusumStats[i]) >= Math.abs(cusumStats[i - 1]) &&
        Math.abs(cusumStats[i]) >= Math.abs(cusumStats[i + 1])) {
      breaks.push({ index: i, significance: absC / threshold });
    }
  }

  return {
    breaks,
    cusumStats,
    threshold,
    hasBreak: breaks.length > 0,
  };
}

/**
 * EWMA volatility (RiskMetrics style).
 */
export function ewmaVolatility(
  returns: number[],
  params?: { lambda?: number; span?: number }
): EwmaVolResult {
  const n = returns.length;
  if (n === 0) return { volatility: [], currentVol: 0, lambda: 0.94 };

  const lambda = params?.lambda ?? (params?.span ? 1 - 2 / (params.span + 1) : 0.94);

  const volatility: number[] = [];
  let variance = returns[0] ** 2;

  for (let i = 0; i < n; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] ** 2;
    volatility.push(Math.sqrt(variance));
  }

  return { volatility, currentVol: volatility[n - 1], lambda };
}

/**
 * Lo-MacKinlay variance ratio test for random walk hypothesis.
 */
export function varianceRatio(
  series: number[],
  periods?: number[]
): VarianceRatioResult {
  const n = series.length;
  const qs = periods ?? [2, 5, 10, 20];

  if (n < 5) return { ratios: [], randomWalk: true };

  // Compute returns
  const rets: number[] = [];
  for (let i = 1; i < n; i++) {
    rets.push(series[i] / series[i - 1] - 1);
  }

  const var1 = rets.reduce((s, r) => s + r * r, 0) / rets.length;
  if (var1 === 0) return { ratios: qs.map(q => ({ period: q, ratio: 1, zStat: 0, pValue: 1 })), randomWalk: true };

  const ratios: VarianceRatioEntry[] = [];
  let isRandomWalk = true;

  for (const q of qs) {
    if (q >= n) continue;

    // q-period returns
    const qRets: number[] = [];
    for (let i = q; i < n; i++) {
      qRets.push(series[i] / series[i - q] - 1);
    }

    const varQ = qRets.reduce((s, r) => s + r * r, 0) / qRets.length;
    const ratio = varQ / (q * var1);

    // Asymptotic z-statistic
    const nq = rets.length;
    const se = Math.sqrt(2 * (2 * q - 1) * (q - 1) / (3 * q * nq));
    const zStat = se === 0 ? 0 : (ratio - 1) / se;
    const pValue = 2 * (1 - normCdf(Math.abs(zStat)));

    if (pValue < 0.05) isRandomWalk = false;

    ratios.push({ period: q, ratio, zStat, pValue });
  }

  return { ratios, randomWalk: isRandomWalk };
}

/**
 * Rolling regime detection with change point identification.
 */
export function regimeChangeDetection(
  series: number[],
  params?: { windowSize?: number; threshold?: number }
): RegimeChangeResult {
  const n = series.length;
  const window = params?.windowSize ?? Math.max(20, Math.floor(n / 10));
  const threshold = params?.threshold ?? 1.5;

  if (n < window * 2) {
    return { regimes: [], currentRegime: 'low_vol', changePoints: [] };
  }

  // Compute rolling mean and volatility
  const rollingMean: number[] = [];
  const rollingVol: number[] = [];

  for (let i = window - 1; i < n; i++) {
    const slice = series.slice(i - window + 1, i + 1);
    rollingMean.push(mean(slice));
    rollingVol.push(standardDeviation(slice));
  }

  const avgVol = mean(rollingVol);
  const avgMean = mean(rollingMean);

  // Detect change points: where rolling stats change significantly
  const changePoints: number[] = [];
  for (let i = 1; i < rollingVol.length; i++) {
    const volChange = Math.abs(rollingVol[i] - rollingVol[i - 1]) / (avgVol || 1);
    const meanChange = Math.abs(rollingMean[i] - rollingMean[i - 1]) / (avgVol || 1);
    if (volChange > threshold * 0.5 || meanChange > threshold) {
      // Avoid duplicate close change points
      if (changePoints.length === 0 || i - changePoints[changePoints.length - 1] > window / 2) {
        changePoints.push(i + window - 1); // Map back to original index
      }
    }
  }

  // Build regimes between change points
  const boundaries = [0, ...changePoints, n - 1];
  const regimes: RegimeEntry[] = [];

  for (let b = 0; b < boundaries.length - 1; b++) {
    const start = boundaries[b];
    const end = boundaries[b + 1];
    if (end <= start) continue;

    const slice = series.slice(start, end + 1);
    const m = mean(slice);
    const v = standardDeviation(slice);

    let label: RegimeEntry['label'];
    if (v > avgVol * 1.3) label = 'high_vol';
    else if (v < avgVol * 0.7) label = 'low_vol';
    else {
      // Check trending vs mean reverting via autocorrelation
      const rets: number[] = [];
      for (let i = 1; i < slice.length; i++) rets.push(slice[i] - slice[i - 1]);
      if (rets.length < 3) {
        label = 'low_vol';
      } else {
        const { acf } = autocorrelation(rets, 1);
        label = acf.length > 1 && acf[1] > 0.1 ? 'trending' : 'mean_reverting';
      }
    }

    regimes.push({ start, end, mean: m, vol: v, label });
  }

  const currentRegime = regimes.length > 0 ? regimes[regimes.length - 1].label : 'low_vol';

  return { regimes, currentRegime, changePoints };
}
