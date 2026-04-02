import { describe, it, expect } from 'vitest';
import {
  kelly, fixedFractionalSize, valueAtRisk, maxDrawdown,
  sharpeRatio, sortinoRatio, calmarRatio,
  correlation, correlationMatrix,
  mean, standardDeviation, zScore, returns, winRate, profitFactor,
  skewness, kurtosis, annualizedVolatility, volatilityPercentile, tailRatio,
  beta, alpha, informationRatio, upsideCapture, downsideCapture,
  linearRegressionSlope, coefficientOfVariation, drawdownSeries,
  rollingReturns, benchmarkReturn, trackingError, maxConsecutiveLosses, expectancy,
} from '../../../../lib/math.js';

// ── Position Sizing ──────────────────────────────────────────

describe('kelly', () => {
  it('returns half-Kelly by default', () => {
    // 60% win rate, 2:1 avg win/loss → full Kelly = 0.6 - 0.4/2 = 0.4, half = 0.2
    expect(kelly(0.6, 2)).toBeCloseTo(0.2);
  });

  it('returns full Kelly when halfKelly=false', () => {
    expect(kelly(0.6, 2, false)).toBeCloseTo(0.4);
  });

  it('returns 0 for unprofitable edge (win rate too low)', () => {
    // 30% win rate, 1:1 ratio → 0.3 - 0.7/1 = -0.4 → clamped to 0
    expect(kelly(0.3, 1)).toBe(0);
  });

  it('returns 0 when win rate is 0', () => {
    expect(kelly(0, 2)).toBe(0);
  });

  it('handles 100% win rate', () => {
    // 1.0 - 0/ratio = 1.0, half = 0.5
    expect(kelly(1, 2)).toBeCloseTo(0.5);
    expect(kelly(1, 2, false)).toBeCloseTo(1.0);
  });
});

describe('fixedFractionalSize', () => {
  it('calculates position size for a long trade', () => {
    // $100k portfolio, 2% risk, entry $50, stop $48 → risk $2/unit → $2000/$2 = 1000 units
    expect(fixedFractionalSize(100_000, 0.02, 50, 48)).toBeCloseTo(1000);
  });

  it('calculates position size for a short trade', () => {
    // entry $50, stop $52 → risk $2/unit → same result
    expect(fixedFractionalSize(100_000, 0.02, 50, 52)).toBeCloseTo(1000);
  });

  it('returns 0 when entry equals stop loss', () => {
    expect(fixedFractionalSize(100_000, 0.02, 50, 50)).toBe(0);
  });

  it('scales with portfolio size', () => {
    const small = fixedFractionalSize(10_000, 0.02, 50, 48);
    const large = fixedFractionalSize(100_000, 0.02, 50, 48);
    expect(large).toBeCloseTo(small * 10);
  });
});

// ── Risk Metrics ──────────────────────────────────────────────

describe('valueAtRisk', () => {
  it('calculates parametric VaR at 95% confidence', () => {
    const dailyReturns = [0.01, -0.02, 0.005, -0.01, 0.015, -0.005, 0.02, -0.015, 0.01, -0.01];
    const result = valueAtRisk(100_000, dailyReturns);
    expect(result).toBeGreaterThan(0);
    // z=1.645 for 95%, horizon=1 day
    const sigma = standardDeviation(dailyReturns);
    expect(result).toBeCloseTo(100_000 * 1.645 * sigma);
  });

  it('gives higher VaR at 99% confidence', () => {
    const dailyReturns = [0.01, -0.02, 0.005, -0.01, 0.015];
    const var95 = valueAtRisk(100_000, dailyReturns, 0.95);
    const var99 = valueAtRisk(100_000, dailyReturns, 0.99);
    expect(var99).toBeGreaterThan(var95);
  });

  it('scales with sqrt of horizon', () => {
    const dailyReturns = [0.01, -0.02, 0.005, -0.01, 0.015];
    const var1d = valueAtRisk(100_000, dailyReturns, 0.95, 1);
    const var4d = valueAtRisk(100_000, dailyReturns, 0.95, 4);
    expect(var4d).toBeCloseTo(var1d * 2); // sqrt(4) = 2
  });
});

