import { describe, it, expect } from 'vitest';
import {
  fearGreedIndex,
  fundingSentiment,
  putCallRatio,
  socialVolumeNormalized,
  contrarianSignal,
  longShortRatio,
  sentimentMomentum,
  compositeScore,
  volSurfaceSentiment,
  marketBreadth,
} from '@ai-fund/lib/sentiment';

// ── fearGreedIndex ──────────────────────────────────────────

describe('fearGreedIndex', () => {
  it('extreme low vol + high positive momentum → greed', () => {
    const result = fearGreedIndex({
      volatility: 0.005,
      avgVolatility: 0.02,
      momentum: 0.1,
      volume: 1000,
      avgVolume: 1000,
      highLowRange: 0.005,
      avgHighLowRange: 0.02,
    });
    expect(result.index).toBeGreaterThan(60);
    expect(['greed', 'extreme_greed']).toContain(result.label);
  });

  it('high vol + negative momentum → fear', () => {
    const result = fearGreedIndex({
      volatility: 0.06,
      avgVolatility: 0.02,
      momentum: -0.1,
      volume: 2000,
      avgVolume: 1000,
      highLowRange: 0.06,
      avgHighLowRange: 0.02,
    });
    expect(result.index).toBeLessThan(40);
    expect(['fear', 'extreme_fear']).toContain(result.label);
  });

  it('index bounded [0, 100]', () => {
    // Extreme inputs
    const resultHigh = fearGreedIndex({
      volatility: 0, avgVolatility: 0.02, momentum: 1,
      volume: 10000, avgVolume: 1000, highLowRange: 0, avgHighLowRange: 0.02,
    });
    expect(resultHigh.index).toBeLessThanOrEqual(100);
    expect(resultHigh.index).toBeGreaterThanOrEqual(0);

    const resultLow = fearGreedIndex({
      volatility: 0.1, avgVolatility: 0.01, momentum: -1,
      volume: 10000, avgVolume: 1000, highLowRange: 0.1, avgHighLowRange: 0.01,
    });
    expect(resultLow.index).toBeLessThanOrEqual(100);
    expect(resultLow.index).toBeGreaterThanOrEqual(0);
  });

  it('includes funding rate component when provided', () => {
    const result = fearGreedIndex({
      volatility: 0.02, avgVolatility: 0.02, momentum: 0,
      volume: 1000, avgVolume: 1000, highLowRange: 0.02, avgHighLowRange: 0.02,
      fundingRate: 0.01,
    });
    expect(result.components.funding).toBeDefined();
    expect(result.components.funding.weight).toBeCloseTo(0.15);
  });

  it('neutral inputs → neutral label', () => {
    const result = fearGreedIndex({
      volatility: 0.02, avgVolatility: 0.02, momentum: 0,
      volume: 1000, avgVolume: 1000, highLowRange: 0.02, avgHighLowRange: 0.02,
    });
    expect(result.label).toBe('neutral');
  });
});

// ── fundingSentiment ────────────────────────────────────────

describe('fundingSentiment', () => {
  it('rates 3+ stddev above mean → crowded_long', () => {
    const rates = [0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.001, 0.005];
    const result = fundingSentiment(rates);
    expect(result.sentiment).toBe('crowded_long');
    expect(result.zScore).toBeGreaterThan(1.5);
  });

  it('rates 3+ stddev below mean → crowded_short', () => {
    const rates = [-0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.001, -0.005];
    const result = fundingSentiment(rates);
    expect(result.sentiment).toBe('crowded_short');
    expect(result.zScore).toBeLessThan(-1.5);
  });

  it('neutral zone for moderate rates', () => {
    const rates = [0.0001, 0.0002, -0.0001, 0.0001, -0.0002, 0.0001, 0.0002, -0.0001, 0.0001, 0.0001];
    const result = fundingSentiment(rates);
    expect(result.sentiment).toBe('neutral');
  });

  it('empty input → neutral with defaults', () => {
    const result = fundingSentiment([]);
    expect(result.sentiment).toBe('neutral');
    expect(result.percentile).toBe(0.5);
    expect(result.zScore).toBe(0);
  });

  it('mean revert signal when z > 2', () => {
    const rates = [0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.005];
    const result = fundingSentiment(rates);
    if (Math.abs(result.zScore) > 2) {
      expect(result.meanRevertSignal).toBe(true);
    }
  });
});

