/**
 * Financial math utilities for trading skills.
 * Position sizing, risk metrics, and statistical functions.
 */

// ── Position Sizing ────────────────────────────────────────

/**
 * Kelly criterion: optimal fraction of capital to risk.
 * Returns half-Kelly by default for safety.
 */
export function kelly(winRate: number, avgWinLossRatio: number, halfKelly: boolean = true): number {
  const f = winRate - (1 - winRate) / avgWinLossRatio;
  const result = Math.max(0, f);
  return halfKelly ? result / 2 : result;
}

/**
 * Fixed fractional position size: how many units to buy given risk parameters.
 */
export function fixedFractionalSize(
  portfolioValue: number,
  riskPerTrade: number,
  entryPrice: number,
  stopLossPrice: number
): number {
  const riskPerUnit = Math.abs(entryPrice - stopLossPrice);
  if (riskPerUnit === 0) return 0;
  const maxLoss = portfolioValue * riskPerTrade;
  return maxLoss / riskPerUnit;
}

// ── Risk Metrics ───────────────────────────────────────────

/**
 * Parametric Value at Risk.
 * @param portfolioValue - total portfolio value
 * @param returns - array of historical returns (decimal)
 * @param confidence - 0.95 or 0.99
 * @param horizon - time horizon in days
 */
export function valueAtRisk(
  portfolioValue: number,
  returns: number[],
  confidence: number = 0.95,
  horizon: number = 1
): number {
  const sigma = standardDeviation(returns);
  const z = confidence === 0.99 ? 2.326 : 1.645;
  return portfolioValue * z * sigma * Math.sqrt(horizon);
}

/**
 * Maximum drawdown from a series of portfolio values.
 */
export function maxDrawdown(values: number[]): {
  maxDrawdown: number;
  peakIndex: number;
  troughIndex: number;
} {
  let peak = values[0];
  let peakIndex = 0;
  let maxDD = 0;
  let maxDDPeakIndex = 0;
  let maxDDTroughIndex = 0;

  for (let i = 1; i < values.length; i++) {
    if (values[i] > peak) {
      peak = values[i];
      peakIndex = i;
    }
    const dd = (peak - values[i]) / peak;
    if (dd > maxDD) {
      maxDD = dd;
      maxDDPeakIndex = peakIndex;
      maxDDTroughIndex = i;
    }
  }

  return {
    maxDrawdown: maxDD,
    peakIndex: maxDDPeakIndex,
    troughIndex: maxDDTroughIndex,
  };
}

/**
 * Sharpe ratio: risk-adjusted return.
 * @param returns - array of period returns
 * @param riskFreeRate - annualized risk-free rate (default 0.05 = 5%)
 * @param periodsPerYear - 252 for daily, 365 for crypto daily, 8760 for hourly
 */
export function sharpeRatio(returns: number[], riskFreeRate: number = 0.05, periodsPerYear: number = 365): number {
  const avgReturn = mean(returns);
  const sigma = standardDeviation(returns);
  if (sigma === 0) return 0;

  const rfPerPeriod = riskFreeRate / periodsPerYear;
  return ((avgReturn - rfPerPeriod) / sigma) * Math.sqrt(periodsPerYear);
}

/**
 * Sortino ratio: like Sharpe but only penalizes downside volatility.
 */
export function sortinoRatio(returns: number[], riskFreeRate: number = 0.05, periodsPerYear: number = 365): number {
  const avgReturn = mean(returns);
  const rfPerPeriod = riskFreeRate / periodsPerYear;
  const downsideReturns = returns.filter(r => r < rfPerPeriod);

  if (downsideReturns.length === 0) return Infinity;
  const downsideDev = standardDeviation(downsideReturns);
  if (downsideDev === 0) return Infinity;

  return ((avgReturn - rfPerPeriod) / downsideDev) * Math.sqrt(periodsPerYear);
}

/**
 * Calmar ratio: annualized return / max drawdown.
 */
