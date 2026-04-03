/**
 * Volume profile analysis and correlation regime detection.
 * Pure functions — no async, no exchange clients, no MCP.
 */

import { correlation, returns, mean } from './math.js';

// ── Interfaces ────────────────────────────────────────────

export interface OHLCVCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface VolumeProfileBin {
  priceLevel: number;
  volume: number;
  pct: number;
}

export interface VolumeProfileResult {
  priceRange: { min: number; max: number };
  pointOfControl: number;
  valueArea: { high: number; low: number };
  profile: VolumeProfileBin[];
  totalVolume: number;
}

export interface CorrelationRegimeResult {
  currentCorrelation: number;
  currentRegime: 'highly_correlated' | 'moderately_correlated' | 'uncorrelated' | 'inversely_correlated';
  averageCorrelation: number;
  transitions: { index: number; from: number; to: number; type: 'decorrelation' | 'recorrelation' }[];
  rollingSeries: { index: number; correlation: number }[];
  dataPoints: number;
}

// ── Volume Profile ────────────────────────────────────────

/**
 * Compute a volume profile from OHLCV candles.
 * Distributes each candle's volume proportionally across price bins
 * based on the overlap between the candle's high-low range and each bin.
 */
export function computeVolumeProfile(
  candles: OHLCVCandle[],
  numBins: number,
): VolumeProfileResult {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const priceMin = Math.min(...lows);
  const priceMax = Math.max(...highs);
  const binSize = (priceMax - priceMin) / numBins;

  const bins: number[] = new Array(numBins).fill(0);

  for (const candle of candles) {
    const candleLow = candle.low;
    const candleHigh = candle.high;
    const candleRange = candleHigh - candleLow;

    for (let i = 0; i < numBins; i++) {
      const binLow = priceMin + i * binSize;
      const binHigh = binLow + binSize;
      const overlapLow = Math.max(candleLow, binLow);
      const overlapHigh = Math.min(candleHigh, binHigh);
      const overlap = Math.max(0, overlapHigh - overlapLow);

      if (overlap > 0) {
        const proportion = candleRange > 0 ? overlap / candleRange : 1 / numBins;
        bins[i] += candle.volume * proportion;
      }
    }
  }

  const totalVolume = Math.round(bins.reduce((a, b) => a + b, 0) * 100) / 100;

  const profile: VolumeProfileBin[] = bins.map((vol, i) => ({
    priceLevel: Math.round((priceMin + (i + 0.5) * binSize) * 100) / 100,
    volume: Math.round(vol * 100) / 100,
    pct: totalVolume > 0 ? Math.round((vol / totalVolume) * 10000) / 100 : 0,
  }));

  // Point of control: bin with highest volume
  let pocIndex = 0;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i].volume > profile[pocIndex].volume) {
      pocIndex = i;
    }
  }
  const pointOfControl = profile[pocIndex].priceLevel;

  // Value area: smallest set of bins containing 70% of total volume
  const targetVolume = totalVolume * 0.7;
  const sorted = profile
    .map((bin, idx) => ({ ...bin, idx }))
    .sort((a, b) => b.volume - a.volume);

  let accumulatedVolume = 0;
  const includedIndices: number[] = [];
  for (const bin of sorted) {
    includedIndices.push(bin.idx);
    accumulatedVolume += bin.volume;
    if (accumulatedVolume >= targetVolume) break;
  }

  includedIndices.sort((a, b) => a - b);
  const vaLow = profile[includedIndices[0]].priceLevel;
  const vaHigh = profile[includedIndices[includedIndices.length - 1]].priceLevel;

  return {
    priceRange: {
      min: Math.round(priceMin * 100) / 100,
      max: Math.round(priceMax * 100) / 100,
    },
    pointOfControl,
    valueArea: {
      high: Math.round(vaHigh * 100) / 100,
      low: Math.round(vaLow * 100) / 100,
    },
    profile,
    totalVolume,
  };
}

// ── Correlation Regime Detection ──────────────────────────

function classifyRegime(corr: number): CorrelationRegimeResult['currentRegime'] {
  if (corr > 0.7) return 'highly_correlated';
  if (corr > 0.3) return 'moderately_correlated';
  if (corr >= -0.3) return 'uncorrelated';
  return 'inversely_correlated';
}

/**
 * Detect correlation regime between two price series using a rolling window.
 * Identifies transitions (zero crossings) as decorrelation or recorrelation events.
 */
export function detectCorrelationRegime(
  closesA: number[],
  closesB: number[],
  window: number,
  maxSamples: number = 50,
): CorrelationRegimeResult {
  // Align series to same length
  const len = Math.min(closesA.length, closesB.length);
  const a = closesA.slice(0, len);
  const b = closesB.slice(0, len);

  const returnsA = returns(a);
  const returnsB = returns(b);

  const rolling: { index: number; correlation: number }[] = [];

  for (let i = window - 1; i < returnsA.length; i++) {
    const sliceA = returnsA.slice(i - window + 1, i + 1);
    const sliceB = returnsB.slice(i - window + 1, i + 1);
    const corr = correlation(sliceA, sliceB);
    rolling.push({ index: i, correlation: Math.round(corr * 100) / 100 });
  }

  // Detect transitions: zero crossings
  const transitions: CorrelationRegimeResult['transitions'] = [];
  for (let i = 1; i < rolling.length; i++) {
    const prev = rolling[i - 1].correlation;
    const curr = rolling[i].correlation;
    if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
      transitions.push({
        index: rolling[i].index,
        from: prev,
        to: curr,
        type: curr < 0 ? 'decorrelation' : 'recorrelation',
      });
    }
  }

  // Sample rolling series down to maxSamples
  let sampled = rolling;
  if (rolling.length > maxSamples) {
    const step = rolling.length / maxSamples;
    sampled = [];
    for (let i = 0; i < maxSamples; i++) {
      sampled.push(rolling[Math.floor(i * step)]);
    }
  }

  const currentCorrelation = rolling.length > 0
    ? rolling[rolling.length - 1].correlation
    : 0;

  const avgCorrelation = rolling.length > 0
    ? Math.round(mean(rolling.map(r => r.correlation)) * 100) / 100
    : 0;

  return {
    currentCorrelation,
    currentRegime: classifyRegime(currentCorrelation),
    averageCorrelation: avgCorrelation,
    transitions,
    rollingSeries: sampled,
    dataPoints: len,
  };
}
