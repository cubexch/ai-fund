/**
 * Monte Carlo simulation library for trading skills.
 * GBM, jump-diffusion, VaR, portfolio VaR, bootstrap CI, scenario generation,
 * drawdown distribution, and option pricing.
 */

import { mean, standardDeviation, returns, maxDrawdown } from './math.js';

// ── Types ─────────────────────────────────────────────────

export interface SimulationResult {
  paths: number[][];
  finalPrices: number[];
  meanFinal: number;
  medianFinal: number;
  percentiles: Record<string, number>;
}

export interface VaRResult {
  var: Record<string, number>;
  cvar: Record<string, number>;
  expectedShortfall: Record<string, number>;
}

export interface PortfolioVaRResult extends VaRResult {
  diversificationBenefit: number;
}

export interface ConfidenceIntervalResult {
  estimate: number;
  lower: number;
  upper: number;
  standardError: number;
  confidenceLevel: number;
}

export interface ScenarioResult {
  scenarios: Array<Record<string, number>>;
  statistics: Record<string, { mean: number; vol: number }>;
}

export interface DrawdownDistributionResult {
  expectedMaxDrawdown: number;
  drawdownVaR95: number;
  drawdownVaR99: number;
  distribution: number[];
  probabilityOfRuin: number;
  ruinThreshold: number;
}

export interface OptionPricingResult {
  price: number;
  standardError: number;
  confidenceInterval: [number, number];
  delta: number;
}

// ── PRNG (xorshift128) ───────────────────────────────────

class Xorshift128 {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    // Initialize state from seed using splitmix32
    this.s0 = this.splitmix32(seed);
    this.s1 = this.splitmix32(this.s0);
    this.s2 = this.splitmix32(this.s1);
    this.s3 = this.splitmix32(this.s2);
  }

  private splitmix32(state: number): number {
    state |= 0;
    state = (state + 0x9e3779b9) | 0;
    let t = state ^ (state >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0);
  }

  /** Returns uniform random in [0, 1) */
  next(): number {
    const t = this.s3;
    let s = this.s0;
    this.s3 = this.s2;
    this.s2 = this.s1;
    this.s1 = s;
    s ^= s << 11;
    s ^= s >>> 8;
    this.s0 = s ^ t ^ (t >>> 19);
    return (this.s0 >>> 0) / 4294967296;
  }
}

// ── Random Variate Generation ────────────────────────────

function boxMuller(rng: Xorshift128): number {
  let u1 = rng.next();
  while (u1 === 0) u1 = rng.next();
  const u2 = rng.next();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function normalRandom(rng: Xorshift128, mu: number = 0, sigma: number = 1): number {
  return mu + sigma * boxMuller(rng);
}

// ── Cholesky Decomposition ───────────────────────────────

function choleskyDecomposition(matrix: number[][]): number[][] {
  const n = matrix.length;
  const L: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }
      if (i === j) {
        const val = matrix[i][i] - sum;
        L[i][j] = Math.sqrt(Math.max(0, val));
      } else {
        L[i][j] = L[j][j] === 0 ? 0 : (matrix[i][j] - sum) / L[j][j];
      }
    }
  }

  return L;
}

// ── Helpers ──────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function median(sorted: number[]): number {
  return percentile(sorted, 50);
}

function computePercentiles(values: number[]): Record<string, number> {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    '5': percentile(sorted, 5),
    '25': percentile(sorted, 25),
    '50': percentile(sorted, 50),
    '75': percentile(sorted, 75),
    '95': percentile(sorted, 95),
  };
}

function buildSimulationResult(paths: number[][], finalPrices: number[]): SimulationResult {
  const sorted = [...finalPrices].sort((a, b) => a - b);
  return {
    paths,
    finalPrices,
    meanFinal: mean(finalPrices),
    medianFinal: median(sorted),
    percentiles: computePercentiles(finalPrices),
  };
}

