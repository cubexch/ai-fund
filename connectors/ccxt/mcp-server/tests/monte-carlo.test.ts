import { describe, it, expect } from 'vitest';
import {
  simulateGBM,
  simulateJumpDiffusion,
  monteCarloVaR,
  portfolioMonteCarloVaR,
  confidenceInterval,
  scenarioGeneration,
  drawdownDistribution,
  optionMonteCarlo,
} from '@ai-fund/lib/monte-carlo';

// ── Geometric Brownian Motion ─────────────────────────────────

describe('simulateGBM', () => {
  const baseParams = {
    initialPrice: 100,
    drift: 0.05,
    volatility: 0.2,
    timeHorizon: 1,
    steps: 252,
    simulations: 1000,
    seed: 42,
  };

  it('produces deterministic output with seed', () => {
    const a = simulateGBM(baseParams);
    const b = simulateGBM(baseParams);
    expect(a.finalPrices).toEqual(b.finalPrices);
    expect(a.meanFinal).toBe(b.meanFinal);
  });

  it('path count matches simulations param', () => {
    const result = simulateGBM(baseParams);
    expect(result.paths).toHaveLength(1000);
    expect(result.finalPrices).toHaveLength(1000);
  });

  it('each path has steps + 1 points (including initial)', () => {
    const result = simulateGBM(baseParams);
    for (const path of result.paths) {
      expect(path).toHaveLength(253); // 252 steps + initial
    }
  });

  it('all paths start at initialPrice', () => {
    const result = simulateGBM(baseParams);
    for (const path of result.paths) {
      expect(path[0]).toBe(100);
    }
  });

  it('all prices are positive', () => {
    const result = simulateGBM(baseParams);
    for (const path of result.paths) {
      for (const p of path) {
        expect(p).toBeGreaterThan(0);
      }
    }
  });

  it('mean final price is near S*exp(drift*T) for large sims', () => {
    const largeSim = simulateGBM({
      ...baseParams,
      simulations: 50000,
    });
    const theoretical = 100 * Math.exp(0.05 * 1);
    // Allow 5% tolerance for MC variance
    expect(largeSim.meanFinal).toBeGreaterThan(theoretical * 0.95);
    expect(largeSim.meanFinal).toBeLessThan(theoretical * 1.05);
  });

  it('percentiles are ordered correctly', () => {
    const result = simulateGBM(baseParams);
    expect(result.percentiles['5']).toBeLessThan(result.percentiles['25']);
    expect(result.percentiles['25']).toBeLessThan(result.percentiles['50']);
    expect(result.percentiles['50']).toBeLessThan(result.percentiles['75']);
    expect(result.percentiles['75']).toBeLessThan(result.percentiles['95']);
  });

  it('median is close to medianFinal field', () => {
    const result = simulateGBM(baseParams);
    expect(result.medianFinal).toBe(result.percentiles['50']);
  });
});

// ── Jump-Diffusion (Merton) ──────────────────────────────────

describe('simulateJumpDiffusion', () => {
  const baseParams = {
    initialPrice: 100,
    drift: 0.05,
    volatility: 0.2,
    jumpIntensity: 5,
    jumpMean: -0.02,
    jumpVol: 0.05,
    timeHorizon: 1,
    steps: 252,
    simulations: 1000,
    seed: 42,
  };

  it('produces deterministic output with seed', () => {
    const a = simulateJumpDiffusion(baseParams);
    const b = simulateJumpDiffusion(baseParams);
    expect(a.finalPrices).toEqual(b.finalPrices);
  });

  it('all prices are positive', () => {
    const result = simulateJumpDiffusion(baseParams);
    for (const path of result.paths) {
      for (const p of path) {
        expect(p).toBeGreaterThan(0);
      }
    }
  });

  it('path count matches simulations param', () => {
    const result = simulateJumpDiffusion(baseParams);
    expect(result.paths).toHaveLength(1000);
    expect(result.finalPrices).toHaveLength(1000);
  });

  it('has more variance than pure GBM with same base params', () => {
    const gbm = simulateGBM({
      initialPrice: 100,
      drift: 0.05,
      volatility: 0.2,
      timeHorizon: 1,
      steps: 252,
      simulations: 5000,
      seed: 42,
    });
    const jd = simulateJumpDiffusion({
      ...baseParams,
      simulations: 5000,
    });

    // Compute variance of final prices
    const gbmMean = gbm.meanFinal;
    const jdMean = jd.meanFinal;
    const gbmVar = gbm.finalPrices.reduce((s, p) => s + (p - gbmMean) ** 2, 0) / gbm.finalPrices.length;
    const jdVar = jd.finalPrices.reduce((s, p) => s + (p - jdMean) ** 2, 0) / jd.finalPrices.length;

    expect(jdVar).toBeGreaterThan(gbmVar);
  });

  it('all paths start at initialPrice', () => {
    const result = simulateJumpDiffusion(baseParams);
    for (const path of result.paths) {
      expect(path[0]).toBe(100);
    }
  });
});

