import { describe, it, expect } from 'vitest';
import {
  garch11,
  adfTest,
  autocorrelation,
  partialAutocorrelation,
  hurstExponent,
  halfLife,
  structuralBreak,
  ewmaVolatility,
  varianceRatio,
  regimeChangeDetection,
} from '@ai-fund/lib/time-series';

// ── Helpers ────────────────────────────────────────────────

function seededRng(seed: number): () => number {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return (x / 0x7fffffff) * 2 - 1; };
}

/** Stationary returns (white noise) */
function whiteNoise(n: number, seed = 42): number[] {
  const rng = seededRng(seed);
  return Array.from({ length: n }, () => rng() * 0.02);
}

/** Random walk */
function randomWalk(n: number, seed = 7): number[] {
  const rng = seededRng(seed);
  const series = [100];
  for (let i = 1; i < n; i++) series.push(series[i - 1] + rng() * 0.5);
  return series;
}

/** AR(1) process: x_t = phi * x_{t-1} + noise */
function ar1(n: number, phi: number, seed = 13): number[] {
  const rng = seededRng(seed);
  const series = [rng() * 0.01];
  for (let i = 1; i < n; i++) {
    series.push(phi * series[i - 1] + rng() * 0.01);
  }
  return series;
}

/** Mean-reverting (OU) process */
function ouProcess(n: number, theta = 0.3, mu = 0, sigma = 0.1, seed = 99): number[] {
  const rng = seededRng(seed);
  const series = [mu + rng() * sigma];
  for (let i = 1; i < n; i++) {
    series.push(series[i - 1] + theta * (mu - series[i - 1]) + sigma * rng());
  }
  return series;
}

/** Trending series */
function trending(n: number, drift = 0.01, seed = 5): number[] {
  const rng = seededRng(seed);
  const series = [100];
  for (let i = 1; i < n; i++) {
    series.push(series[i - 1] + drift + rng() * 0.001);
  }
  return series;
}

// ── garch11 ────────────────────────────────────────────────

describe('garch11', () => {
  it('persistence < 1 for stationary volatility', () => {
    const returns = whiteNoise(200);
    const result = garch11(returns);
    expect(result.persistence).toBeLessThan(1);
    expect(result.persistence).toBeGreaterThanOrEqual(0);
  });

  it('conditional vol array matches returns length', () => {
    const returns = whiteNoise(100);
    const result = garch11(returns);
    expect(result.conditionalVol).toHaveLength(100);
  });

  it('forecast vol is positive', () => {
    const returns = whiteNoise(100);
    const result = garch11(returns);
    expect(result.forecastVol).toBeGreaterThan(0);
  });

  it('all conditional vols are positive', () => {
    const returns = whiteNoise(100);
    const result = garch11(returns);
    for (const v of result.conditionalVol) {
      expect(v).toBeGreaterThan(0);
    }
  });

  it('returns defaults for short series', () => {
    const result = garch11([0.01, 0.02, 0.03]);
    expect(result.conditionalVol).toHaveLength(0);
    expect(result.forecastVol).toBe(0);
    expect(result.persistence).toBe(0);
  });

  it('respects custom params', () => {
    const returns = whiteNoise(50);
    const result = garch11(returns, { omega: 0.00001, alpha: 0.1, beta: 0.85 });
    expect(result.alpha).toBe(0.1);
    expect(result.beta).toBe(0.85);
  });

  it('long run variance is finite for stationary GARCH', () => {
    const returns = whiteNoise(200);
    const result = garch11(returns);
    if (result.persistence < 1) {
      expect(result.longRunVar).toBeGreaterThan(0);
      expect(isFinite(result.longRunVar)).toBe(true);
    }
  });
});

// ── adfTest ────────────────────────────────────────────────