function makeRng(seed?: number): Xorshift128 {
  return new Xorshift128(seed ?? (Date.now() ^ (Math.random() * 0xffffffff)));
}

// ── Correlation Matrix from Returns ──────────────────────

function computeCorrelationMatrix(series: number[][]): number[][] {
  const n = series.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const means = series.map(s => mean(s));
  const stds = series.map(s => standardDeviation(s));

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
      } else {
        const len = Math.min(series[i].length, series[j].length);
        let sum = 0;
        for (let k = 0; k < len; k++) {
          sum += (series[i][k] - means[i]) * (series[j][k] - means[j]);
        }
        const corr = (stds[i] === 0 || stds[j] === 0) ? 0 : sum / ((len - 1) * stds[i] * stds[j]);
        matrix[i][j] = corr;
        matrix[j][i] = corr;
      }
    }
  }

  return matrix;
}

// ── 1. Geometric Brownian Motion ─────────────────────────

/**
 * Simulate price paths using Geometric Brownian Motion.
 * dS = μ·S·dt + σ·S·dW
 */
export function simulateGBM(params: {
  initialPrice: number;
  drift: number;
  volatility: number;
  timeHorizon: number;
  steps: number;
  simulations: number;
  seed?: number;
}): SimulationResult {
  const { initialPrice, drift, volatility, timeHorizon, steps, simulations, seed } = params;
  const dt = timeHorizon / steps;
  const sqrtDt = Math.sqrt(dt);
  const rng = makeRng(seed);

  const paths: number[][] = [];
  const finalPrices: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    const path: number[] = [initialPrice];
    let price = initialPrice;

    for (let t = 0; t < steps; t++) {
      const z = boxMuller(rng);
      price = price * Math.exp((drift - 0.5 * volatility * volatility) * dt + volatility * sqrtDt * z);
      path.push(price);
    }

    paths.push(path);
    finalPrices.push(price);
  }

  return buildSimulationResult(paths, finalPrices);
}

// ── 2. Jump-Diffusion (Merton) ───────────────────────────

/**
 * Simulate price paths using Merton's jump-diffusion model.
 * dS = (μ - λ·k)·S·dt + σ·S·dW + J·S·dN
 * where J ~ LogNormal(jumpMean, jumpVol), N ~ Poisson(jumpIntensity)
 */
export function simulateJumpDiffusion(params: {
  initialPrice: number;
  drift: number;
  volatility: number;
  jumpIntensity: number;
  jumpMean: number;
  jumpVol: number;
  timeHorizon: number;
  steps: number;
  simulations: number;
  seed?: number;
}): SimulationResult {
  const {
    initialPrice, drift, volatility,
    jumpIntensity, jumpMean, jumpVol,
    timeHorizon, steps, simulations, seed,
  } = params;
  const dt = timeHorizon / steps;
  const sqrtDt = Math.sqrt(dt);
  const rng = makeRng(seed);
  // Compensator: k = E[e^J - 1]
  const k = Math.exp(jumpMean + 0.5 * jumpVol * jumpVol) - 1;

  const paths: number[][] = [];
  const finalPrices: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    const path: number[] = [initialPrice];
    let price = initialPrice;

    for (let t = 0; t < steps; t++) {
      const z = boxMuller(rng);
      // Poisson number of jumps in dt
      const lambda = jumpIntensity * dt;
      let numJumps = 0;
      let p = Math.exp(-lambda);
      let cumP = p;
      const u = rng.next();
      while (u > cumP) {
        numJumps++;
        p *= lambda / numJumps;
        cumP += p;
      }

      let jumpComponent = 0;
      for (let j = 0; j < numJumps; j++) {
        jumpComponent += normalRandom(rng, jumpMean, jumpVol);
      }

      const diffusion = (drift - jumpIntensity * k - 0.5 * volatility * volatility) * dt + volatility * sqrtDt * z;
      price = price * Math.exp(diffusion + jumpComponent);
      path.push(price);
    }

    paths.push(path);
    finalPrices.push(price);
  }

  return buildSimulationResult(paths, finalPrices);
}

