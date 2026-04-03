/**
 * Market regime classification engine.
 *
 * Classifies market conditions into discrete regimes (trending, ranging,
 * volatile, quiet, breakout) using a multi-indicator scoring approach.
 * Tracks regime transitions over time and provides strategy recommendations.
 */

import type { Bar } from './connector-interface.js';
import {
  sma, rsi, bollingerBands, atr, adx,
  type OHLCV,
} from './indicators.js';
import {
  standardDeviation, mean, returns as calcReturns,
} from './math.js';

// ── Types ────────────────────────────────────────────────────

export type MarketRegime =
  | 'trending_up'
  | 'trending_down'
  | 'ranging'
  | 'volatile'
  | 'quiet'
  | 'breakout';

export interface RegimeAnalysis {
  currentRegime: MarketRegime;
  confidence: number;
  regimeScores: Record<MarketRegime, number>;
  indicators: {
    adxValue: number;
    adxTrend: 'rising' | 'falling' | 'flat';
    trendDirection: 'up' | 'down' | 'neutral';
    volatilityPercentile: number;
    bollingerWidth: number;
    rsiZone: 'oversold' | 'neutral' | 'overbought';
    volumeTrend: 'increasing' | 'decreasing' | 'stable';
    priceVsSma200: number;
    priceVsSma50: number;
    higherHighs: boolean;
    lowerLows: boolean;
  };
  transitions: RegimeTransition[];
  recommendation: RegimeRecommendation;
}

export interface RegimeTransition {
  from: MarketRegime;
  to: MarketRegime;
  timestamp: number;
  barsAgo: number;
}

export interface RegimeRecommendation {
  strategies: string[];
  riskLevel: 'low' | 'medium' | 'high';
  positionSizing: 'full' | 'reduced' | 'minimal';
  advice: string;
}

export interface RegimeHistoryEntry {
  regime: MarketRegime;
  startBar: number;
  endBar: number;
  startTimestamp: number;
  endTimestamp: number;
  durationBars: number;
  confidence: number;
}

// ── Constants ────────────────────────────────────────────────

const ADX_TRENDING_THRESHOLD = 25;
const ADX_RANGING_THRESHOLD = 20;
const VOL_HIGH_PERCENTILE = 80;
const VOL_LOW_PERCENTILE = 20;
const VOLUME_SPIKE_THRESHOLD = 1.5;
const BB_SQUEEZE_THRESHOLD = 0.03;
const BB_WIDE_THRESHOLD = 0.08;
const SWING_LOOKBACK = 10;

// ── Helpers ──────────────────────────────────────────────────

function barsToOhlcv(bars: Bar[]): OHLCV[] {
  return bars.map(b => ({
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
    timestamp: b.timestamp,
  }));
}

/**
 * Detect higher highs over a rolling window.
 * Looks at the most recent swing highs and checks if they are ascending.
 */
function detectHigherHighs(bars: Bar[], lookback: number = SWING_LOOKBACK): boolean {
  if (bars.length < lookback * 3) return false;

  const recentBars = bars.slice(-lookback * 3);
  const swingHighs: number[] = [];

  for (let i = 2; i < recentBars.length - 2; i++) {
    const h = recentBars[i].high;
    if (
      h > recentBars[i - 1].high &&
      h > recentBars[i - 2].high &&
      h > recentBars[i + 1].high &&
      h > recentBars[i + 2].high
    ) {
      swingHighs.push(h);
    }
  }

  if (swingHighs.length < 2) return false;
  const last = swingHighs.slice(-3);
  for (let i = 1; i < last.length; i++) {
    if (last[i] <= last[i - 1]) return false;
  }
  return true;
}

/**
 * Detect lower lows over a rolling window.
 */
function detectLowerLows(bars: Bar[], lookback: number = SWING_LOOKBACK): boolean {
  if (bars.length < lookback * 3) return false;

  const recentBars = bars.slice(-lookback * 3);
  const swingLows: number[] = [];

  for (let i = 2; i < recentBars.length - 2; i++) {
    const l = recentBars[i].low;
    if (
      l < recentBars[i - 1].low &&
      l < recentBars[i - 2].low &&
      l < recentBars[i + 1].low &&
      l < recentBars[i + 2].low
    ) {
      swingLows.push(l);
    }
  }

  if (swingLows.length < 2) return false;
  const last = swingLows.slice(-3);
  for (let i = 1; i < last.length; i++) {
    if (last[i] >= last[i - 1]) return false;
  }
  return true;
}

