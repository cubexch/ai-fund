/**
 * Order flow analytics: pure functions for CVD, footprint charts,
 * absorption/iceberg detection, aggressive/passive flow, and more.
 * No async, no exchange clients — composable building blocks.
 */

import { mean, standardDeviation } from './math.js';

// ── Interfaces ───────────────────────────────────────────────

export interface Trade {
  price: number;
  volume: number;
  side: 'buy' | 'sell';
}

export interface TimestampedTrade extends Trade {
  timestamp: number;
}

export interface MakerTrade extends Trade {
  isMaker: boolean;
}

export interface CvdResult {
  cvd: number[];
  totalBuyVolume: number;
  totalSellVolume: number;
  netDelta: number;
  trend: 'accumulation' | 'distribution' | 'neutral';
}

export interface FootprintLevel {
  price: number;
  bidVolume: number;
  askVolume: number;
  delta: number;
  totalVolume: number;
  imbalance: number;
}

export interface FootprintResult {
  levels: FootprintLevel[];
  poc: number;
  highVolNode: number;
  lowVolNode: number;
}

export interface Absorption {
  price: number;
  absorbedVolume: number;
  side: 'bid' | 'ask';
  strength: number;
  timestamp: number;
}

export interface AbsorptionResult {
  absorptions: Absorption[];
  totalAbsorbed: number;
  dominantSide: 'buyers' | 'sellers' | 'balanced';
}

export interface IcebergEntry {
  price: number;
  side: 'buy' | 'sell';
  estimatedSize: number;
  fillCount: number;
  avgFillSize: number;
  confidence: number;
}

export interface IcebergResult {
  icebergs: IcebergEntry[];
  totalHiddenLiquidity: number;
}

export interface AggressivePassiveResult {
  aggressiveBuy: number;
  aggressiveSell: number;
  passiveBuy: number;
  passiveSell: number;
  aggressiveRatio: number;
  netAggressive: number;
  signal: 'aggressive_buying' | 'aggressive_selling' | 'passive_accumulation' | 'passive_distribution' | 'balanced';
}

export interface VolumeClockResult {
  currentRate: number;
  averageRate: number;
  acceleration: number;
  percentile: number;
  regime: 'fast' | 'normal' | 'slow';
  timeToNextBucket: number;
}

export interface ImbalanceLevel {
  price: number;
  imbalance: number;
  buyVolume: number;
  sellVolume: number;
  significantImbalance: boolean;
}

export interface StrongLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: number;
}

export interface ImbalanceProfileResult {
  profile: ImbalanceLevel[];
  overallImbalance: number;
  strongLevels: StrongLevel[];
}

export interface DeltaDivergence {
  index: number;
  type: 'bullish' | 'bearish';
  priceTrend: 'up' | 'down';
  deltaTrend: 'up' | 'down';
}

export interface DeltaExhaustion {
  index: number;
  type: 'buying_exhaustion' | 'selling_exhaustion';
}

export interface DeltaProfileResult {
  deltas: number[];
  cumulativeDelta: number[];
  divergences: DeltaDivergence[];
  exhaustion: DeltaExhaustion[];
}

export interface LargeTrade {
  price: number;
  volume: number;
  side: 'buy' | 'sell';
  timestamp: number;
  zScore: number;
}

export interface LargeTradeResult {
  largeTrades: LargeTrade[];
  totalLargeVolume: number;
  largeTradeRatio: number;
  netLargeFlow: number;
  whaleActivity: 'heavy_buying' | 'heavy_selling' | 'mixed' | 'quiet';
}

export interface HeatmapCell {
  timeSlot: number;
  priceLevel: number;
  volume: number;
  tradeCount: number;
  intensity: number;
}

export interface TradeIntensityResult {
  cells: HeatmapCell[];
  hotspots: Array<{ timeSlot: number; priceLevel: number; intensity: number }>;
  quietPeriods: Array<{ start: number; end: number }>;
}

// ── Functions ────────────────────────────────────────────────