export function calmarRatio(returns: number[], portfolioValues: number[], periodsPerYear: number = 365): number {
  const totalReturn = returns.reduce((acc, r) => acc * (1 + r), 1) - 1;
  const annualizedReturn = (1 + totalReturn) ** (periodsPerYear / returns.length) - 1;
  const { maxDrawdown: mdd } = maxDrawdown(portfolioValues);
  if (mdd === 0) return Infinity;
  return annualizedReturn / mdd;
}

// ── Correlation ────────────────────────────────────────────

/**
 * Pearson correlation coefficient between two return series.
 */
export function correlation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;

  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);
  const xMean = mean(xSlice);
  const yMean = mean(ySlice);

  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - xMean;
    const dy = ySlice[i] - yMean;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  return denom === 0 ? 0 : sumXY / denom;
}

/**
 * Correlation matrix for multiple return series.
 */
export function correlationMatrix(series: number[][], labels?: string[]): { matrix: number[][]; labels: string[] } {
  const n = series.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const corr = i === j ? 1 : correlation(series[i], series[j]);
      matrix[i][j] = corr;
      matrix[j][i] = corr;
    }
  }

  return {
    matrix,
    labels: labels ?? series.map((_, i) => `Asset ${i}`),
  };
}

// ── Statistical Helpers ────────────────────────────────────

export function mean(data: number[]): number {
  if (data.length === 0) return 0;
  return data.reduce((a, b) => a + b, 0) / data.length;
}

export function standardDeviation(data: number[]): number {
  if (data.length < 2) return 0;
  const avg = mean(data);
  const variance = data.reduce((sum, val) => sum + (val - avg) ** 2, 0) / (data.length - 1);
  return Math.sqrt(variance);
}

export function zScore(value: number, data: number[]): number {
  const avg = mean(data);
  const sd = standardDeviation(data);
  return sd === 0 ? 0 : (value - avg) / sd;
}

/**
 * Calculate returns from a price series.
 */
export function returns(prices: number[]): number[] {
  const result: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    result.push((prices[i] - prices[i - 1]) / prices[i - 1]);
  }
  return result;
}

/**
 * Win rate from an array of P&L values.
 */
export function winRate(pnls: number[]): number {
  if (pnls.length === 0) return 0;
  const wins = pnls.filter(p => p > 0).length;
  return wins / pnls.length;
}

/**
 * Profit factor: gross profits / gross losses.
 */
export function profitFactor(pnls: number[]): number {
  const grossProfit = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0));
  return grossLoss === 0 ? Infinity : grossProfit / grossLoss;
}

// ── Distribution Shape ────────────────────────────────────

/**
 * Sample skewness (Fisher-Pearson).
 * Positive → right-skewed (more extreme gains), Negative → left-skewed (more extreme losses).
 */
export function skewness(data: number[]): number {
  const n = data.length;
  if (n < 3) return 0;
  const avg = mean(data);
  const sd = standardDeviation(data);
  if (sd === 0) return 0;
  const m3 = data.reduce((s, v) => s + ((v - avg) / sd) ** 3, 0) / n;
  return (n * m3) / ((n - 1) * (n - 2) / n); // adjusted Fisher-Pearson
}

/**
 * Excess kurtosis (Fisher).
 * > 0 → fat tails (leptokurtic), < 0 → thin tails (platykurtic), 0 → normal.
 */
export function kurtosis(data: number[]): number {
  const n = data.length;
  if (n < 4) return 0;
  const avg = mean(data);
  const sd = standardDeviation(data);
  if (sd === 0) return 0;
  const m4 = data.reduce((s, v) => s + ((v - avg) / sd) ** 4, 0) / n;
  return m4 - 3; // excess kurtosis (subtract 3 for normal baseline)
}

// ── Volatility ────────────────────────────────────────────

/**
 * Annualized volatility from a return series.
 * @param returnSeries - period returns (decimal)
 * @param periodsPerYear - 365 for crypto daily, 252 for equities daily
 */
export function annualizedVolatility(returnSeries: number[], periodsPerYear: number = 365): number {
  if (returnSeries.length < 2) return 0;
  return standardDeviation(returnSeries) * Math.sqrt(periodsPerYear);
}

