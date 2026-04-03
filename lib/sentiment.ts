/**
 * Sentiment scoring and contrarian signal detection.
 * Pure functions for fear/greed analysis, crowding detection,
 * and composite sentiment indicators.
 */

import { mean, standardDeviation, zScore, correlation } from './math.js';

// ── Types ─────────────────────────────────────────────────

export interface FearGreedResult {
  index: number;
  label: 'extreme_fear' | 'fear' | 'neutral' | 'greed' | 'extreme_greed';
  components: Record<string, { value: number; weight: number; score: number }>;
}

export interface FundingSentimentResult {
  sentiment: 'crowded_long' | 'crowded_short' | 'neutral';
  percentile: number;
  zScore: number;
  extremeLevel: number;
  meanRevertSignal: boolean;
  historicalContext: { mean: number; std: number; currentRate: number };
}

export interface PutCallResult {
  volumeRatio: number;
  oiRatio: number;
  signal: 'extreme_bearish' | 'bearish' | 'neutral' | 'bullish' | 'extreme_bullish';
  contrarian: boolean;
  interpretation: string;
}

export interface SocialVolumeResult {
  normalizedVolume: number[];
  currentZScore: number;
  spikes: Array<{ index: number; zScore: number }>;
  divergence: boolean;
  priceVolumeCorrelation: number;
}

export interface ContrarianSignalResult {
  signal: 'contrarian_buy' | 'contrarian_sell' | 'neutral';
  confidence: number;
  sentimentPercentile: number;
  historicalAccuracy: number;
  extremeLevel: number;
}

export interface LongShortResult {
  accountRatio: number;
  volumeRatio: number;
  crowding: 'long_crowded' | 'short_crowded' | 'balanced';
  percentile: number;
  reversalRisk: number;
}

export interface SentimentMomentumResult {
  momentum: number;
  acceleration: number;
  trend: 'improving' | 'deteriorating' | 'stable';
  crossover: boolean;
  divergenceFromPrice?: number;
}

export interface CompositeScoreResult {
  score: number;
  normalizedIndicators: Array<{ name: string; normalizedValue: number; contribution: number }>;
  interpretation: string;
}

export interface VolSurfaceSentimentResult {
  signal: 'fear' | 'complacency' | 'neutral';
  skewSignal: 'crash_protection_demand' | 'neutral' | 'upside_demand';
  ivPercentile: number;
  regime: 'low_vol' | 'normal_vol' | 'high_vol';
}

export interface MarketBreadthResult {
  advanceDeclineRatio: number;
  advanceDeclineLine: number;
  pctPositive: number;
  pctAboveMA: number;
  breadthThrust: boolean;
  divergence: 'bullish_divergence' | 'bearish_divergence' | 'none';
  interpretation: string;
}

// ── Helpers ───────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percentileRank(value: number, data: number[]): number {
  if (data.length === 0) return 0.5;
  const below = data.filter(d => d < value).length;
  return below / data.length;
}

function sma(data: number[], window: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < window - 1) {
      result.push(mean(data.slice(0, i + 1)));
    } else {
      result.push(mean(data.slice(i - window + 1, i + 1)));
    }
  }
  return result;
}

// ── Fear & Greed Index ────────────────────────────────────

/**
 * Composite fear/greed index (0-100).
 * Combines volatility, momentum, volume, range, and optional funding rate.
 */