describe('maxDrawdown', () => {
  it('finds drawdown in a V-shaped series', () => {
    const values = [100, 110, 90, 80, 95, 120];
    const result = maxDrawdown(values);
    // Peak at 110, trough at 80 → (110-80)/110 ≈ 0.2727
    expect(result.maxDrawdown).toBeCloseTo(30 / 110);
    expect(result.peakIndex).toBe(1);
    expect(result.troughIndex).toBe(3);
  });

  it('returns 0 for monotonically rising series', () => {
    const values = [100, 110, 120, 130, 140];
    const result = maxDrawdown(values);
    expect(result.maxDrawdown).toBe(0);
  });

  it('handles monotonically falling series', () => {
    const values = [100, 90, 80, 70, 60];
    const result = maxDrawdown(values);
    // Peak at 100, trough at 60 → 40/100 = 0.4
    expect(result.maxDrawdown).toBeCloseTo(0.4);
    expect(result.peakIndex).toBe(0);
    expect(result.troughIndex).toBe(4);
  });
});

describe('sharpeRatio', () => {
  it('returns 0 for zero volatility', () => {
    const constantReturns = [0.01, 0.01, 0.01, 0.01, 0.01];
    expect(sharpeRatio(constantReturns)).toBe(0);
  });

  it('returns positive value for good returns', () => {
    // Consistently positive returns with some variance
    const goodReturns = [0.02, 0.03, 0.01, 0.04, 0.02, 0.03, 0.01, 0.02, 0.03, 0.02];
    expect(sharpeRatio(goodReturns)).toBeGreaterThan(0);
  });

  it('returns negative value for poor returns', () => {
    // Returns well below risk-free rate (default 5% annual = ~0.0137% daily)
    const poorReturns = [-0.05, -0.03, -0.04, -0.06, -0.02, -0.05, -0.03, -0.04, -0.06, -0.02];
    expect(sharpeRatio(poorReturns)).toBeLessThan(0);
  });
});

describe('sortinoRatio', () => {
  it('returns Infinity when no downside returns exist', () => {
    const allPositive = [0.01, 0.02, 0.03, 0.04, 0.05];
    expect(sortinoRatio(allPositive)).toBe(Infinity);
  });

  it('is higher than Sharpe when downside is limited', () => {
    // Most returns positive, some negative
    const mixedReturns = [0.03, 0.02, -0.01, 0.04, 0.01, 0.03, -0.005, 0.02, 0.03, 0.01];
    const sharpe = sharpeRatio(mixedReturns);
    const sortino = sortinoRatio(mixedReturns);
    // Sortino should generally be higher since it only penalizes downside
    expect(sortino).toBeGreaterThan(sharpe);
  });
});

describe('calmarRatio', () => {
  it('returns Infinity when no drawdown exists', () => {
    const returns_arr = [0.01, 0.02, 0.01, 0.02];
    const values = [100, 101, 103.02, 104.0502, 106.1312];
    expect(calmarRatio(returns_arr, values)).toBe(Infinity);
  });

  it('returns a finite positive value with drawdown', () => {
    const returns_arr = [0.1, -0.2, 0.15, 0.05];
    const values = [100, 110, 88, 101.2, 106.26];
    const result = calmarRatio(returns_arr, values);
    expect(result).toBeGreaterThan(0);
    expect(isFinite(result)).toBe(true);
  });
});

// ── Correlation ──────────────────────────────────────────────

describe('correlation', () => {
  it('returns 1 for perfectly correlated series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(correlation(x, y)).toBeCloseTo(1);
  });

  it('returns -1 for perfectly inversely correlated series', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    expect(correlation(x, y)).toBeCloseTo(-1);
  });

  it('returns 0 for empty arrays', () => {
    expect(correlation([], [])).toBe(0);
  });

  it('handles arrays of different lengths (uses shorter)', () => {
    const x = [1, 2, 3, 4, 5, 6, 7];
    const y = [2, 4, 6];
    expect(correlation(x, y)).toBeCloseTo(1);
  });

  it('returns 0 for constant series', () => {
    const x = [5, 5, 5, 5];
    const y = [1, 2, 3, 4];
    expect(correlation(x, y)).toBe(0);
  });
});

describe('correlationMatrix', () => {
  it('has 1 on the diagonal', () => {
    const series = [[1, 2, 3], [4, 5, 6], [7, 8, 9]];
    const { matrix } = correlationMatrix(series);
    for (let i = 0; i < matrix.length; i++) {
      expect(matrix[i][i]).toBe(1);
    }
  });

  it('is symmetric', () => {
    const series = [[1, 2, 3, 4], [4, 3, 2, 1], [1, 3, 2, 4]];
    const { matrix } = correlationMatrix(series);
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix.length; j++) {
        expect(matrix[i][j]).toBeCloseTo(matrix[j][i]);
      }
    }
  });

  it('uses default labels when none provided', () => {
    const series = [[1, 2], [3, 4]];
    const { labels } = correlationMatrix(series);
    expect(labels).toEqual(['Asset 0', 'Asset 1']);
  });

  it('uses custom labels when provided', () => {
    const series = [[1, 2], [3, 4]];
    const { labels } = correlationMatrix(series, ['BTC', 'ETH']);
    expect(labels).toEqual(['BTC', 'ETH']);
  });
});

