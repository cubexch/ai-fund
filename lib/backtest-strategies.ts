/**
 * Built-in backtest strategy implementations.
 * Nine strategies covering momentum, mean-reversion, trend, and confluence.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import type { Bar } from './connector-interface.js';
import {
  sma, ema, rsi, macd, bollingerBands, stochastic,
  type OHLCV,
} from './indicators.js';

// ── Signal type ─────────────────────────────────────────

export type Signal = 'buy' | 'sell' | 'hold';

export type StrategyFn = (bars: Bar[], params: Record<string, number>) => Signal[];

// ── Strategy Registry ───────────────────────────────────

export const STRATEGIES: Record<string, StrategyFn> = {
  sma_crossover: smaCrossoverStrategy,
  rsi_mean_reversion: rsiMeanReversionStrategy,
  macd_momentum: macdMomentumStrategy,
  bollinger_breakout: bollingerBreakoutStrategy,
  bollinger_mean_reversion: bollingerMeanReversionStrategy,
  ema_trend_following: emaTrendFollowingStrategy,
  stochastic_oscillator: stochasticOscillatorStrategy,
  adx_trend_strength: adxTrendStrengthStrategy,
  multi_indicator_confluence: multiIndicatorConfluenceStrategy,
};

/** Default parameters for each strategy — used by runAll(). */
export const DEFAULT_PARAMS: Record<string, Record<string, number>> = {
  sma_crossover: { fastPeriod: 10, slowPeriod: 30 },
  rsi_mean_reversion: { period: 14, oversold: 30, overbought: 70 },
  macd_momentum: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  bollinger_breakout: { period: 20, stdDev: 2 },
  bollinger_mean_reversion: { period: 20, stdDev: 2 },
  ema_trend_following: { period: 20 },
  stochastic_oscillator: { kPeriod: 14, dPeriod: 3, oversold: 20, overbought: 80 },
  adx_trend_strength: { period: 14, threshold: 25 },
  multi_indicator_confluence: {
    rsiPeriod: 14, smaPeriod: 20,
    macdFast: 12, macdSlow: 26, macdSignal: 9,
    requiredSignals: 2,
  },
};

// ── Helpers ─────────────────────────────────────────────

/** Wilders smoothing (same as in lib/indicators.ts — reproduced here for +DI/-DI). */
function wildersSmooth(data: number[], period: number): number[] {
  const result: number[] = [];
  result.push(data.slice(0, period).reduce((a, b) => a + b, 0));
  for (let i = period; i < data.length; i++) {
    result.push(result[result.length - 1] - result[result.length - 1] / period + data[i]);
  }
  return result;
}

// ── Strategy Implementations ────────────────────────────

/**
 * 1. SMA Crossover
 * Buy when fast SMA crosses above slow SMA, sell when it crosses below.
 */
function smaCrossoverStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const fastPeriod = params.fastPeriod ?? 10;
  const slowPeriod = params.slowPeriod ?? 30;

  if (fastPeriod >= slowPeriod) {
    throw new Error(`fastPeriod (${fastPeriod}) must be less than slowPeriod (${slowPeriod})`);
  }

  const closes = bars.map(b => b.close);
  const fastSma = sma(closes, fastPeriod);
  const slowSma = sma(closes, slowPeriod);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  // Both SMAs must exist — slow SMA starts at index (slowPeriod - 1)
  const offset = slowPeriod - 1;

  for (let i = offset + 1; i < bars.length; i++) {
    const fastIdx = i - (fastPeriod - 1);
    const slowIdx = i - (slowPeriod - 1);
    const prevFastIdx = fastIdx - 1;
    const prevSlowIdx = slowIdx - 1;

    if (prevFastIdx < 0 || prevSlowIdx < 0) continue;

    const fastNow = fastSma[fastIdx];
    const slowNow = slowSma[slowIdx];
    const fastPrev = fastSma[prevFastIdx];
    const slowPrev = slowSma[prevSlowIdx];

    if (fastPrev <= slowPrev && fastNow > slowNow) {
      signals[i] = 'buy';
    } else if (fastPrev >= slowPrev && fastNow < slowNow) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 2. RSI Mean Reversion
 * Buy when RSI drops below oversold, sell when RSI rises above overbought.
 */
function rsiMeanReversionStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 14;
  const oversold = params.oversold ?? 30;
  const overbought = params.overbought ?? 70;

  const closes = bars.map(b => b.close);
  const rsiValues = rsi(closes, period);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  // RSI starts producing values at index `period` in the closes array
  const rsiOffset = period;

  for (let i = rsiOffset; i < bars.length; i++) {
    const rsiIdx = i - rsiOffset;
    if (rsiIdx < 0 || rsiIdx >= rsiValues.length) continue;

    const val = rsiValues[rsiIdx];
    if (val < oversold) {
      signals[i] = 'buy';
    } else if (val > overbought) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 3. MACD Momentum
 * Buy when MACD line crosses above signal line, sell when it crosses below.
 */
function macdMomentumStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const fastPeriod = params.fastPeriod ?? 12;
  const slowPeriod = params.slowPeriod ?? 26;
  const signalPeriod = params.signalPeriod ?? 9;

  const closes = bars.map(b => b.close);
  const result = macd(closes, fastPeriod, slowPeriod, signalPeriod);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  const macdLine = result.macd;
  const signalLine = result.signal;
  const signalOffset = signalPeriod - 1;

  const barsOffset = (slowPeriod - 1) + (signalPeriod - 1);

  for (let i = 1; i < signalLine.length; i++) {
    const barIdx = barsOffset + i;
    if (barIdx >= bars.length) break;

    const macdNow = macdLine[i + signalOffset];
    const macdPrev = macdLine[i + signalOffset - 1];
    const sigNow = signalLine[i];
    const sigPrev = signalLine[i - 1];

    if (macdPrev <= sigPrev && macdNow > sigNow) {
      signals[barIdx] = 'buy';
    } else if (macdPrev >= sigPrev && macdNow < sigNow) {
      signals[barIdx] = 'sell';
    }
  }

  return signals;
}

/**
 * 4. Bollinger Band Breakout
 * Buy when price breaks above the upper band, sell when it breaks below the lower band.
 */
function bollingerBreakoutStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 20;
  const stdDev = params.stdDev ?? 2;

  const closes = bars.map(b => b.close);
  const bb = bollingerBands(closes, period, stdDev);

  const signals: Signal[] = new Array(bars.length).fill('hold');
  const bbOffset = period - 1;

  for (let i = bbOffset + 1; i < bars.length; i++) {
    const bbIdx = i - bbOffset;
    const prevBbIdx = bbIdx - 1;
    if (prevBbIdx < 0) continue;

    const priceNow = closes[i];
    const pricePrev = closes[i - 1];

    // Breakout above upper band
    if (pricePrev <= bb.upper[prevBbIdx] && priceNow > bb.upper[bbIdx]) {
      signals[i] = 'buy';
    }
    // Breakdown below lower band
    else if (pricePrev >= bb.lower[prevBbIdx] && priceNow < bb.lower[bbIdx]) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 5. Bollinger Band Mean Reversion
 * Buy when price touches the lower band, sell when it touches the upper band.
 */
function bollingerMeanReversionStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 20;
  const stdDev = params.stdDev ?? 2;

  const closes = bars.map(b => b.close);
  const bb = bollingerBands(closes, period, stdDev);

  const signals: Signal[] = new Array(bars.length).fill('hold');
  const bbOffset = period - 1;

  for (let i = bbOffset; i < bars.length; i++) {
    const bbIdx = i - bbOffset;
    const price = closes[i];

    if (price <= bb.lower[bbIdx]) {
      signals[i] = 'buy';
    } else if (price >= bb.upper[bbIdx]) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 6. EMA Trend Following
 * Buy when price is above EMA and EMA is rising. Sell when price is below EMA and EMA is falling.
 */
function emaTrendFollowingStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 20;

  const closes = bars.map(b => b.close);
  const emaValues = ema(closes, period);

  const signals: Signal[] = new Array(bars.length).fill('hold');
  const emaOffset = period - 1;

  for (let i = emaOffset + 1; i < bars.length; i++) {
    const emaIdx = i - emaOffset;
    const emaPrevIdx = emaIdx - 1;
    if (emaPrevIdx < 0) continue;

    const price = closes[i];
    const emaNow = emaValues[emaIdx];
    const emaPrev = emaValues[emaPrevIdx];
    const emaRising = emaNow > emaPrev;
    const emaFalling = emaNow < emaPrev;

    if (price > emaNow && emaRising) {
      signals[i] = 'buy';
    } else if (price < emaNow && emaFalling) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 7. Stochastic Oscillator
 * Buy when %K crosses above %D in the oversold zone.
 * Sell when %K crosses below %D in the overbought zone.
 */
function stochasticOscillatorStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const kPeriod = params.kPeriod ?? 14;
  const dPeriod = params.dPeriod ?? 3;
  const oversold = params.oversold ?? 20;
  const overbought = params.overbought ?? 80;

  const candles: OHLCV[] = bars.map(b => ({
    open: b.open, high: b.high, low: b.low,
    close: b.close, volume: b.volume, timestamp: b.timestamp,
  }));

  const stoch = stochastic(candles, kPeriod, dPeriod);
  const kLine = stoch.k;
  const dLine = stoch.d;

  const signals: Signal[] = new Array(bars.length).fill('hold');

  const kOffset = kPeriod - 1;
  const dOffset = dPeriod - 1;
  const totalOffset = kOffset + dOffset;

  for (let j = 1; j < dLine.length; j++) {
    const barIdx = totalOffset + j;
    if (barIdx >= bars.length) break;

    const kNow = kLine[dOffset + j];
    const kPrev = kLine[dOffset + j - 1];
    const dNow = dLine[j];
    const dPrev = dLine[j - 1];

    // Bullish crossover in oversold zone
    if (kPrev <= dPrev && kNow > dNow && kNow < oversold) {
      signals[barIdx] = 'buy';
    }
    // Bearish crossover in overbought zone
    else if (kPrev >= dPrev && kNow < dNow && kNow > overbought) {
      signals[barIdx] = 'sell';
    }
  }

  return signals;
}

/**
 * 8. ADX Trend Strength
 * Only trade when ADX > threshold. Use +DI/-DI for direction.
 * Buy when +DI crosses above -DI with strong ADX. Sell on the reverse.
 */
function adxTrendStrengthStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 14;
  const threshold = params.threshold ?? 25;

  if (bars.length < period * 2 + 1) {
    throw new Error(`Need at least ${period * 2 + 1} bars for ADX strategy.`);
  }

  // Compute True Range, +DM, -DM
  const trueRanges: number[] = [];
  const plusDMRaw: number[] = [];
  const minusDMRaw: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevHigh = bars[i - 1].high;
    const prevLow = bars[i - 1].low;
    const prevClose = bars[i - 1].close;

    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    plusDMRaw.push(high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0);
    minusDMRaw.push(prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0);
  }

  // Wilders smoothing
  const smoothTR = wildersSmooth(trueRanges, period);
  const smoothPlusDM = wildersSmooth(plusDMRaw, period);
  const smoothMinusDM = wildersSmooth(minusDMRaw, period);

  // Compute +DI, -DI, DX
  const plusDI: number[] = [];
  const minusDI: number[] = [];
  const dx: number[] = [];

  for (let i = 0; i < smoothTR.length; i++) {
    const pdi = smoothTR[i] === 0 ? 0 : (smoothPlusDM[i] / smoothTR[i]) * 100;
    const mdi = smoothTR[i] === 0 ? 0 : (smoothMinusDM[i] / smoothTR[i]) * 100;
    plusDI.push(pdi);
    minusDI.push(mdi);
    const diSum = pdi + mdi;
    dx.push(diSum === 0 ? 0 : (Math.abs(pdi - mdi) / diSum) * 100);
  }

  // ADX = SMA of DX
  const adxValues = sma(dx, period);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  const adxBarOffset = 2 * period - 1;

  for (let j = 1; j < adxValues.length; j++) {
    const barIdx = adxBarOffset + j;
    if (barIdx >= bars.length) break;

    const adxVal = adxValues[j];
    if (adxVal < threshold) continue; // No trade in weak trend

    const diIdx = period - 1 + j;
    const diIdxPrev = diIdx - 1;
    if (diIdxPrev < 0 || diIdx >= plusDI.length) continue;

    const pdiNow = plusDI[diIdx];
    const pdiPrev = plusDI[diIdxPrev];
    const mdiNow = minusDI[diIdx];
    const mdiPrev = minusDI[diIdxPrev];

    // +DI crosses above -DI
    if (pdiPrev <= mdiPrev && pdiNow > mdiNow) {
      signals[barIdx] = 'buy';
    }
    // -DI crosses above +DI
    else if (pdiPrev >= mdiPrev && pdiNow < mdiNow) {
      signals[barIdx] = 'sell';
    }
  }

  return signals;
}

/**
 * 9. Multi-Indicator Confluence
 * Requires N out of M indicators to agree before entering.
 * Indicators: RSI, SMA trend, MACD histogram.
 */
function multiIndicatorConfluenceStrategy(bars: Bar[], params: Record<string, number>): Signal[] {
  const rsiPeriod = params.rsiPeriod ?? 14;
  const smaPeriod = params.smaPeriod ?? 20;
  const macdFast = params.macdFast ?? 12;
  const macdSlow = params.macdSlow ?? 26;
  const macdSignalPeriod = params.macdSignal ?? 9;
  const requiredSignals = params.requiredSignals ?? 2;

  const closes = bars.map(b => b.close);

  // Compute indicators
  const rsiValues = rsi(closes, rsiPeriod);
  const smaValues = sma(closes, smaPeriod);
  const macdResult = macd(closes, macdFast, macdSlow, macdSignalPeriod);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  const rsiStart = rsiPeriod;
  const smaStart = smaPeriod - 1;
  const macdHistStart = (macdSlow - 1) + (macdSignalPeriod - 1);
  const startIdx = Math.max(rsiStart, smaStart, macdHistStart) + 1;

  for (let i = startIdx; i < bars.length; i++) {
    let bullish = 0;
    let bearish = 0;

    // RSI signal
    const rsiIdx = i - rsiPeriod;
    if (rsiIdx >= 0 && rsiIdx < rsiValues.length) {
      if (rsiValues[rsiIdx] < 40) bullish++;
      else if (rsiValues[rsiIdx] > 60) bearish++;
    }

    // SMA trend signal
    const smaIdx = i - (smaPeriod - 1);
    if (smaIdx >= 0 && smaIdx < smaValues.length) {
      if (closes[i] > smaValues[smaIdx]) bullish++;
      else if (closes[i] < smaValues[smaIdx]) bearish++;
    }

    // MACD histogram signal
    const histIdx = i - macdHistStart;
    if (histIdx >= 0 && histIdx < macdResult.histogram.length) {
      if (macdResult.histogram[histIdx] > 0) bullish++;
      else if (macdResult.histogram[histIdx] < 0) bearish++;
    }

    if (bullish >= requiredSignals) {
      signals[i] = 'buy';
    } else if (bearish >= requiredSignals) {
      signals[i] = 'sell';
    }
  }

  return signals;
}