// ── 3. Monte Carlo VaR ───────────────────────────────────

/**
 * Monte Carlo Value at Risk and Conditional VaR via bootstrap resampling.
 * Resamples from historical returns to build simulated P&L distribution.
 */
export function monteCarloVaR(
  historicalReturns: number[],
  params?: {
    simulations?: number;
    horizon?: number;
    confidenceLevels?: number[];
  }
): VaRResult {
  const simulations = params?.simulations ?? 10000;
  const horizon = params?.horizon ?? 1;
  const confidenceLevels = params?.confidenceLevels ?? [95, 99];
  const rng = makeRng(42);

  if (historicalReturns.length === 0) {
    const empty: Record<string, number> = {};
    for (const cl of confidenceLevels) {
      empty[String(cl)] = 0;
    }
    return { var: { ...empty }, cvar: { ...empty }, expectedShortfall: { ...empty } };
  }

  // Simulate cumulative returns over horizon
  const simReturns: number[] = [];
  for (let i = 0; i < simulations; i++) {
    let cumReturn = 1;
    for (let d = 0; d < horizon; d++) {
      const idx = Math.floor(rng.next() * historicalReturns.length);
      cumReturn *= (1 + historicalReturns[idx]);
    }
    simReturns.push(cumReturn - 1);
  }

  const sorted = [...simReturns].sort((a, b) => a - b);

  const varResult: Record<string, number> = {};
  const cvarResult: Record<string, number> = {};

  for (const cl of confidenceLevels) {
    const idx = Math.floor((1 - cl / 100) * sorted.length);
    const varValue = -sorted[idx];
    varResult[String(cl)] = varValue;

    // CVaR = mean of losses beyond VaR
    const tail = sorted.slice(0, idx + 1);
    const cvar = tail.length > 0 ? -mean(tail) : varValue;
    cvarResult[String(cl)] = cvar;
  }

  return {
    var: varResult,
    cvar: cvarResult,
    expectedShortfall: { ...cvarResult },
  };
}

// ── 4. Portfolio Monte Carlo VaR ─────────────────────────

/**
 * Portfolio Monte Carlo VaR with correlated multivariate simulation.
 * Uses Cholesky decomposition to generate correlated returns.
 */