// ── Statistical Helpers ──────────────────────────────────────

describe('mean', () => {
  it('calculates mean correctly', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it('returns 0 for empty array', () => {
    expect(mean([])).toBe(0);
  });

  it('handles single element', () => {
    expect(mean([42])).toBe(42);
  });

  it('handles negative numbers', () => {
    expect(mean([-2, -1, 0, 1, 2])).toBe(0);
  });
});

describe('standardDeviation', () => {
  it('calculates sample standard deviation', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, variance=4, sd=2
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.1381, 3);
  });

  it('returns 0 for single element', () => {
    expect(standardDeviation([42])).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(standardDeviation([])).toBe(0);
  });

  it('returns 0 for constant values', () => {
    expect(standardDeviation([5, 5, 5, 5])).toBe(0);
  });
});

describe('zScore', () => {
  it('calculates z-score correctly', () => {
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    const avg = mean(data);
    const sd = standardDeviation(data);
    // z-score of the mean should be 0
    expect(zScore(avg, data)).toBeCloseTo(0);
    // z-score of a value 1 sd above mean
    expect(zScore(avg + sd, data)).toBeCloseTo(1);
  });

  it('returns 0 when standard deviation is 0', () => {
    expect(zScore(10, [5, 5, 5, 5])).toBe(0);
  });
});

describe('returns', () => {
  it('calculates percentage returns from price series', () => {
    const prices = [100, 110, 99, 108];
    const result = returns(prices);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeCloseTo(0.1);      // (110-100)/100
    expect(result[1]).toBeCloseTo(-0.1);     // (99-110)/110
    expect(result[2]).toBeCloseTo(9 / 99);   // (108-99)/99
  });

  it('returns empty array for single price', () => {
    expect(returns([100])).toEqual([]);
  });

  it('returns empty array for no prices', () => {
    expect(returns([])).toEqual([]);
  });
});

describe('winRate', () => {
  it('calculates win rate correctly', () => {
    const pnls = [100, -50, 200, -30, 150];
    expect(winRate(pnls)).toBeCloseTo(0.6); // 3 wins / 5 trades
  });

  it('returns 0 for empty array', () => {
    expect(winRate([])).toBe(0);
  });

  it('returns 1 for all wins', () => {
    expect(winRate([10, 20, 30])).toBe(1);
  });

  it('returns 0 for all losses', () => {
    expect(winRate([-10, -20, -30])).toBe(0);
  });

  it('does not count zero as a win', () => {
    expect(winRate([0, 0, 0])).toBe(0);
  });
});

describe('profitFactor', () => {
  it('calculates profit factor correctly', () => {
    // Gross profit = 100 + 200 = 300, gross loss = |(-50) + (-30)| = 80
    const pnls = [100, -50, 200, -30];
    expect(profitFactor(pnls)).toBeCloseTo(300 / 80);
  });

  it('returns Infinity when no losses', () => {
    expect(profitFactor([10, 20, 30])).toBe(Infinity);
  });

  it('returns 0 when no profits (only losses)', () => {
    expect(profitFactor([-10, -20])).toBe(0);
  });

  it('returns Infinity for empty array (0/0 case)', () => {
    // No losses → gross loss = 0 → Infinity
    expect(profitFactor([])).toBe(Infinity);
  });
});

// ── Distribution Shape ──────────────────────────────────────

describe('skewness', () => {
  it('returns ~0 for symmetric data', () => {
    const symmetric = [-3, -2, -1, 0, 1, 2, 3];
    expect(Math.abs(skewness(symmetric))).toBeLessThan(0.1);
  });

  it('returns positive for right-skewed data', () => {
    const rightSkewed = [1, 2, 2, 3, 3, 3, 4, 4, 10, 20];
    expect(skewness(rightSkewed)).toBeGreaterThan(0);
  });

  it('returns 0 for insufficient data', () => {
    expect(skewness([1, 2])).toBe(0);
  });

  it('returns 0 for constant data', () => {
    expect(skewness([5, 5, 5, 5, 5])).toBe(0);
  });
});

