/**
 * Signal generation engine — produces actionable trading signals
 * from technical indicator analysis on OHLCV bars.
 */

import type { BarResult } from './exchange.js';
import {
  sma, ema, rsi, macd, bollingerBands, atr, adx, stochastic,
  type OHLCV,
} from '../../../../../lib/indicators.js';
import { mean, standardDeviation } from '../../../../../lib/math.js';

// ── Types ────────────────────────────────────────────────────

export type SignalType = 'buy' | 'sell' | 'hold';
export type SignalStrength = 'strong' | 'moderate' | 'weak';

export interface TradingSignal {
  symbol: string;
  timestamp: number;
  type: SignalType;
  strength: SignalStrength;
  confidence: number;  // 0-1
  source: string;      // which indicator/pattern generated it
  price: number;
  targetPrice: number | null;
  stopLoss: number | null;
  riskRewardRatio: number | null;
  timeframe: string;
  metadata: Record<string, unknown>;
}

export interface ScanResult {
  symbol: string;
  signals: TradingSignal[];
  overallBias: 'bullish' | 'bearish' | 'neutral';
  score: number;  // -100 to +100
  topSignal: TradingSignal | null;
}

// ── Helpers ──────────────────────────────────────────────────

function barsToOHLCV(bars: BarResult[]): OHLCV[] {
  return bars.map(b => ({
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    timestamp: b.timestamp,
  }));
}

function makeSignal(
  symbol: string,
  timeframe: string,
  price: number,
  type: SignalType,
  strength: SignalStrength,
  confidence: number,
  source: string,
  metadata: Record<string, unknown> = {},
  targetPrice: number | null = null,
  stopLoss: number | null = null,
): TradingSignal {
  let riskRewardRatio: number | null = null;
  if (targetPrice !== null && stopLoss !== null && stopLoss !== price) {
    riskRewardRatio = Math.abs(targetPrice - price) / Math.abs(price - stopLoss);
    riskRewardRatio = Math.round(riskRewardRatio * 100) / 100;
  }
  return {
    symbol,
    timestamp: Date.now(),
    type,
    strength,
    confidence: Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100,
    source,
    price,
    targetPrice,
    stopLoss,
    riskRewardRatio,
    timeframe,
    metadata,
  };
}

// ── SignalGenerator ──────────────────────────────────────────

export class SignalGenerator {

  // ── Public API ─────────────────────────────────────────────

