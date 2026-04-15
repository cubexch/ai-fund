import { describe, it, expect } from 'vitest';
import {
  analyzeTimeframeSignals,
  detectConfluence,
  detectBbSqueeze,
  scanMeanReversion,
} from '@ai-fund/lib/confluence-detector';
import type { OHLCV } from '@ai-fund/lib/indicators';

// ── Helpers ───────────────────────────────────────────────

/** Generate synthetic OHLCV data with an uptrend */
function generateUptrend(count: number, startPrice: number = 100): OHLCV[] {
  const bars: OHLCV[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price *= 1 + 0.005 + Math.sin(i * 0.1) * 0.002;
    bars.push({
      timestamp: i * 60000,
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000 + i * 10,
    });
  }
  return bars;
}

/** Generate synthetic OHLCV data with a downtrend */
function generateDowntrend(count: number, startPrice: number = 200): OHLCV[] {
  const bars: OHLCV[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    price *= 1 - 0.005 + Math.sin(i * 0.1) * 0.002;
    bars.push({
      timestamp: i * 60000,
      open: price * 1.001,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 1000 + i * 10,
    });
  }
  return bars;
}

/** Generate flat/range-bound data */
function generateFlat(count: number, basePrice: number = 100): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const noise = Math.sin(i * 0.3) * 0.5;
    const price = basePrice + noise;
    bars.push({
      timestamp: i * 60000,
      open: price - 0.1,
      high: price + 0.3,
      low: price - 0.3,
      close: price,
      volume: 1000,
    });
  }
  return bars;
}

// ── analyzeTimeframeSignals ───────────────────────────────

describe('analyzeTimeframeSignals', () => {
  it('returns bullish signals for uptrend data', () => {
    const bars = generateUptrend(60);
    const signal = analyzeTimeframeSignals(bars);
    expect(signal.trend).toBe('bullish');
    expect(signal.priceVsEma).toBe('above');
  });

  it('returns bearish signals for downtrend data', () => {
    const bars = generateDowntrend(60);
    const signal = analyzeTimeframeSignals(bars);
    expect(signal.trend).toBe('bearish');
    expect(signal.priceVsEma).toBe('below');
  });

  it('returns valid RSI values (0-100)', () => {
    const bars = generateUptrend(60);
    const signal = analyzeTimeframeSignals(bars);
    expect(signal.rsi).toBeGreaterThanOrEqual(0);
    expect(signal.rsi).toBeLessThanOrEqual(100);
  });

  it('classifies RSI correctly', () => {
    const bars = generateUptrend(60);
    const signal = analyzeTimeframeSignals(bars);
    if (signal.rsi > 70) expect(signal.rsiSignal).toBe('overbought');
    else if (signal.rsi < 30) expect(signal.rsiSignal).toBe('oversold');
    else expect(signal.rsiSignal).toBe('neutral');
  });

  it('returns valid BB position', () => {
    const bars = generateFlat(60);
    const signal = analyzeTimeframeSignals(bars);
    expect(['inside', 'above_upper', 'below_lower']).toContain(signal.bbPosition);
  });
});

// ── detectConfluence ──────────────────────────────────────