// ── putCallRatio ────────────────────────────────────────────

describe('putCallRatio', () => {
  it('high put volume → extreme_bearish', () => {
    const result = putCallRatio({ putVolume: 2000, callVolume: 1000, putOI: 3000, callOI: 1000 });
    expect(result.signal).toBe('extreme_bearish');
    expect(result.contrarian).toBe(true);
  });

  it('high call volume → extreme_bullish', () => {
    const result = putCallRatio({ putVolume: 200, callVolume: 1000, putOI: 300, callOI: 1000 });
    expect(result.signal).toBe('extreme_bullish');
    expect(result.contrarian).toBe(true);
  });

  it('balanced volumes → neutral', () => {
    const result = putCallRatio({ putVolume: 900, callVolume: 1000, putOI: 950, callOI: 1000 });
    expect(result.signal).toBe('neutral');
    expect(result.contrarian).toBe(false);
  });

  it('calculates volume and OI ratios correctly', () => {
    const result = putCallRatio({ putVolume: 500, callVolume: 1000, putOI: 600, callOI: 1200 });
    expect(result.volumeRatio).toBeCloseTo(0.5);
    expect(result.oiRatio).toBeCloseTo(0.5);
  });

  it('zero call volume → Infinity ratios', () => {
    const result = putCallRatio({ putVolume: 100, callVolume: 0, putOI: 100, callOI: 0 });
    expect(result.volumeRatio).toBe(Infinity);
    expect(result.oiRatio).toBe(Infinity);
  });
});

// ── socialVolumeNormalized ──────────────────────────────────

describe('socialVolumeNormalized', () => {
  it('spike detection at 2+ stddev', () => {
    const volumes = [10, 12, 11, 10, 13, 11, 10, 50, 12]; // spike at index 7
    const prices = [100, 101, 102, 101, 103, 102, 101, 100, 99];
    const result = socialVolumeNormalized(volumes, prices);
    expect(result.spikes.length).toBeGreaterThanOrEqual(1);
    expect(result.spikes.some(s => s.index === 7)).toBe(true);
  });

  it('divergence when social volume up but price down', () => {
    // High social volume in recent periods, price declining
    // Need last 3 normalized volumes to average > 1.5 stddev AND recent price return < 0
    const volumes = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 100, 110, 120];
    const prices = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 98, 95, 90];
    const result = socialVolumeNormalized(volumes, prices);
    expect(result.divergence).toBe(true);
  });

  it('empty inputs → safe defaults', () => {
    const result = socialVolumeNormalized([], []);
    expect(result.normalizedVolume).toEqual([]);
    expect(result.currentZScore).toBe(0);
    expect(result.spikes).toEqual([]);
    expect(result.divergence).toBe(false);
  });

  it('single data point → no spikes', () => {
    const result = socialVolumeNormalized([10], [100]);
    expect(result.spikes).toEqual([]);
    expect(result.currentZScore).toBe(0);
  });

  it('all-same volumes → zScore 0', () => {
    const volumes = [10, 10, 10, 10, 10];
    const prices = [100, 101, 102, 103, 104];
    const result = socialVolumeNormalized(volumes, prices);
    expect(result.currentZScore).toBe(0);
  });
});

// ── contrarianSignal ────────────────────────────────────────