  /**
   * Run ALL signal detectors on the provided bars and return every
   * signal found.
   */
  generateSignals(bars: BarResult[], symbol: string, timeframe: string): TradingSignal[] {
    if (bars.length < 55) return []; // need enough data for EMA ribbon (55)

    const closes = bars.map(b => b.close);
    const candles = barsToOHLCV(bars);
    const price = closes[closes.length - 1];
    const atrValues = atr(candles, 14);
    const currentAtr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : price * 0.02;

    const signals: TradingSignal[] = [];

    signals.push(...this.detectGoldenDeathCross(closes, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectRsiDivergence(bars, closes, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectMacdZeroCross(closes, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectMacdSignalCross(closes, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectBollingerBounce(closes, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectBollingerSqueeze(closes, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectVolumeBreakout(bars, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectSupportResistanceBreak(bars, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectCandlePatterns(bars, symbol, timeframe));
    signals.push(...this.detectDoubleTopBottom(bars, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectEmaRibbon(closes, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectStochasticSignal(candles, symbol, timeframe, price, currentAtr));
    signals.push(...this.detectAdxTrendStart(candles, symbol, timeframe, price, currentAtr));

    return signals;
  }

  /**
   * Aggregate signals into an overall bias and score (-100 to +100).
   */
  scoreSignals(signals: TradingSignal[]): { bias: 'bullish' | 'bearish' | 'neutral'; score: number } {
    if (signals.length === 0) return { bias: 'neutral', score: 0 };

    const strengthWeight: Record<SignalStrength, number> = {
      strong: 3,
      moderate: 2,
      weak: 1,
    };

    let raw = 0;
    let totalWeight = 0;

    for (const s of signals) {
      const w = strengthWeight[s.strength] * s.confidence;
      totalWeight += w;
      if (s.type === 'buy') raw += w;
      else if (s.type === 'sell') raw -= w;
      // hold contributes zero
    }

    // Normalize to -100..+100
    const score = totalWeight === 0
      ? 0
      : Math.round((raw / totalWeight) * 100);

    const bias: 'bullish' | 'bearish' | 'neutral' =
      score > 15 ? 'bullish' : score < -15 ? 'bearish' : 'neutral';

    return { bias, score };
  }

  /**
   * Identify support and resistance levels from pivot points and
   * price clustering.
   */
  findSupportResistance(
    bars: BarResult[],
  ): { supports: number[]; resistances: number[] } {
    if (bars.length < 5) return { supports: [], resistances: [] };

    const pivotHighs: number[] = [];
    const pivotLows: number[] = [];

    // Find pivot points (local extrema with 2-bar lookback/lookahead)
    for (let i = 2; i < bars.length - 2; i++) {
      const h = bars[i].high;
      if (
        h > bars[i - 1].high && h > bars[i - 2].high &&
        h > bars[i + 1].high && h > bars[i + 2].high
      ) {
        pivotHighs.push(h);
      }
      const l = bars[i].low;
      if (
        l < bars[i - 1].low && l < bars[i - 2].low &&
        l < bars[i + 1].low && l < bars[i + 2].low
      ) {
        pivotLows.push(l);
      }
    }

    const currentPrice = bars[bars.length - 1].close;

    // Cluster nearby levels (within 1% of each other)
    const clusterLevels = (levels: number[]): number[] => {
      if (levels.length === 0) return [];
      const sorted = [...levels].sort((a, b) => a - b);
      const clusters: number[][] = [[sorted[0]]];

      for (let i = 1; i < sorted.length; i++) {
        const lastCluster = clusters[clusters.length - 1];
        const clusterMid = mean(lastCluster);
        if (Math.abs(sorted[i] - clusterMid) / clusterMid < 0.01) {
          lastCluster.push(sorted[i]);
        } else {
          clusters.push([sorted[i]]);
        }
      }

      // Return cluster means, sorted by cluster size (more touches = stronger)
      return clusters
        .sort((a, b) => b.length - a.length)
        .map(c => Math.round(mean(c) * 100) / 100)
        .slice(0, 5);
    };

    const resistanceLevels = clusterLevels(
      pivotHighs.filter(p => p > currentPrice),
    );
    const supportLevels = clusterLevels(
      pivotLows.filter(p => p < currentPrice),
    );

    return {
      supports: supportLevels,
      resistances: resistanceLevels,
    };
  }

  /**
   * Detect candlestick patterns from bars.
   * Public wrapper for external callers (scanner tools).
   */
  detectCandlePatterns(
    bars: BarResult[],
    symbol: string = '',
    timeframe: string = '1d',
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (bars.length < 4) return signals;

    const price = bars[bars.length - 1].close;

    // Three White Soldiers / Three Black Crows
    signals.push(...this.detectThreeSoldiersOrCrows(bars, symbol, timeframe, price));

    // Engulfing
    signals.push(...this.detectEngulfing(bars, symbol, timeframe, price));

    // Doji Star
    signals.push(...this.detectDojiStar(bars, symbol, timeframe, price));

    // Hammer / Shooting Star
    signals.push(...this.detectHammerShootingStar(bars, symbol, timeframe, price));

    return signals;
  }

  // ── Private signal detectors ───────────────────────────────

  private detectGoldenDeathCross(
    closes: number[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (closes.length < 201) return signals;

    const sma50vals = sma(closes, 50);
    const sma200vals = sma(closes, 200);

    if (sma50vals.length < 2 || sma200vals.length < 2) return signals;

    // Align arrays: sma50 starts at index 49, sma200 at index 199
    // So the overlap starts where sma200 begins
    const offset = 150; // 200-50
    const len = sma200vals.length;
    if (len < 2 || sma50vals.length < offset + len) return signals;

    const curr50 = sma50vals[offset + len - 1];
    const prev50 = sma50vals[offset + len - 2];
    const curr200 = sma200vals[len - 1];
    const prev200 = sma200vals[len - 2];

    if (prev50 <= prev200 && curr50 > curr200) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'strong', 0.85,
        'Golden Cross (SMA50 x SMA200)',
        { sma50: round(curr50), sma200: round(curr200) },
        price + currentAtr * 3, price - currentAtr * 1.5,
      ));
    } else if (prev50 >= prev200 && curr50 < curr200) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'strong', 0.85,
        'Death Cross (SMA50 x SMA200)',
        { sma50: round(curr50), sma200: round(curr200) },
        price - currentAtr * 3, price + currentAtr * 1.5,
      ));
    }

    return signals;
  }

  private detectRsiDivergence(
    bars: BarResult[], closes: number[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    const rsiValues = rsi(closes, 14);
    if (rsiValues.length < 20) return signals;

    // Compare recent 10-bar window vs previous 10-bar window
    const rsiLen = rsiValues.length;
    const recentPriceHigh = Math.max(...closes.slice(-10));
    const prevPriceHigh = Math.max(...closes.slice(-20, -10));
    const recentRsiHigh = Math.max(...rsiValues.slice(-10));
    const prevRsiHigh = Math.max(...rsiValues.slice(-20, -10));

    const recentPriceLow = Math.min(...closes.slice(-10));
    const prevPriceLow = Math.min(...closes.slice(-20, -10));
    const recentRsiLow = Math.min(...rsiValues.slice(-10));
    const prevRsiLow = Math.min(...rsiValues.slice(-20, -10));

    // Bearish divergence: price higher high, RSI lower high
    if (recentPriceHigh > prevPriceHigh && recentRsiHigh < prevRsiHigh) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'moderate', 0.7,
        'Bearish RSI Divergence',
        {
          recentPriceHigh: round(recentPriceHigh),
          prevPriceHigh: round(prevPriceHigh),
          recentRsi: round(recentRsiHigh),
          prevRsi: round(prevRsiHigh),
        },
        price - currentAtr * 2, price + currentAtr * 1,
      ));
    }

    // Bullish divergence: price lower low, RSI higher low
    if (recentPriceLow < prevPriceLow && recentRsiLow > prevRsiLow) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'moderate', 0.7,
        'Bullish RSI Divergence',
        {
          recentPriceLow: round(recentPriceLow),
          prevPriceLow: round(prevPriceLow),
          recentRsi: round(recentRsiLow),
          prevRsi: round(prevRsiLow),
        },
        price + currentAtr * 2, price - currentAtr * 1,
      ));
    }

    return signals;
  }