export function portfolioMonteCarloVaR(
  returnsSeries: Record<string, number[]>,
  weights: Record<string, number>,
  params?: {
    simulations?: number;
    horizon?: number;
    confidenceLevels?: number[];
  }
): PortfolioVaRResult {
  const simulations = params?.simulations ?? 10000;
  const horizon = params?.horizon ?? 1;
  const confidenceLevels = params?.confidenceLevels ?? [95, 99];
  const rng = makeRng(42);

  const assets = Object.keys(returnsSeries);
  const n = assets.length;
  const series = assets.map(a => returnsSeries[a]);
  const assetWeights = assets.map(a => weights[a] ?? 0);
  const assetMeans = series.map(s => mean(s));
  const assetStds = series.map(s => standardDeviation(s));

  // Correlation matrix and Cholesky
  const corrMatrix = computeCorrelationMatrix(series);
  const L = choleskyDecomposition(corrMatrix);

  // Simulate portfolio returns
  const portfolioReturns: number[] = [];
  for (let sim = 0; sim < simulations; sim++) {
    let cumReturn = 0;
    for (let d = 0; d < horizon; d++) {
      // Generate correlated normals
      const z: number[] = [];
      for (let i = 0; i < n; i++) z.push(boxMuller(rng));
      const correlated: number[] = [];
      for (let i = 0; i < n; i++) {
        let val = 0;
        for (let j = 0; j <= i; j++) {
          val += L[i][j] * z[j];
        }
        correlated.push(assetMeans[i] + assetStds[i] * val);
      }

      let dayReturn = 0;
      for (let i = 0; i < n; i++) {
        dayReturn += assetWeights[i] * correlated[i];
      }
      cumReturn = (1 + cumReturn) * (1 + dayReturn) - 1;
    }
    portfolioReturns.push(cumReturn);
  }

  const sorted = [...portfolioReturns].sort((a, b) => a - b);

  const varResult: Record<string, number> = {};
  const cvarResult: Record<string, number> = {};

  for (const cl of confidenceLevels) {
    const idx = Math.floor((1 - cl / 100) * sorted.length);
    varResult[String(cl)] = -sorted[idx];
    const tail = sorted.slice(0, idx + 1);
    cvarResult[String(cl)] = tail.length > 0 ? -mean(tail) : -sorted[idx];
  }

  // Diversification benefit: sum of individual VaRs vs portfolio VaR
  let undiversifiedVar = 0;
  for (let i = 0; i < n; i++) {
    const indivVaR = monteCarloVaR(series[i], { simulations: 1000, horizon, confidenceLevels: [95] });
    undiversifiedVar += Math.abs(assetWeights[i]) * indivVaR.var['95'];
  }

  const portfolioVar95 = varResult['95'] ?? Object.values(varResult)[0] ?? 0;
  const divBenefit = undiversifiedVar === 0 ? 0 : 1 - portfolioVar95 / undiversifiedVar;

  return {
    var: varResult,
    cvar: cvarResult,
    expectedShortfall: { ...cvarResult },
    diversificationBenefit: Math.max(0, divBenefit),
  };
}

// ── 5. Bootstrap Confidence Interval ─────────────────────

/**
 * Bootstrap confidence interval for a given statistic.
 * Resamples returns with replacement and computes the statistic each time.
 */
export function confidenceInterval(
  historicalReturns: number[],
  params?: {
    simulations?: number;
    statistic?: 'sharpe' | 'mean' | 'max_drawdown' | 'volatility';
    confidenceLevel?: number;
  }
): ConfidenceIntervalResult {
  const simulations = params?.simulations ?? 5000;
  const statistic = params?.statistic ?? 'sharpe';
  const confidenceLevel = params?.confidenceLevel ?? 0.95;
  const rng = makeRng(42);

  if (historicalReturns.length === 0) {
    return { estimate: 0, lower: 0, upper: 0, standardError: 0, confidenceLevel };
  }

  const computeStat = (data: number[]): number => {
    switch (statistic) {
      case 'mean':
        return mean(data);
      case 'volatility':
        return standardDeviation(data);
      case 'max_drawdown': {
        // Build equity curve from returns
        const values: number[] = [1];
        for (const r of data) values.push(values[values.length - 1] * (1 + r));
        return maxDrawdown(values).maxDrawdown;
      }
      case 'sharpe': {
        const m = mean(data);
        const s = standardDeviation(data);
        return s === 0 ? 0 : (m / s) * Math.sqrt(365);
      }
    }
  };

  const pointEstimate = computeStat(historicalReturns);

  const bootstrapStats: number[] = [];
  for (let i = 0; i < simulations; i++) {
    const sample: number[] = [];
    for (let j = 0; j < historicalReturns.length; j++) {
      const idx = Math.floor(rng.next() * historicalReturns.length);
      sample.push(historicalReturns[idx]);
    }
    bootstrapStats.push(computeStat(sample));
  }

  const sorted = [...bootstrapStats].sort((a, b) => a - b);
  const alpha = 1 - confidenceLevel;
  const lowerIdx = Math.floor((alpha / 2) * sorted.length);
  const upperIdx = Math.floor((1 - alpha / 2) * sorted.length);

  return {
    estimate: pointEstimate,
    lower: sorted[lowerIdx],
    upper: sorted[Math.min(upperIdx, sorted.length - 1)],
    standardError: standardDeviation(bootstrapStats),
    confidenceLevel,
  };
}