/**
 * Calculate volatility percentile: where current ATR sits relative to history.
 * Returns 0–100.
 */
function computeVolatilityPercentile(atrValues: number[]): number {
  if (atrValues.length < 10) return 50;
  const current = atrValues[atrValues.length - 1];
  const sorted = [...atrValues].sort((a, b) => a - b);
  const belowCount = sorted.filter(v => v < current).length;
  return Math.round((belowCount / sorted.length) * 100);
}

/**
 * Determine volume trend from recent bars.
 */
function computeVolumeTrend(volumes: number[], shortWindow: number = 5, longWindow: number = 20): 'increasing' | 'decreasing' | 'stable' {
  if (volumes.length < longWindow) return 'stable';
  const shortAvg = mean(volumes.slice(-shortWindow));
  const longAvg = mean(volumes.slice(-longWindow));
  if (longAvg === 0) return 'stable';
  const ratio = shortAvg / longAvg;
  if (ratio > 1.2) return 'increasing';
  if (ratio < 0.8) return 'decreasing';
  return 'stable';
}

/**
 * Determine ADX trend direction from recent ADX values.
 */
function computeAdxTrend(adxValues: number[], lookback: number = 5): 'rising' | 'falling' | 'flat' {
  if (adxValues.length < lookback) return 'flat';
  const recent = adxValues.slice(-lookback);
  const first = mean(recent.slice(0, Math.floor(lookback / 2)));
  const second = mean(recent.slice(Math.floor(lookback / 2)));
  const diff = second - first;
  if (diff > 2) return 'rising';
  if (diff < -2) return 'falling';
  return 'flat';
}

/**
 * Classify RSI into zones.
 */
function classifyRsi(rsiValue: number): 'oversold' | 'neutral' | 'overbought' {
  if (rsiValue < 30) return 'oversold';
  if (rsiValue > 70) return 'overbought';
  return 'neutral';
}

// ── Regime Scoring ───────────────────────────────────────────

interface IndicatorSnapshot {
  adxValue: number;
  adxTrend: 'rising' | 'falling' | 'flat';
  trendDirection: 'up' | 'down' | 'neutral';
  volatilityPercentile: number;
  bollingerWidth: number;
  rsiZone: 'oversold' | 'neutral' | 'overbought';
  rsiValue: number;
  volumeTrend: 'increasing' | 'decreasing' | 'stable';
  priceVsSma200: number;
  priceVsSma50: number;
  higherHighs: boolean;
  lowerLows: boolean;
  volumeSpike: boolean;
  bbSqueeze: boolean;
  bbSqueezeRelease: boolean;
  candleBodyRatio: number;
  /** ATR normalized by price (ATR/price * 100) — key for vol classification */
  normalizedAtr: number;
  /** Standard deviation of returns — raw vol measure */
  returnStdDev: number;
  /** Net price change as % of the range — directional strength */
  netDirectionPct: number;
  /** How many times price crosses the SMA20 in recent bars — oscillation measure */
  smaCrossCount: number;
  /** Ratio of total absolute bar-to-bar changes to net change — high = oscillating */
  pathToNetRatio: number;
}

function scoreTrendingUp(snap: IndicatorSnapshot): number {
  let score = 0;

  // Strong directional move is the primary signal
  if (snap.netDirectionPct > 0.6 && snap.trendDirection === 'up') score += 0.3;
  else if (snap.trendDirection === 'up') score += 0.15;

  if (snap.adxValue > ADX_TRENDING_THRESHOLD) score += 0.2;
  if (snap.priceVsSma50 > 2) score += 0.15;
  else if (snap.priceVsSma50 > 0) score += 0.05;
  if (snap.higherHighs) score += 0.15;
  if (snap.rsiValue > 55 && snap.rsiValue < 80) score += 0.1;

  // Penalize if direction is ambiguous
  if (snap.netDirectionPct < 0.3) score *= 0.5;

  // Penalize if volatility is high — that's volatile, not trending
  if (snap.returnStdDev > 0.05) score *= 0.3;
  else if (snap.normalizedAtr > 6) score *= 0.5;

  // Penalize if price is oscillating more than trending
  if (snap.pathToNetRatio > 8) score *= 0.5;

  return Math.min(1, score);
}