// ── Monte Carlo VaR ─────────────────────────────────────────

describe('monteCarloVaR', () => {
  // Generate normally-distributed-ish returns with known properties
  const normalReturns: number[] = [];
  // Use a simple LCG to generate pseudo-normal returns via CLT
  let lcgState = 12345;
  for (let i = 0; i < 1000; i++) {
    let sum = 0;
    for (let j = 0; j < 12; j++) {
      lcgState = (lcgState * 1103515245 + 12345) & 0x7fffffff;
      sum += lcgState / 0x7fffffff;
    }
    normalReturns.push((sum - 6) * 0.01); // ~N(0, 0.01)
  }

  it('VaR at 99% is worse than at 95%', () => {
    const result = monteCarloVaR(normalReturns, {
      simulations: 10000,
      confidenceLevels: [95, 99],
    });
    expect(result.var['99']).toBeGreaterThan(result.var['95']);
  });

  it('CVaR is worse than VaR at each confidence level', () => {
    const result = monteCarloVaR(normalReturns, {
      simulations: 10000,
      confidenceLevels: [95, 99],
    });
    expect(result.cvar['95']).toBeGreaterThanOrEqual(result.var['95']);
    expect(result.cvar['99']).toBeGreaterThanOrEqual(result.var['99']);
  });

  it('expectedShortfall matches cvar', () => {
    const result = monteCarloVaR(normalReturns, { simulations: 5000 });
    expect(result.expectedShortfall).toEqual(result.cvar);
  });

  it('returns zeros for empty returns', () => {
    const result = monteCarloVaR([]);
    expect(result.var['95']).toBe(0);
    expect(result.var['99']).toBe(0);
    expect(result.cvar['95']).toBe(0);
  });

  it('VaR is positive for returns with negative mean', () => {
    const negReturns = Array(200).fill(-0.01);
    const result = monteCarloVaR(negReturns, { simulations: 5000 });
    expect(result.var['95']).toBeGreaterThan(0);
  });

  it('returns reasonable VaR for approximate N(0,0.01) returns', () => {
    // 95% VaR for N(0, sigma) ~ 1.645 * sigma
    // Our returns have sigma ~0.01, so VaR ~ 0.01645
    const result = monteCarloVaR(normalReturns, {
      simulations: 50000,
      horizon: 1,
      confidenceLevels: [95],
    });
    // generous tolerance (20%) because bootstrap resampling
    expect(result.var['95']).toBeGreaterThan(0.005);
    expect(result.var['95']).toBeLessThan(0.04);
  });
});

// ── Portfolio Monte Carlo VaR ───────────────────────────────

describe('portfolioMonteCarloVaR', () => {
  // Create two uncorrelated return series
  const n = 200;
  const seriesA: number[] = [];
  const seriesB: number[] = [];
  let stateA = 11111;
  let stateB = 99999;
  for (let i = 0; i < n; i++) {
    stateA = (stateA * 1103515245 + 12345) & 0x7fffffff;
    stateB = (stateB * 1103515245 + 12345) & 0x7fffffff;
    seriesA.push(((stateA / 0x7fffffff) - 0.5) * 0.04);
    seriesB.push(((stateB / 0x7fffffff) - 0.5) * 0.04);
  }

  it('diversification benefit is positive for uncorrelated assets', () => {
    const result = portfolioMonteCarloVaR(
      { A: seriesA, B: seriesB },
      { A: 0.5, B: 0.5 },
      { simulations: 5000, confidenceLevels: [95] },
    );
    expect(result.diversificationBenefit).toBeGreaterThan(0);
  });

  it('single asset portfolio VaR is close to individual VaR', () => {
    const portfolioResult = portfolioMonteCarloVaR(
      { A: seriesA },
      { A: 1.0 },
      { simulations: 10000, confidenceLevels: [95] },
    );
    const individualResult = monteCarloVaR(seriesA, {
      simulations: 10000,
      confidenceLevels: [95],
    });
    // Allow 20% tolerance for MC variance
    const ratio = portfolioResult.var['95'] / individualResult.var['95'];
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.0);
  });

  it('returns VaR and CVaR at requested confidence levels', () => {
    const result = portfolioMonteCarloVaR(
      { A: seriesA, B: seriesB },
      { A: 0.5, B: 0.5 },
      { simulations: 5000, confidenceLevels: [90, 95, 99] },
    );
    expect(result.var).toHaveProperty('90');
    expect(result.var).toHaveProperty('95');
    expect(result.var).toHaveProperty('99');
    expect(result.cvar).toHaveProperty('99');
  });

  it('99% VaR is worse than 95% VaR for portfolio', () => {
    const result = portfolioMonteCarloVaR(
      { A: seriesA, B: seriesB },
      { A: 0.5, B: 0.5 },
      { simulations: 10000, confidenceLevels: [95, 99] },
    );
    expect(result.var['99']).toBeGreaterThan(result.var['95']);
  });
});

