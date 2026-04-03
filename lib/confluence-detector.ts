/**
 * Exchange-agnostic confluence detection and related analysis.
 * Pure functions that take typed inputs (OHLCV arrays) and return structured results.
 * No exchange client imports, no MCP, no zod.
 */

import {
  sma, ema, rsi, macd, bollingerBands,
  type OHLCV,
} from './indicators.js';
import {
  mean, standardDeviation, zScore, returns,
} from './math.js';

// ── Types ────────────────────────────────────────────────

export interface TimeframeSignal {
  rsi: number;
  rsiSignal: 'overbought' | 'oversold' | 'neutral';
  macd: 'bullish' | 'bearish';
  trend: 'bullish' | 'bearish';
  bbPosition: 'inside' | 'above_upper' | 'below_lower';
  priceVsEma: 'above' | 'below';
}

export interface ConfluenceResult {
  signals: Record<string, TimeframeSignal>;
  confluence: {
    bullish: number;
    bearish: number;
    score: number;
    direction: 'bullish' | 'bearish';
    strength: 'strong' | 'moderate' | 'weak';
  };
  recommendation: string;
}

export interface BbSqueezeResult {
  symbol: string;
  inSqueeze: boolean;
  bandwidth: number;
  avgBandwidth: number;
  squeezeRatio: number;
  squeezeDuration: number;
  pricePosition: 'above_middle' | 'below_middle';
  signal: string;
}

export interface MeanReversionEntry {
  symbol: string;
  currentPrice: number;
  mean: number;
  std: number;
  zscore: number;
  signal: 'overbought' | 'oversold' | 'neutral';
  deviationPct: number;
}

export interface MeanReversionError {
  symbol: string;
  error: string;
}

export type MeanReversionResult = MeanReversionEntry | MeanReversionError;

export interface VolTermStructureEntry {
  timeframe: string;
  annualizedVolatility: number;
  sampleSize: number;
  periodsPerYear: number;
}

export interface VolTermStructureRatio {
  from: string;
  to: string;
  ratio: number | null;
}

export interface VolTermStructureResult {
  structure: VolTermStructureEntry[];
  ratios: VolTermStructureRatio[];
  classification: 'normal' | 'inverted' | 'mixed';
}

// ── Periods-per-year lookup ──────────────────────────────

export const PERIODS_PER_YEAR: Record<string, number> = {
  '1m': 525600,
  '5m': 105120,
  '15m': 35040,
  '1h': 8760,
  '4h': 2190,
  '1d': 365,
  '1w': 52,
};

// ── Multi-timeframe confluence detection ─────────────────

/**
 * Analyze a single timeframe's bars and produce signal classification.
 * Requires at least 51 bars (for SMA(50)).
 */
export function analyzeTimeframeSignals(candles: OHLCV[]): TimeframeSignal {
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  // RSI(14)
  const rsi14 = rsi(closes, 14);
  const rsiValue = rsi14.length > 0 ? Math.round(rsi14[rsi14.length - 1] * 100) / 100 : 50;
  const rsiSignal: TimeframeSignal['rsiSignal'] =
    rsiValue > 70 ? 'overbought' : rsiValue < 30 ? 'oversold' : 'neutral';

  // MACD histogram sign
  const macdResult = macd(closes, 12, 26, 9);
  const histogram = macdResult.histogram.length > 0
    ? macdResult.histogram[macdResult.histogram.length - 1] : 0;
  const macdSignal: TimeframeSignal['macd'] = histogram > 0 ? 'bullish' : 'bearish';

  // SMA(20) vs SMA(50)
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma20Val = sma20.length > 0 ? sma20[sma20.length - 1] : 0;
  const sma50Val = sma50.length > 0 ? sma50[sma50.length - 1] : 0;
  const trend: TimeframeSignal['trend'] = sma20Val > sma50Val ? 'bullish' : 'bearish';

  // Bollinger Band position
  const bb = bollingerBands(closes, 20, 2);
  let bbPosition: TimeframeSignal['bbPosition'] = 'inside';
  if (bb.upper.length > 0) {
    const upperVal = bb.upper[bb.upper.length - 1];
    const lowerVal = bb.lower[bb.lower.length - 1];
    if (currentPrice > upperVal) bbPosition = 'above_upper';
    else if (currentPrice < lowerVal) bbPosition = 'below_lower';
  }

  // Price vs EMA(20)
  const ema20 = ema(closes, 20);
  const ema20Val = ema20.length > 0 ? ema20[ema20.length - 1] : currentPrice;
  const priceVsEma: TimeframeSignal['priceVsEma'] = currentPrice > ema20Val ? 'above' : 'below';

  return { rsi: rsiValue, rsiSignal, macd: macdSignal, trend, bbPosition, priceVsEma };
}

