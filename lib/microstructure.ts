/**
 * Market microstructure analytics: pure functions for trade classification,
 * price impact estimation, informed trading detection, and liquidity measurement.
 */

import { mean, standardDeviation, returns } from './math.js';

// ── Types ──────────────────────────────────────────────────────

export interface VpinBucket {
  buyVolume: number;
  sellVolume: number;
  imbalance: number;
}

export interface VpinResult {
  vpin: number;
  buckets: VpinBucket[];
  toxicityLevel: 'low' | 'medium' | 'high';
}

export interface KyleLambdaResult {
  lambda: number;
  tStatistic: number;
  rSquared: number;
  significantImpact: boolean;
}

export interface ClassifiedTrade {
  price: number;
  bid: number;
  ask: number;
  side: 'buy' | 'sell';
  confidence: number;
}

export interface AdverseSelectionCost {
  horizon: number;
  cost: number;
}

export interface AdverseSelectionResult {
  costs: AdverseSelectionCost[];
  averageCost: number;
  informedFlowPct: number;
}

export interface AmihudResult {
  ratio: number;
  rollingRatios: number[];
  liquidityScore: 'high' | 'medium' | 'low';
}

export interface SpreadDecomposition {
  effectiveSpread: number;
  realizedSpread: number;
  priceImpact: number;
  adverseSelectionPct: number;
}

export interface RollSpreadResult {
  impliedSpread: number;
  serialCovariance: number;
}

export interface PinResult {
  pin: number;
  alpha: number;
  delta: number;
  mu: number;
  epsilonBuy: number;
  epsilonSell: number;
}

export interface HasbrouckResult {
  shareA: number;
  shareB: number;
  dominantVenue: 'A' | 'B';
}

export interface TradeFlowToxicityResult {
  toxicity: number;
  flowImbalance: number;
  arrivalRate: number;
  regime: 'normal' | 'toxic' | 'benign';
}

// ── VPIN ───────────────────────────────────────────────────────

/**
 * Volume-Synchronized Probability of Informed Trading.
 * Classifies trades via bulk volume classification when side is not given,
 * buckets by volume, and computes buy/sell imbalance per bucket.
 *
 * @param trades - array of trades with price, volume, and optional side
 * @param bucketSize - volume per bucket
 */
export function computeVpin(
  trades: Array<{ price: number; volume: number; side?: 'buy' | 'sell' }>,
  bucketSize: number,
): VpinResult {
  if (trades.length === 0 || bucketSize <= 0) {
    return { vpin: 0, buckets: [], toxicityLevel: 'low' };
  }

  // Classify trades using bulk volume classification if side not provided
  const classified = trades.map((t, i) => {
    if (t.side) return { ...t, side: t.side };
    // Bulk volume classification: use price change direction
    if (i === 0) return { ...t, side: 'buy' as const };
    const delta = t.price - trades[i - 1].price;
    if (delta > 0) return { ...t, side: 'buy' as const };
    if (delta < 0) return { ...t, side: 'sell' as const };
    // No change — carry forward previous classification
    return { ...t, side: 'buy' as const };
  });

  // Fill volume buckets
  const buckets: VpinBucket[] = [];
  let currentBuy = 0;
  let currentSell = 0;
  let currentVolume = 0;

  for (const t of classified) {
    let remaining = t.volume;

    while (remaining > 0) {
      const spaceInBucket = bucketSize - currentVolume;
      const fill = Math.min(remaining, spaceInBucket);

      if (t.side === 'buy') {
        currentBuy += fill;
      } else {
        currentSell += fill;
      }
      currentVolume += fill;
      remaining -= fill;

      if (currentVolume >= bucketSize) {
        const totalBucket = currentBuy + currentSell;
        const imbalance = totalBucket > 0
          ? Math.abs(currentBuy - currentSell) / totalBucket
          : 0;
        buckets.push({
          buyVolume: currentBuy,
          sellVolume: currentSell,
          imbalance,
        });
        currentBuy = 0;
        currentSell = 0;
        currentVolume = 0;
      }
    }
  }

  if (buckets.length === 0) {
    return { vpin: 0, buckets: [], toxicityLevel: 'low' };
  }

  // VPIN = average imbalance across buckets
  const vpin = mean(buckets.map(b => b.imbalance));

  const toxicityLevel: 'low' | 'medium' | 'high' =
    vpin > 0.7 ? 'high' : vpin > 0.4 ? 'medium' : 'low';

  return { vpin, buckets, toxicityLevel };
}

// ── Kyle's Lambda ──────────────────────────────────────────────