export function fearGreedIndex(params: {
  volatility: number;
  avgVolatility: number;
  momentum: number;
  volume: number;
  avgVolume: number;
  highLowRange: number;
  avgHighLowRange: number;
  fundingRate?: number;
}): FearGreedResult {
  const { volatility, avgVolatility, momentum, volume, avgVolume, highLowRange, avgHighLowRange, fundingRate } = params;

  const hasFunding = fundingRate !== undefined;
  const volWeight = hasFunding ? 0.25 : 0.30;
  const momWeight = hasFunding ? 0.25 : 0.30;
  const volumeWeight = hasFunding ? 0.20 : 0.20;
  const rangeWeight = hasFunding ? 0.15 : 0.20;
  const fundingWeight = hasFunding ? 0.15 : 0;

  // Volatility: high vol = fear (invert: lower score = more fear)
  const volRatio = avgVolatility === 0 ? 1 : volatility / avgVolatility;
  const volScore = clamp(100 - (volRatio - 0.5) * 100, 0, 100);

  // Momentum: positive = greed, negative = fear
  const momScore = clamp(50 + momentum * 500, 0, 100);

  // Volume: high volume with positive momentum = greed, high volume with negative momentum = fear
  const volMultiplier = avgVolume === 0 ? 1 : volume / avgVolume;
  const volumeScore = momentum >= 0
    ? clamp(50 + (volMultiplier - 1) * 50, 0, 100)
    : clamp(50 - (volMultiplier - 1) * 50, 0, 100);

  // Range: wide range = uncertainty/fear
  const rangeRatio = avgHighLowRange === 0 ? 1 : highLowRange / avgHighLowRange;
  const rangeScore = clamp(100 - (rangeRatio - 0.5) * 100, 0, 100);

  // Funding rate: positive = greed (longs paying), negative = fear
  const fundingScore = hasFunding
    ? clamp(50 + fundingRate! * 10000, 0, 100)
    : 50;

  const components: Record<string, { value: number; weight: number; score: number }> = {
    volatility: { value: volatility, weight: volWeight, score: volScore },
    momentum: { value: momentum, weight: momWeight, score: momScore },
    volume: { value: volume, weight: volumeWeight, score: volumeScore },
    range: { value: highLowRange, weight: rangeWeight, score: rangeScore },
  };

  if (hasFunding) {
    components.funding = { value: fundingRate!, weight: fundingWeight, score: fundingScore };
  }

  const index = clamp(
    volScore * volWeight +
    momScore * momWeight +
    volumeScore * volumeWeight +
    rangeScore * rangeWeight +
    fundingScore * fundingWeight,
    0,
    100
  );

  let label: FearGreedResult['label'];
  if (index <= 20) label = 'extreme_fear';
  else if (index <= 40) label = 'fear';
  else if (index <= 60) label = 'neutral';
  else if (index <= 80) label = 'greed';
  else label = 'extreme_greed';

  return { index, label, components };
}

// ── Funding Sentiment ─────────────────────────────────────

/**
 * Crowding signal from funding rates.
 * Extreme positive rates → crowded long, extreme negative → crowded short.
 */
export function fundingSentiment(
  rates: number[],
  params?: { lookback?: number }
): FundingSentimentResult {
  const lookback = params?.lookback ?? rates.length;
  const window = rates.slice(-lookback);

  if (window.length === 0) {
    return {
      sentiment: 'neutral',
      percentile: 0.5,
      zScore: 0,
      extremeLevel: 0,
      meanRevertSignal: false,
      historicalContext: { mean: 0, std: 0, currentRate: 0 },
    };
  }

  const current = window[window.length - 1];
  const avg = mean(window);
  const std = standardDeviation(window);
  const z = zScore(current, window);
  const pct = percentileRank(current, window);

  const extremeLevel = clamp(Math.abs(z) / 3, 0, 1);

  let sentiment: FundingSentimentResult['sentiment'];
  if (z > 1.5) sentiment = 'crowded_long';
  else if (z < -1.5) sentiment = 'crowded_short';
  else sentiment = 'neutral';

  const meanRevertSignal = Math.abs(z) > 2;

  return {
    sentiment,
    percentile: pct,
    zScore: z,
    extremeLevel,
    meanRevertSignal,
    historicalContext: { mean: avg, std, currentRate: current },
  };
}

// ── Put/Call Ratio ────────────────────────────────────────

/**
 * Put/call ratio analysis.
 * High put/call → bearish sentiment (contrarian bullish).
 */