function scoreTrendingDown(snap: IndicatorSnapshot): number {
  let score = 0;

  if (snap.netDirectionPct > 0.6 && snap.trendDirection === 'down') score += 0.3;
  else if (snap.trendDirection === 'down') score += 0.15;

  if (snap.adxValue > ADX_TRENDING_THRESHOLD) score += 0.2;
  if (snap.priceVsSma50 < -2) score += 0.15;
  else if (snap.priceVsSma50 < 0) score += 0.05;
  if (snap.lowerLows) score += 0.15;
  if (snap.rsiValue < 45 && snap.rsiValue > 20) score += 0.1;

  if (snap.netDirectionPct < 0.3) score *= 0.5;

  // Penalize if volatility is high — that's volatile, not trending
  if (snap.returnStdDev > 0.05) score *= 0.3;
  else if (snap.normalizedAtr > 6) score *= 0.5;

  // Penalize if price is oscillating more than trending
  if (snap.pathToNetRatio > 8) score *= 0.5;

  return Math.min(1, score);
}

function scoreRanging(snap: IndicatorSnapshot): number {
  let score = 0;

  // High path-to-net ratio is the strongest ranging signal
  // (lots of back-and-forth relative to net movement)
  if (snap.pathToNetRatio > 10) score += 0.3;
  else if (snap.pathToNetRatio > 5) score += 0.2;
  else if (snap.pathToNetRatio > 3) score += 0.1;

  // Frequent SMA crosses = oscillating price
  if (snap.smaCrossCount > 10) score += 0.2;
  else if (snap.smaCrossCount > 5) score += 0.1;

  if (snap.adxValue < ADX_RANGING_THRESHOLD) score += 0.15;
  if (!snap.higherHighs && !snap.lowerLows) score += 0.1;
  if (snap.trendDirection === 'neutral') score += 0.1;

  // Distinguish from quiet: ranging has moderate volatility
  if (snap.normalizedAtr > 0.3 && snap.normalizedAtr < 8) score += 0.1;

  // Penalize if very low path-to-net ratio (clearly directional)
  if (snap.pathToNetRatio < 2) score *= 0.3;

  // Penalize if return volatility is very high — that's volatile, not ranging
  if (snap.returnStdDev > 0.08) score *= 0.3;
  else if (snap.returnStdDev > 0.05) score *= 0.6;

  // Penalize if return volatility is extremely low — that's quiet, not ranging
  if (snap.returnStdDev < 0.002) score *= 0.5;

  return Math.min(1, score);
}

function scoreVolatile(snap: IndicatorSnapshot): number {
  let score = 0;

  // Extreme return volatility is the definitive signal
  if (snap.returnStdDev > 0.12) score += 0.4;
  else if (snap.returnStdDev > 0.06) score += 0.25;
  else if (snap.returnStdDev > 0.03) score += 0.15;

  // High normalized ATR
  if (snap.normalizedAtr > 15) score += 0.3;
  else if (snap.normalizedAtr > 8) score += 0.2;
  else if (snap.normalizedAtr > 4) score += 0.1;

  if (snap.bollingerWidth > BB_WIDE_THRESHOLD) score += 0.1;
  if (snap.candleBodyRatio > 0.6) score += 0.1;

  // Penalize if low volatility
  if (snap.normalizedAtr < 2) score *= 0.3;

  return Math.min(1, score);
}

function scoreQuiet(snap: IndicatorSnapshot): number {
  let score = 0;

  // Very low return standard deviation is the definitive quiet signal
  if (snap.returnStdDev < 0.002) score += 0.35;
  else if (snap.returnStdDev < 0.005) score += 0.25;
  else if (snap.returnStdDev < 0.01) score += 0.1;

  // Very low normalized ATR
  if (snap.normalizedAtr < 0.2) score += 0.25;
  else if (snap.normalizedAtr < 0.5) score += 0.15;

  if (snap.bollingerWidth < BB_SQUEEZE_THRESHOLD) score += 0.15;
  if (snap.candleBodyRatio < 0.35) score += 0.1;
  if (snap.adxValue < 15) score += 0.1;

  // Penalize if there is significant movement
  if (snap.normalizedAtr > 1) score *= 0.3;

  return Math.min(1, score);
}