/**
 * Aggregate signals across multiple timeframes into a confluence score.
 * @param barsPerTimeframe - map of timeframe label to OHLCV array (each needs >= 51 bars)
 */
export function detectConfluence(
  barsPerTimeframe: Record<string, OHLCV[]>
): ConfluenceResult {
  const tfList = Object.keys(barsPerTimeframe);
  const signals: Record<string, TimeframeSignal> = {};
  let bullishCount = 0;
  let bearishCount = 0;

  for (const tf of tfList) {
    const candles = barsPerTimeframe[tf];
    const sig = analyzeTimeframeSignals(candles);

    // Count bullish/bearish signals for this timeframe
    let tfBullish = 0;
    let tfBearish = 0;

    if (sig.macd === 'bullish') tfBullish++; else tfBearish++;
    if (sig.trend === 'bullish') tfBullish++; else tfBearish++;
    if (sig.priceVsEma === 'above') tfBullish++; else tfBearish++;
    if (sig.rsiSignal === 'overbought') tfBearish++;
    else if (sig.rsiSignal === 'oversold') tfBullish++;
    if (sig.bbPosition === 'above_upper') tfBearish++;
    else if (sig.bbPosition === 'below_lower') tfBullish++;

    if (tfBullish > tfBearish) bullishCount++;
    else if (tfBearish > tfBullish) bearishCount++;

    signals[tf] = sig;
  }

  const total = tfList.length;
  const dominant: 'bullish' | 'bearish' = bullishCount >= bearishCount ? 'bullish' : 'bearish';
  const dominantCount = Math.max(bullishCount, bearishCount);
  const score = Math.round((dominantCount / total) * 100);
  const strength: 'strong' | 'moderate' | 'weak' =
    score >= 80 ? 'strong' : score >= 60 ? 'moderate' : 'weak';

  const recommendation =
    `${strength.charAt(0).toUpperCase() + strength.slice(1)} ${dominant} confluence across ${dominantCount}/${total} timeframes`;

  return {
    signals,
    confluence: { bullish: bullishCount, bearish: bearishCount, score, direction: dominant, strength },
    recommendation,
  };
}

// ── BB Squeeze detection ─────────────────────────────────

/**
 * Detect Bollinger Band squeeze for a single symbol's bars.
 * @param closes - close price series (needs at least period + 1 values)
 * @param period - Bollinger Band period (default 20)
 * @param squeezeThreshold - squeeze if bandwidth < threshold * mean bandwidth (default 0.5)
 */
export function detectBbSqueeze(
  closes: number[],
  period: number = 20,
  squeezeThreshold: number = 0.5,
): Omit<BbSqueezeResult, 'symbol'> {
  const bb = bollingerBands(closes, period, 2);

  if (bb.upper.length === 0) {
    throw new Error('Could not compute Bollinger Bands — insufficient data');
  }

  // Compute bandwidth series: (upper - lower) / middle * 100
  const bandwidthSeries: number[] = [];
  for (let i = 0; i < bb.upper.length; i++) {
    const bw = bb.middle[i] !== 0
      ? ((bb.upper[i] - bb.lower[i]) / bb.middle[i]) * 100
      : 0;
    bandwidthSeries.push(bw);
  }

  const currentBandwidth = bandwidthSeries[bandwidthSeries.length - 1];
  const avgBandwidth = mean(bandwidthSeries);
  const squeezeRatio = avgBandwidth !== 0 ? currentBandwidth / avgBandwidth : 1;
  const inSqueeze = squeezeRatio < squeezeThreshold;

  // Squeeze duration: consecutive bars below threshold
  let squeezeDuration = 0;
  if (inSqueeze) {
    for (let i = bandwidthSeries.length - 1; i >= 0; i--) {
      const ratio = avgBandwidth !== 0 ? bandwidthSeries[i] / avgBandwidth : 1;
      if (ratio < squeezeThreshold) {
        squeezeDuration++;
      } else {
        break;
      }
    }
  }

  // Direction hint: price vs middle band
  const currentPrice = closes[closes.length - 1];
  const currentMiddle = bb.middle[bb.middle.length - 1];
  const pricePosition: BbSqueezeResult['pricePosition'] =
    currentPrice > currentMiddle ? 'above_middle' : 'below_middle';

  // Build signal string
  let signal: string;
  if (inSqueeze) {
    const bias = pricePosition === 'above_middle' ? 'bullish' : 'bearish';
    if (squeezeDuration >= 10) {
      signal = `Extended squeeze (${squeezeDuration} bars) — breakout imminent, bias ${bias}`;
    } else {
      signal = `Tight squeeze — breakout imminent, bias ${bias}`;
    }
  } else {
    signal = 'No squeeze — normal volatility';
  }

  return {
    inSqueeze,
    bandwidth: Math.round(currentBandwidth * 10000) / 10000,
    avgBandwidth: Math.round(avgBandwidth * 10000) / 10000,
    squeezeRatio: Math.round(squeezeRatio * 10000) / 10000,
    squeezeDuration,
    pricePosition,
    signal,
  };
}