export function putCallRatio(params: {
  putVolume: number;
  callVolume: number;
  putOI: number;
  callOI: number;
}): PutCallResult {
  const { putVolume, callVolume, putOI, callOI } = params;

  const volumeRatio = callVolume === 0 ? Infinity : putVolume / callVolume;
  const oiRatio = callOI === 0 ? Infinity : putOI / callOI;

  const avgRatio = (volumeRatio + oiRatio) / 2;

  let signal: PutCallResult['signal'];
  if (avgRatio > 1.5) signal = 'extreme_bearish';
  else if (avgRatio > 1.1) signal = 'bearish';
  else if (avgRatio > 0.7) signal = 'neutral';
  else if (avgRatio > 0.5) signal = 'bullish';
  else signal = 'extreme_bullish';

  const contrarian = signal === 'extreme_bearish' || signal === 'extreme_bullish';

  let interpretation: string;
  if (signal === 'extreme_bearish') {
    interpretation = 'Extreme put buying suggests widespread fear — contrarian bullish signal';
  } else if (signal === 'bearish') {
    interpretation = 'Elevated put/call ratio indicates bearish sentiment';
  } else if (signal === 'neutral') {
    interpretation = 'Put/call ratio in normal range — no strong directional signal';
  } else if (signal === 'bullish') {
    interpretation = 'Low put/call ratio indicates bullish sentiment';
  } else {
    interpretation = 'Extreme call buying suggests widespread greed — contrarian bearish signal';
  }

  return { volumeRatio, oiRatio, signal, contrarian, interpretation };
}

// ── Social Volume ─────────────────────────────────────────

/**
 * Normalize social media volume against price action to detect unusual attention.
 * Divergence between social volume spikes and price direction can signal reversals.
 */
export function socialVolumeNormalized(
  volumes: number[],
  prices: number[]
): SocialVolumeResult {
  if (volumes.length === 0 || prices.length === 0) {
    return {
      normalizedVolume: [],
      currentZScore: 0,
      spikes: [],
      divergence: false,
      priceVolumeCorrelation: 0,
    };
  }

  const n = Math.min(volumes.length, prices.length);
  const vols = volumes.slice(0, n);
  const prc = prices.slice(0, n);

  const volMean = mean(vols);
  const volStd = standardDeviation(vols);

  const normalizedVolume = vols.map(v =>
    volStd === 0 ? 0 : (v - volMean) / volStd
  );

  const currentZScore = normalizedVolume.length > 0
    ? normalizedVolume[normalizedVolume.length - 1]
    : 0;

  const spikeThreshold = 2;
  const spikes: Array<{ index: number; zScore: number }> = [];
  for (let i = 0; i < normalizedVolume.length; i++) {
    if (normalizedVolume[i] > spikeThreshold) {
      spikes.push({ index: i, zScore: normalizedVolume[i] });
    }
  }

  // Price returns for correlation
  const priceReturns: number[] = [];
  for (let i = 1; i < prc.length; i++) {
    priceReturns.push(prc[i - 1] === 0 ? 0 : (prc[i] - prc[i - 1]) / prc[i - 1]);
  }
  const volChanges = vols.slice(1).map((v, i) => vols[i] === 0 ? 0 : (v - vols[i]) / vols[i]);

  const priceVolumeCorrelation = priceReturns.length >= 2 && volChanges.length >= 2
    ? correlation(priceReturns, volChanges)
    : 0;

  // Divergence: social volume spiking but price flat or declining
  const recentVol = normalizedVolume.length >= 3
    ? mean(normalizedVolume.slice(-3))
    : currentZScore;
  const recentPriceReturn = prc.length >= 3 && prc[prc.length - 3] !== 0
    ? (prc[prc.length - 1] - prc[prc.length - 3]) / prc[prc.length - 3]
    : 0;
  const divergence = recentVol > 1.5 && recentPriceReturn < 0;

  return { normalizedVolume, currentZScore, spikes, divergence, priceVolumeCorrelation };
}

// ── Contrarian Signal ─────────────────────────────────────

/**
 * Detect contrarian opportunities when sentiment reaches extremes.
 * When everyone is fearful, be greedy — and vice versa.
 */