/**
 * Kyle's lambda: permanent price impact coefficient.
 * Regresses price changes on signed order flow (volume * sign).
 *
 * @param trades - trades with price, volume, and side
 * @param windowSize - optional rolling window (defaults to all trades)
 */
export function kyleLambda(
  trades: Array<{ price: number; volume: number; side: 'buy' | 'sell' }>,
  windowSize?: number,
): KyleLambdaResult {
  const n = windowSize ? Math.min(windowSize, trades.length) : trades.length;
  const subset = trades.slice(trades.length - n);

  if (subset.length < 3) {
    return { lambda: 0, tStatistic: 0, rSquared: 0, significantImpact: false };
  }

  // Compute price changes and signed order flow
  const priceChanges: number[] = [];
  const signedFlow: number[] = [];

  for (let i = 1; i < subset.length; i++) {
    priceChanges.push(subset[i].price - subset[i - 1].price);
    const sign = subset[i].side === 'buy' ? 1 : -1;
    signedFlow.push(sign * subset[i].volume);
  }

  // OLS regression: priceChange = lambda * signedFlow + epsilon
  const flowMean = mean(signedFlow);
  const priceMean = mean(priceChanges);

  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < priceChanges.length; i++) {
    const dx = signedFlow[i] - flowMean;
    const dy = priceChanges[i] - priceMean;
    sumXY += dx * dy;
    sumX2 += dx * dx;
  }

  const lambda = sumX2 === 0 ? 0 : sumXY / sumX2;

  // Residuals for R-squared and t-statistic
  let ssRes = 0;
  let ssTot = 0;

  for (let i = 0; i < priceChanges.length; i++) {
    const predicted = lambda * signedFlow[i] + (priceMean - lambda * flowMean);
    const residual = priceChanges[i] - predicted;
    ssRes += residual * residual;
    ssTot += (priceChanges[i] - priceMean) ** 2;
  }

  const rSquared = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  // Standard error of lambda
  const k = priceChanges.length;
  const residualVariance = k > 2 ? ssRes / (k - 2) : 0;
  const seLambda = sumX2 > 0 ? Math.sqrt(residualVariance / sumX2) : 0;
  const tStatistic = seLambda > 0 ? lambda / seLambda : 0;

  return {
    lambda,
    tStatistic,
    rSquared,
    significantImpact: Math.abs(tStatistic) > 1.96,
  };
}

// ── Trade Classification ───────────────────────────────────────

/**
 * Classify trades as buy or sell using Lee-Ready, tick test, or bulk volume classification.
 *
 * @param trades - trades with price, bid, and ask
 * @param method - classification method (default: 'lee-ready')
 */
export function classifyTrades(
  trades: Array<{ price: number; bid: number; ask: number }>,
  method: 'lee-ready' | 'tick' | 'bulk' = 'lee-ready',
): ClassifiedTrade[] {
  if (trades.length === 0) return [];

  if (method === 'bulk') {
    return trades.map((t, i) => {
      if (i === 0) {
        const mid = (t.bid + t.ask) / 2;
        return {
          ...t,
          side: t.price >= mid ? 'buy' as const : 'sell' as const,
          confidence: 0.5,
        };
      }
      const delta = t.price - trades[i - 1].price;
      return {
        ...t,
        side: delta >= 0 ? 'buy' as const : 'sell' as const,
        confidence: Math.abs(delta) > 0 ? 0.7 : 0.5,
      };
    });
  }

  if (method === 'tick') {
    return trades.map((t, i) => {
      if (i === 0) {
        const mid = (t.bid + t.ask) / 2;
        return {
          ...t,
          side: t.price >= mid ? 'buy' as const : 'sell' as const,
          confidence: 0.5,
        };
      }
      const delta = t.price - trades[i - 1].price;
      if (delta > 0) return { ...t, side: 'buy' as const, confidence: 0.85 };
      if (delta < 0) return { ...t, side: 'sell' as const, confidence: 0.85 };
      // No price change — look further back
      for (let j = i - 2; j >= 0; j--) {
        const d = t.price - trades[j].price;
        if (d > 0) return { ...t, side: 'buy' as const, confidence: 0.6 };
        if (d < 0) return { ...t, side: 'sell' as const, confidence: 0.6 };
      }
      return { ...t, side: 'buy' as const, confidence: 0.5 };
    });
  }

  // Lee-Ready: compare to midpoint, tick test for ties
  return trades.map((t, i) => {
    const mid = (t.bid + t.ask) / 2;
    const spread = t.ask - t.bid;

    if (t.price > mid) {
      const distFromMid = (t.price - mid) / (spread / 2 || 1);
      return {
        ...t,
        side: 'buy' as const,
        confidence: Math.min(0.95, 0.7 + 0.25 * Math.min(1, distFromMid)),
      };
    }
    if (t.price < mid) {
      const distFromMid = (mid - t.price) / (spread / 2 || 1);
      return {
        ...t,
        side: 'sell' as const,
        confidence: Math.min(0.95, 0.7 + 0.25 * Math.min(1, distFromMid)),
      };
    }

    // Price at midpoint — fall back to tick test
    if (i > 0) {
      const delta = t.price - trades[i - 1].price;
      if (delta > 0) return { ...t, side: 'buy' as const, confidence: 0.6 };
      if (delta < 0) return { ...t, side: 'sell' as const, confidence: 0.6 };
    }

    return { ...t, side: 'buy' as const, confidence: 0.5 };
  });
}