describe('kurtosis', () => {
  it('returns ~0 for normal-like data', () => {
    // Approximate normal distribution (large sample)
    const normal = [-2.5, -2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5,
      -2, -1, 0, 1, 2, -1.5, -0.5, 0.5, 1.5];
    const k = kurtosis(normal);
    expect(Math.abs(k)).toBeLessThan(2); // loosely normal
  });

  it('returns positive for heavy-tailed data', () => {
    const heavyTails = [0, 0, 0, 0, 0, 0, 0, 0, -10, 10];
    expect(kurtosis(heavyTails)).toBeGreaterThan(0);
  });

  it('returns 0 for insufficient data', () => {
    expect(kurtosis([1, 2, 3])).toBe(0);
  });
});

// ── Volatility ──────────────────────────────────────────────

describe('annualizedVolatility', () => {
  it('annualizes daily standard deviation', () => {
    const dailyReturns = [0.01, -0.02, 0.005, -0.01, 0.015, -0.005, 0.02, -0.015, 0.01, -0.01];
    const vol = annualizedVolatility(dailyReturns);
    const dailySd = standardDeviation(dailyReturns);
    expect(vol).toBeCloseTo(dailySd * Math.sqrt(365));
  });

  it('returns 0 for insufficient data', () => {
    expect(annualizedVolatility([0.01])).toBe(0);
  });
});

describe('volatilityPercentile', () => {
  it('returns high percentile during high vol', () => {
    // Low vol period then high vol at the end
    const lowVol = Array(300).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.001);
    const highVol = Array(30).fill(0).map((_, i) => Math.sin(i * 0.5) * 0.05);
    const combined = [...lowVol, ...highVol];
    const pct = volatilityPercentile(combined, 30, 252);
    expect(pct).toBeGreaterThan(0.7);
  });

  it('returns 0.5 for insufficient data', () => {
    expect(volatilityPercentile([0.01, 0.02], 30, 252)).toBe(0.5);
  });
});

describe('tailRatio', () => {
  it('returns ~1 for symmetric returns', () => {
    const symmetric = Array(100).fill(0).map((_, i) => Math.sin(i * 0.3) * 0.02);
    const ratio = tailRatio(symmetric);
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2);
  });

  it('returns 1 for insufficient data', () => {
    expect(tailRatio([0.01, 0.02])).toBe(1);
  });
});

// ── Benchmark Comparison ────────────────────────────────────

describe('beta', () => {
  it('returns ~1 for identical series', () => {
    const r = [0.01, -0.02, 0.015, -0.01, 0.005];
    expect(beta(r, r)).toBeCloseTo(1);
  });

  it('returns ~2 for 2x leveraged returns', () => {
    const bench = [0.01, -0.02, 0.015, -0.01, 0.005, 0.02, -0.005];
    const leveraged = bench.map(r => r * 2);
    expect(beta(leveraged, bench)).toBeCloseTo(2, 0);
  });

  it('returns 1 for insufficient data', () => {
    expect(beta([0.01], [0.01])).toBe(1);
  });
});

describe('alpha', () => {
  it('returns positive for outperforming asset', () => {
    const asset = [0.05, 0.03, 0.04, 0.06, 0.02, 0.05, 0.03];
    const bench = [0.01, -0.02, 0.01, 0.02, -0.01, 0.01, 0.00];
    expect(alpha(asset, bench)).toBeGreaterThan(0);
  });

  it('returns ~0 for identical series', () => {
    const r = [0.01, -0.02, 0.015, -0.01, 0.005];
    expect(alpha(r, r)).toBeCloseTo(0, 4);
  });
});

describe('informationRatio', () => {
  it('returns positive for consistent outperformance', () => {
    const asset = [0.02, 0.03, 0.02, 0.03, 0.02];
    const bench = [0.01, 0.01, 0.01, 0.01, 0.01];
    expect(informationRatio(asset, bench)).toBeGreaterThan(0);
  });

  it('returns 0 for insufficient data', () => {
    expect(informationRatio([0.01], [0.01])).toBe(0);
  });
});

describe('upsideCapture', () => {
  it('returns > 1 for asset that gains more on up days', () => {
    const bench = [0.02, -0.01, 0.03, -0.02, 0.01];
    const asset = [0.04, -0.005, 0.06, -0.01, 0.02]; // 2x on up days
    expect(upsideCapture(asset, bench)).toBeGreaterThan(1);
  });

  it('returns 0 when no up days', () => {
    const bench = [-0.01, -0.02, -0.01];
    const asset = [-0.005, -0.01, -0.005];
    expect(upsideCapture(asset, bench)).toBe(0);
  });
});

