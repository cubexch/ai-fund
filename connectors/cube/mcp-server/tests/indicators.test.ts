import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, macd, bollingerBands, atr, adx, obv, stochastic, hurst, momentum, historicalVolatility, vwap, volumeSpike } from '../../../../lib/indicators.js';
import type { OHLCV } from '../../../../lib/indicators.js';

// Helper: generate simple OHLCV data
function generateCandles(count: number, basePrice: number = 100, volatility: number = 2): OHLCV[] {
  const candles: OHLCV[] = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const change = (Math.sin(i * 0.3) + Math.cos(i * 0.7)) * volatility;
    price = Math.max(1, price + change);
    const high = price + Math.abs(change) * 0.5;
    const low = price - Math.abs(change) * 0.5;
    candles.push({
      open: price - change * 0.3,
      high,
      low,
      close: price,
      volume: 1000 + i * 10,
      timestamp: Date.now() - (count - i) * 3_600_000,
    });
  }
  return candles;
}

describe('SMA', () => {
  it('calculates correct simple moving average', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = sma(data, 3);
    expect(result.length).toBe(8); // 10 - 3 + 1
    expect(result[0]).toBeCloseTo(2);    // (1+2+3)/3
    expect(result[1]).toBeCloseTo(3);    // (2+3+4)/3
    expect(result[7]).toBeCloseTo(9);    // (8+9+10)/3
  });

  it('returns empty for insufficient data', () => {
    expect(sma([1, 2], 5).length).toBe(0);
  });
});

describe('EMA', () => {
  it('first EMA value equals SMA of the seed period', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = ema(data, 5);
    // First value should be SMA(5) of first 5 elements = 3
    expect(result[0]).toBeCloseTo(3);
    expect(result.length).toBe(6); // 10 - 5 + 1
  });

  it('reacts faster to recent changes than SMA', () => {
    const data = [10, 10, 10, 10, 10, 10, 10, 10, 10, 20];
    const emaResult = ema(data, 5);
    const smaResult = sma(data, 5);
    // EMA should be higher than SMA at the end (more weight on recent 20)
    expect(emaResult[emaResult.length - 1]).toBeGreaterThan(smaResult[smaResult.length - 1]);
  });
});