  private detectMacdZeroCross(
    closes: number[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    const m = macd(closes, 12, 26, 9);
    if (m.macd.length < 2) return signals;

    const curr = m.macd[m.macd.length - 1];
    const prev = m.macd[m.macd.length - 2];

    if (prev <= 0 && curr > 0) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'moderate', 0.65,
        'MACD Zero Cross (bullish)',
        { macd: round(curr), prevMacd: round(prev) },
        price + currentAtr * 2, price - currentAtr * 1,
      ));
    } else if (prev >= 0 && curr < 0) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'moderate', 0.65,
        'MACD Zero Cross (bearish)',
        { macd: round(curr), prevMacd: round(prev) },
        price - currentAtr * 2, price + currentAtr * 1,
      ));
    }

    return signals;
  }

  private detectMacdSignalCross(
    closes: number[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    const m = macd(closes, 12, 26, 9);
    if (m.macd.length < 2 || m.signal.length < 2) return signals;

    // Align: signal is shorter than macd by (signalPeriod - 1)
    const offset = m.macd.length - m.signal.length;
    const currMacd = m.macd[m.macd.length - 1];
    const prevMacd = m.macd[m.macd.length - 2];
    const currSig = m.signal[m.signal.length - 1];
    const prevSig = m.signal[m.signal.length - 2];

    if (prevMacd <= prevSig && currMacd > currSig) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'moderate', 0.6,
        'MACD Signal Cross (bullish)',
        { macd: round(currMacd), signal: round(currSig) },
        price + currentAtr * 2, price - currentAtr * 1,
      ));
    } else if (prevMacd >= prevSig && currMacd < currSig) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'moderate', 0.6,
        'MACD Signal Cross (bearish)',
        { macd: round(currMacd), signal: round(currSig) },
        price - currentAtr * 2, price + currentAtr * 1,
      ));
    }

    return signals;
  }

  private detectBollingerBounce(
    closes: number[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    const bb = bollingerBands(closes, 20, 2);
    if (bb.upper.length < 2) return signals;

    const upper = bb.upper[bb.upper.length - 1];
    const lower = bb.lower[bb.lower.length - 1];
    const mid = bb.middle[bb.middle.length - 1];

    if (price <= lower) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'moderate', 0.6,
        'Bollinger Band Bounce (lower)',
        { lower: round(lower), upper: round(upper), middle: round(mid) },
        mid, price - currentAtr * 1,
      ));
    } else if (price >= upper) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'moderate', 0.6,
        'Bollinger Band Bounce (upper)',
        { lower: round(lower), upper: round(upper), middle: round(mid) },
        mid, price + currentAtr * 1,
      ));
    }

    return signals;
  }

  private detectBollingerSqueeze(
    closes: number[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    const bb = bollingerBands(closes, 20, 2);
    if (bb.width.length < 21) return signals;

    const recentWidth = bb.width.slice(-5);
    const priorWidth = bb.width.slice(-21, -5);
    const avgRecent = mean(recentWidth);
    const avgPrior = mean(priorWidth);

    // Squeeze detected when recent width is < 60% of prior width
    // Release when current bar's width expands > 20% above the squeeze avg
    const currentWidth = bb.width[bb.width.length - 1];
    const prevWidth = bb.width[bb.width.length - 2];

    if (avgRecent < avgPrior * 0.6 && currentWidth > prevWidth * 1.2) {
      // Direction determined by price relative to middle band
      const mid = bb.middle[bb.middle.length - 1];
      const type: SignalType = price > mid ? 'buy' : 'sell';
      signals.push(makeSignal(
        symbol, timeframe, price, type, 'strong', 0.75,
        'Bollinger Squeeze Release',
        {
          currentWidth: round(currentWidth),
          squeezeAvgWidth: round(avgRecent),
          priorAvgWidth: round(avgPrior),
        },
        type === 'buy' ? price + currentAtr * 3 : price - currentAtr * 3,
        type === 'buy' ? price - currentAtr * 1.5 : price + currentAtr * 1.5,
      ));
    }

    return signals;
  }

  private detectVolumeBreakout(
    bars: BarResult[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (bars.length < 21) return signals;

    const volumes = bars.map(b => b.volume);
    const avgVol20 = mean(volumes.slice(-21, -1));
    const currentVol = volumes[volumes.length - 1];

    if (currentVol > avgVol20 * 2 && avgVol20 > 0) {
      const priceChange = bars[bars.length - 1].close - bars[bars.length - 2].close;
      const type: SignalType = priceChange > 0 ? 'buy' : 'sell';
      const volRatio = round(currentVol / avgVol20);

      signals.push(makeSignal(
        symbol, timeframe, price, type, 'moderate', 0.65,
        'Volume Breakout',
        { volumeRatio: volRatio, currentVolume: currentVol, avgVolume20: round(avgVol20) },
        type === 'buy' ? price + currentAtr * 2 : price - currentAtr * 2,
        type === 'buy' ? price - currentAtr * 1 : price + currentAtr * 1,
      ));
    }

    return signals;
  }

  private detectSupportResistanceBreak(
    bars: BarResult[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (bars.length < 20) return signals;

    // Find recent pivot highs/lows (excluding last 2 bars)
    const lookback = bars.slice(-20, -2);
    const pivotHigh = Math.max(...lookback.map(b => b.high));
    const pivotLow = Math.min(...lookback.map(b => b.low));

    const currentBar = bars[bars.length - 1];

    if (currentBar.close > pivotHigh) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'strong', 0.75,
        'Resistance Break',
        { resistanceLevel: round(pivotHigh) },
        price + currentAtr * 3, pivotHigh - currentAtr * 0.5,
      ));
    }

    if (currentBar.close < pivotLow) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'strong', 0.75,
        'Support Break',
        { supportLevel: round(pivotLow) },
        price - currentAtr * 3, pivotLow + currentAtr * 0.5,
      ));
    }

    return signals;
  }

  private detectThreeSoldiersOrCrows(
    bars: BarResult[], symbol: string, timeframe: string, price: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (bars.length < 4) return signals;

    const last3 = bars.slice(-3);
    const allBullish = last3.every(b => b.close > b.open);
    const allBearish = last3.every(b => b.close < b.open);
    const progressiveHigher = last3[1].close > last3[0].close && last3[2].close > last3[1].close;
    const progressiveLower = last3[1].close < last3[0].close && last3[2].close < last3[1].close;

    if (allBullish && progressiveHigher) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'moderate', 0.65,
        'Three White Soldiers',
        { pattern: 'three_white_soldiers' },
      ));
    }

    if (allBearish && progressiveLower) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'moderate', 0.65,
        'Three Black Crows',
        { pattern: 'three_black_crows' },
      ));
    }

    return signals;
  }

  private detectEngulfing(
    bars: BarResult[], symbol: string, timeframe: string, price: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (bars.length < 2) return signals;

    const prev = bars[bars.length - 2];
    const curr = bars[bars.length - 1];

    const prevBody = Math.abs(prev.close - prev.open);
    const currBody = Math.abs(curr.close - curr.open);

    // Bullish engulfing: prev bearish, curr bullish, curr body engulfs prev body
    if (
      prev.close < prev.open &&
      curr.close > curr.open &&
      curr.open <= prev.close &&
      curr.close >= prev.open &&
      currBody > prevBody
    ) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'moderate', 0.7,
        'Bullish Engulfing',
        { pattern: 'bullish_engulfing' },
      ));
    }

    // Bearish engulfing: prev bullish, curr bearish, curr body engulfs prev body
    if (
      prev.close > prev.open &&
      curr.close < curr.open &&
      curr.open >= prev.close &&
      curr.close <= prev.open &&
      currBody > prevBody
    ) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'moderate', 0.7,
        'Bearish Engulfing',
        { pattern: 'bearish_engulfing' },
      ));
    }

    return signals;
  }

  private detectDojiStar(
    bars: BarResult[], symbol: string, timeframe: string, price: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (bars.length < 3) return signals;

    const prev = bars[bars.length - 2];
    const curr = bars[bars.length - 1];

    const bodySize = Math.abs(curr.close - curr.open);
    const range = curr.high - curr.low;

    // Doji: body < 10% of full range
    const isDoji = range > 0 && bodySize / range < 0.1;

    if (!isDoji) return signals;

    // Doji after uptrend (check 3 prior bars trending up)
    const priorBars = bars.slice(-5, -1);
    const uptrend = priorBars.length >= 3 &&
      priorBars[priorBars.length - 1].close > priorBars[0].close;
    const downtrend = priorBars.length >= 3 &&
      priorBars[priorBars.length - 1].close < priorBars[0].close;

    if (uptrend) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'weak', 0.5,
        'Doji Star (bearish)',
        { pattern: 'doji_star', bodyRatio: round(range > 0 ? bodySize / range : 0) },
      ));
    } else if (downtrend) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'weak', 0.5,
        'Doji Star (bullish)',
        { pattern: 'doji_star', bodyRatio: round(range > 0 ? bodySize / range : 0) },
      ));
    }

    return signals;
  }

  private detectHammerShootingStar(
    bars: BarResult[], symbol: string, timeframe: string, price: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (bars.length < 5) return signals;

    const curr = bars[bars.length - 1];
    const body = Math.abs(curr.close - curr.open);
    const range = curr.high - curr.low;
    if (range === 0 || body === 0) return signals;

    const upperShadow = curr.high - Math.max(curr.open, curr.close);
    const lowerShadow = Math.min(curr.open, curr.close) - curr.low;

    // Check prior trend
    const priorBars = bars.slice(-6, -1);
    const uptrend = priorBars[priorBars.length - 1].close > priorBars[0].close;
    const downtrend = priorBars[priorBars.length - 1].close < priorBars[0].close;

    // Hammer: small body at top, long lower shadow (> 2x body), short upper shadow
    if (downtrend && lowerShadow > body * 2 && upperShadow < body * 0.5) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'moderate', 0.6,
        'Hammer',
        { pattern: 'hammer', lowerShadowRatio: round(lowerShadow / body) },
      ));
    }

    // Shooting star: small body at bottom, long upper shadow (> 2x body), short lower shadow
    if (uptrend && upperShadow > body * 2 && lowerShadow < body * 0.5) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'moderate', 0.6,
        'Shooting Star',
        { pattern: 'shooting_star', upperShadowRatio: round(upperShadow / body) },
      ));
    }

    return signals;
  }

  private detectDoubleTopBottom(
    bars: BarResult[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    if (bars.length < 30) return signals;

    const window = bars.slice(-30);
    const highs = window.map(b => b.high);
    const lows = window.map(b => b.low);

    // Find top two peaks and troughs
    const peaks: { idx: number; value: number }[] = [];
    const troughs: { idx: number; value: number }[] = [];

    for (let i = 2; i < window.length - 2; i++) {
      if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
          highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
        peaks.push({ idx: i, value: highs[i] });
      }
      if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
          lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
        troughs.push({ idx: i, value: lows[i] });
      }
    }

    // Double top: two peaks at similar level (within 1.5%), separated by at least 5 bars
    for (let i = 0; i < peaks.length - 1; i++) {
      for (let j = i + 1; j < peaks.length; j++) {
        const diff = Math.abs(peaks[i].value - peaks[j].value) / peaks[i].value;
        const separation = peaks[j].idx - peaks[i].idx;
        if (diff < 0.015 && separation >= 5 && price < peaks[j].value) {
          signals.push(makeSignal(
            symbol, timeframe, price, 'sell', 'strong', 0.7,
            'Double Top',
            {
              peak1: round(peaks[i].value),
              peak2: round(peaks[j].value),
              pattern: 'double_top',
            },
            price - currentAtr * 3, Math.max(peaks[i].value, peaks[j].value) + currentAtr * 0.5,
          ));
          break;
        }
      }
    }

    // Double bottom: two troughs at similar level
    for (let i = 0; i < troughs.length - 1; i++) {
      for (let j = i + 1; j < troughs.length; j++) {
        const diff = Math.abs(troughs[i].value - troughs[j].value) / troughs[i].value;
        const separation = troughs[j].idx - troughs[i].idx;
        if (diff < 0.015 && separation >= 5 && price > troughs[j].value) {
          signals.push(makeSignal(
            symbol, timeframe, price, 'buy', 'strong', 0.7,
            'Double Bottom',
            {
              trough1: round(troughs[i].value),
              trough2: round(troughs[j].value),
              pattern: 'double_bottom',
            },
            price + currentAtr * 3, Math.min(troughs[i].value, troughs[j].value) - currentAtr * 0.5,
          ));
          break;
        }
      }
    }

    return signals;
  }

  private detectEmaRibbon(
    closes: number[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    const periods = [8, 13, 21, 34, 55];
    if (closes.length < 56) return signals;

    const emas = periods.map(p => {
      const values = ema(closes, p);
      return values[values.length - 1];
    });

    // Check if all EMAs are aligned bullish (8 > 13 > 21 > 34 > 55)
    const bullishAligned = emas.every((v, i) => i === 0 || emas[i - 1] > v);
    const bearishAligned = emas.every((v, i) => i === 0 || emas[i - 1] < v);

    // Check spread (tightness of ribbon)
    const spread = (Math.max(...emas) - Math.min(...emas)) / price;

    if (bullishAligned) {
      const strength: SignalStrength = spread > 0.03 ? 'strong' : 'moderate';
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', strength, 0.7,
        'EMA Ribbon (bullish aligned)',
        {
          ema8: round(emas[0]), ema13: round(emas[1]), ema21: round(emas[2]),
          ema34: round(emas[3]), ema55: round(emas[4]), spread: round(spread),
        },
        price + currentAtr * 2, emas[4] - currentAtr * 0.5,
      ));
    } else if (bearishAligned) {
      const strength: SignalStrength = spread > 0.03 ? 'strong' : 'moderate';
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', strength, 0.7,
        'EMA Ribbon (bearish aligned)',
        {
          ema8: round(emas[0]), ema13: round(emas[1]), ema21: round(emas[2]),
          ema34: round(emas[3]), ema55: round(emas[4]), spread: round(spread),
        },
        price - currentAtr * 2, emas[4] + currentAtr * 0.5,
      ));
    }

    return signals;
  }

  private detectStochasticSignal(
    candles: OHLCV[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    const stoch = stochastic(candles, 14, 3);
    if (stoch.k.length < 2 || stoch.d.length < 2) return signals;

    const currK = stoch.k[stoch.k.length - 1];
    const prevK = stoch.k[stoch.k.length - 2];
    // Align %D (it is SMA of %K, so shorter by dPeriod - 1 = 2)
    const currD = stoch.d[stoch.d.length - 1];
    const prevD = stoch.d[stoch.d.length - 2];

    // Oversold crossover: %K < 20, %K crosses above %D
    if (currK < 20 && prevK <= prevD && currK > currD) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'buy', 'moderate', 0.65,
        'Stochastic Oversold Crossover',
        { k: round(currK), d: round(currD) },
        price + currentAtr * 2, price - currentAtr * 1,
      ));
    }

    // Overbought crossover: %K > 80, %K crosses below %D
    if (currK > 80 && prevK >= prevD && currK < currD) {
      signals.push(makeSignal(
        symbol, timeframe, price, 'sell', 'moderate', 0.65,
        'Stochastic Overbought Crossover',
        { k: round(currK), d: round(currD) },
        price - currentAtr * 2, price + currentAtr * 1,
      ));
    }

    return signals;
  }

  private detectAdxTrendStart(
    candles: OHLCV[], symbol: string, timeframe: string,
    price: number, currentAtr: number,
  ): TradingSignal[] {
    const signals: TradingSignal[] = [];
    const adxValues = adx(candles, 14);
    if (adxValues.length < 2) return signals;

    const currAdx = adxValues[adxValues.length - 1];
    const prevAdx = adxValues[adxValues.length - 2];

    // ADX crossing above 25 signals trend initiation
    if (prevAdx <= 25 && currAdx > 25) {
      // Determine direction from price action (last 5 bars)
      const recentCloses = candles.slice(-5).map(c => c.close);
      const direction = recentCloses[recentCloses.length - 1] > recentCloses[0] ? 'buy' : 'sell';

      signals.push(makeSignal(
        symbol, timeframe, price,
        direction as SignalType,
        'moderate', 0.6,
        'ADX Trend Start',
        { adx: round(currAdx), prevAdx: round(prevAdx) },
        direction === 'buy' ? price + currentAtr * 2.5 : price - currentAtr * 2.5,
        direction === 'buy' ? price - currentAtr * 1.5 : price + currentAtr * 1.5,
      ));
    }

    return signals;
  }
}

// ── Utility ──────────────────────────────────────────────────

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