function scoreBreakout(snap: IndicatorSnapshot): number {
  let score = 0;
  if (snap.bbSqueezeRelease) score += 0.3;
  if (snap.volumeSpike) score += 0.25;
  if (snap.adxTrend === 'rising') score += 0.2;
  if (snap.volatilityPercentile > 60 && snap.volatilityPercentile < 90) score += 0.15;
  if (snap.candleBodyRatio > 0.6) score += 0.1;
  return Math.min(1, score);
}

// ── Strategy Recommendations ─────────────────────────────────

const REGIME_STRATEGIES: Record<MarketRegime, RegimeRecommendation> = {
  trending_up: {
    strategies: ['momentum', 'trend-following', 'breakout'],
    riskLevel: 'medium',
    positionSizing: 'full',
    advice: 'Market is trending up. Favor long momentum strategies with trailing stops. Buy dips to moving averages. Avoid counter-trend shorts.',
  },
  trending_down: {
    strategies: ['short-selling', 'hedging', 'mean-reversion'],
    riskLevel: 'high',
    positionSizing: 'reduced',
    advice: 'Market is trending down. Consider short positions or hedges. Mean-reversion counter-trend entries at resistance. Reduce overall exposure.',
  },
  ranging: {
    strategies: ['mean-reversion', 'grid-trading', 'range-trading'],
    riskLevel: 'low',
    positionSizing: 'full',
    advice: 'Market is range-bound. Buy support, sell resistance. Grid strategies work well. Watch for breakout signals that would invalidate the range.',
  },
  volatile: {
    strategies: ['reduce-size', 'widen-stops', 'volatility-selling'],
    riskLevel: 'high',
    positionSizing: 'minimal',
    advice: 'Market is highly volatile. Reduce position sizes significantly. Widen stop-losses to avoid whipsaws. Consider selling volatility (options) or waiting for conditions to stabilize.',
  },
  quiet: {
    strategies: ['accumulate', 'bollinger-squeeze', 'breakout-preparation'],
    riskLevel: 'low',
    positionSizing: 'full',
    advice: 'Market is quiet with low volatility. Good time to accumulate positions. Watch for Bollinger squeeze setups — a big move is likely coming. Prepare breakout orders.',
  },
  breakout: {
    strategies: ['momentum', 'trend-following', 'scale-in'],
    riskLevel: 'medium',
    positionSizing: 'reduced',
    advice: 'Market is breaking out. Enter in the direction of the breakout with tight initial stops. Scale in as the move confirms. Watch volume for follow-through.',
  },
};

function getRecommendation(regime: MarketRegime, riskTolerance?: 'conservative' | 'moderate' | 'aggressive'): RegimeRecommendation {
  const base = { ...REGIME_STRATEGIES[regime] };

  if (riskTolerance === 'conservative') {
    if (base.positionSizing === 'full') base.positionSizing = 'reduced';
    else if (base.positionSizing === 'reduced') base.positionSizing = 'minimal';
    if (base.riskLevel === 'medium') base.riskLevel = 'high';
  } else if (riskTolerance === 'aggressive') {
    if (base.positionSizing === 'minimal') base.positionSizing = 'reduced';
    else if (base.positionSizing === 'reduced') base.positionSizing = 'full';
    if (base.riskLevel === 'medium') base.riskLevel = 'low';
  }

  return base;
}

// ── RegimeDetector Class ─────────────────────────────────────

export class RegimeDetector {
  /**
   * Minimum bars required for a full regime analysis.
   * Need 200 for SMA-200 plus some buffer.
   */
  static readonly MIN_BARS = 220;

  /**
   * Compute a full indicator snapshot from bar data.
   */
  private computeSnapshot(bars: Bar[]): IndicatorSnapshot {
    const candles = barsToOhlcv(bars);
    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume);

    // Moving averages
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const currentPrice = closes[closes.length - 1];

    const latestSma50 = sma50.length > 0 ? sma50[sma50.length - 1] : currentPrice;
    const latestSma200 = sma200.length > 0 ? sma200[sma200.length - 1] : currentPrice;

    const priceVsSma50 = latestSma50 === 0 ? 0 : ((currentPrice - latestSma50) / latestSma50) * 100;
    const priceVsSma200 = latestSma200 === 0 ? 0 : ((currentPrice - latestSma200) / latestSma200) * 100;

