import { describe, it, expect } from 'vitest';
import {
  kelly, fixedFractionalSize, valueAtRisk, maxDrawdown,
  sharpeRatio, sortinoRatio, calmarRatio,
  correlation, correlationMatrix,
  mean, standardDeviation, zScore, returns, winRate, profitFactor,
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