export function contrarianSignal(params: {
  sentiment: number;
  price: number;
  historicalSentiment: number[];
  historicalPrices: number[];
  threshold?: number;
}): ContrarianSignalResult {
  const { sentiment, price, historicalSentiment, historicalPrices, threshold = 0.85 } = params;

  if (historicalSentiment.length === 0) {
    return {
      signal: 'neutral',
      confidence: 0,
      sentimentPercentile: 0.5,
      historicalAccuracy: 0,
      extremeLevel: 0,
    };
  }

  const sentimentPct = percentileRank(sentiment, historicalSentiment);

  // Extreme level: how far into the tail we are (0 = center, 1 = extreme)
  const extremeLevel = Math.max(sentimentPct, 1 - sentimentPct) * 2 - 1;

  // Historical accuracy: when sentiment was this extreme before, how often did price reverse?
  const n = Math.min(historicalSentiment.length, historicalPrices.length);
  let extremeCount = 0;
  let reversalCount = 0;
  const lookAhead = Math.min(10, Math.floor(n / 4));

  for (let i = 0; i < n - lookAhead; i++) {
    const pct = percentileRank(historicalSentiment[i], historicalSentiment);
    const isExtremeHigh = pct >= threshold;
    const isExtremeLow = pct <= (1 - threshold);

    if (isExtremeHigh || isExtremeLow) {
      extremeCount++;
      const futureReturn = historicalPrices[i + lookAhead] !== 0 && historicalPrices[i] !== 0
        ? (historicalPrices[i + lookAhead] - historicalPrices[i]) / historicalPrices[i]
        : 0;
      // Reversal: extreme greed followed by decline, or extreme fear followed by rally
      if ((isExtremeHigh && futureReturn < 0) || (isExtremeLow && futureReturn > 0)) {
        reversalCount++;
      }
    }
  }

  const historicalAccuracy = extremeCount === 0 ? 0.5 : reversalCount / extremeCount;

  let signal: ContrarianSignalResult['signal'] = 'neutral';
  let confidence = 0;

  if (sentimentPct >= threshold) {
    signal = 'contrarian_sell';
    confidence = clamp(extremeLevel * historicalAccuracy, 0, 1);
  } else if (sentimentPct <= (1 - threshold)) {
    signal = 'contrarian_buy';
    confidence = clamp(extremeLevel * historicalAccuracy, 0, 1);
  }

  return { signal, confidence, sentimentPercentile: sentimentPct, historicalAccuracy, extremeLevel };
}

// ── Long/Short Ratio ──────────────────────────────────────

/**
 * Analyze positioning from long/short ratios.
 * Crowded positioning increases reversal risk.
 */
export function longShortRatio(params: {
  longAccounts: number;
  shortAccounts: number;
  longVolume: number;
  shortVolume: number;
  historical?: Array<{ longRatio: number; shortRatio: number }>;
}): LongShortResult {
  const { longAccounts, shortAccounts, longVolume, shortVolume, historical } = params;

  const totalAccounts = longAccounts + shortAccounts;
  const totalVolume = longVolume + shortVolume;

  const accountRatio = totalAccounts === 0 ? 1 : longAccounts / totalAccounts;
  const volumeRatio = totalVolume === 0 ? 1 : longVolume / totalVolume;

  // Crowding threshold: >65% on one side is crowded
  let crowding: LongShortResult['crowding'];
  const avgRatio = (accountRatio + volumeRatio) / 2;
  if (avgRatio > 0.65) crowding = 'long_crowded';
  else if (avgRatio < 0.35) crowding = 'short_crowded';
  else crowding = 'balanced';

  // Historical percentile
  let pct = 0.5;
  if (historical && historical.length > 0) {
    const historicalLongRatios = historical.map(h => h.longRatio / (h.longRatio + h.shortRatio));
    pct = percentileRank(accountRatio, historicalLongRatios);
  }

  // Reversal risk: higher when more crowded
  const reversalRisk = clamp(Math.abs(avgRatio - 0.5) * 4, 0, 1);

  return { accountRatio, volumeRatio, crowding, percentile: pct, reversalRisk };
}

