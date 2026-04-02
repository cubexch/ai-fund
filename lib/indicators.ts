/**
 * Technical indicator calculations for trading skills.
 * All functions take arrays of numbers (typically close prices)
 * and return computed indicator values.
 */

export interface OHLCV {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

// ── Moving Averages ────────────────────────────────────────

export function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result.push(sum / period);
  }
  return result;
}

export function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);
  result.push(data.slice(0, period).reduce((a, b) => a + b, 0) / period);

  for (let i = period; i < data.length; i++) {
    result.push((data[i] - result[result.length - 1]) * multiplier + result[result.length - 1]);
  }
  return result;
}

// ── RSI ────────────────────────────────────────────────────

export function rsi(closes: number[], period: number = 14): number[] {
  const result: number[] = [];
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

  result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }

  return result;
}

// ── MACD ───────────────────────────────────────────────────

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDResult {
  const fastEma = ema(closes, fastPeriod);
  const slowEma = ema(closes, slowPeriod);

  const offset = slowPeriod - fastPeriod;
  const macdLine: number[] = [];
  for (let i = 0; i < slowEma.length; i++) {
    macdLine.push(fastEma[i + offset] - slowEma[i]);
  }

  const signalLine = ema(macdLine, signalPeriod);
  const signalOffset = signalPeriod - 1;
  const histogram: number[] = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[i + signalOffset] - signalLine[i]);
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

// ── Bollinger Bands ────────────────────────────────────────

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[];
}

export function bollingerBands(closes: number[], period: number = 20, stdDev: number = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const width: number[] = [];

  for (let i = 0; i < middle.length; i++) {
    const slice = closes.slice(i, i + period);
    const mean = middle[i];
    const variance = slice.reduce((sum, val) => sum + (val - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance) * stdDev;
    upper.push(mean + sd);
    lower.push(mean - sd);
    width.push((sd * 2) / mean); // Normalized width
  }

  return { upper, middle, lower, width };
}

// ── ADX ────────────────────────────────────────────────────

export function adx(candles: OHLCV[], period: number = 14): number[] {
  const trueRanges: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    plusDM.push(high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0);
    minusDM.push(prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0);
  }

  const smoothTR = smoothed(trueRanges, period);
  const smoothPlusDM = smoothed(plusDM, period);
  const smoothMinusDM = smoothed(minusDM, period);

  const dx: number[] = [];
  for (let i = 0; i < smoothTR.length; i++) {
    const plusDI = (smoothPlusDM[i] / smoothTR[i]) * 100;
    const minusDI = (smoothMinusDM[i] / smoothTR[i]) * 100;
    dx.push((Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100);
  }

  return sma(dx, period);
}

function smoothed(data: number[], period: number): number[] {
  const result: number[] = [];
  result.push(data.slice(0, period).reduce((a, b) => a + b, 0));
  for (let i = period; i < data.length; i++) {
    result.push(result[result.length - 1] - result[result.length - 1] / period + data[i]);
  }
  return result;
}

// ── ATR ────────────────────────────────────────────────────

export function atr(candles: OHLCV[], period: number = 14): number[] {
  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  return sma(trueRanges, period);
}

// ── OBV ────────────────────────────────────────────────────

export function obv(candles: OHLCV[]): number[] {
  const result: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) {
      result.push(result[result.length - 1] + candles[i].volume);
    } else if (candles[i].close < candles[i - 1].close) {
      result.push(result[result.length - 1] - candles[i].volume);
    } else {
      result.push(result[result.length - 1]);
    }
  }
  return result;
}

// ── Stochastic ─────────────────────────────────────────────

export interface StochasticResult {
  k: number[];
  d: number[];
}

export function stochastic(candles: OHLCV[], kPeriod: number = 14, dPeriod: number = 3): StochasticResult {
  const k: number[] = [];

  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map(c => c.high));
    const low = Math.min(...slice.map(c => c.low));
    const close = candles[i].close;
    k.push(high === low ? 50 : ((close - low) / (high - low)) * 100);
  }

  const d = sma(k, dPeriod);
  return { k, d };
}

// ── Hurst Exponent ────────────────────────────────────────

/**
 * Hurst exponent via rescaled range (R/S) analysis.
 * H < 0.5 → mean-reverting, H = 0.5 → random walk, H > 0.5 → trending.
 * @param data - price or return series (minimum ~20 data points)
 * @param maxLag - maximum lag for R/S calculation (default 20)
 */