// ── Adverse Selection ──────────────────────────────────────────

/**
 * Adverse selection cost: price movement after a trade in the direction of the trade.
 * Measures how much the market moves against the liquidity provider after filling.
 *
 * @param trades - trades with price, side, and midPrice
 * @param horizons - number of trades ahead to measure (default [1, 5, 10])
 */
export function adverseSelection(
  trades: Array<{ price: number; side: 'buy' | 'sell'; midPrice: number }>,
  horizons: number[] = [1, 5, 10],
): AdverseSelectionResult {
  if (trades.length < 2) {
    return {
      costs: horizons.map(h => ({ horizon: h, cost: 0 })),
      averageCost: 0,
      informedFlowPct: 0,
    };
  }

  const costs: AdverseSelectionCost[] = [];

  for (const horizon of horizons) {
    const measurements: number[] = [];

    for (let i = 0; i < trades.length - horizon; i++) {
      const trade = trades[i];
      const futureMid = trades[i + horizon].midPrice;
      const midChange = futureMid - trade.midPrice;
      // Adverse selection = price move in direction of trade
      const sign = trade.side === 'buy' ? 1 : -1;
      const cost = sign * midChange;
      if (trade.midPrice > 0) {
        measurements.push(cost / trade.midPrice);
      }
    }

    costs.push({
      horizon,
      cost: measurements.length > 0 ? mean(measurements) : 0,
    });
  }

  const averageCost = mean(costs.map(c => c.cost));

  // Informed flow: percentage of trades where adverse selection is positive
  const informedCount = costs.filter(c => c.cost > 0).length;
  const informedFlowPct = costs.length > 0 ? informedCount / costs.length : 0;

  return { costs, averageCost, informedFlowPct };
}

// ── Amihud Illiquidity ─────────────────────────────────────────

/**
 * Amihud illiquidity ratio: average |return| / volume.
 * Higher values indicate less liquid markets.
 *
 * @param prices - price series
 * @param volumes - volume series (same length as prices)
 */
export function amihudIlliquidity(
  prices: number[],
  volumes: number[],
): AmihudResult {
  const n = Math.min(prices.length, volumes.length);
  if (n < 2) {
    return { ratio: 0, rollingRatios: [], liquidityScore: 'high' };
  }

  const rets = returns(prices.slice(0, n));
  const rollingRatios: number[] = [];

  for (let i = 0; i < rets.length; i++) {
    const vol = volumes[i + 1]; // volume corresponds to the return period
    if (vol > 0) {
      rollingRatios.push(Math.abs(rets[i]) / vol);
    } else {
      rollingRatios.push(0);
    }
  }

  const ratio = mean(rollingRatios);

  // Classify liquidity based on ratio magnitude
  // Thresholds are relative — lower ratio means more liquid
  const liquidityScore: 'high' | 'medium' | 'low' =
    ratio < 1e-9 ? 'high' : ratio < 1e-6 ? 'medium' : 'low';

  return { ratio, rollingRatios, liquidityScore };
}

// ── Realized Spread Decomposition ──────────────────────────────

/**
 * Decompose the effective spread into realized spread and price impact.
 * Effective spread = realized spread (market maker profit) + price impact (information cost).
 *
 * @param trades - trades with price, side, and midPrice
 * @param horizon - number of trades ahead for realized spread (default 5)
 */