// ── 6. Scenario Generation ───────────────────────────────

/**
 * Generate correlated multi-asset scenarios via bootstrap or parametric methods.
 */
export function scenarioGeneration(params: {
  returns: Record<string, number[]>;
  numScenarios: number;
  method?: 'bootstrap' | 'parametric';
}): ScenarioResult {
  const { returns: returnData, numScenarios, method = 'bootstrap' } = params;
  const rng = makeRng(42);
  const assets = Object.keys(returnData);

  const statistics: Record<string, { mean: number; vol: number }> = {};
  for (const asset of assets) {
    statistics[asset] = {
      mean: mean(returnData[asset]),
      vol: standardDeviation(returnData[asset]),
    };
  }

  const scenarios: Array<Record<string, number>> = [];

  if (method === 'bootstrap') {
    // Synchronized bootstrap: pick same time index for all assets to preserve correlation
    const minLen = Math.min(...assets.map(a => returnData[a].length));
    for (let i = 0; i < numScenarios; i++) {
      const idx = Math.floor(rng.next() * minLen);
      const scenario: Record<string, number> = {};
      for (const asset of assets) {
        scenario[asset] = returnData[asset][idx];
      }
      scenarios.push(scenario);
    }
  } else {
    // Parametric: correlated normals via Cholesky
    const series = assets.map(a => returnData[a]);
    const corrMatrix = computeCorrelationMatrix(series);
    const L = choleskyDecomposition(corrMatrix);
    const means = assets.map(a => statistics[a].mean);
    const stds = assets.map(a => statistics[a].vol);

    for (let i = 0; i < numScenarios; i++) {
      const z: number[] = [];
      for (let j = 0; j < assets.length; j++) z.push(boxMuller(rng));
      const scenario: Record<string, number> = {};
      for (let j = 0; j < assets.length; j++) {
        let val = 0;
        for (let k = 0; k <= j; k++) {
          val += L[j][k] * z[k];
        }
        scenario[assets[j]] = means[j] + stds[j] * val;
      }
      scenarios.push(scenario);
    }
  }

  return { scenarios, statistics };
}

// ── 7. Drawdown Distribution ─────────────────────────────

/**
 * Simulate the distribution of max drawdowns via bootstrap.
 * Estimates expected max drawdown, VaR of drawdowns, and probability of ruin.
 */
export function drawdownDistribution(
  historicalReturns: number[],
  params?: {
    simulations?: number;
    horizon?: number;
  }
): DrawdownDistributionResult {
  const simulations = params?.simulations ?? 5000;
  const horizon = params?.horizon ?? historicalReturns.length;
  const ruinThreshold = 0.2;
  const rng = makeRng(42);

  if (historicalReturns.length === 0) {
    return {
      expectedMaxDrawdown: 0,
      drawdownVaR95: 0,
      drawdownVaR99: 0,
      distribution: [],
      probabilityOfRuin: 0,
      ruinThreshold,
    };
  }

  const drawdowns: number[] = [];
  let ruinCount = 0;

  for (let sim = 0; sim < simulations; sim++) {
    const values: number[] = [1];
    for (let t = 0; t < horizon; t++) {
      const idx = Math.floor(rng.next() * historicalReturns.length);
      values.push(values[values.length - 1] * (1 + historicalReturns[idx]));
    }
    const dd = maxDrawdown(values).maxDrawdown;
    drawdowns.push(dd);
    if (dd >= ruinThreshold) ruinCount++;
  }

  const sorted = [...drawdowns].sort((a, b) => a - b);

  return {
    expectedMaxDrawdown: mean(drawdowns),
    drawdownVaR95: percentile(sorted, 95),
    drawdownVaR99: percentile(sorted, 99),
    distribution: sorted,
    probabilityOfRuin: ruinCount / simulations,
    ruinThreshold,
  };
}

// ── 8. Monte Carlo Option Pricing ────────────────────────