// ── Mean reversion scanning ──────────────────────────────

/**
 * Compute mean reversion z-score for a single symbol's close prices.
 * @param closes - close price series
 * @param lookback - lookback period for mean/std calculation
 * @param zscoreThreshold - z-score threshold to flag opportunities
 */
export function scanMeanReversion(
  closes: number[],
  lookback: number,
  zscoreThreshold: number,
): Omit<MeanReversionEntry, 'symbol'> {
  const lookbackCloses = closes.slice(-lookback);
  const currentPrice = closes[closes.length - 1];

  const avg = mean(lookbackCloses);
  const std = standardDeviation(lookbackCloses);

  if (std === 0) {
    return {
      currentPrice,
      mean: avg,
      std: 0,
      zscore: 0,
      signal: 'neutral',
      deviationPct: 0,
    };
  }

  const z = zScore(currentPrice, lookbackCloses);
  const deviationPct = ((currentPrice - avg) / avg) * 100;

  let signal: 'overbought' | 'oversold' | 'neutral';
  if (z > zscoreThreshold) {
    signal = 'overbought';
  } else if (z < -zscoreThreshold) {
    signal = 'oversold';
  } else {
    signal = 'neutral';
  }

  return {
    currentPrice: Math.round(currentPrice * 100) / 100,
    mean: Math.round(avg * 100) / 100,
    std: Math.round(std * 100) / 100,
    zscore: Math.round(z * 10000) / 10000,
    signal,
    deviationPct: Math.round(deviationPct * 100) / 100,
  };
}

// ── Volatility term structure ────────────────────────────

/**
 * Build volatility term structure from multiple timeframes.
 * @param barsPerTimeframe - map of timeframe label to close price arrays
 */
export function computeVolTermStructure(
  barsPerTimeframe: Record<string, number[]>
): VolTermStructureResult {
  const tfList = Object.keys(barsPerTimeframe);

  const structure: VolTermStructureEntry[] = [];

  for (const tf of tfList) {
    const closes = barsPerTimeframe[tf];
    const rets = returns(closes);
    const std = standardDeviation(rets);
    const ppy = PERIODS_PER_YEAR[tf] ?? 365;
    const annVol = std * Math.sqrt(ppy);

    structure.push({
      timeframe: tf,
      annualizedVolatility: Math.round(annVol * 10000) / 10000,
      sampleSize: rets.length,
      periodsPerYear: ppy,
    });
  }

  // Compute volatility ratios between adjacent timeframes
  const ratios: VolTermStructureRatio[] = [];
  for (let i = 0; i < structure.length - 1; i++) {
    const ratio = structure[i + 1].annualizedVolatility !== 0
      ? structure[i].annualizedVolatility / structure[i + 1].annualizedVolatility
      : null;
    ratios.push({
      from: structure[i].timeframe,
      to: structure[i + 1].timeframe,
      ratio: ratio != null ? Math.round(ratio * 10000) / 10000 : null,
    });
  }

  // Classify: normal = longer timeframes have higher annualized vol;
  // inverted = shorter timeframes have higher annualized vol
  let increasingCount = 0;
  let decreasingCount = 0;
  for (let i = 0; i < structure.length - 1; i++) {
    if (structure[i + 1].annualizedVolatility > structure[i].annualizedVolatility) {
      increasingCount++;
    } else {
      decreasingCount++;
    }
  }

  const classification: 'normal' | 'inverted' | 'mixed' =
    structure.length <= 1 ? 'normal' :
    increasingCount > decreasingCount ? 'normal' :
    decreasingCount > increasingCount ? 'inverted' :
    'mixed';

  return { structure, ratios, classification };
}