// ── Sentiment Momentum ────────────────────────────────────

/**
 * Rate of change in sentiment.
 * Detects whether fear is increasing or decreasing, with acceleration.
 */
export function sentimentMomentum(
  sentimentSeries: number[],
  params?: { shortWindow?: number; longWindow?: number }
): SentimentMomentumResult {
  const shortWindow = params?.shortWindow ?? 5;
  const longWindow = params?.longWindow ?? 20;

  if (sentimentSeries.length < 2) {
    return { momentum: 0, acceleration: 0, trend: 'stable', crossover: false };
  }

  const shortMA = sma(sentimentSeries, Math.min(shortWindow, sentimentSeries.length));
  const longMA = sma(sentimentSeries, Math.min(longWindow, sentimentSeries.length));

  const currentShort = shortMA[shortMA.length - 1];
  const currentLong = longMA[longMA.length - 1];

  // Momentum: difference between short and long MA
  const momentum = currentShort - currentLong;

  // Acceleration: change in momentum
  let acceleration = 0;
  if (shortMA.length >= 2 && longMA.length >= 2) {
    const prevMomentum = shortMA[shortMA.length - 2] - longMA[longMA.length - 2];
    acceleration = momentum - prevMomentum;
  }

  // Trend classification
  let trend: SentimentMomentumResult['trend'];
  if (momentum > 1) trend = 'improving';
  else if (momentum < -1) trend = 'deteriorating';
  else trend = 'stable';

  // Crossover: short MA crossed long MA in recent period
  let crossover = false;
  if (shortMA.length >= 2 && longMA.length >= 2) {
    const prevShort = shortMA[shortMA.length - 2];
    const prevLong = longMA[longMA.length - 2];
    crossover = (prevShort <= prevLong && currentShort > currentLong) ||
                (prevShort >= prevLong && currentShort < currentLong);
  }

  return { momentum, acceleration, trend, crossover };
}

// ── Composite Score ───────────────────────────────────────

/**
 * Normalize and combine multiple sentiment indicators into a single score.
 * Each indicator is mapped to 0-100 range and weighted.
 */
export function compositeScore(
  indicators: Array<{
    name: string;
    value: number;
    min: number;
    max: number;
    weight?: number;
    invert?: boolean;
  }>
): CompositeScoreResult {
  if (indicators.length === 0) {
    return { score: 50, normalizedIndicators: [], interpretation: 'No indicators provided' };
  }

  const totalWeight = indicators.reduce((s, ind) => s + (ind.weight ?? 1), 0);

  const normalizedIndicators = indicators.map(ind => {
    const range = ind.max - ind.min;
    let normalized = range === 0 ? 50 : ((ind.value - ind.min) / range) * 100;
    normalized = clamp(normalized, 0, 100);
    if (ind.invert) normalized = 100 - normalized;
    const weight = (ind.weight ?? 1) / totalWeight;
    return {
      name: ind.name,
      normalizedValue: normalized,
      contribution: normalized * weight,
    };
  });

  const score = clamp(
    normalizedIndicators.reduce((s, ind) => s + ind.contribution, 0),
    0,
    100
  );

  let interpretation: string;
  if (score <= 20) interpretation = 'Extreme fear — potential contrarian buy opportunity';
  else if (score <= 35) interpretation = 'Elevated fear — market pessimistic';
  else if (score <= 65) interpretation = 'Neutral — no strong directional sentiment';
  else if (score <= 80) interpretation = 'Elevated greed — caution warranted';
  else interpretation = 'Extreme greed — potential contrarian sell opportunity';

  return { score, normalizedIndicators, interpretation };
}

// ── Vol Surface Sentiment ─────────────────────────────────

/**
 * Derive sentiment from options volatility surface shape.
 * Steep skew = crash protection demand (fear), flat/inverted = complacency.
 */
