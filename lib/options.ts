/**
 * Options pricing and Greeks library.
 * Black-Scholes, Black-76, binomial trees, implied volatility,
 * vol surface analytics, and portfolio Greeks aggregation.
 */

import { standardDeviation, mean } from './math.js';

// ── Types ─────────────────────────────────────────────────

export interface OptionGreeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface BlackScholesParams {
  spot: number;
  strike: number;
  timeToExpiry: number;
  rate: number;
  vol: number;
  type: 'call' | 'put';
}

export interface Black76Params {
  forward: number;
  strike: number;
  timeToExpiry: number;
  rate: number;
  vol: number;
  type: 'call' | 'put';
}

export interface BinomialParams {
  spot: number;
  strike: number;
  timeToExpiry: number;
  rate: number;
  vol: number;
  type: 'call' | 'put';
  steps?: number;
  american?: boolean;
}

export interface ImpliedVolParams {
  marketPrice: number;
  spot: number;
  strike: number;
  timeToExpiry: number;
  rate: number;
  type: 'call' | 'put';
}

export interface PutCallParityParams {
  call?: number;
  put?: number;
  spot: number;
  strike: number;
  timeToExpiry: number;
  rate: number;
}

export interface VolSurfaceOption {
  strike: number;
  expiry: number;
  iv: number;
}

export interface VolSurfaceResult {
  smile: Array<{ strike: number; iv: number }>[];
  termStructure: Array<{ expiry: number; atmIv: number }>;
  skew: number;
  kurtosis: number;
}

export interface SkewChainOption {
  strike: number;
  iv: number;
  type: 'call' | 'put';
}

export interface SkewMetricsResult {
  riskReversal25d: number;
  butterfly25d: number;
  skewIndex: number;
  putCallSkew: number;
}

export interface GreeksPosition {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  quantity: number;
}

export interface AggregatedGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export interface BreakevenParams {
  strike: number;
  premium: number;
  type: 'call' | 'put';
}

export interface MaxPainOption {
  strike: number;
  openInterest: number;
  type: 'call' | 'put';
}

// ── Internal Helpers: Standard Normal CDF & PDF ───────────

/**
 * Standard normal PDF: φ(x) = (1/√2π) * e^(-x²/2)
 */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Standard normal CDF using rational approximation (Abramowitz & Stegun 26.2.17).
 * Accurate to ~7.5e-8.
 */
function normCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

// ── Black-Scholes ─────────────────────────────────────────

/**
 * Black-Scholes pricing with all first-order Greeks.
 * Assumes European options on a non-dividend-paying underlying.
 */
