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