/**
 * Cumulative Volume Delta — running sum of buy minus sell volume.
 * Reveals whether aggressive buyers or sellers dominate.
 */
export function cumulativeVolumeDelta(trades: Trade[]): CvdResult {
  if (trades.length === 0) {
    return { cvd: [], totalBuyVolume: 0, totalSellVolume: 0, netDelta: 0, trend: 'neutral' };
  }

  const cvd: number[] = [];
  let totalBuyVolume = 0;
  let totalSellVolume = 0;
  let running = 0;

  for (const t of trades) {
    if (t.side === 'buy') {
      totalBuyVolume += t.volume;
      running += t.volume;
    } else {
      totalSellVolume += t.volume;
      running -= t.volume;
    }
    cvd.push(running);
  }

  const netDelta = totalBuyVolume - totalSellVolume;
  const totalVolume = totalBuyVolume + totalSellVolume;
  const ratio = totalVolume === 0 ? 0 : Math.abs(netDelta) / totalVolume;

  let trend: CvdResult['trend'] = 'neutral';
  if (ratio > 0.1) {
    trend = netDelta > 0 ? 'accumulation' : 'distribution';
  }

  return { cvd, totalBuyVolume, totalSellVolume, netDelta, trend };
}

/**
 * Footprint chart data — aggregate trades into price level buckets.
 * Each level shows bid volume, ask volume, delta, and imbalance.
 */
export function footprintData(trades: Trade[], tickSize: number): FootprintResult {
  if (trades.length === 0 || tickSize <= 0) {
    return { levels: [], poc: 0, highVolNode: 0, lowVolNode: 0 };
  }

  const buckets = new Map<number, { bidVolume: number; askVolume: number }>();

  for (const t of trades) {
    const bucket = Math.round(t.price / tickSize) * tickSize;
    const rounded = parseFloat(bucket.toPrecision(12));
    let entry = buckets.get(rounded);
    if (!entry) {
      entry = { bidVolume: 0, askVolume: 0 };
      buckets.set(rounded, entry);
    }
    if (t.side === 'buy') {
      entry.askVolume += t.volume; // buyer lifts the ask
    } else {
      entry.bidVolume += t.volume; // seller hits the bid
    }
  }

  const levels: FootprintLevel[] = [];
  let maxVol = 0;
  let minVol = Infinity;
  let pocPrice = 0;
  let highVolNodePrice = 0;
  let lowVolNodePrice = 0;

  for (const [price, { bidVolume, askVolume }] of buckets) {
    const totalVolume = bidVolume + askVolume;
    const delta = askVolume - bidVolume;
    const imbalance = totalVolume === 0 ? 0 : delta / totalVolume;
    levels.push({ price, bidVolume, askVolume, delta, totalVolume, imbalance });

    if (totalVolume > maxVol) {
      maxVol = totalVolume;
      pocPrice = price;
      highVolNodePrice = price;
    }
    if (totalVolume < minVol) {
      minVol = totalVolume;
      lowVolNodePrice = price;
    }
  }

  levels.sort((a, b) => a.price - b.price);

  return { levels, poc: pocPrice, highVolNode: highVolNodePrice, lowVolNode: lowVolNodePrice };
}

/**
 * Absorption detection — find large resting orders absorbing aggressive flow.
 * Identifies price levels where significant volume was traded without price movement.
 */