/**
 * Monte Carlo option pricing for vanilla and exotic options.
 * Supports Asian and barrier options via the `exotic` parameter.
 */
export function optionMonteCarlo(params: {
  spot: number;
  strike: number;
  rate: number;
  vol: number;
  timeToExpiry: number;
  type: 'call' | 'put';
  simulations?: number;
  steps?: number;
  exotic?: 'asian' | 'barrier_up' | 'barrier_down';
  barrier?: number;
}): OptionPricingResult {
  const {
    spot, strike, rate, vol, timeToExpiry, type,
    simulations = 50000,
    steps = 100,
    exotic,
    barrier,
  } = params;
  const dt = timeToExpiry / steps;
  const sqrtDt = Math.sqrt(dt);
  const discount = Math.exp(-rate * timeToExpiry);
  const rng = makeRng(42);

  const payoffs: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    let price = spot;
    let sumPrice = spot;
    let barrierHit = false;

    for (let t = 0; t < steps; t++) {
      const z = boxMuller(rng);
      price = price * Math.exp((rate - 0.5 * vol * vol) * dt + vol * sqrtDt * z);
      sumPrice += price;

      if (exotic === 'barrier_up' && barrier !== undefined && price >= barrier) {
        barrierHit = true;
      }
      if (exotic === 'barrier_down' && barrier !== undefined && price <= barrier) {
        barrierHit = true;
      }
    }

    let payoff: number;

    if (exotic === 'asian') {
      const avgPrice = sumPrice / (steps + 1);
      payoff = type === 'call'
        ? Math.max(0, avgPrice - strike)
        : Math.max(0, strike - avgPrice);
    } else if (exotic === 'barrier_up' || exotic === 'barrier_down') {
      // Knock-out barrier option: worthless if barrier is hit
      if (barrierHit) {
        payoff = 0;
      } else {
        payoff = type === 'call'
          ? Math.max(0, price - strike)
          : Math.max(0, strike - price);
      }
    } else {
      payoff = type === 'call'
        ? Math.max(0, price - strike)
        : Math.max(0, strike - price);
    }

    payoffs.push(payoff);
  }

  const optionPrice = discount * mean(payoffs);
  const se = discount * standardDeviation(payoffs) / Math.sqrt(simulations);
  const ci: [number, number] = [optionPrice - 1.96 * se, optionPrice + 1.96 * se];

  // Delta via bump-and-reprice
  const bumpSize = spot * 0.01;
  const rngUp = makeRng(42);
  const payoffsUp: number[] = [];

  for (let sim = 0; sim < simulations; sim++) {
    let price = spot + bumpSize;
    let sumPrice = price;
    let barrierHit = false;

    for (let t = 0; t < steps; t++) {
      const z = boxMuller(rngUp);
      price = price * Math.exp((rate - 0.5 * vol * vol) * dt + vol * sqrtDt * z);
      sumPrice += price;

      if (exotic === 'barrier_up' && barrier !== undefined && price >= barrier) {
        barrierHit = true;
      }
      if (exotic === 'barrier_down' && barrier !== undefined && price <= barrier) {
        barrierHit = true;
      }
    }

    let payoff: number;
    if (exotic === 'asian') {
      const avgPrice = sumPrice / (steps + 1);
      payoff = type === 'call'
        ? Math.max(0, avgPrice - strike)
        : Math.max(0, strike - avgPrice);
    } else if ((exotic === 'barrier_up' || exotic === 'barrier_down') && barrierHit) {
      payoff = 0;
    } else {
      payoff = type === 'call'
        ? Math.max(0, price - strike)
        : Math.max(0, strike - price);
    }

    payoffsUp.push(payoff);
  }

  const priceUp = discount * mean(payoffsUp);
  const delta = (priceUp - optionPrice) / bumpSize;

  return {
    price: optionPrice,
    standardError: se,
    confidenceInterval: ci,
    delta,
  };
}