    // ADX
    const adxValues = adx(candles, 14);
    const latestAdx = adxValues.length > 0 ? adxValues[adxValues.length - 1] : 0;
    const adxTrendDir = computeAdxTrend(adxValues);

    // Trend direction: compare SMA50 slope
    let trendDirection: 'up' | 'down' | 'neutral' = 'neutral';
    if (sma50.length >= 5) {
      const recent = sma50.slice(-5);
      const slope = recent[recent.length - 1] - recent[0];
      const avgPrice = mean(recent);
      const slopeNorm = avgPrice === 0 ? 0 : (slope / avgPrice) * 100;
      if (slopeNorm > 0.5) trendDirection = 'up';
      else if (slopeNorm < -0.5) trendDirection = 'down';
    }

    // ATR + volatility percentile
    const atrValues = atr(candles, 14);
    const volPercentile = computeVolatilityPercentile(atrValues);

    // Bollinger Bands
    const bb = bollingerBands(closes, 20, 2);
    const latestBbWidth = bb.width.length > 0 ? bb.width[bb.width.length - 1] : 0;

    // Bollinger squeeze detection
    const bbSqueeze = latestBbWidth < BB_SQUEEZE_THRESHOLD;
    let bbSqueezeRelease = false;
    if (bb.width.length >= 5) {
      const recentWidths = bb.width.slice(-5);
      const prevMin = Math.min(...recentWidths.slice(0, 3));
      const currWidth = recentWidths[recentWidths.length - 1];
      if (prevMin < BB_SQUEEZE_THRESHOLD && currWidth > BB_SQUEEZE_THRESHOLD * 1.5) {
        bbSqueezeRelease = true;
      }
    }

    // RSI
    const rsiValues = rsi(closes, 14);
    const latestRsi = rsiValues.length > 0 ? rsiValues[rsiValues.length - 1] : 50;
    const rsiZone = classifyRsi(latestRsi);

    // Volume
    const volumeTrend = computeVolumeTrend(volumes);
    const shortVolAvg = volumes.length >= 5 ? mean(volumes.slice(-5)) : 0;
    const longVolAvg = volumes.length >= 20 ? mean(volumes.slice(-20)) : shortVolAvg;
    const volumeSpike = longVolAvg > 0 && shortVolAvg / longVolAvg > VOLUME_SPIKE_THRESHOLD;

    // Swing structure
    const higherHighs = detectHigherHighs(bars);
    const lowerLows = detectLowerLows(bars);

    // Candle body ratio: average body / average range for recent bars
    const recentBars = bars.slice(-20);
    const bodyRatios = recentBars.map(b => {
      const range = b.high - b.low;
      const body = Math.abs(b.close - b.open);
      return range === 0 ? 0 : body / range;
    });
    const candleBodyRatio = mean(bodyRatios);

    // Normalized ATR: ATR / price * 100
    const latestAtr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;
    const normalizedAtr = currentPrice === 0 ? 0 : (latestAtr / Math.abs(currentPrice)) * 100;

    // Return standard deviation
    const priceReturns = calcReturns(closes);
    const returnStdDev = priceReturns.length > 1 ? standardDeviation(priceReturns) : 0;

    // Net direction: how much net movement vs total range
    const firstPrice = closes[0];
    const priceRange = Math.max(...closes) - Math.min(...closes);
    const netChange = currentPrice - firstPrice;
    const netDirectionPct = priceRange === 0 ? 0 : Math.abs(netChange) / priceRange;

    // SMA cross count: how often price crosses the SMA20 (oscillation measure)
    const sma20 = sma(closes, 20);
    let smaCrossCount = 0;
    if (sma20.length > 1) {
      const offset = closes.length - sma20.length;
      for (let ci = 1; ci < sma20.length; ci++) {
        const prevAbove = closes[offset + ci - 1] > sma20[ci - 1];
        const currAbove = closes[offset + ci] > sma20[ci];
        if (prevAbove !== currAbove) smaCrossCount++;
      }
    }

    // Path-to-net ratio: total absolute changes / absolute net change
    // High ratio (>5) means lots of back-and-forth (ranging)
    // Low ratio (~1) means consistent direction (trending)
    let totalAbsChange = 0;
    for (let ci = 1; ci < closes.length; ci++) {
      totalAbsChange += Math.abs(closes[ci] - closes[ci - 1]);
    }
    const absNetChange = Math.abs(closes[closes.length - 1] - closes[0]);
    const pathToNetRatio = absNetChange < 0.001 ? 100 : totalAbsChange / absNetChange;