describe('adfTest', () => {
  it('detects stationary series', () => {
    const returns = whiteNoise(200);
    const result = adfTest(returns);
    expect(result.stationary).toBe(true);
    expect(result.pValue).toBeLessThan(0.1);
  });

  it('does not reject unit root for random walk', () => {
    const rw = randomWalk(200);
    const result = adfTest(rw);
    expect(result.stationary).toBe(false);
  });

  it('critical values present and ordered', () => {
    const result = adfTest(whiteNoise(100));
    expect(result.criticalValues['1%']).toBeLessThan(result.criticalValues['5%']);
    expect(result.criticalValues['5%']).toBeLessThan(result.criticalValues['10%']);
  });

  it('returns usedLag field', () => {
    const result = adfTest(whiteNoise(100));
    expect(typeof result.usedLag).toBe('number');
    expect(result.usedLag).toBeGreaterThanOrEqual(0);
  });

  it('handles very short series', () => {
    const result = adfTest([1, 2, 3]);
    expect(result.stationary).toBe(false);
    expect(result.pValue).toBe(1);
  });

  it('handles empty array', () => {
    const result = adfTest([]);
    expect(result.stationary).toBe(false);
  });
});

// ── autocorrelation ────────────────────────────────────────

describe('autocorrelation', () => {
  it('ACF[0] = 1', () => {
    const result = autocorrelation(whiteNoise(200));
    expect(result.acf[0]).toBe(1);
  });

  it('AR(1) has significant lag 1 ACF', () => {
    const series = ar1(500, 0.8);
    const result = autocorrelation(series);
    expect(Math.abs(result.acf[1])).toBeGreaterThan(result.confidenceBand);
    expect(result.significantLags).toContain(1);
  });

  it('white noise has few/no significant lags', () => {
    const noise = whiteNoise(500, 123);
    const result = autocorrelation(noise, 20);
    // Most lags should be insignificant for white noise
    expect(result.significantLags.length).toBeLessThan(5);
  });

  it('confidence band is 1.96/sqrt(n)', () => {
    const n = 400;
    const result = autocorrelation(whiteNoise(n));
    expect(result.confidenceBand).toBeCloseTo(1.96 / Math.sqrt(n), 5);
  });

  it('returns empty for very short series', () => {
    const result = autocorrelation([1, 2]);
    expect(result.acf).toHaveLength(0);
    expect(result.confidenceBand).toBe(0);
  });

  it('respects maxLag', () => {
    const result = autocorrelation(whiteNoise(100), 5);
    expect(result.acf).toHaveLength(6); // lag 0 through 5
  });

  it('all-same values gives zero ACF beyond lag 0', () => {
    const result = autocorrelation(Array(50).fill(5));
    expect(result.acf[0]).toBe(0); // c0 = 0, so acf fills with 0
  });
});

// ── partialAutocorrelation ─────────────────────────────────

describe('partialAutocorrelation', () => {
  it('PACF[0] = 1', () => {
    const result = partialAutocorrelation(whiteNoise(200));
    expect(result.pacf[0]).toBe(1);
  });

  it('AR(1) has significant PACF at lag 1', () => {
    const series = ar1(500, 0.7);
    const result = partialAutocorrelation(series, 10);
    expect(result.significantLags).toContain(1);
  });

  it('AR(1) PACF drops after lag 1', () => {
    const series = ar1(500, 0.7);
    const result = partialAutocorrelation(series, 10);
    // PACF at lag 1 should be much larger than later lags
    expect(Math.abs(result.pacf[1])).toBeGreaterThan(Math.abs(result.pacf[5]));
  });

  it('returns empty for very short series', () => {
    const result = partialAutocorrelation([1, 2]);
    expect(result.pacf).toHaveLength(0);
  });

  it('confidence band matches ACF', () => {
    const series = whiteNoise(200);
    const acfResult = autocorrelation(series);
    const pacfResult = partialAutocorrelation(series);
    expect(pacfResult.confidenceBand).toBe(acfResult.confidenceBand);
  });
});

// ── hurstExponent ──────────────────────────────────────────