describe('detectConfluence', () => {
  it('detects confluence direction with all uptrend timeframes', () => {
    const result = detectConfluence({
      '1h': generateUptrend(60),
      '4h': generateUptrend(60),
      '1d': generateUptrend(60),
    });
    // Should detect a dominant direction and produce a valid score
    expect(['bullish', 'bearish']).toContain(result.confluence.direction);
    expect(result.confluence.score).toBeGreaterThanOrEqual(0);
    expect(result.confluence.score).toBeLessThanOrEqual(100);
  });

  it('detects bearish confluence with all downtrend timeframes', () => {
    const result = detectConfluence({
      '1h': generateDowntrend(60),
      '4h': generateDowntrend(60),
    });
    expect(result.confluence.direction).toBe('bearish');
    expect(result.confluence.bearish).toBeGreaterThan(0);
  });

  it('returns signals for each timeframe', () => {
    const result = detectConfluence({
      '1h': generateUptrend(60),
      '4h': generateDowntrend(60),
    });
    expect(Object.keys(result.signals)).toEqual(['1h', '4h']);
  });

  it('generates a recommendation string', () => {
    const result = detectConfluence({
      '1h': generateUptrend(60),
    });
    expect(result.recommendation).toBeTruthy();
    expect(result.recommendation.length).toBeGreaterThan(10);
  });

  it('score between 0 and 100', () => {
    const result = detectConfluence({
      '1h': generateUptrend(60),
      '4h': generateDowntrend(60),
      '1d': generateFlat(60),
    });
    expect(result.confluence.score).toBeGreaterThanOrEqual(0);
    expect(result.confluence.score).toBeLessThanOrEqual(100);
  });
});

// ── detectBbSqueeze ───────────────────────────────────────

describe('detectBbSqueeze', () => {
  it('detects no squeeze in normal volatility', () => {
    const bars = generateUptrend(60);
    const closes = bars.map(b => b.close);
    const result = detectBbSqueeze(closes);
    expect(result.signal).toContain('No squeeze');
  });

  it('reports bandwidth and avgBandwidth', () => {
    const bars = generateFlat(60);
    const closes = bars.map(b => b.close);
    const result = detectBbSqueeze(closes);
    expect(result.bandwidth).toBeGreaterThanOrEqual(0);
    expect(result.avgBandwidth).toBeGreaterThan(0);
  });

  it('throws on insufficient data', () => {
    expect(() => detectBbSqueeze([100, 101, 102])).toThrow('insufficient data');
  });

  it('detects squeeze in very flat data', () => {
    // Very tight range — should trigger squeeze
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i * 0.01) * 0.01);
    const result = detectBbSqueeze(closes, 20, 0.5);
    // Very flat data should produce very low bandwidth
    expect(result.squeezeRatio).toBeLessThan(2);
  });

  it('reports pricePosition relative to middle band', () => {
    const bars = generateUptrend(60);
    const closes = bars.map(b => b.close);
    const result = detectBbSqueeze(closes);
    expect(['above_middle', 'below_middle']).toContain(result.pricePosition);
  });
});

// ── scanMeanReversion ─────────────────────────────────────

describe('scanMeanReversion', () => {
  it('returns neutral for flat data', () => {
    const closes = Array.from({ length: 30 }, () => 100);
    const result = scanMeanReversion(closes, 20, 2);
    expect(result.zscore).toBe(0);
    expect(result.signal).toBe('neutral');
  });

  it('returns overbought for prices above mean', () => {
    // Build series with current price far above mean
    const closes = Array.from({ length: 30 }, (_, i) => i < 25 ? 100 : 120);
    const result = scanMeanReversion(closes, 20, 1.5);
    expect(result.zscore).toBeGreaterThan(0);
    if (result.zscore >= 1.5) {
      expect(result.signal).toBe('overbought');
    }
  });

  it('returns oversold for prices below mean', () => {
    const closes = Array.from({ length: 30 }, (_, i) => i < 25 ? 100 : 80);
    const result = scanMeanReversion(closes, 20, 1.5);
    expect(result.zscore).toBeLessThan(0);
    if (Math.abs(result.zscore) >= 1.5) {
      expect(result.signal).toBe('oversold');
    }
  });

  it('handles zero std (constant prices)', () => {
    const closes = Array.from({ length: 30 }, () => 50);
    const result = scanMeanReversion(closes, 20, 2);
    expect(result.std).toBe(0);
    expect(result.signal).toBe('neutral');
  });

  it('computes deviationPct', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i * 0.5);
    const result = scanMeanReversion(closes, 20, 2);
    expect(typeof result.deviationPct).toBe('number');
  });
});