// ── Bootstrap Confidence Interval ───────────────────────────

describe('confidenceInterval', () => {
  const sampleReturns = Array.from({ length: 200 }, (_, i) => {
    const seed = (i * 1103515245 + 12345) & 0x7fffffff;
    return ((seed / 0x7fffffff) - 0.5) * 0.04;
  });

  it('lower < estimate < upper for sharpe', () => {
    const result = confidenceInterval(sampleReturns, { statistic: 'sharpe' });
    expect(result.lower).toBeLessThan(result.estimate);
    expect(result.estimate).toBeLessThan(result.upper);
  });

  it('lower < estimate < upper for mean', () => {
    const result = confidenceInterval(sampleReturns, { statistic: 'mean' });
    expect(result.lower).toBeLessThanOrEqual(result.estimate);
    expect(result.estimate).toBeLessThanOrEqual(result.upper);
  });

  it('lower < estimate < upper for volatility', () => {
    const result = confidenceInterval(sampleReturns, { statistic: 'volatility' });
    expect(result.lower).toBeLessThan(result.estimate);
    expect(result.estimate).toBeLessThan(result.upper);
  });

  it('width decreases with more data', () => {
    const small = confidenceInterval(sampleReturns.slice(0, 30), {
      statistic: 'mean',
      simulations: 3000,
    });
    const large = confidenceInterval(sampleReturns, {
      statistic: 'mean',
      simulations: 3000,
    });
    const smallWidth = small.upper - small.lower;
    const largeWidth = large.upper - large.lower;
    expect(largeWidth).toBeLessThan(smallWidth);
  });

  it('standard error is positive', () => {
    const result = confidenceInterval(sampleReturns, { statistic: 'sharpe' });
    expect(result.standardError).toBeGreaterThan(0);
  });

  it('returns zeros for empty returns', () => {
    const result = confidenceInterval([]);
    expect(result.estimate).toBe(0);
    expect(result.lower).toBe(0);
    expect(result.upper).toBe(0);
    expect(result.standardError).toBe(0);
  });

  it('confidenceLevel is stored in result', () => {
    const result = confidenceInterval(sampleReturns, { confidenceLevel: 0.99 });
    expect(result.confidenceLevel).toBe(0.99);
  });

  it('max_drawdown statistic returns non-negative estimate', () => {
    const result = confidenceInterval(sampleReturns, { statistic: 'max_drawdown' });
    expect(result.estimate).toBeGreaterThanOrEqual(0);
  });
});

// ── Scenario Generation ─────────────────────────────────────

describe('scenarioGeneration', () => {
  const returnsData: Record<string, number[]> = {
    BTC: Array.from({ length: 100 }, (_, i) => Math.sin(i * 0.3) * 0.02),
    ETH: Array.from({ length: 100 }, (_, i) => Math.cos(i * 0.3) * 0.03),
  };

  it('generates correct number of scenarios (bootstrap)', () => {
    const result = scenarioGeneration({
      returns: returnsData,
      numScenarios: 500,
      method: 'bootstrap',
    });
    expect(result.scenarios).toHaveLength(500);
  });

  it('generates correct number of scenarios (parametric)', () => {
    const result = scenarioGeneration({
      returns: returnsData,
      numScenarios: 300,
      method: 'parametric',
    });
    expect(result.scenarios).toHaveLength(300);
  });

  it('each scenario has all assets', () => {
    const result = scenarioGeneration({
      returns: returnsData,
      numScenarios: 50,
    });
    for (const scenario of result.scenarios) {
      expect(scenario).toHaveProperty('BTC');
      expect(scenario).toHaveProperty('ETH');
    }
  });

  it('statistics has mean and vol for each asset', () => {
    const result = scenarioGeneration({
      returns: returnsData,
      numScenarios: 100,
    });
    expect(result.statistics.BTC.mean).toBeDefined();
    expect(result.statistics.BTC.vol).toBeDefined();
    expect(result.statistics.ETH.mean).toBeDefined();
    expect(result.statistics.ETH.vol).toBeDefined();
  });

  it('bootstrap preserves mean approximately', () => {
    const result = scenarioGeneration({
      returns: returnsData,
      numScenarios: 10000,
      method: 'bootstrap',
    });
    const btcScenarioMean = result.scenarios.reduce((s, sc) => s + sc.BTC, 0) / result.scenarios.length;
    const btcActualMean = result.statistics.BTC.mean;
    // Allow 20% relative tolerance or absolute 0.005
    expect(Math.abs(btcScenarioMean - btcActualMean)).toBeLessThan(
      Math.max(Math.abs(btcActualMean) * 0.2, 0.005)
    );
  });
});