export function volSurfaceSentiment(
  skew: number,
  ivLevel: number,
  historicalIv: number[]
): VolSurfaceSentimentResult {
  // IV percentile
  const ivPct = historicalIv.length > 0
    ? percentileRank(ivLevel, historicalIv)
    : 0.5;

  // Skew signal: positive skew = puts more expensive (crash protection)
  let skewSignal: VolSurfaceSentimentResult['skewSignal'];
  if (skew > 5) skewSignal = 'crash_protection_demand';
  else if (skew < -5) skewSignal = 'upside_demand';
  else skewSignal = 'neutral';

  // Overall signal from combination of IV level and skew
  let signal: VolSurfaceSentimentResult['signal'];
  if (ivPct > 0.75 && skew > 3) signal = 'fear';
  else if (ivPct < 0.25 && skew < 3) signal = 'complacency';
  else signal = 'neutral';

  // Vol regime
  let regime: VolSurfaceSentimentResult['regime'];
  if (ivPct <= 0.25) regime = 'low_vol';
  else if (ivPct >= 0.75) regime = 'high_vol';
  else regime = 'normal_vol';

  return { signal, skewSignal, ivPercentile: ivPct, regime };
}

// ── Market Breadth ────────────────────────────────────────

/**
 * Market breadth indicators: advance/decline, % above MA.
 * Breadth divergence from price is a powerful signal.
 */
export function marketBreadth(
  data: Array<{ symbol: string; change: number; volume: number; aboveMA?: boolean }>
): MarketBreadthResult {
  if (data.length === 0) {
    return {
      advanceDeclineRatio: 1,
      advanceDeclineLine: 0,
      pctPositive: 0.5,
      pctAboveMA: 0.5,
      breadthThrust: false,
      divergence: 'none',
      interpretation: 'No data provided',
    };
  }

  const advancers = data.filter(d => d.change > 0);
  const decliners = data.filter(d => d.change < 0);

  const advanceCount = advancers.length;
  const declineCount = decliners.length;

  const advanceDeclineRatio = declineCount === 0
    ? (advanceCount > 0 ? Infinity : 1)
    : advanceCount / declineCount;

  const advanceDeclineLine = advanceCount - declineCount;

  const pctPositive = data.length === 0 ? 0.5 : advanceCount / data.length;

  const withMA = data.filter(d => d.aboveMA !== undefined);
  const pctAboveMA = withMA.length === 0
    ? 0.5
    : withMA.filter(d => d.aboveMA).length / withMA.length;

  // Breadth thrust: >80% of stocks advancing (rare, very bullish)
  const breadthThrust = pctPositive > 0.8;

  // Volume-weighted average change
  const totalVolume = data.reduce((s, d) => s + d.volume, 0);
  const volumeWeightedChange = totalVolume === 0
    ? 0
    : data.reduce((s, d) => s + d.change * d.volume, 0) / totalVolume;

  // Divergence: price (volume-weighted) going one way but breadth going another
  let divergence: MarketBreadthResult['divergence'] = 'none';
  if (volumeWeightedChange > 0 && pctPositive < 0.4) {
    divergence = 'bearish_divergence';
  } else if (volumeWeightedChange < 0 && pctPositive > 0.6) {
    divergence = 'bullish_divergence';
  }

  let interpretation: string;
  if (breadthThrust) {
    interpretation = 'Breadth thrust detected — strong bullish signal with broad participation';
  } else if (divergence === 'bearish_divergence') {
    interpretation = 'Bearish divergence — market rising on narrow leadership, internal weakness';
  } else if (divergence === 'bullish_divergence') {
    interpretation = 'Bullish divergence — broad strength despite negative headline returns';
  } else if (pctPositive > 0.6) {
    interpretation = 'Healthy breadth — majority of assets advancing';
  } else if (pctPositive < 0.4) {
    interpretation = 'Weak breadth — majority of assets declining';
  } else {
    interpretation = 'Mixed breadth — no clear directional signal';
  }

  return {
    advanceDeclineRatio,
    advanceDeclineLine,
    pctPositive,
    pctAboveMA,
    breadthThrust,
    divergence,
    interpretation,
  };
}