    return {
      adxValue: latestAdx,
      adxTrend: adxTrendDir,
      trendDirection,
      volatilityPercentile: volPercentile,
      bollingerWidth: latestBbWidth,
      rsiZone,
      rsiValue: latestRsi,
      volumeTrend,
      priceVsSma200: Math.round(priceVsSma200 * 100) / 100,
      priceVsSma50: Math.round(priceVsSma50 * 100) / 100,
      higherHighs,
      lowerLows,
      volumeSpike,
      bbSqueeze,
      bbSqueezeRelease,
      candleBodyRatio,
      normalizedAtr,
      returnStdDev,
      netDirectionPct,
      smaCrossCount,
      pathToNetRatio,
    };
  }

  /**
   * Score all regimes and pick the winner.
   */
  private scoreRegimes(snap: IndicatorSnapshot): { scores: Record<MarketRegime, number>; winner: MarketRegime; confidence: number } {
    const scores: Record<MarketRegime, number> = {
      trending_up: scoreTrendingUp(snap),
      trending_down: scoreTrendingDown(snap),
      ranging: scoreRanging(snap),
      volatile: scoreVolatile(snap),
      quiet: scoreQuiet(snap),
      breakout: scoreBreakout(snap),
    };

    let winner: MarketRegime = 'ranging';
    let maxScore = -1;
    for (const [regime, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        winner = regime as MarketRegime;
      }
    }

    // Confidence: combination of absolute score strength and margin over runner-up
    const sortedScores = Object.values(scores).sort((a, b) => b - a);
    const gap = sortedScores.length > 1 ? sortedScores[0] - sortedScores[1] : sortedScores[0];
    const confidence = Math.min(1, Math.max(0, maxScore * 0.7 + gap * 0.6));

    return {
      scores: Object.fromEntries(
        Object.entries(scores).map(([k, v]) => [k, Math.round(v * 1000) / 1000])
      ) as Record<MarketRegime, number>,
      winner,
      confidence: Math.round(confidence * 1000) / 1000,
    };
  }

  /**
   * Detect regime at a specific point in the bar series.
   * Uses bars up to `endIndex` (exclusive) for the analysis.
   */
  private detectAtIndex(bars: Bar[], endIndex: number): { regime: MarketRegime; confidence: number } | null {
    const minBars = 50; // minimum for a meaningful regime classification
    if (endIndex < minBars) return null;

    const slice = bars.slice(0, endIndex);
    const snap = this.computeSnapshot(slice);
    const { winner, confidence } = this.scoreRegimes(snap);
    return { regime: winner, confidence };
  }

  /**
   * Simple detect method: classify bars and return regime, confidence, and recommendations.
   * Handles short or empty data gracefully without throwing.
   */
  detect(bars: Bar[]): { regime: MarketRegime; confidence: number; recommendations: string[] } {
    if (bars.length < 20) {
      // Not enough data for meaningful classification — return a low-confidence default
      const defaultRegime: MarketRegime = bars.length === 0 ? 'quiet' : 'ranging';
      return {
        regime: defaultRegime,
        confidence: 0,
        recommendations: REGIME_STRATEGIES[defaultRegime].strategies,
      };
    }

    const snap = this.computeSnapshot(bars);
    const { winner, confidence } = this.scoreRegimes(snap);
    const rec = getRecommendation(winner);

    return {
      regime: winner,
      confidence,
      recommendations: rec.strategies,
    };
  }

  /**
   * Scan backward through bar data to identify regime transitions.
   * Returns an object with the transition list and the current regime.
   */
  detectTransitions(bars: Bar[], step: number = 10): { transitions: RegimeTransition[]; currentRegime: MarketRegime } {
    const transitions: RegimeTransition[] = [];
    const totalBars = bars.length;

    if (totalBars < 60) {
      const current = this.detect(bars);
      return { transitions, currentRegime: current.regime };
    }

    let prevRegime: MarketRegime | null = null;
    let lastRegime: MarketRegime = 'ranging';

    // Walk from oldest viable window to newest
    const startIdx = Math.max(50, totalBars - 200);
    for (let i = startIdx; i <= totalBars; i += step) {
      const result = this.detectAtIndex(bars, i);
      if (!result) continue;

      lastRegime = result.regime;

      if (prevRegime !== null && result.regime !== prevRegime) {
        const barIdx = Math.min(i, totalBars - 1);
        transitions.push({
          from: prevRegime,
          to: result.regime,
          timestamp: bars[barIdx]?.timestamp ?? 0,
          barsAgo: totalBars - barIdx,
        });
      }

      prevRegime = result.regime;
    }

    return { transitions, currentRegime: lastRegime };
  }

  /**
   * Build a full regime history with duration info.
   */
  getHistory(bars: Bar[], step: number = 10): RegimeHistoryEntry[] {
    const history: RegimeHistoryEntry[] = [];
    const totalBars = bars.length;

    if (totalBars < 50) return history;

    let currentRegime: MarketRegime | null = null;
    let segmentStart = 0;
    let segmentStartTimestamp = 0;
    let segmentConfidence = 0;

    const startIdx = Math.max(50, totalBars - 300);
    for (let i = startIdx; i <= totalBars; i += step) {
      const result = this.detectAtIndex(bars, i);
      if (!result) continue;

      const barIdx = Math.min(i - 1, totalBars - 1);

      if (currentRegime === null) {
        currentRegime = result.regime;
        segmentStart = barIdx;
        segmentStartTimestamp = bars[barIdx]?.timestamp ?? 0;
        segmentConfidence = result.confidence;
        continue;
      }

      if (result.regime !== currentRegime) {
        // Close the previous segment
        history.push({
          regime: currentRegime,
          startBar: segmentStart,
          endBar: barIdx,
          startTimestamp: segmentStartTimestamp,
          endTimestamp: bars[barIdx]?.timestamp ?? 0,
          durationBars: barIdx - segmentStart,
          confidence: segmentConfidence,
        });

        currentRegime = result.regime;
        segmentStart = barIdx;
        segmentStartTimestamp = bars[barIdx]?.timestamp ?? 0;
        segmentConfidence = result.confidence;
      } else {
        // Update confidence with rolling average
        segmentConfidence = (segmentConfidence + result.confidence) / 2;
      }
    }

    // Close final segment
    if (currentRegime !== null) {
      const lastIdx = totalBars - 1;
      history.push({
        regime: currentRegime,
        startBar: segmentStart,
        endBar: lastIdx,
        startTimestamp: segmentStartTimestamp,
        endTimestamp: bars[lastIdx]?.timestamp ?? 0,
        durationBars: lastIdx - segmentStart,
        confidence: segmentConfidence,
      });
    }

    return history;
  }

  /**
   * Primary analysis method: classify the current market regime.
   */
  analyze(bars: Bar[]): RegimeAnalysis {
    if (bars.length < 50) {
      throw new Error(`Need at least 50 bars for regime detection, got ${bars.length}`);
    }

    const snap = this.computeSnapshot(bars);
    const { scores, winner, confidence } = this.scoreRegimes(snap);
    const { transitions } = this.detectTransitions(bars);
    const recommendation = getRecommendation(winner);

    return {
      currentRegime: winner,
      confidence,
      regimeScores: scores,
      indicators: {
        adxValue: Math.round(snap.adxValue * 100) / 100,
        adxTrend: snap.adxTrend,
        trendDirection: snap.trendDirection,
        volatilityPercentile: snap.volatilityPercentile,
        bollingerWidth: Math.round(snap.bollingerWidth * 10000) / 10000,
        rsiZone: snap.rsiZone,
        volumeTrend: snap.volumeTrend,
        priceVsSma200: snap.priceVsSma200,
        priceVsSma50: snap.priceVsSma50,
        higherHighs: snap.higherHighs,
        lowerLows: snap.lowerLows,
      },
      transitions,
      recommendation,
    };
  }

  /**
   * Match a strategy to the current regime with risk tolerance adjustment.
   */
  matchStrategy(
    bars: Bar[],
    riskTolerance: 'conservative' | 'moderate' | 'aggressive' = 'moderate',
  ): RegimeAnalysis {
    const analysis = this.analyze(bars);
    analysis.recommendation = getRecommendation(analysis.currentRegime, riskTolerance);
    return analysis;
  }
}