export function realizedSpreadDecomposition(
  trades: Array<{ price: number; side: 'buy' | 'sell'; midPrice: number }>,
  horizon: number = 5,
): SpreadDecomposition {
  if (trades.length < horizon + 1) {
    return {
      effectiveSpread: 0,
      realizedSpread: 0,
      priceImpact: 0,
      adverseSelectionPct: 0,
    };
  }

  const effectiveSpreads: number[] = [];
  const realizedSpreads: number[] = [];
  const priceImpacts: number[] = [];

  for (let i = 0; i < trades.length - horizon; i++) {
    const trade = trades[i];
    const sign = trade.side === 'buy' ? 1 : -1;

    // Effective spread: 2 * sign * (price - midPrice)
    const effective = 2 * sign * (trade.price - trade.midPrice);

    // Realized spread: 2 * sign * (price - futureMid)
    const futureMid = trades[i + horizon].midPrice;
    const realized = 2 * sign * (trade.price - futureMid);

    // Price impact: effective spread - realized spread = 2 * sign * (futureMid - midPrice)
    const impact = effective - realized;

    if (trade.midPrice > 0) {
      effectiveSpreads.push(effective / trade.midPrice);
      realizedSpreads.push(realized / trade.midPrice);
      priceImpacts.push(impact / trade.midPrice);
    }
  }

  const effectiveSpread = effectiveSpreads.length > 0 ? mean(effectiveSpreads) : 0;
  const realizedSpread = realizedSpreads.length > 0 ? mean(realizedSpreads) : 0;
  const priceImpact = priceImpacts.length > 0 ? mean(priceImpacts) : 0;

  const adverseSelectionPct = effectiveSpread > 0
    ? Math.max(0, Math.min(1, priceImpact / effectiveSpread))
    : 0;

  return {
    effectiveSpread,
    realizedSpread,
    priceImpact,
    adverseSelectionPct,
  };
}

// ── Roll Spread ────────────────────────────────────────────────

/**
 * Roll (1984) implied spread estimator from serial covariance of price changes.
 * Spread = 2 * sqrt(-cov) when covariance is negative, 0 otherwise.
 *
 * @param prices - price series
 */
export function rollSpread(prices: number[]): RollSpreadResult {
  if (prices.length < 3) {
    return { impliedSpread: 0, serialCovariance: 0 };
  }

  const changes: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  // Serial covariance: cov(deltaP_t, deltaP_{t-1})
  let sumProduct = 0;
  const n = changes.length - 1;

  for (let i = 1; i < changes.length; i++) {
    sumProduct += changes[i] * changes[i - 1];
  }

  const serialCovariance = n > 0 ? sumProduct / n : 0;

  // Implied spread = 2 * sqrt(-cov) if cov < 0
  const impliedSpread = serialCovariance < 0
    ? 2 * Math.sqrt(-serialCovariance)
    : 0;

  return { impliedSpread, serialCovariance };
}

// ── PIN Model ──────────────────────────────────────────────────

/**
 * Simplified PIN (Probability of Informed Trading) model.
 * Estimates the probability that a trade is information-driven using
 * buy/sell trade counts across periods.
 *
 * @param params - buyTrades, sellTrades, totalPeriods
 */
export function pinModel(params: {
  buyTrades: number;
  sellTrades: number;
  totalPeriods: number;
}): PinResult {
  const { buyTrades, sellTrades, totalPeriods } = params;

  if (totalPeriods <= 0 || (buyTrades + sellTrades) === 0) {
    return { pin: 0, alpha: 0, delta: 0.5, mu: 0, epsilonBuy: 0, epsilonSell: 0 };
  }

  const totalTrades = buyTrades + sellTrades;
  const avgTradesPerPeriod = totalTrades / totalPeriods;

  // Estimate uninformed arrival rates
  const epsilonBuy = Math.min(buyTrades, sellTrades) / totalPeriods;
  const epsilonSell = epsilonBuy;

  // Informed trade surplus
  const excessBuys = Math.max(0, buyTrades / totalPeriods - epsilonBuy);
  const excessSells = Math.max(0, sellTrades / totalPeriods - epsilonSell);
  const mu = excessBuys + excessSells;

  // Alpha: probability of information event
  const alpha = avgTradesPerPeriod > 0
    ? Math.min(1, mu / avgTradesPerPeriod)
    : 0;

  // Delta: probability that information is bad news
  const delta = mu > 0 ? excessSells / mu : 0.5;

  // PIN = alpha * mu / (alpha * mu + epsilonBuy + epsilonSell)
  const numerator = alpha * mu;
  const denominator = numerator + epsilonBuy + epsilonSell;
  const pin = denominator > 0 ? numerator / denominator : 0;

  return { pin, alpha, delta, mu, epsilonBuy, epsilonSell };
}

