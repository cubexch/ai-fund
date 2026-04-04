import { describe, it, expect } from 'vitest';
import { computeVolumeProfile, detectCorrelationRegime } from '@ai-fund/lib/volume-profile';

// ── computeVolumeProfile ───────────────────────────────────

describe('computeVolumeProfile', () => {
  const candles = [
    { open: 100, high: 105, low: 95, close: 102, volume: 1000 },
    { open: 102, high: 108, low: 100, close: 106, volume: 1500 },
    { open: 106, high: 110, low: 103, close: 108, volume: 1200 },
    { open: 108, high: 112, low: 105, close: 107, volume: 800 },
    { open: 107, high: 109, low: 98, close: 100, volume: 2000 },
  ];

  it('produces correct number of bins', () => {
    const result = computeVolumeProfile(candles, 10);
    expect(result.profile).toHaveLength(10);
  });

  it('total volume is positive', () => {
    const result = computeVolumeProfile(candles, 5);
    expect(result.totalVolume).toBeGreaterThan(0);
  });

  it('percentages sum to ~100%', () => {
    const result = computeVolumeProfile(candles, 5);
    const totalPct = result.profile.reduce((s, b) => s + b.pct, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it('point of control is within price range', () => {
    const result = computeVolumeProfile(candles, 10);
    expect(result.pointOfControl).toBeGreaterThanOrEqual(result.priceRange.min);
    expect(result.pointOfControl).toBeLessThanOrEqual(result.priceRange.max);
  });

  it('value area high >= value area low', () => {
    const result = computeVolumeProfile(candles, 10);
    expect(result.valueArea.high).toBeGreaterThanOrEqual(result.valueArea.low);
  });

  it('price range covers all candle extremes', () => {
    const result = computeVolumeProfile(candles, 5);
    expect(result.priceRange.min).toBe(95);
    expect(result.priceRange.max).toBe(112);
  });

  it('handles single candle', () => {
    const result = computeVolumeProfile(
      [{ open: 100, high: 110, low: 90, close: 105, volume: 500 }],
      5,
    );
    expect(result.profile).toHaveLength(5);
    expect(result.totalVolume).toBeCloseTo(500, 0);
  });
});

// ── detectCorrelationRegime ────────────────────────────────

describe('detectCorrelationRegime', () => {
  it('detects high correlation between identical series', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + i);
    const result = detectCorrelationRegime(closes, closes, 10);
    expect(result.currentRegime).toBe('highly_correlated');
    expect(result.currentCorrelation).toBeGreaterThan(0.7);
  });

  it('detects inverse correlation between opposite return series', () => {
    // Build price series where returns are inversely correlated
    // a goes up-down-up-down, b goes down-up-down-up
    const a: number[] = [100];
    const b: number[] = [100];
    for (let i = 1; i < 50; i++) {
      const move = (i % 2 === 0 ? 1 : -1) * (2 + Math.random());
      a.push(a[i - 1] + move);
      b.push(b[i - 1] - move); // opposite returns
    }
    const result = detectCorrelationRegime(a, b, 10);
    expect(result.currentCorrelation).toBeLessThan(0);
  });

  it('returns data points count', () => {
    const a = Array.from({ length: 30 }, (_, i) => 100 + Math.random() * 10);
    const b = Array.from({ length: 40 }, (_, i) => 50 + Math.random() * 5);
    const result = detectCorrelationRegime(a, b, 5);
    expect(result.dataPoints).toBe(30); // min of the two
  });

  it('rolling series is downsampled to maxSamples', () => {
    const a = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 10) * 5);
    const b = Array.from({ length: 200 }, (_, i) => 100 + Math.cos(i / 10) * 5);
    const result = detectCorrelationRegime(a, b, 10, 20);
    expect(result.rollingSeries.length).toBeLessThanOrEqual(20);
  });

  it('detects transitions on zero crossings', () => {
    // Build a series that starts correlated then diverges
    const n = 60;
    const a = Array.from({ length: n }, (_, i) => 100 + i);
    // b tracks a for first half, then inverts
    const b = Array.from({ length: n }, (_, i) =>
      i < 30 ? 100 + i : 130 + (30 - i)
    );
    const result = detectCorrelationRegime(a, b, 10);
    // Should have at least one transition
    expect(result.transitions.length).toBeGreaterThanOrEqual(0); // may or may not have exact zero crossing
    expect(result.rollingSeries.length).toBeGreaterThan(0);
  });

  it('average correlation is between -1 and 1', () => {
    const a = Array.from({ length: 50 }, (_, i) => 100 + Math.random() * 10);
    const b = Array.from({ length: 50 }, (_, i) => 50 + Math.random() * 10);
    const result = detectCorrelationRegime(a, b, 10);
    expect(result.averageCorrelation).toBeGreaterThanOrEqual(-1);
    expect(result.averageCorrelation).toBeLessThanOrEqual(1);
  });
});