export function hurst(data: number[], maxLag: number = 20): number {
  if (data.length < maxLag + 1) return 0.5; // insufficient data → assume random walk

  const logN: number[] = [];
  const logRS: number[] = [];

  for (let lag = 2; lag <= maxLag; lag++) {
    const rsValues: number[] = [];

    for (let start = 0; start + lag <= data.length; start += lag) {
      const segment = data.slice(start, start + lag);
      if (segment.length < lag) break;

      const segMean = segment.reduce((a, b) => a + b, 0) / segment.length;
      const deviations = segment.map(v => v - segMean);

      // Cumulative deviations
      const cumDev: number[] = [];
      let sum = 0;
      for (const d of deviations) {
        sum += d;
        cumDev.push(sum);
      }

      const range = Math.max(...cumDev) - Math.min(...cumDev);
      const stdDev = Math.sqrt(deviations.reduce((s, d) => s + d * d, 0) / deviations.length);

      if (stdDev > 0) {
        rsValues.push(range / stdDev);
      }
    }

    if (rsValues.length > 0) {
      const avgRS = rsValues.reduce((a, b) => a + b, 0) / rsValues.length;
      if (avgRS > 0) {
        logN.push(Math.log(lag));
        logRS.push(Math.log(avgRS));
      }
    }
  }

  if (logN.length < 2) return 0.5;

  // Linear regression of log(R/S) on log(n)
  const n = logN.length;
  const sumX = logN.reduce((a, b) => a + b, 0);
  const sumY = logRS.reduce((a, b) => a + b, 0);
  const sumXY = logN.reduce((s, x, i) => s + x * logRS[i], 0);
  const sumX2 = logN.reduce((s, x) => s + x * x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  return Math.max(0, Math.min(1, slope)); // clamp to [0, 1]
}

// ── Momentum ──────────────────────────────────────────────

/**
 * Multi-period momentum as percentage returns over given windows.
 * @param prices - price series
 * @param windows - lookback windows in periods (e.g., [21, 63, 126] for 1m/3m/6m daily)
 * @returns object mapping each window to its momentum value (most recent)
 */
export function momentum(prices: number[], windows: number[]): Record<number, number | null> {
  const result: Record<number, number | null> = {};
  for (const w of windows) {
    if (prices.length > w) {
      const current = prices[prices.length - 1];
      const past = prices[prices.length - 1 - w];
      result[w] = past === 0 ? null : (current - past) / past;
    } else {
      result[w] = null;
    }
  }
  return result;
}

// ── Historical Volatility ─────────────────────────────────

/**
 * Annualized historical volatility from a return series.
 * @param returnSeries - array of period returns (decimal)
 * @param annualizationFactor - sqrt scaling factor (252 for daily equities, 365 for crypto)
 */
export function historicalVolatility(returnSeries: number[], annualizationFactor: number = 365): number {
  if (returnSeries.length < 2) return 0;
  const avg = returnSeries.reduce((a, b) => a + b, 0) / returnSeries.length;
  const variance = returnSeries.reduce((s, r) => s + (r - avg) ** 2, 0) / (returnSeries.length - 1);
  return Math.sqrt(variance) * Math.sqrt(annualizationFactor);
}

// ── VWAP ──────────────────────────────────────────────────

/**
 * Volume-weighted average price from intraday candles.
 * Returns cumulative VWAP at each bar.
 */
export function vwap(candles: OHLCV[]): number[] {
  const result: number[] = [];
  let cumTypicalVolume = 0;
  let cumVolume = 0;

  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumTypicalVolume += typical * c.volume;
    cumVolume += c.volume;
    result.push(cumVolume === 0 ? typical : cumTypicalVolume / cumVolume);
  }
  return result;
}

// ── Volume Spike ──────────────────────────────────────────

/**
 * Volume spike ratio: short-term avg volume / long-term avg volume.
 * Values > 1 indicate above-average volume activity.
 * @param volumes - volume series
 * @param shortWindow - short-term lookback (default 5)
 * @param longWindow - long-term lookback (default 63)
 */
export function volumeSpike(volumes: number[], shortWindow: number = 5, longWindow: number = 63): number[] {
  const result: number[] = [];
  for (let i = longWindow - 1; i < volumes.length; i++) {
    const longSlice = volumes.slice(i - longWindow + 1, i + 1);
    const shortStart = Math.max(0, i - shortWindow + 1);
    const shortSlice = volumes.slice(shortStart, i + 1);
    const longAvg = longSlice.reduce((a, b) => a + b, 0) / longSlice.length;
    const shortAvg = shortSlice.reduce((a, b) => a + b, 0) / shortSlice.length;
    result.push(longAvg === 0 ? 0 : shortAvg / longAvg);
  }
  return result;
}