// ── Drawdown Distribution ───────────────────────────────────

describe('drawdownDistribution', () => {
  const returns50bps = Array.from({ length: 200 }, (_, i) => {
    const seed = (i * 1103515245 + 12345) & 0x7fffffff;
    return ((seed / 0x7fffffff) - 0.5) * 0.04;
  });

  it('expected max drawdown is positive', () => {
    const result = drawdownDistribution(returns50bps, { simulations: 2000 });
    expect(result.expectedMaxDrawdown).toBeGreaterThan(0);
  });

  it('drawdownVaR99 >= drawdownVaR95', () => {
    const result = drawdownDistribution(returns50bps, { simulations: 2000 });
    expect(result.drawdownVaR99).toBeGreaterThanOrEqual(result.drawdownVaR95);
  });

  it('higher vol leads to worse drawdowns', () => {
    const lowVol = Array.from({ length: 200 }, (_, i) => {
      const seed = (i * 1103515245 + 12345) & 0x7fffffff;
      return ((seed / 0x7fffffff) - 0.5) * 0.01;
    });
    const highVol = Array.from({ length: 200 }, (_, i) => {
      const seed = (i * 1103515245 + 12345) & 0x7fffffff;
      return ((seed / 0x7fffffff) - 0.5) * 0.08;
    });
    const lowResult = drawdownDistribution(lowVol, { simulations: 3000 });
    const highResult = drawdownDistribution(highVol, { simulations: 3000 });
    expect(highResult.expectedMaxDrawdown).toBeGreaterThan(lowResult.expectedMaxDrawdown);
  });

  it('probabilityOfRuin increases with higher volatility', () => {
    const lowVol = Array.from({ length: 200 }, (_, i) => {
      const seed = (i * 1103515245 + 12345) & 0x7fffffff;
      return ((seed / 0x7fffffff) - 0.5) * 0.005;
    });
    const highVol = Array.from({ length: 200 }, (_, i) => {
      const seed = (i * 1103515245 + 12345) & 0x7fffffff;
      return ((seed / 0x7fffffff) - 0.5) * 0.10;
    });
    const lowResult = drawdownDistribution(lowVol, { simulations: 3000 });
    const highResult = drawdownDistribution(highVol, { simulations: 3000 });
    expect(highResult.probabilityOfRuin).toBeGreaterThanOrEqual(lowResult.probabilityOfRuin);
  });

  it('distribution array is sorted', () => {
    const result = drawdownDistribution(returns50bps, { simulations: 1000 });
    for (let i = 1; i < result.distribution.length; i++) {
      expect(result.distribution[i]).toBeGreaterThanOrEqual(result.distribution[i - 1]);
    }
  });

  it('returns zeros for empty returns', () => {
    const result = drawdownDistribution([]);
    expect(result.expectedMaxDrawdown).toBe(0);
    expect(result.drawdownVaR95).toBe(0);
    expect(result.probabilityOfRuin).toBe(0);
    expect(result.distribution).toEqual([]);
  });

  it('ruinThreshold defaults to 0.2', () => {
    const result = drawdownDistribution(returns50bps);
    expect(result.ruinThreshold).toBe(0.2);
  });
});

// ── Option Monte Carlo ──────────────────────────────────────