/**
 * Volatility percentile: where current vol ranks historically.
 * @param returnSeries - full return series
 * @param currentWindow - window for current vol (e.g., 30)
 * @param lookback - historical lookback for ranking (e.g., 252)
 * @returns percentile 0-1 (0.9 means current vol is higher than 90% of history)
 */
export function volatilityPercentile(returnSeries: number[], currentWindow: number = 30, lookback: number = 252): number {
  if (returnSeries.length < currentWindow + lookback) return 0.5;

  const currentVol = standardDeviation(returnSeries.slice(-currentWindow));
  const historicalVols: number[] = [];

  const start = returnSeries.length - lookback - currentWindow;
  for (let i = Math.max(0, start); i <= returnSeries.length - currentWindow; i++) {
    historicalVols.push(standardDeviation(returnSeries.slice(i, i + currentWindow)));
  }

  const below = historicalVols.filter(v => v < currentVol).length;
  return below / historicalVols.length;
}

// ── Tail Risk ─────────────────────────────────────────────

/**
 * Tail ratio: right tail magnitude / left tail magnitude.
 * > 1 → fatter right tail (favorable), < 1 → fatter left tail (risky).
 * @param returnSeries - return series
 * @param percentile - tail cutoff (default 0.05 for 5th/95th)
 */
export function tailRatio(returnSeries: number[], percentile: number = 0.05): number {
  if (returnSeries.length < 20) return 1;
  const sorted = [...returnSeries].sort((a, b) => a - b);
  const lowerIdx = Math.floor(sorted.length * percentile);
  const upperIdx = Math.floor(sorted.length * (1 - percentile));
  const leftTail = Math.abs(sorted[lowerIdx]);
  const rightTail = Math.abs(sorted[upperIdx]);
  return leftTail === 0 ? Infinity : rightTail / leftTail;
}

// ── Benchmark Comparison ──────────────────────────────────

/**
 * Market beta: sensitivity of asset returns to benchmark returns.
 * beta > 1 → more volatile than market, beta < 1 → less volatile.
 */
export function beta(assetReturns: number[], benchmarkReturns: number[]): number {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  if (n < 2) return 1;
  const a = assetReturns.slice(0, n);
  const b = benchmarkReturns.slice(0, n);
  const bMean = mean(b);
  const covariance = a.reduce((s, v, i) => s + (v - mean(a)) * (b[i] - bMean), 0) / (n - 1);
  const benchVariance = b.reduce((s, v) => s + (v - bMean) ** 2, 0) / (n - 1);
  return benchVariance === 0 ? 1 : covariance / benchVariance;
}

/**
 * Jensen's alpha: excess return above what beta predicts.
 * Positive alpha → outperformance, negative → underperformance.
 */
export function alpha(
  assetReturns: number[],
  benchmarkReturns: number[],
  riskFreeRate: number = 0.05,
  periodsPerYear: number = 365
): number {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  if (n < 2) return 0;
  const a = assetReturns.slice(0, n);
  const b = benchmarkReturns.slice(0, n);
  const rfPerPeriod = riskFreeRate / periodsPerYear;
  const assetAvg = mean(a);
  const benchAvg = mean(b);
  const b_ = beta(a, b);
  return (assetAvg - rfPerPeriod) - b_ * (benchAvg - rfPerPeriod);
}

/**
 * Information ratio: active return / tracking error.
 * Higher → more consistent outperformance.
 */
export function informationRatio(assetReturns: number[], benchmarkReturns: number[]): number {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  if (n < 2) return 0;
  const activeReturns = assetReturns.slice(0, n).map((r, i) => r - benchmarkReturns[i]);
  const te = standardDeviation(activeReturns);
  return te === 0 ? 0 : mean(activeReturns) / te;
}

/**
 * Upside capture ratio: how much of benchmark's up-moves the asset captures.
 * > 1 → captures more than the benchmark on up-days.
 */