export function blackScholes(params: BlackScholesParams): OptionGreeks {
  const { spot, strike, timeToExpiry, rate, vol, type } = params;

  if (timeToExpiry <= 0) {
    const intrinsic = type === 'call'
      ? Math.max(spot - strike, 0)
      : Math.max(strike - spot, 0);
    return { price: intrinsic, delta: type === 'call' ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const sqrtT = Math.sqrt(timeToExpiry);
  const d1 = (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * timeToExpiry) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const discount = Math.exp(-rate * timeToExpiry);

  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const nd1Neg = normCdf(-d1);
  const nd2Neg = normCdf(-d2);
  const pd1 = normPdf(d1);

  // Common Greeks
  const gamma = pd1 / (spot * vol * sqrtT);
  const vega = spot * pd1 * sqrtT / 100; // per 1% vol move

  if (type === 'call') {
    const price = spot * nd1 - strike * discount * nd2;
    const delta = nd1;
    const theta = (-(spot * pd1 * vol) / (2 * sqrtT) - rate * strike * discount * nd2) / 365;
    const rho = strike * timeToExpiry * discount * nd2 / 100;
    return { price, delta, gamma, theta, vega, rho };
  } else {
    const price = strike * discount * nd2Neg - spot * nd1Neg;
    const delta = nd1 - 1;
    const theta = (-(spot * pd1 * vol) / (2 * sqrtT) + rate * strike * discount * nd2Neg) / 365;
    const rho = -strike * timeToExpiry * discount * nd2Neg / 100;
    return { price, delta, gamma, theta, vega, rho };
  }
}

// ── Black-76 ──────────────────────────────────────────────

/**
 * Black-76 model for futures/forward options.
 * Same Greeks shape as Black-Scholes, using forward price instead of spot.
 */
export function black76(params: Black76Params): OptionGreeks {
  const { forward, strike, timeToExpiry, rate, vol, type } = params;

  if (timeToExpiry <= 0) {
    const intrinsic = type === 'call'
      ? Math.max(forward - strike, 0)
      : Math.max(strike - forward, 0);
    return { price: intrinsic, delta: type === 'call' ? (forward > strike ? 1 : 0) : (forward < strike ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const sqrtT = Math.sqrt(timeToExpiry);
  const discount = Math.exp(-rate * timeToExpiry);
  const d1 = (Math.log(forward / strike) + 0.5 * vol * vol * timeToExpiry) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;

  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const nd1Neg = normCdf(-d1);
  const nd2Neg = normCdf(-d2);
  const pd1 = normPdf(d1);

  const gamma = discount * pd1 / (forward * vol * sqrtT);
  const vega = discount * forward * pd1 * sqrtT / 100;

  if (type === 'call') {
    const price = discount * (forward * nd1 - strike * nd2);
    const delta = discount * nd1;
    const theta = (-(discount * forward * pd1 * vol) / (2 * sqrtT) - rate * price) / 365;
    const rho = -timeToExpiry * price / 100;
    return { price, delta, gamma, theta, vega, rho };
  } else {
    const price = discount * (strike * nd2Neg - forward * nd1Neg);
    const delta = -discount * nd1Neg;
    const theta = (-(discount * forward * pd1 * vol) / (2 * sqrtT) - rate * price) / 365;
    const rho = -timeToExpiry * price / 100;
    return { price, delta, gamma, theta, vega, rho };
  }
}

// ── Binomial Tree (CRR) ──────────────────────────────────

/**
 * Cox-Ross-Rubinstein binomial tree pricing.
 * Supports both European and American exercise.
 */
export function binomialPrice(params: BinomialParams): OptionGreeks {
  const { spot, strike, timeToExpiry, rate, vol, type, steps = 100, american = false } = params;

  if (timeToExpiry <= 0) {
    const intrinsic = type === 'call'
      ? Math.max(spot - strike, 0)
      : Math.max(strike - spot, 0);
    return { price: intrinsic, delta: type === 'call' ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const dt = timeToExpiry / steps;
  const u = Math.exp(vol * Math.sqrt(dt));
  const d = 1 / u;
  const erdt = Math.exp(rate * dt);
  const p = (erdt - d) / (u - d);
  const q = 1 - p;
  const disc = Math.exp(-rate * dt);

  const payoff = (s: number): number =>
    type === 'call' ? Math.max(s - strike, 0) : Math.max(strike - s, 0);

  // Build terminal values
  const optionValues = new Array(steps + 1);
  for (let j = 0; j <= steps; j++) {
    const sT = spot * Math.pow(u, steps - j) * Math.pow(d, j);
    optionValues[j] = payoff(sT);
  }

  // Store values at step 2 and step 1 for Greeks
  let step1Values: number[] | undefined;
  let step2Values: number[] | undefined;

  // Backward induction
  for (let i = steps - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const continuation = disc * (p * optionValues[j] + q * optionValues[j + 1]);
      if (american) {
        const sNode = spot * Math.pow(u, i - j) * Math.pow(d, j);
        optionValues[j] = Math.max(continuation, payoff(sNode));
      } else {
        optionValues[j] = continuation;
      }
    }
    if (i === 2) step2Values = optionValues.slice(0, 3);
    if (i === 1) step1Values = optionValues.slice(0, 2);
  }

  const price = optionValues[0];

  // Delta from step 1
  const sUp = spot * u;
  const sDown = spot * d;
  const delta = step1Values
    ? (step1Values[0] - step1Values[1]) / (sUp - sDown)
    : 0;

  // Gamma from step 2
  let gamma = 0;
  if (step2Values) {
    const sUU = spot * u * u;
    const sDD = spot * d * d;
    const sMid = spot; // u*d = 1
    const deltaUp = (step2Values[0] - step2Values[1]) / (sUU - sMid);
    const deltaDown = (step2Values[1] - step2Values[2]) / (sMid - sDD);
    gamma = (deltaUp - deltaDown) / (0.5 * (sUU - sDD));
  }

  // Theta from step 2 center vs step 0
  const theta = step2Values
    ? (step2Values[1] - price) / (2 * dt) / 365
    : 0;

  // Vega via finite difference: bump vol by 1%
  const bumpedParams = { ...params, vol: vol + 0.01, steps, american };
  const bumpedPrice = binomialPriceOnly(bumpedParams);
  const vega = (bumpedPrice - price); // per 1% vol

  // Rho via finite difference: bump rate by 1%
  const rhoParams = { ...params, rate: rate + 0.01, steps, american };
  const rhoPrice = binomialPriceOnly(rhoParams);
  const rho = (rhoPrice - price); // per 1% rate

  return { price, delta, gamma, theta, vega, rho };
}

/**
 * Internal: price-only binomial for finite-difference Greeks.
 */
function binomialPriceOnly(params: BinomialParams): number {
  const { spot, strike, timeToExpiry, rate, vol, type, steps = 100, american = false } = params;
  const dt = timeToExpiry / steps;
  const u = Math.exp(vol * Math.sqrt(dt));
  const d = 1 / u;
  const erdt = Math.exp(rate * dt);
  const p = (erdt - d) / (u - d);
  const q = 1 - p;
  const disc = Math.exp(-rate * dt);

  const payoff = (s: number): number =>
    type === 'call' ? Math.max(s - strike, 0) : Math.max(strike - s, 0);

  const values = new Array(steps + 1);
  for (let j = 0; j <= steps; j++) {
    values[j] = payoff(spot * Math.pow(u, steps - j) * Math.pow(d, j));
  }

  for (let i = steps - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const cont = disc * (p * values[j] + q * values[j + 1]);
      if (american) {
        const sNode = spot * Math.pow(u, i - j) * Math.pow(d, j);
        values[j] = Math.max(cont, payoff(sNode));
      } else {
        values[j] = cont;
      }
    }
  }

  return values[0];
}

// ── Implied Volatility ────────────────────────────────────

/**
 * Newton-Raphson implied volatility solver.
 * Returns the vol that makes Black-Scholes price match market price.
 */
export function impliedVol(params: ImpliedVolParams): number {
  const { marketPrice, spot, strike, timeToExpiry, rate, type } = params;

  const maxIterations = 100;
  const tolerance = 1e-8;
  let vol = 0.3; // initial guess

  for (let i = 0; i < maxIterations; i++) {
    const result = blackScholes({ spot, strike, timeToExpiry, rate, vol, type });
    const diff = result.price - marketPrice;

    if (Math.abs(diff) < tolerance) return vol;

    // Vega in absolute terms (undo the /100 scaling)
    const sqrtT = Math.sqrt(timeToExpiry);
    const d1 = (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * timeToExpiry) / (vol * sqrtT);
    const vegaAbs = spot * normPdf(d1) * sqrtT;

    if (vegaAbs < 1e-12) break; // vega too small, can't converge

    vol = vol - diff / vegaAbs;

    // Clamp to reasonable range
    if (vol < 0.001) vol = 0.001;
    if (vol > 10) vol = 10;
  }

  return vol;
}

// ── Put-Call Parity ───────────────────────────────────────

/**
 * Put-call parity: C - P = S - K*e^(-rT).
 * Given one price, returns the other.
 */
export function putCallParity(params: PutCallParityParams): number {
  const { call, put, spot, strike, timeToExpiry, rate } = params;
  const pvStrike = strike * Math.exp(-rate * timeToExpiry);

  if (call !== undefined && put === undefined) {
    // Solve for put: P = C - S + K*e^(-rT)
    return call - spot + pvStrike;
  } else if (put !== undefined && call === undefined) {
    // Solve for call: C = P + S - K*e^(-rT)
    return put + spot - pvStrike;
  } else {
    // Both provided — return the call (or could throw)
    return call ?? 0;
  }
}

// ── Vol Surface ───────────────────────────────────────────

/**
 * Constructs a volatility surface from a set of options with strikes and expiries.
 * Returns smile curves (grouped by expiry), ATM term structure, skew, and kurtosis.
 */
export function volSurface(options: VolSurfaceOption[]): VolSurfaceResult {
  if (options.length === 0) {
    return { smile: [], termStructure: [], skew: 0, kurtosis: 0 };
  }

  // Group by expiry
  const byExpiry = new Map<number, Array<{ strike: number; iv: number }>>();
  for (const opt of options) {
    const group = byExpiry.get(opt.expiry) ?? [];
    group.push({ strike: opt.strike, iv: opt.iv });
    byExpiry.set(opt.expiry, group);
  }

  // Build smile curves (sorted by strike within each expiry)
  const smile: Array<{ strike: number; iv: number }>[] = [];
  const termStructure: Array<{ expiry: number; atmIv: number }> = [];

  const sortedExpiries = [...byExpiry.keys()].sort((a, b) => a - b);

  for (const expiry of sortedExpiries) {
    const group = byExpiry.get(expiry)!;
    group.sort((a, b) => a.strike - b.strike);
    smile.push(group);

    // ATM IV: use the strike closest to the median strike as proxy
    const strikes = group.map(g => g.strike);
    const midStrike = strikes[Math.floor(strikes.length / 2)];
    const atmOption = group.find(g => g.strike === midStrike);
    if (atmOption) {
      termStructure.push({ expiry, atmIv: atmOption.iv });
    }
  }

  // Skew: slope of IV vs strike for the nearest expiry
  const allIvs = options.map(o => o.iv);
  const avgIv = mean(allIvs);
  const ivStdDev = standardDeviation(allIvs);

  // Compute skew as the normalized third moment of IVs
  let skew = 0;
  let kurtosis = 0;
  if (ivStdDev > 0 && allIvs.length > 2) {
    const n = allIvs.length;
    const centered = allIvs.map(iv => (iv - avgIv) / ivStdDev);
    skew = centered.reduce((sum, z) => sum + z * z * z, 0) / n;
    kurtosis = centered.reduce((sum, z) => sum + z * z * z * z, 0) / n - 3; // excess kurtosis
  }

  return { smile, termStructure, skew, kurtosis };
}

// ── Skew Metrics ──────────────────────────────────────────

/**
 * Computes skew metrics from an options chain.
 * Risk reversal, butterfly spread, skew index, and put/call skew.
 */
export function skewMetrics(chain: SkewChainOption[]): SkewMetricsResult {
  const puts = chain.filter(o => o.type === 'put').sort((a, b) => a.strike - b.strike);
  const calls = chain.filter(o => o.type === 'call').sort((a, b) => a.strike - b.strike);

  if (puts.length === 0 || calls.length === 0) {
    return { riskReversal25d: 0, butterfly25d: 0, skewIndex: 0, putCallSkew: 0 };
  }

  // Use 25th/75th percentile strikes as proxies for 25-delta options
  const allStrikes = chain.map(o => o.strike).sort((a, b) => a - b);
  const lowStrikeIdx = Math.floor(allStrikes.length * 0.25);
  const highStrikeIdx = Math.floor(allStrikes.length * 0.75);
  const midStrikeIdx = Math.floor(allStrikes.length * 0.5);

  const lowStrike = allStrikes[lowStrikeIdx];
  const highStrike = allStrikes[highStrikeIdx];
  const midStrike = allStrikes[midStrikeIdx];

  // Find closest IVs for these strikes
  const findIv = (arr: SkewChainOption[], strike: number): number => {
    let closest = arr[0];
    for (const o of arr) {
      if (Math.abs(o.strike - strike) < Math.abs(closest.strike - strike)) {
        closest = o;
      }
    }
    return closest.iv;
  };

  const putIvLow = findIv(puts, lowStrike);
  const callIvHigh = findIv(calls, highStrike);
  const atmIv = findIv(chain, midStrike);

  // Risk reversal: 25d call IV - 25d put IV
  const riskReversal25d = callIvHigh - putIvLow;

  // Butterfly: average of wings minus ATM
  const butterfly25d = (callIvHigh + putIvLow) / 2 - atmIv;

  // Skew index: put IV / call IV ratio - 1
  const avgPutIv = mean(puts.map(p => p.iv));
  const avgCallIv = mean(calls.map(c => c.iv));
  const skewIndex = avgCallIv > 0 ? (avgPutIv / avgCallIv) - 1 : 0;

  // Put-call skew: difference in average IVs
  const putCallSkew = avgPutIv - avgCallIv;

  return { riskReversal25d, butterfly25d, skewIndex, putCallSkew };
}

// ── Portfolio Greeks Exposure ─────────────────────────────

/**
 * Aggregates Greeks across a portfolio of option positions.
 */
export function greeksExposure(positions: GreeksPosition[]): AggregatedGreeks {
  let delta = 0;
  let gamma = 0;
  let theta = 0;
  let vega = 0;

  for (const pos of positions) {
    delta += pos.delta * pos.quantity;
    gamma += pos.gamma * pos.quantity;
    theta += pos.theta * pos.quantity;
    vega += pos.vega * pos.quantity;
  }

  return { delta, gamma, theta, vega };
}

// ── Breakeven ─────────────────────────────────────────────

/**
 * Breakeven price for a long option position.
 */
export function breakeven(params: BreakevenParams): number {
  const { strike, premium, type } = params;
  return type === 'call' ? strike + premium : strike - premium;
}

// ── Max Pain ──────────────────────────────────────────────

/**
 * Max pain: the strike price at which the total value of outstanding
 * options (calls + puts) would cause the greatest loss to option holders,
 * i.e. the strike where total intrinsic value paid out is minimized.
 */
export function maxPain(chain: MaxPainOption[]): number {
  if (chain.length === 0) return 0;

  const strikes = [...new Set(chain.map(o => o.strike))].sort((a, b) => a - b);

  let minPain = Infinity;
  let maxPainStrike = strikes[0];

  for (const testStrike of strikes) {
    let totalPain = 0;

    for (const opt of chain) {
      if (opt.type === 'call') {
        // Call holders lose when price is below strike; they gain when above
        // Pain to call holders at testStrike: max(testStrike - strike, 0) * OI
        totalPain += Math.max(testStrike - opt.strike, 0) * opt.openInterest;
      } else {
        // Put holders lose when price is above strike; they gain when below
        // Pain to put holders at testStrike: max(strike - testStrike, 0) * OI
        totalPain += Math.max(opt.strike - testStrike, 0) * opt.openInterest;
      }
    }

    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = testStrike;
    }
  }

  return maxPainStrike;
}