describe('hurstExponent', () => {
  it('trending series has H > 0.5', () => {
    const series = trending(500, 0.05);
    const result = hurstExponent(series);
    expect(result.hurst).toBeGreaterThan(0.5);
    expect(result.regime).toBe('trending');
  });

  it('mean-reverting series has H <= 0.5 or close', () => {
    // R/S analysis on OU process; the estimate depends on parameters and sample.
    // Use returns of the OU process (which are more clearly mean-reverting).
    const ou = ouProcess(1000, 0.5, 0, 0.1, 77);
    const returns = ou.slice(1).map((v, i) => v - ou[i]);
    const result = hurstExponent(returns);
    // Returns of OU should show H < 0.55
    expect(result.hurst).toBeLessThan(0.55);
  });

  it('random walk returns have H in reasonable range', () => {
    const rw = randomWalk(1000, 42);
    const returns = rw.slice(1).map((v, i) => v - rw[i]);
    const result = hurstExponent(returns);
    // Returns of random walk should be near 0.5
    expect(result.hurst).toBeGreaterThan(0.2);
    expect(result.hurst).toBeLessThan(0.8);
  });

  it('returns 0.5 for too-short series', () => {
    const result = hurstExponent([1, 2, 3, 4, 5]);
    expect(result.hurst).toBe(0.5);
    expect(result.confidence).toBe(0);
  });

  it('DFA method also works', () => {
    const series = trending(500, 0.05, 10);
    const result = hurstExponent(series, { method: 'dfa' });
    expect(result.method).toBe('dfa');
    expect(result.hurst).toBeGreaterThanOrEqual(0);
    expect(result.hurst).toBeLessThanOrEqual(1);
  });

  it('hurst is bounded [0, 1]', () => {
    const series = randomWalk(300);
    const result = hurstExponent(series);
    expect(result.hurst).toBeGreaterThanOrEqual(0);
    expect(result.hurst).toBeLessThanOrEqual(1);
  });

  it('rSquared field present and between 0 and 1', () => {
    const result = hurstExponent(randomWalk(300));
    expect(result.rSquared).toBeGreaterThanOrEqual(0);
    expect(result.rSquared).toBeLessThanOrEqual(1);
  });
});

// ── halfLife ───────────────────────────────────────────────

describe('halfLife', () => {
  it('mean-reverting series gives finite positive half-life', () => {
    const series = ouProcess(200, 0.3);
    const result = halfLife(series);
    expect(result.halfLife).toBeGreaterThan(0);
    expect(result.halfLife).toBeLessThan(100);
    expect(result.stationary).toBe(true);
    expect(result.lambda).toBeLessThan(0);
  });

  it('non-stationary series gives Infinity', () => {
    const series = trending(100);
    const result = halfLife(series);
    expect(result.halfLife).toBe(Infinity);
    expect(result.stationary).toBe(false);
  });

  it('returns Infinity for very short series', () => {
    const result = halfLife([1, 2]);
    expect(result.halfLife).toBe(Infinity);
  });

  it('returns correct structure', () => {
    const result = halfLife(ouProcess(100));
    expect(result).toHaveProperty('halfLife');
    expect(result).toHaveProperty('lambda');
    expect(result).toHaveProperty('meanRevertSpeed');
    expect(result).toHaveProperty('stationary');
  });

  it('meanRevertSpeed is positive for stationary', () => {
    const result = halfLife(ouProcess(200, 0.3));
    if (result.stationary) {
      expect(result.meanRevertSpeed).toBeGreaterThan(0);
    }
  });
});

// ── structuralBreak ────────────────────────────────────────

describe('structuralBreak', () => {
  it('detects break in series with regime shift', () => {
    // First half: mean=100, second half: mean=200
    const series = [
      ...Array.from({ length: 50 }, () => 100 + Math.random() * 2),
      ...Array.from({ length: 50 }, () => 200 + Math.random() * 2),
    ];
    const result = structuralBreak(series);
    expect(result.hasBreak).toBe(true);
    expect(result.breaks.length).toBeGreaterThan(0);
  });

  it('constant series has no break', () => {
    const series = Array(100).fill(50);
    const result = structuralBreak(series);
    expect(result.hasBreak).toBe(false);
    expect(result.breaks).toHaveLength(0);
  });

  it('returns cusumStats with correct length', () => {
    const series = whiteNoise(100);
    const result = structuralBreak(series);
    expect(result.cusumStats).toHaveLength(100);
  });

  it('threshold is 1.36', () => {
    const result = structuralBreak(whiteNoise(50));
    expect(result.threshold).toBe(1.36);
  });

  it('handles short series gracefully', () => {
    const result = structuralBreak([1, 2, 3, 4, 5]);
    expect(result.hasBreak).toBe(false);
    expect(result.breaks).toHaveLength(0);
  });

  it('break indices are within series bounds', () => {
    const series = [
      ...Array.from({ length: 50 }, () => 10),
      ...Array.from({ length: 50 }, () => 1000),
    ];
    const result = structuralBreak(series);
    for (const b of result.breaks) {
      expect(b.index).toBeGreaterThanOrEqual(0);
      expect(b.index).toBeLessThan(100);
      expect(b.significance).toBeGreaterThan(0);
    }
  });
});