// ── Hasbrouck Information Share ─────────────────────────────────

/**
 * Hasbrouck information share: which venue contributes more to price discovery.
 * Uses variance of price innovations to determine dominant venue.
 *
 * @param priceSeriesA - price series from venue A
 * @param priceSeriesB - price series from venue B
 */
export function hasbrouckInfoShare(
  priceSeriesA: number[],
  priceSeriesB: number[],
): HasbrouckResult {
  const n = Math.min(priceSeriesA.length, priceSeriesB.length);

  if (n < 3) {
    return { shareA: 0.5, shareB: 0.5, dominantVenue: 'A' };
  }

  const a = priceSeriesA.slice(0, n);
  const b = priceSeriesB.slice(0, n);

  // Compute returns (price innovations)
  const retA = returns(a);
  const retB = returns(b);

  // Variance of innovations
  const varA = standardDeviation(retA) ** 2;
  const varB = standardDeviation(retB) ** 2;

  // Lead-lag: measure how A leads B and vice versa
  // Cross-correlation of returns at lag 1
  let corrALeadsB = 0;
  let corrBLeadsA = 0;
  const m = retA.length - 1;

  if (m > 0) {
    for (let i = 0; i < m; i++) {
      corrALeadsB += retA[i] * retB[i + 1];
      corrBLeadsA += retB[i] * retA[i + 1];
    }
    corrALeadsB /= m;
    corrBLeadsA /= m;
  }

  // Information share based on variance contribution and lead-lag
  const leadA = Math.abs(corrALeadsB);
  const leadB = Math.abs(corrBLeadsA);

  const totalVar = varA + varB;
  const totalLead = leadA + leadB;

  // Weighted combination of variance and lead-lag contributions
  let rawShareA: number;
  if (totalVar === 0 && totalLead === 0) {
    rawShareA = 0.5;
  } else if (totalVar === 0) {
    rawShareA = totalLead > 0 ? leadA / totalLead : 0.5;
  } else if (totalLead === 0) {
    rawShareA = varA / totalVar;
  } else {
    // Higher variance + more leading = more price discovery contribution
    rawShareA = 0.5 * (varA / totalVar) + 0.5 * (leadA / totalLead);
  }

  const shareA = Math.max(0, Math.min(1, rawShareA));
  const shareB = 1 - shareA;

  return {
    shareA,
    shareB,
    dominantVenue: shareA >= shareB ? 'A' : 'B',
  };
}

// ── Trade Flow Toxicity ────────────────────────────────────────

/**
 * Rolling toxicity metrics: VPIN-like toxicity, order flow imbalance,
 * and trade arrival intensity.
 *
 * @param trades - trades with price, volume, side, and timestamp
 * @param windowMs - rolling window in milliseconds (default 60000 = 1 minute)
 */
export function tradeFlowToxicity(
  trades: Array<{ price: number; volume: number; side: 'buy' | 'sell'; timestamp: number }>,
  windowMs: number = 60000,
): TradeFlowToxicityResult {
  if (trades.length === 0) {
    return { toxicity: 0, flowImbalance: 0, arrivalRate: 0, regime: 'benign' };
  }

  // Filter to window
  const latestTs = trades[trades.length - 1].timestamp;
  const windowStart = latestTs - windowMs;
  const windowTrades = trades.filter(t => t.timestamp >= windowStart);

  if (windowTrades.length === 0) {
    return { toxicity: 0, flowImbalance: 0, arrivalRate: 0, regime: 'benign' };
  }

  // Volume imbalance (VPIN-like)
  let buyVol = 0;
  let sellVol = 0;

  for (const t of windowTrades) {
    if (t.side === 'buy') buyVol += t.volume;
    else sellVol += t.volume;
  }

  const totalVol = buyVol + sellVol;
  const toxicity = totalVol > 0 ? Math.abs(buyVol - sellVol) / totalVol : 0;

  // Flow imbalance: signed, range [-1, 1]
  const flowImbalance = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;

  // Arrival rate: trades per second
  const windowDurationMs = windowTrades.length > 1
    ? windowTrades[windowTrades.length - 1].timestamp - windowTrades[0].timestamp
    : windowMs;
  const arrivalRate = windowDurationMs > 0
    ? (windowTrades.length / windowDurationMs) * 1000
    : 0;

  // Regime classification
  const regime: 'normal' | 'toxic' | 'benign' =
    toxicity > 0.7 ? 'toxic' : toxicity < 0.2 ? 'benign' : 'normal';

  return { toxicity, flowImbalance, arrivalRate, regime };
}