describe('RSI', () => {
  it('returns values between 0 and 100', () => {
    const candles = generateCandles(50);
    const closes = candles.map(c => c.close);
    const result = rsi(closes);
    for (const v of result) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('returns 100 for continuously rising prices', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    const result = rsi(rising);
    expect(result[result.length - 1]).toBe(100);
  });

  it('returns 0 for continuously falling prices', () => {
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
    const result = rsi(falling);
    expect(result[result.length - 1]).toBe(0);
  });
});

describe('MACD', () => {
  it('produces macd, signal, and histogram arrays', () => {
    const candles = generateCandles(50);
    const closes = candles.map(c => c.close);
    const result = macd(closes);
    expect(result.macd.length).toBeGreaterThan(0);
    expect(result.signal.length).toBeGreaterThan(0);
    expect(result.histogram.length).toBeGreaterThan(0);
  });

  it('histogram = macd - signal', () => {
    const candles = generateCandles(60);
    const closes = candles.map(c => c.close);
    const result = macd(closes);
    // The histogram should approximately equal the difference at each aligned index
    const signalOffset = 9 - 1; // signalPeriod - 1
    for (let i = 0; i < result.histogram.length; i++) {
      const expected = result.macd[i + signalOffset] - result.signal[i];
      expect(result.histogram[i]).toBeCloseTo(expected, 6);
    }
  });
});

describe('Bollinger Bands', () => {
  it('upper > middle > lower', () => {
    const candles = generateCandles(50);
    const closes = candles.map(c => c.close);
    const bb = bollingerBands(closes);
    for (let i = 0; i < bb.middle.length; i++) {
      expect(bb.upper[i]).toBeGreaterThan(bb.middle[i]);
      expect(bb.middle[i]).toBeGreaterThan(bb.lower[i]);
    }
  });

  it('bandwidth is positive', () => {
    const candles = generateCandles(50);
    const closes = candles.map(c => c.close);
    const bb = bollingerBands(closes);
    for (const w of bb.width) {
      expect(w).toBeGreaterThan(0);
    }
  });
});

describe('ATR', () => {
  it('returns positive values', () => {
    const candles = generateCandles(30);
    const result = atr(candles);
    expect(result.length).toBeGreaterThan(0);
    for (const v of result) {
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('ADX', () => {
  it('returns values between 0 and 100', () => {
    const candles = generateCandles(60);
    const result = adx(candles);
    expect(result.length).toBeGreaterThan(0);
    for (const v of result) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe('OBV', () => {
  it('starts at 0', () => {
    const candles = generateCandles(20);
    const result = obv(candles);
    expect(result[0]).toBe(0);
    expect(result.length).toBe(candles.length);
  });
});

describe('Stochastic', () => {
  it('K and D values are between 0 and 100', () => {
    const candles = generateCandles(30);
    const result = stochastic(candles);
    for (const v of result.k) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    for (const v of result.d) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

// ── New Indicators ──────────────────────────────────────────

describe('Hurst Exponent', () => {
  it('returns ~0.5 for random walk', () => {
    // Generate pseudo-random walk
    const data: number[] = [100];
    for (let i = 1; i < 200; i++) {
      data.push(data[i - 1] + Math.sin(i * 1.7) * 2 + Math.cos(i * 3.1));
    }
    const h = hurst(data);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(1);
  });

  it('returns 0.5 for insufficient data', () => {
    expect(hurst([1, 2, 3])).toBe(0.5);
  });

  it('detects trending behavior (H > 0.5) in a trend', () => {
    // Strong uptrend
    const trending = Array.from({ length: 100 }, (_, i) => 100 + i * 2);
    const h = hurst(trending);
    expect(h).toBeGreaterThan(0.5);
  });

  it('is bounded between 0 and 1', () => {
    const candles = generateCandles(100);
    const closes = candles.map(c => c.close);
    const h = hurst(closes);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(1);
  });
});

describe('Momentum', () => {
  it('calculates multi-period returns', () => {
    const prices = Array.from({ length: 130 }, (_, i) => 100 + i);
    const result = momentum(prices, [21, 63, 126]);
    expect(result[21]).toBeCloseTo((229 - 208) / 208, 4);
    expect(result[63]).toBeCloseTo((229 - 166) / 166, 4);
    expect(result[126]).toBeCloseTo((229 - 103) / 103, 4);
  });

  it('returns null for insufficient data', () => {
    const prices = [100, 110, 120];
    const result = momentum(prices, [5, 10]);
    expect(result[5]).toBeNull();
    expect(result[10]).toBeNull();
  });
});

describe('Historical Volatility', () => {
  it('returns annualized vol from returns', () => {
    const dailyReturns = [0.01, -0.02, 0.005, -0.01, 0.015, -0.005, 0.02, -0.015, 0.01, -0.01];
    const vol = historicalVolatility(dailyReturns);
    expect(vol).toBeGreaterThan(0);
    // Should be in reasonable range for crypto (annualized)
    expect(vol).toBeLessThan(5); // 500% would be extreme
  });

  it('returns 0 for insufficient data', () => {
    expect(historicalVolatility([0.01])).toBe(0);
  });

  it('accepts custom annualization factor', () => {
    const returns = [0.01, -0.02, 0.005, -0.01, 0.015];
    const crypto = historicalVolatility(returns, 365);
    const equities = historicalVolatility(returns, 252);
    expect(crypto).toBeGreaterThan(equities);
  });
});

describe('VWAP', () => {
  it('returns cumulative VWAP for each bar', () => {
    const candles = generateCandles(20);
    const result = vwap(candles);
    expect(result.length).toBe(candles.length);
    // VWAP should be within the price range
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).toBeGreaterThan(0);
    }
  });

  it('first bar VWAP equals typical price', () => {
    const candles = generateCandles(5);
    const typical = (candles[0].high + candles[0].low + candles[0].close) / 3;
    const result = vwap(candles);
    expect(result[0]).toBeCloseTo(typical);
  });
});

describe('Volume Spike', () => {
  it('detects above-average volume', () => {
    // Low volume followed by a spike
    const volumes = Array(63).fill(100);
    volumes.push(500, 500, 500, 500, 500); // spike
    const result = volumeSpike(volumes);
    expect(result[result.length - 1]).toBeGreaterThan(1);
  });

  it('returns ~1 for constant volume', () => {
    const volumes = Array(100).fill(1000);
    const result = volumeSpike(volumes);
    for (const v of result) {
      expect(v).toBeCloseTo(1, 1);
    }
  });

  it('returns correct number of data points', () => {
    const volumes = Array(100).fill(1000);
    const result = volumeSpike(volumes, 5, 63);
    expect(result.length).toBe(100 - 63 + 1);
  });
});