export function absorptionDetection(
  orderbook: { bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }> },
  trades: TimestampedTrade[],
  params?: { windowSize?: number; threshold?: number }
): AbsorptionResult {
  const windowSize = params?.windowSize ?? 10;
  const threshold = params?.threshold ?? 2.0;

  if (trades.length === 0) {
    return { absorptions: [], totalAbsorbed: 0, dominantSide: 'balanced' };
  }

  // Build a set of significant orderbook levels
  const bidLevels = new Map<number, number>();
  const askLevels = new Map<number, number>();
  for (const b of orderbook.bids) bidLevels.set(b.price, b.qty);
  for (const a of orderbook.asks) askLevels.set(a.price, a.qty);

  // Group trades by price within rolling windows
  const volumes = trades.map(t => t.volume);
  const avgVol = mean(volumes);
  const stdVol = standardDeviation(volumes);
  const volumeThreshold = avgVol + threshold * stdVol;

  const priceGroups = new Map<number, { totalVolume: number; trades: TimestampedTrade[] }>();
  for (const t of trades) {
    let group = priceGroups.get(t.price);
    if (!group) {
      group = { totalVolume: 0, trades: [] };
      priceGroups.set(t.price, group);
    }
    group.totalVolume += t.volume;
    group.trades.push(t);
  }

  const absorptions: Absorption[] = [];

  for (const [price, group] of priceGroups) {
    if (group.trades.length < windowSize) continue;

    // Check if this level has significant resting liquidity
    const bidQty = bidLevels.get(price) ?? 0;
    const askQty = askLevels.get(price) ?? 0;
    const restingQty = Math.max(bidQty, askQty);

    if (group.totalVolume > volumeThreshold && restingQty > 0) {
      const side: 'bid' | 'ask' = bidQty >= askQty ? 'bid' : 'ask';
      const strength = Math.min(group.totalVolume / (avgVol * windowSize), 5);
      const latestTs = group.trades[group.trades.length - 1].timestamp;
      absorptions.push({
        price,
        absorbedVolume: group.totalVolume,
        side,
        strength,
        timestamp: latestTs,
      });
    }
  }

  const totalAbsorbed = absorptions.reduce((s, a) => s + a.absorbedVolume, 0);
  const bidAbsorbed = absorptions.filter(a => a.side === 'bid').reduce((s, a) => s + a.absorbedVolume, 0);
  const askAbsorbed = absorptions.filter(a => a.side === 'ask').reduce((s, a) => s + a.absorbedVolume, 0);

  let dominantSide: AbsorptionResult['dominantSide'] = 'balanced';
  const total = bidAbsorbed + askAbsorbed;
  if (total > 0) {
    const ratio = bidAbsorbed / total;
    if (ratio > 0.6) dominantSide = 'buyers';
    else if (ratio < 0.4) dominantSide = 'sellers';
  }

  return { absorptions, totalAbsorbed, dominantSide };
}

/**
 * Iceberg detection — find hidden orders from repeated fills at the same price.
 * Icebergs show a pattern of consistent-sized fills at a single level.
 */