export function upsideCapture(assetReturns: number[], benchmarkReturns: number[]): number {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  const upDays: { asset: number; bench: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (benchmarkReturns[i] > 0) {
      upDays.push({ asset: assetReturns[i], bench: benchmarkReturns[i] });
    }
  }
  if (upDays.length === 0) return 0;
  const assetUp = mean(upDays.map(d => d.asset));
  const benchUp = mean(upDays.map(d => d.bench));
  return benchUp === 0 ? 0 : assetUp / benchUp;
}

/**
 * Downside capture ratio: how much of benchmark's down-moves the asset captures.
 * < 1 → loses less than the benchmark on down-days (good).
 */
export function downsideCapture(assetReturns: number[], benchmarkReturns: number[]): number {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  const downDays: { asset: number; bench: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (benchmarkReturns[i] < 0) {
      downDays.push({ asset: assetReturns[i], bench: benchmarkReturns[i] });
    }
  }
  if (downDays.length === 0) return 0;
  const assetDown = mean(downDays.map(d => d.asset));
  const benchDown = mean(downDays.map(d => d.bench));
  return benchDown === 0 ? 0 : assetDown / benchDown;
}

// ── Trend Analysis ────────────────────────────────────────

/**
 * Simple linear regression slope on data indices.
 * Positive → uptrend, negative → downtrend. Magnitude = strength.
 */
export function linearRegressionSlope(data: number[]): number {
  const n = data.length;
  if (n < 2) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += data[i];
    sumXY += i * data[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

/**
 * Coefficient of variation: std / |mean|.
 * Lower → more stable. Useful for margin/FCF consistency analysis.
 */
export function coefficientOfVariation(data: number[]): number {
  const avg = mean(data);
  if (avg === 0) return Infinity;
  return standardDeviation(data) / Math.abs(avg);
}

// ── Drawdown Analysis ─────────────────────────────────────

/**
 * Full drawdown series from portfolio values.
 * Each element is the drawdown from the running peak (0 to -1 scale).
 */
export function drawdownSeries(values: number[]): number[] {
  const result: number[] = [];
  let peak = values[0];
  for (const v of values) {
    if (v > peak) peak = v;
    result.push(peak === 0 ? 0 : (v - peak) / peak);
  }
  return result;
}

// ── Rolling Returns ───────────────────────────────────────

/**
 * Multi-window rolling returns from a price series.
 * @param prices - price series
 * @param windows - array of lookback periods
 * @returns object mapping each window to an array of rolling returns
 */
export function rollingReturns(prices: number[], windows: number[]): Record<number, number[]> {
  const result: Record<number, number[]> = {};
  for (const w of windows) {
    const series: number[] = [];
    for (let i = w; i < prices.length; i++) {
      series.push(prices[i - w] === 0 ? 0 : (prices[i] - prices[i - w]) / prices[i - w]);
    }
    result[w] = series;
  }
  return result;
}

// ── Backtest Metrics ──────────────────────────────────────

/**
 * Buy-and-hold benchmark return for a price series.
 */
export function benchmarkReturn(prices: number[]): number {
  if (prices.length < 2 || prices[0] === 0) return 0;
  return (prices[prices.length - 1] - prices[0]) / prices[0];
}

/**
 * Tracking error: standard deviation of active returns vs benchmark.
 */
export function trackingError(assetReturns: number[], benchmarkReturns: number[]): number {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  if (n < 2) return 0;
  const activeReturns = assetReturns.slice(0, n).map((r, i) => r - benchmarkReturns[i]);
  return standardDeviation(activeReturns);
}

/**
 * Maximum consecutive losing trades.
 */
export function maxConsecutiveLosses(pnls: number[]): number {
  let max = 0;
  let current = 0;
  for (const p of pnls) {
    if (p < 0) {
      current++;
      if (current > max) max = current;
    } else {
      current = 0;
    }
  }
  return max;
}

/**
 * Expected value per trade: winRate * avgWin - lossRate * avgLoss.
 */
export function expectancy(tradeWinRate: number, avgWin: number, avgLoss: number): number {
  return tradeWinRate * avgWin - (1 - tradeWinRate) * Math.abs(avgLoss);
}