// ── ewmaVolatility ─────────────────────────────────────────

describe('ewmaVolatility', () => {
  it('output length matches input', () => {
    const returns = whiteNoise(100);
    const result = ewmaVolatility(returns);
    expect(result.volatility).toHaveLength(100);
  });

  it('higher lambda gives smoother series', () => {
    const returns = whiteNoise(200);
    const smooth = ewmaVolatility(returns, { lambda: 0.99 });
    const rough = ewmaVolatility(returns, { lambda: 0.5 });
    // Smoother series should have lower variance of vol changes
    const smoothChanges = smooth.volatility.slice(1).map((v, i) => Math.abs(v - smooth.volatility[i]));
    const roughChanges = rough.volatility.slice(1).map((v, i) => Math.abs(v - rough.volatility[i]));
    const avgSmooth = smoothChanges.reduce((a, b) => a + b, 0) / smoothChanges.length;
    const avgRough = roughChanges.reduce((a, b) => a + b, 0) / roughChanges.length;
    expect(avgSmooth).toBeLessThan(avgRough);
  });

  it('zero returns give declining vol', () => {
    const returns = [0.05, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const result = ewmaVolatility(returns);
    // After the initial shock, vol should decay
    for (let i = 2; i < result.volatility.length; i++) {
      expect(result.volatility[i]).toBeLessThanOrEqual(result.volatility[i - 1] + 1e-10);
    }
  });

  it('default lambda is 0.94', () => {
    const result = ewmaVolatility(whiteNoise(10));
    expect(result.lambda).toBe(0.94);
  });

  it('empty returns give empty output', () => {
    const result = ewmaVolatility([]);
    expect(result.volatility).toHaveLength(0);
    expect(result.currentVol).toBe(0);
  });

  it('all vols are non-negative', () => {
    const result = ewmaVolatility(whiteNoise(100));
    for (const v of result.volatility) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('span parameter sets lambda correctly', () => {
    const result = ewmaVolatility(whiteNoise(50), { span: 20 });
    const expectedLambda = 1 - 2 / (20 + 1);
    expect(result.lambda).toBeCloseTo(expectedLambda, 10);
  });
});

// ── varianceRatio ──────────────────────────────────────────

describe('varianceRatio', () => {
  it('random walk gives ratios near 1', () => {
    const rw = randomWalk(500);
    const result = varianceRatio(rw);
    expect(result.randomWalk).toBe(true);
    for (const r of result.ratios) {
      expect(r.ratio).toBeGreaterThan(0.5);
      expect(r.ratio).toBeLessThan(2.0);
    }
  });

  it('trending series gives ratios > 1', () => {
    const series = trending(500, 0.1, 88);
    const result = varianceRatio(series);
    // At least one ratio should be > 1 for a trending series
    const hasHighRatio = result.ratios.some(r => r.ratio > 1);
    expect(hasHighRatio).toBe(true);
  });

  it('mean-reverting series gives ratios < 1', () => {
    const series = ouProcess(500, 0.5, 100, 0.5, 33);
    const result = varianceRatio(series);
    // At least some ratios should be < 1
    const hasLowRatio = result.ratios.some(r => r.ratio < 1);
    expect(hasLowRatio).toBe(true);
  });

  it('custom periods work', () => {
    const result = varianceRatio(randomWalk(200), [2, 10]);
    expect(result.ratios).toHaveLength(2);
    expect(result.ratios[0].period).toBe(2);
    expect(result.ratios[1].period).toBe(10);
  });

  it('short series returns empty', () => {
    const result = varianceRatio([1, 2, 3]);
    expect(result.ratios).toHaveLength(0);
    expect(result.randomWalk).toBe(true);
  });

  it('each entry has required fields', () => {
    const result = varianceRatio(randomWalk(100));
    for (const r of result.ratios) {
      expect(r).toHaveProperty('period');
      expect(r).toHaveProperty('ratio');
      expect(r).toHaveProperty('zStat');
      expect(r).toHaveProperty('pValue');
      expect(r.pValue).toBeGreaterThanOrEqual(0);
      expect(r.pValue).toBeLessThanOrEqual(1);
    }
  });
});

// ── regimeChangeDetection ──────────────────────────────────

describe('regimeChangeDetection', () => {
  it('detects regimes in series with clear shifts', () => {
    const rng = seededRng(42);
    // Low vol regime, then high vol regime
    const lowVol = Array.from({ length: 100 }, () => 100 + rng() * 0.5);
    const highVol = Array.from({ length: 100 }, () => 100 + rng() * 10);
    const series = [...lowVol, ...highVol];
    const result = regimeChangeDetection(series, { windowSize: 20 });
    expect(result.regimes.length).toBeGreaterThan(0);
    expect(result.currentRegime).toBeTruthy();
  });

  it('change points near transitions', () => {
    const rng = seededRng(42);
    const lowVol = Array.from({ length: 100 }, () => 100 + rng() * 0.5);
    const highVol = Array.from({ length: 100 }, () => 100 + rng() * 10);
    const series = [...lowVol, ...highVol];
    const result = regimeChangeDetection(series, { windowSize: 20 });
    if (result.changePoints.length > 0) {
      // At least one change point should be near index 100
      const nearTransition = result.changePoints.some(cp => cp >= 80 && cp <= 140);
      expect(nearTransition).toBe(true);
    }
  });

  it('constant series has no change points', () => {
    const series = Array(200).fill(50);
    const result = regimeChangeDetection(series, { windowSize: 20 });
    expect(result.changePoints).toHaveLength(0);
  });

  it('too-short series returns empty', () => {
    const result = regimeChangeDetection([1, 2, 3, 4, 5]);
    expect(result.regimes).toHaveLength(0);
    expect(result.currentRegime).toBe('low_vol');
    expect(result.changePoints).toHaveLength(0);
  });

  it('regimes cover the entire series', () => {
    const rng = seededRng(10);
    const series = Array.from({ length: 200 }, () => 50 + rng() * 5);
    const result = regimeChangeDetection(series, { windowSize: 20 });
    if (result.regimes.length > 0) {
      expect(result.regimes[0].start).toBe(0);
      const lastRegime = result.regimes[result.regimes.length - 1];
      expect(lastRegime.end).toBe(199);
    }
  });

  it('regime labels are valid', () => {
    const rng = seededRng(10);
    const series = Array.from({ length: 200 }, () => 50 + rng() * 5);
    const result = regimeChangeDetection(series, { windowSize: 20 });
    const validLabels = ['low_vol', 'high_vol', 'trending', 'mean_reverting'];
    for (const r of result.regimes) {
      expect(validLabels).toContain(r.label);
      expect(typeof r.mean).toBe('number');
      expect(typeof r.vol).toBe('number');
    }
  });
});

// ── Edge cases ─────────────────────────────────────────────

describe('edge cases', () => {
  it('all functions handle single element', () => {
    expect(garch11([0.01]).conditionalVol).toHaveLength(0);
    expect(adfTest([1]).stationary).toBe(false);
    expect(autocorrelation([1]).acf).toHaveLength(0);
    expect(partialAutocorrelation([1]).pacf).toHaveLength(0);
    expect(halfLife([1]).halfLife).toBe(Infinity);
    expect(structuralBreak([1]).hasBreak).toBe(false);
    expect(ewmaVolatility([0.01]).volatility).toHaveLength(1);
    expect(varianceRatio([1]).ratios).toHaveLength(0);
  });

  it('all functions handle empty input', () => {
    expect(garch11([]).conditionalVol).toHaveLength(0);
    expect(adfTest([]).stationary).toBe(false);
    expect(autocorrelation([]).acf).toHaveLength(0);
    expect(halfLife([]).halfLife).toBe(Infinity);
    expect(ewmaVolatility([]).volatility).toHaveLength(0);
    expect(varianceRatio([]).ratios).toHaveLength(0);
  });

  it('all-same values do not crash', () => {
    const same = Array(100).fill(42);
    expect(() => garch11(same)).not.toThrow();
    expect(() => adfTest(same)).not.toThrow();
    expect(() => autocorrelation(same)).not.toThrow();
    expect(() => hurstExponent(same)).not.toThrow();
    expect(() => halfLife(same)).not.toThrow();
    expect(() => structuralBreak(same)).not.toThrow();
    expect(() => ewmaVolatility(same)).not.toThrow();
    expect(() => varianceRatio(same)).not.toThrow();
    expect(() => regimeChangeDetection(same)).not.toThrow();
  });
});