export function icebergDetection(
  trades: TimestampedTrade[],
  params?: { minRepeat?: number; priceTolerance?: number; timeTolerance?: number }
): IcebergResult {
  const minRepeat = params?.minRepeat ?? 3;
  const priceTolerance = params?.priceTolerance ?? 0.001;
  const timeTolerance = params?.timeTolerance ?? 60000; // 60s default

  if (trades.length < minRepeat) {
    return { icebergs: [], totalHiddenLiquidity: 0 };
  }

  // Group trades by approximate price level and side
  const clusters: Array<{ price: number; side: 'buy' | 'sell'; fills: TimestampedTrade[] }> = [];

  for (const t of trades) {
    let matched = false;
    for (const cluster of clusters) {
      const priceDiff = Math.abs(t.price - cluster.price) / cluster.price;
      if (priceDiff <= priceTolerance && t.side === cluster.side) {
        const lastFill = cluster.fills[cluster.fills.length - 1];
        if (t.timestamp - lastFill.timestamp <= timeTolerance) {
          cluster.fills.push(t);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      clusters.push({ price: t.price, side: t.side, fills: [t] });
    }
  }

  const icebergs: IcebergEntry[] = [];

  for (const cluster of clusters) {
    if (cluster.fills.length < minRepeat) continue;

    const sizes = cluster.fills.map(f => f.volume);
    const avgSize = mean(sizes);
    const sizeStd = standardDeviation(sizes);

    // Iceberg fills tend to have consistent sizes (low coefficient of variation)
    const cv = avgSize > 0 ? sizeStd / avgSize : 1;
    const confidence = Math.max(0, Math.min(1, 1 - cv));

    // Only flag if fills are reasonably consistent
    if (confidence > 0.3) {
      icebergs.push({
        price: cluster.price,
        side: cluster.side,
        estimatedSize: avgSize * cluster.fills.length,
        fillCount: cluster.fills.length,
        avgFillSize: avgSize,
        confidence,
      });
    }
  }

  const totalHiddenLiquidity = icebergs.reduce((s, i) => s + i.estimatedSize, 0);

  return { icebergs, totalHiddenLiquidity };
}

/**
 * Aggressive vs passive flow classification.
 * Taker (aggressive) flow drives price; maker (passive) flow absorbs it.
 */
export function aggressivePassiveFlow(
  trades: MakerTrade[],
  params?: { windowSize?: number }
): AggressivePassiveResult {
  const _windowSize = params?.windowSize ?? trades.length;
  const window = trades.slice(-_windowSize);

  let aggressiveBuy = 0;
  let aggressiveSell = 0;
  let passiveBuy = 0;
  let passiveSell = 0;

  for (const t of window) {
    if (t.isMaker) {
      if (t.side === 'buy') passiveBuy += t.volume;
      else passiveSell += t.volume;
    } else {
      if (t.side === 'buy') aggressiveBuy += t.volume;
      else aggressiveSell += t.volume;
    }
  }

  const totalAggressive = aggressiveBuy + aggressiveSell;
  const totalPassive = passiveBuy + passiveSell;
  const totalVolume = totalAggressive + totalPassive;
  const aggressiveRatio = totalVolume === 0 ? 0 : totalAggressive / totalVolume;
  const netAggressive = aggressiveBuy - aggressiveSell;

  let signal: AggressivePassiveResult['signal'] = 'balanced';
  if (totalVolume > 0) {
    const aggBuyRatio = aggressiveBuy / totalVolume;
    const aggSellRatio = aggressiveSell / totalVolume;
    const passBuyRatio = passiveBuy / totalVolume;
    const passSellRatio = passiveSell / totalVolume;

    if (aggBuyRatio > 0.35) signal = 'aggressive_buying';
    else if (aggSellRatio > 0.35) signal = 'aggressive_selling';
    else if (passBuyRatio > 0.35) signal = 'passive_accumulation';
    else if (passSellRatio > 0.35) signal = 'passive_distribution';
  }

  return { aggressiveBuy, aggressiveSell, passiveBuy, passiveSell, aggressiveRatio, netAggressive, signal };
}

/**
 * Volume clock speed — trade arrival rate analysis.
 * Compares current volume rate against historical average.
 */
export function volumeClockSpeed(
  trades: Array<{ volume: number; timestamp: number }>,
  params?: { bucketSize?: number; lookback?: number }
): VolumeClockResult {
  const bucketSize = params?.bucketSize ?? 60000; // 1 minute buckets
  const lookback = params?.lookback ?? 20;

  if (trades.length === 0) {
    return { currentRate: 0, averageRate: 0, acceleration: 0, percentile: 0, regime: 'slow', timeToNextBucket: 0 };
  }

  // Group trades into time buckets
  const minTs = trades[0].timestamp;
  const maxTs = trades[trades.length - 1].timestamp;

  const buckets = new Map<number, number>();
  for (const t of trades) {
    const bucket = Math.floor(t.timestamp / bucketSize);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + t.volume);
  }

  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  const rates = sortedKeys.map(k => buckets.get(k)!);

  // Use the last `lookback` buckets for comparison
  const recentRates = rates.slice(-lookback);
  const currentRate = recentRates.length > 0 ? recentRates[recentRates.length - 1] : 0;
  const averageRate = mean(recentRates);

  // Acceleration: compare last bucket to previous
  let acceleration = 0;
  if (recentRates.length >= 2) {
    const prev = recentRates[recentRates.length - 2];
    acceleration = prev === 0 ? 0 : (currentRate - prev) / prev;
  }

  // Percentile rank of current rate
  const sorted = [...recentRates].sort((a, b) => a - b);
  const rank = sorted.filter(r => r <= currentRate).length;
  const percentile = sorted.length === 0 ? 0 : rank / sorted.length;

  // Regime classification
  let regime: VolumeClockResult['regime'] = 'normal';
  if (percentile > 0.75) regime = 'fast';
  else if (percentile < 0.25) regime = 'slow';

  // Time remaining in current bucket
  const currentBucket = Math.floor(maxTs / bucketSize);
  const bucketEnd = (currentBucket + 1) * bucketSize;
  const timeToNextBucket = bucketEnd - maxTs;

  return { currentRate, averageRate, acceleration, percentile, regime, timeToNextBucket };
}

/**
 * Order flow imbalance profile across price levels.
 * Identifies support/resistance based on volume imbalance.
 */
export function orderFlowImbalanceProfile(
  trades: Trade[],
  priceLevels: number
): ImbalanceProfileResult {
  if (trades.length === 0 || priceLevels <= 0) {
    return { profile: [], overallImbalance: 0, strongLevels: [] };
  }

  const prices = trades.map(t => t.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const range = maxPrice - minPrice;

  if (range === 0) {
    // All trades at same price
    let buyVol = 0;
    let sellVol = 0;
    for (const t of trades) {
      if (t.side === 'buy') buyVol += t.volume;
      else sellVol += t.volume;
    }
    const total = buyVol + sellVol;
    const imbalance = total === 0 ? 0 : (buyVol - sellVol) / total;
    return {
      profile: [{ price: minPrice, imbalance, buyVolume: buyVol, sellVolume: sellVol, significantImbalance: Math.abs(imbalance) > 0.3 }],
      overallImbalance: imbalance,
      strongLevels: Math.abs(imbalance) > 0.3
        ? [{ price: minPrice, type: imbalance > 0 ? 'support' as const : 'resistance' as const, strength: Math.abs(imbalance) }]
        : [],
    };
  }

  const step = range / priceLevels;
  const buckets: Array<{ price: number; buyVolume: number; sellVolume: number }> = [];
  for (let i = 0; i < priceLevels; i++) {
    buckets.push({ price: minPrice + step * (i + 0.5), buyVolume: 0, sellVolume: 0 });
  }

  for (const t of trades) {
    const idx = Math.min(Math.floor((t.price - minPrice) / step), priceLevels - 1);
    if (t.side === 'buy') buckets[idx].buyVolume += t.volume;
    else buckets[idx].sellVolume += t.volume;
  }

  let totalBuy = 0;
  let totalSell = 0;
  const profile: ImbalanceLevel[] = [];
  const strongLevels: StrongLevel[] = [];

  for (const b of buckets) {
    totalBuy += b.buyVolume;
    totalSell += b.sellVolume;
    const total = b.buyVolume + b.sellVolume;
    const imbalance = total === 0 ? 0 : (b.buyVolume - b.sellVolume) / total;
    const significantImbalance = Math.abs(imbalance) > 0.3 && total > 0;

    profile.push({
      price: b.price,
      imbalance,
      buyVolume: b.buyVolume,
      sellVolume: b.sellVolume,
      significantImbalance,
    });

    if (significantImbalance) {
      strongLevels.push({
        price: b.price,
        type: imbalance > 0 ? 'support' : 'resistance',
        strength: Math.abs(imbalance),
      });
    }
  }

  const totalVol = totalBuy + totalSell;
  const overallImbalance = totalVol === 0 ? 0 : (totalBuy - totalSell) / totalVol;

  return { profile, overallImbalance, strongLevels };
}

/**
 * Delta profile — volume delta per candle with divergence detection.
 * Divergences signal potential reversals when price and delta disagree.
 */
export function deltaProfile(
  candles: Array<{ open: number; high: number; low: number; close: number; volume: number; buyVolume: number; sellVolume: number }>
): DeltaProfileResult {
  if (candles.length === 0) {
    return { deltas: [], cumulativeDelta: [], divergences: [], exhaustion: [] };
  }

  const deltas: number[] = [];
  const cumulativeDelta: number[] = [];
  let cumDelta = 0;

  for (const c of candles) {
    const delta = c.buyVolume - c.sellVolume;
    deltas.push(delta);
    cumDelta += delta;
    cumulativeDelta.push(cumDelta);
  }

  const divergences: DeltaDivergence[] = [];
  const exhaustion: DeltaExhaustion[] = [];

  // Look for divergences over sliding windows of 3+ candles
  for (let i = 2; i < candles.length; i++) {
    const priceChange = candles[i].close - candles[i - 2].close;
    const deltaChange = cumulativeDelta[i] - cumulativeDelta[i - 2];
    const priceTrend: 'up' | 'down' = priceChange >= 0 ? 'up' : 'down';
    const deltaTrend: 'up' | 'down' = deltaChange >= 0 ? 'up' : 'down';

    // Divergence: price and delta moving in opposite directions
    if (priceTrend === 'up' && deltaTrend === 'down') {
      divergences.push({ index: i, type: 'bearish', priceTrend, deltaTrend });
    } else if (priceTrend === 'down' && deltaTrend === 'up') {
      divergences.push({ index: i, type: 'bullish', priceTrend, deltaTrend });
    }

    // Exhaustion: large delta with small price movement (relative to recent)
    if (i >= 3) {
      const recentVolumes = candles.slice(Math.max(0, i - 5), i).map(c => c.volume);
      const avgVol = mean(recentVolumes);
      const currentVol = candles[i].volume;
      const priceRange = candles[i].high - candles[i].low;
      const prevRange = candles[i - 1].high - candles[i - 1].low;

      // High volume but shrinking range = exhaustion
      if (currentVol > avgVol * 1.5 && prevRange > 0 && priceRange < prevRange * 0.5) {
        if (deltas[i] > 0) {
          exhaustion.push({ index: i, type: 'buying_exhaustion' });
        } else if (deltas[i] < 0) {
          exhaustion.push({ index: i, type: 'selling_exhaustion' });
        }
      }
    }
  }

  return { deltas, cumulativeDelta, divergences, exhaustion };
}

/**
 * Large trade detection — identify block trades and whale activity.
 * Uses z-score, fixed threshold, or percentile methods.
 */
export function largeTradeDetection(
  trades: TimestampedTrade[],
  params?: { threshold?: number; method?: 'fixed' | 'percentile' | 'stddev' }
): LargeTradeResult {
  const method = params?.method ?? 'stddev';
  const threshold = params?.threshold ?? 2.0;

  if (trades.length === 0) {
    return { largeTrades: [], totalLargeVolume: 0, largeTradeRatio: 0, netLargeFlow: 0, whaleActivity: 'quiet' };
  }

  const volumes = trades.map(t => t.volume);
  const avgVol = mean(volumes);
  const stdVol = standardDeviation(volumes);

  let cutoff: number;
  if (method === 'fixed') {
    cutoff = threshold;
  } else if (method === 'percentile') {
    const sorted = [...volumes].sort((a, b) => a - b);
    const pctIdx = Math.min(Math.floor(sorted.length * (threshold / 100)), sorted.length - 1);
    cutoff = sorted[pctIdx];
  } else {
    // stddev method
    cutoff = avgVol + threshold * stdVol;
  }

  const largeTrades: LargeTrade[] = [];
  for (const t of trades) {
    if (t.volume >= cutoff) {
      const zScore = stdVol === 0 ? 0 : (t.volume - avgVol) / stdVol;
      largeTrades.push({
        price: t.price,
        volume: t.volume,
        side: t.side,
        timestamp: t.timestamp,
        zScore,
      });
    }
  }

  const totalLargeVolume = largeTrades.reduce((s, t) => s + t.volume, 0);
  const totalVolume = volumes.reduce((s, v) => s + v, 0);
  const largeTradeRatio = totalVolume === 0 ? 0 : totalLargeVolume / totalVolume;
  const netLargeFlow = largeTrades.reduce((s, t) => s + (t.side === 'buy' ? t.volume : -t.volume), 0);

  let whaleActivity: LargeTradeResult['whaleActivity'] = 'quiet';
  if (largeTrades.length > 0) {
    const buyLarge = largeTrades.filter(t => t.side === 'buy').reduce((s, t) => s + t.volume, 0);
    const sellLarge = largeTrades.filter(t => t.side === 'sell').reduce((s, t) => s + t.volume, 0);
    const total = buyLarge + sellLarge;
    if (total > 0) {
      const ratio = buyLarge / total;
      if (ratio > 0.65) whaleActivity = 'heavy_buying';
      else if (ratio < 0.35) whaleActivity = 'heavy_selling';
      else whaleActivity = 'mixed';
    }
  }

  return { largeTrades, totalLargeVolume, largeTradeRatio, netLargeFlow, whaleActivity };
}

/**
 * Trade intensity map — 2D heatmap of trade activity (price x time).
 * Reveals hotspots of concentrated activity and quiet periods.
 */
export function tradeIntensityMap(
  trades: Array<{ price: number; volume: number; timestamp: number }>,
  params?: { timeResolution?: number; priceResolution?: number }
): TradeIntensityResult {
  const timeResolution = params?.timeResolution ?? 60000; // 1 minute
  const priceResolution = params?.priceResolution ?? 1;

  if (trades.length === 0) {
    return { cells: [], hotspots: [], quietPeriods: [] };
  }

  // Build 2D grid
  const grid = new Map<string, { volume: number; tradeCount: number }>();
  const timeSlots = new Set<number>();

  for (const t of trades) {
    const timeSlot = Math.floor(t.timestamp / timeResolution) * timeResolution;
    const priceLevel = Math.round(t.price / priceResolution) * priceResolution;
    const key = `${timeSlot}:${priceLevel}`;
    timeSlots.add(timeSlot);

    let cell = grid.get(key);
    if (!cell) {
      cell = { volume: 0, tradeCount: 0 };
      grid.set(key, cell);
    }
    cell.volume += t.volume;
    cell.tradeCount += 1;
  }

  // Compute intensity scores
  const allVolumes = [...grid.values()].map(c => c.volume);
  const maxVolume = Math.max(...allVolumes);

  const cells: HeatmapCell[] = [];
  for (const [key, data] of grid) {
    const [ts, pl] = key.split(':').map(Number);
    const intensity = maxVolume === 0 ? 0 : data.volume / maxVolume;
    cells.push({
      timeSlot: ts,
      priceLevel: pl,
      volume: data.volume,
      tradeCount: data.tradeCount,
      intensity,
    });
  }

  // Identify hotspots (top 10% by intensity)
  const sortedByIntensity = [...cells].sort((a, b) => b.intensity - a.intensity);
  const hotspotCutoff = Math.max(1, Math.floor(cells.length * 0.1));
  const hotspots = sortedByIntensity.slice(0, hotspotCutoff).map(c => ({
    timeSlot: c.timeSlot,
    priceLevel: c.priceLevel,
    intensity: c.intensity,
  }));

  // Identify quiet periods (time slots with very low activity)
  const sortedTimeSlots = [...timeSlots].sort((a, b) => a - b);
  const slotVolumes = sortedTimeSlots.map(ts => {
    let vol = 0;
    for (const [key, data] of grid) {
      if (key.startsWith(`${ts}:`)) vol += data.volume;
    }
    return { ts, vol };
  });

  const avgSlotVol = mean(slotVolumes.map(s => s.vol));
  const quietThreshold = avgSlotVol * 0.25;

  const quietPeriods: Array<{ start: number; end: number }> = [];
  let quietStart: number | null = null;

  for (const sv of slotVolumes) {
    if (sv.vol <= quietThreshold) {
      if (quietStart === null) quietStart = sv.ts;
    } else {
      if (quietStart !== null) {
        quietPeriods.push({ start: quietStart, end: sv.ts });
        quietStart = null;
      }
    }
  }
  if (quietStart !== null) {
    const lastTs = sortedTimeSlots[sortedTimeSlots.length - 1];
    quietPeriods.push({ start: quietStart, end: lastTs + timeResolution });
  }

  return { cells, hotspots, quietPeriods };
}