describe('downsideCapture', () => {
  it('returns < 1 for asset that loses less on down days', () => {
    const bench = [0.02, -0.04, 0.03, -0.06, 0.01];
    const asset = [0.01, -0.02, 0.02, -0.03, 0.005]; // half the losses
    expect(downsideCapture(asset, bench)).toBeLessThan(1);
  });

  it('returns 0 when no down days', () => {
    const bench = [0.01, 0.02, 0.01];
    const asset = [0.02, 0.03, 0.02];
    expect(downsideCapture(asset, bench)).toBe(0);
  });
});

// ── Trend Analysis ──────────────────────────────────────────

describe('linearRegressionSlope', () => {
  it('returns positive slope for uptrend', () => {
    const uptrend = [10, 12, 14, 16, 18, 20];
    expect(linearRegressionSlope(uptrend)).toBeCloseTo(2);
  });

  it('returns negative slope for downtrend', () => {
    const downtrend = [20, 18, 16, 14, 12, 10];
    expect(linearRegressionSlope(downtrend)).toBeCloseTo(-2);
  });

  it('returns 0 for flat data', () => {
    const flat = [10, 10, 10, 10];
    expect(linearRegressionSlope(flat)).toBeCloseTo(0);
  });

  it('returns 0 for insufficient data', () => {
    expect(linearRegressionSlope([42])).toBe(0);
  });
});

describe('coefficientOfVariation', () => {
  it('calculates std / |mean|', () => {
    const data = [10, 12, 14, 16, 18];
    const cv = coefficientOfVariation(data);
    expect(cv).toBeCloseTo(standardDeviation(data) / mean(data));
  });

  it('returns Infinity for zero mean', () => {
    expect(coefficientOfVariation([-1, 0, 1])).toBe(Infinity);
  });
});

// ── Drawdown Analysis ───────────────────────────────────────

describe('drawdownSeries', () => {
  it('all values are <= 0', () => {
    const values = [100, 110, 90, 80, 95, 120, 115];
    const dd = drawdownSeries(values);
    for (const v of dd) {
      expect(v).toBeLessThanOrEqual(0);
    }
  });

  it('is 0 at new highs', () => {
    const values = [100, 110, 120, 130];
    const dd = drawdownSeries(values);
    for (const v of dd) {
      expect(v).toBe(0);
    }
  });

  it('calculates correct drawdown values', () => {
    const values = [100, 110, 88];
    const dd = drawdownSeries(values);
    expect(dd[0]).toBe(0);
    expect(dd[1]).toBe(0); // new high
    expect(dd[2]).toBeCloseTo((88 - 110) / 110); // -20%
  });
});

// ── Rolling Returns ─────────────────────────────────────────

describe('rollingReturns', () => {
  it('calculates returns over multiple windows', () => {
    const prices = [100, 110, 105, 115, 120];
    const result = rollingReturns(prices, [1, 2]);
    expect(result[1]).toHaveLength(4); // 5 - 1
    expect(result[2]).toHaveLength(3); // 5 - 2
    expect(result[1][0]).toBeCloseTo(0.10); // (110-100)/100
  });
});

// ── Backtest Metrics ────────────────────────────────────────

describe('benchmarkReturn', () => {
  it('calculates buy-and-hold return', () => {
    expect(benchmarkReturn([100, 110, 120])).toBeCloseTo(0.20);
  });

  it('returns 0 for single price', () => {
    expect(benchmarkReturn([100])).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(benchmarkReturn([])).toBe(0);
  });
});

describe('trackingError', () => {
  it('returns 0 for identical series', () => {
    const r = [0.01, -0.02, 0.015];
    expect(trackingError(r, r)).toBeCloseTo(0);
  });

  it('returns positive for different series', () => {
    const a = [0.02, -0.01, 0.03];
    const b = [0.01, -0.02, 0.01];
    expect(trackingError(a, b)).toBeGreaterThan(0);
  });
});

describe('maxConsecutiveLosses', () => {
  it('finds longest losing streak', () => {
    const pnls = [10, -5, -3, -2, 20, -1, -4, 5];
    expect(maxConsecutiveLosses(pnls)).toBe(3); // -5, -3, -2
  });

  it('returns 0 for all wins', () => {
    expect(maxConsecutiveLosses([10, 20, 30])).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(maxConsecutiveLosses([])).toBe(0);
  });
});

describe('expectancy', () => {
  it('calculates expected value per trade', () => {
    // 60% win rate, avg win $200, avg loss $100
    // 0.6 * 200 - 0.4 * 100 = 120 - 40 = 80
    expect(expectancy(0.6, 200, 100)).toBeCloseTo(80);
  });

  it('returns negative for losing system', () => {
    // 30% win rate, avg win $100, avg loss $200
    expect(expectancy(0.3, 100, 200)).toBeLessThan(0);
  });
});