describe('contrarianSignal', () => {
  it('extreme fear + low price → contrarian_buy', () => {
    const historicalSentiment = Array.from({ length: 100 }, (_, i) => 30 + i * 0.4); // 30 to 70
    const historicalPrices = Array.from({ length: 100 }, (_, i) => 100 + i);
    const result = contrarianSignal({
      sentiment: 5,   // extreme low
      price: 50,
      historicalSentiment,
      historicalPrices,
      threshold: 0.85,
    });
    expect(result.signal).toBe('contrarian_buy');
    expect(result.sentimentPercentile).toBeLessThan(0.15);
  });

  it('extreme greed + high price → contrarian_sell', () => {
    const historicalSentiment = Array.from({ length: 100 }, (_, i) => 30 + i * 0.4);
    const historicalPrices = Array.from({ length: 100 }, (_, i) => 100 + i);
    const result = contrarianSignal({
      sentiment: 95,  // extreme high
      price: 300,
      historicalSentiment,
      historicalPrices,
      threshold: 0.85,
    });
    expect(result.signal).toBe('contrarian_sell');
    expect(result.sentimentPercentile).toBeGreaterThan(0.85);
  });

  it('neutral sentiment → neutral signal', () => {
    const historicalSentiment = Array.from({ length: 100 }, (_, i) => 30 + i * 0.4);
    const result = contrarianSignal({
      sentiment: 50,
      price: 150,
      historicalSentiment,
      historicalPrices: Array.from({ length: 100 }, () => 150),
    });
    expect(result.signal).toBe('neutral');
  });

  it('empty historical data → neutral', () => {
    const result = contrarianSignal({
      sentiment: 80,
      price: 100,
      historicalSentiment: [],
      historicalPrices: [],
    });
    expect(result.signal).toBe('neutral');
    expect(result.confidence).toBe(0);
  });

  it('confidence bounded [0, 1]', () => {
    const historicalSentiment = Array.from({ length: 100 }, (_, i) => i);
    const historicalPrices = Array.from({ length: 100 }, (_, i) => 100 + i);
    const result = contrarianSignal({
      sentiment: 0,
      price: 50,
      historicalSentiment,
      historicalPrices,
    });
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

// ── longShortRatio ──────────────────────────────────────────

describe('longShortRatio', () => {
  it('90% long → long_crowded', () => {
    const result = longShortRatio({
      longAccounts: 900, shortAccounts: 100,
      longVolume: 9000, shortVolume: 1000,
    });
    expect(result.crowding).toBe('long_crowded');
    expect(result.accountRatio).toBeCloseTo(0.9);
  });

  it('90% short → short_crowded', () => {
    const result = longShortRatio({
      longAccounts: 100, shortAccounts: 900,
      longVolume: 1000, shortVolume: 9000,
    });
    expect(result.crowding).toBe('short_crowded');
    expect(result.accountRatio).toBeCloseTo(0.1);
  });

  it('balanced → balanced', () => {
    const result = longShortRatio({
      longAccounts: 500, shortAccounts: 500,
      longVolume: 5000, shortVolume: 5000,
    });
    expect(result.crowding).toBe('balanced');
    expect(result.accountRatio).toBeCloseTo(0.5);
    expect(result.volumeRatio).toBeCloseTo(0.5);
  });

  it('reversal risk higher when more crowded', () => {
    const balanced = longShortRatio({
      longAccounts: 500, shortAccounts: 500,
      longVolume: 5000, shortVolume: 5000,
    });
    const crowded = longShortRatio({
      longAccounts: 900, shortAccounts: 100,
      longVolume: 9000, shortVolume: 1000,
    });
    expect(crowded.reversalRisk).toBeGreaterThan(balanced.reversalRisk);
  });

  it('zero accounts → default ratio 1', () => {
    const result = longShortRatio({
      longAccounts: 0, shortAccounts: 0,
      longVolume: 0, shortVolume: 0,
    });
    expect(result.accountRatio).toBe(1);
    expect(result.volumeRatio).toBe(1);
  });
});

// ── sentimentMomentum ───────────────────────────────────────

describe('sentimentMomentum', () => {
  it('increasing sentiment → improving', () => {
    // Long flat then ramp up
    const series = [...Array(20).fill(40), ...Array(10).fill(60)];
    const result = sentimentMomentum(series);
    expect(result.trend).toBe('improving');
    expect(result.momentum).toBeGreaterThan(0);
  });

  it('decreasing sentiment → deteriorating', () => {
    const series = [...Array(20).fill(60), ...Array(10).fill(40)];
    const result = sentimentMomentum(series);
    expect(result.trend).toBe('deteriorating');
    expect(result.momentum).toBeLessThan(0);
  });

  it('flat sentiment → stable', () => {
    const series = Array(30).fill(50);
    const result = sentimentMomentum(series);
    expect(result.trend).toBe('stable');
    expect(result.momentum).toBeCloseTo(0);
  });

  it('single data point → stable with zero momentum', () => {
    const result = sentimentMomentum([50]);
    expect(result.trend).toBe('stable');
    expect(result.momentum).toBe(0);
  });

  it('empty series → stable', () => {
    const result = sentimentMomentum([]);
    expect(result.trend).toBe('stable');
    expect(result.momentum).toBe(0);
  });
});

// ── compositeScore ──────────────────────────────────────────

describe('compositeScore', () => {
  it('equal indicators at midpoint → score near 50', () => {
    const result = compositeScore([
      { name: 'A', value: 50, min: 0, max: 100 },
      { name: 'B', value: 50, min: 0, max: 100 },
    ]);
    expect(result.score).toBeCloseTo(50, 0);
  });

  it('inverted indicator works correctly', () => {
    const normal = compositeScore([{ name: 'X', value: 80, min: 0, max: 100, invert: false }]);
    const inverted = compositeScore([{ name: 'X', value: 80, min: 0, max: 100, invert: true }]);
    expect(normal.score).toBeCloseTo(80, 0);
    expect(inverted.score).toBeCloseTo(20, 0);
  });

  it('empty indicators → score 50', () => {
    const result = compositeScore([]);
    expect(result.score).toBe(50);
    expect(result.normalizedIndicators).toEqual([]);
  });

  it('all max values → score 100', () => {
    const result = compositeScore([
      { name: 'A', value: 100, min: 0, max: 100 },
      { name: 'B', value: 100, min: 0, max: 100 },
    ]);
    expect(result.score).toBeCloseTo(100);
  });

  it('all min values → score 0', () => {
    const result = compositeScore([
      { name: 'A', value: 0, min: 0, max: 100 },
      { name: 'B', value: 0, min: 0, max: 100 },
    ]);
    expect(result.score).toBeCloseTo(0);
  });

  it('respects weights', () => {
    const result = compositeScore([
      { name: 'A', value: 100, min: 0, max: 100, weight: 3 },
      { name: 'B', value: 0, min: 0, max: 100, weight: 1 },
    ]);
    // Weighted: (100 * 3/4) + (0 * 1/4) = 75
    expect(result.score).toBeCloseTo(75, 0);
  });
});

// ── volSurfaceSentiment ─────────────────────────────────────

describe('volSurfaceSentiment', () => {
  it('high skew → crash_protection_demand', () => {
    const result = volSurfaceSentiment(10, 30, [20, 22, 25, 28, 30]);
    expect(result.skewSignal).toBe('crash_protection_demand');
  });

  it('negative skew → upside_demand', () => {
    const result = volSurfaceSentiment(-10, 25, [20, 22, 25, 28, 30]);
    expect(result.skewSignal).toBe('upside_demand');
  });

  it('high IV percentile → fear', () => {
    const historicalIv = Array.from({ length: 100 }, (_, i) => 10 + i * 0.2); // 10 to 30
    const result = volSurfaceSentiment(8, 35, historicalIv); // IV above most history + positive skew
    expect(result.signal).toBe('fear');
    expect(result.ivPercentile).toBeGreaterThan(0.75);
  });

  it('low IV percentile + low skew → complacency', () => {
    const historicalIv = Array.from({ length: 100 }, (_, i) => 20 + i * 0.3); // 20 to 50
    const result = volSurfaceSentiment(1, 15, historicalIv);
    expect(result.signal).toBe('complacency');
    expect(result.ivPercentile).toBeLessThan(0.25);
  });

  it('regime classification based on IV percentile', () => {
    const historicalIv = Array.from({ length: 100 }, (_, i) => i);
    const low = volSurfaceSentiment(0, 5, historicalIv);
    expect(low.regime).toBe('low_vol');
    const high = volSurfaceSentiment(0, 95, historicalIv);
    expect(high.regime).toBe('high_vol');
    const normal = volSurfaceSentiment(0, 50, historicalIv);
    expect(normal.regime).toBe('normal_vol');
  });

  it('empty historical IV → defaults', () => {
    const result = volSurfaceSentiment(0, 20, []);
    expect(result.ivPercentile).toBe(0.5);
    expect(result.regime).toBe('normal_vol');
  });
});

// ── marketBreadth ───────────────────────────────────────────

describe('marketBreadth', () => {
  it('all advancing → high advanceDeclineRatio', () => {
    const data = [
      { symbol: 'A', change: 0.05, volume: 100 },
      { symbol: 'B', change: 0.03, volume: 200 },
      { symbol: 'C', change: 0.01, volume: 150 },
    ];
    const result = marketBreadth(data);
    expect(result.advanceDeclineRatio).toBe(Infinity);
    expect(result.pctPositive).toBe(1);
    expect(result.breadthThrust).toBe(true);
  });

  it('price up but few advancing → bearish_divergence', () => {
    const data = [
      { symbol: 'A', change: 0.20, volume: 1000 },  // big cap up a lot
      { symbol: 'B', change: -0.02, volume: 100 },
      { symbol: 'C', change: -0.01, volume: 100 },
      { symbol: 'D', change: -0.03, volume: 100 },
      { symbol: 'E', change: -0.02, volume: 100 },
    ];
    const result = marketBreadth(data);
    expect(result.divergence).toBe('bearish_divergence');
  });

  it('price down but many advancing → bullish_divergence', () => {
    const data = [
      { symbol: 'A', change: -0.30, volume: 1000 },  // big cap down a lot
      { symbol: 'B', change: 0.02, volume: 100 },
      { symbol: 'C', change: 0.01, volume: 100 },
      { symbol: 'D', change: 0.03, volume: 100 },
      { symbol: 'E', change: 0.02, volume: 100 },
    ];
    const result = marketBreadth(data);
    expect(result.divergence).toBe('bullish_divergence');
  });

  it('empty data → safe defaults', () => {
    const result = marketBreadth([]);
    expect(result.advanceDeclineRatio).toBe(1);
    expect(result.pctPositive).toBe(0.5);
    expect(result.breadthThrust).toBe(false);
    expect(result.divergence).toBe('none');
  });

  it('advance-decline line = advancers - decliners', () => {
    const data = [
      { symbol: 'A', change: 0.05, volume: 100 },
      { symbol: 'B', change: -0.05, volume: 100 },
      { symbol: 'C', change: 0.03, volume: 100 },
    ];
    const result = marketBreadth(data);
    expect(result.advanceDeclineLine).toBe(1); // 2 - 1
  });

  it('pctAboveMA calculated from aboveMA field', () => {
    const data = [
      { symbol: 'A', change: 0.01, volume: 100, aboveMA: true },
      { symbol: 'B', change: -0.01, volume: 100, aboveMA: false },
      { symbol: 'C', change: 0.02, volume: 100, aboveMA: true },
      { symbol: 'D', change: -0.02, volume: 100, aboveMA: false },
    ];
    const result = marketBreadth(data);
    expect(result.pctAboveMA).toBeCloseTo(0.5);
  });
});