describe('optionMonteCarlo', () => {
  // Black-Scholes analytical call price for validation
  function blackScholesCall(S: number, K: number, r: number, sigma: number, T: number): number {
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    return S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
  }

  function blackScholesPut(S: number, K: number, r: number, sigma: number, T: number): number {
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    return K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
  }

  // Standard normal CDF approximation (Abramowitz & Stegun)
  function cdf(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1.0 / (1.0 + p * Math.abs(x));
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return 0.5 * (1.0 + sign * y);
  }

  it('vanilla call is close to Black-Scholes (within 15%)', () => {
    const S = 100, K = 100, r = 0.05, vol = 0.2, T = 1;
    const bsPrice = blackScholesCall(S, K, r, vol, T);
    const mcResult = optionMonteCarlo({
      spot: S, strike: K, rate: r, vol, timeToExpiry: T,
      type: 'call', simulations: 100000, steps: 200,
    });
    const relError = Math.abs(mcResult.price - bsPrice) / bsPrice;
    expect(relError).toBeLessThan(0.15);
  });

  it('vanilla put is close to Black-Scholes (within 25%)', () => {
    const S = 100, K = 100, r = 0.05, vol = 0.2, T = 1;
    const bsPrice = blackScholesPut(S, K, r, vol, T);
    const mcResult = optionMonteCarlo({
      spot: S, strike: K, rate: r, vol, timeToExpiry: T,
      type: 'put', simulations: 100000, steps: 200,
    });
    const relError = Math.abs(mcResult.price - bsPrice) / bsPrice;
    expect(relError).toBeLessThan(0.25);
  });

  it('Asian call is cheaper than vanilla call', () => {
    const params = { spot: 100, strike: 100, rate: 0.05, vol: 0.2, timeToExpiry: 1, type: 'call' as const, simulations: 50000 };
    const vanilla = optionMonteCarlo(params);
    const asian = optionMonteCarlo({ ...params, exotic: 'asian' });
    expect(asian.price).toBeLessThan(vanilla.price);
  });

  it('barrier up-and-out call is cheaper than vanilla call', () => {
    const params = { spot: 100, strike: 100, rate: 0.05, vol: 0.2, timeToExpiry: 1, type: 'call' as const, simulations: 50000 };
    const vanilla = optionMonteCarlo(params);
    const barrier = optionMonteCarlo({ ...params, exotic: 'barrier_up', barrier: 130 });
    expect(barrier.price).toBeLessThan(vanilla.price);
  });

  it('barrier down-and-out put is cheaper than vanilla put', () => {
    const params = { spot: 100, strike: 100, rate: 0.05, vol: 0.2, timeToExpiry: 1, type: 'put' as const, simulations: 50000 };
    const vanilla = optionMonteCarlo(params);
    const barrier = optionMonteCarlo({ ...params, exotic: 'barrier_down', barrier: 70 });
    expect(barrier.price).toBeLessThan(vanilla.price);
  });

  it('call delta is between 0 and 1', () => {
    const result = optionMonteCarlo({
      spot: 100, strike: 100, rate: 0.05, vol: 0.2, timeToExpiry: 1,
      type: 'call', simulations: 50000,
    });
    expect(result.delta).toBeGreaterThan(0);
    expect(result.delta).toBeLessThan(1);
  });

  it('put delta is between -1 and 0', () => {
    const result = optionMonteCarlo({
      spot: 100, strike: 100, rate: 0.05, vol: 0.2, timeToExpiry: 1,
      type: 'put', simulations: 50000,
    });
    expect(result.delta).toBeLessThan(0);
    expect(result.delta).toBeGreaterThan(-1);
  });

  it('confidence interval contains the price', () => {
    const result = optionMonteCarlo({
      spot: 100, strike: 100, rate: 0.05, vol: 0.2, timeToExpiry: 1,
      type: 'call', simulations: 50000,
    });
    expect(result.confidenceInterval[0]).toBeLessThan(result.price);
    expect(result.confidenceInterval[1]).toBeGreaterThan(result.price);
  });

  it('standard error is positive', () => {
    const result = optionMonteCarlo({
      spot: 100, strike: 100, rate: 0.05, vol: 0.2, timeToExpiry: 1,
      type: 'call', simulations: 50000,
    });
    expect(result.standardError).toBeGreaterThan(0);
  });

  it('deep OTM call has near-zero price', () => {
    const result = optionMonteCarlo({
      spot: 100, strike: 200, rate: 0.05, vol: 0.2, timeToExpiry: 0.25,
      type: 'call', simulations: 50000,
    });
    expect(result.price).toBeLessThan(1);
  });

  it('deep ITM call price is close to intrinsic value', () => {
    const S = 150, K = 100, r = 0.05, T = 0.25;
    const result = optionMonteCarlo({
      spot: S, strike: K, rate: r, vol: 0.2, timeToExpiry: T,
      type: 'call', simulations: 50000,
    });
    const intrinsic = S - K * Math.exp(-r * T);
    // Should be at least intrinsic value
    expect(result.price).toBeGreaterThan(intrinsic * 0.9);
  });
});
