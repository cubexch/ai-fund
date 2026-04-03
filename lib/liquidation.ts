/**
 * Liquidation modeling and leverage analytics for crypto markets.
 * Pure functions for estimating liquidation levels, cascade risk,
 * margin health, and deleveraging signals.
 */

import { mean, standardDeviation, correlation } from './math.js';

// ── Types ─────────────────────────────────────────────────

export interface LeverageBucket {
  leverage: number;
  weight: number;
}

export interface LiquidationLevel {
  price: number;
  leverage: number;
  side: 'long' | 'short';
  estimatedSize: number;
  distanceFromCurrent: number;
  distancePct: number;
}

export interface HighDensityZone {
  priceFrom: number;
  priceTo: number;
  totalSize: number;
}

export interface LiquidationLevelsResult {
  levels: LiquidationLevel[];
  nearestLong: number;
  nearestShort: number;
  highDensityZones: HighDensityZone[];
}

export interface CascadePath {
  triggerPrice: number;
  totalLiquidated: number;
  priceImpact: number;
  stages: number;
}

export interface CascadeRiskResult {
  cascadeScore: number;
  maxCascadeDepth: number;
  cascadePaths: CascadePath[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface HeatmapBand {
  priceFrom: number;
  priceTo: number;
  longLiquidations: number;
  shortLiquidations: number;
  netExposure: number;
  intensity: number;
}

export interface HeatmapResult {
  bands: HeatmapBand[];
  maxIntensityPrice: number;
  asymmetry: number;
}

export interface OiSnapshot {
  timestamp: number;
  openInterest: number;
  price: number;
  fundingRate: number;
}

export interface OiChange {
  period: string;
  oiChange: number;
  priceChange: number;
  interpretation: string;
}

export interface OpenInterestAnalysisResult {
  trend: 'increasing' | 'decreasing' | 'stable';
  oiPriceCorrelation: number;
  leverageBuildUp: boolean;
  delevaragingSignal: boolean;
  longOpenRatio: number;
  changes: OiChange[];
}

export interface InsuranceFundHealthResult {
  coverageRatio: number;
  daysOfCoverage: number;
  riskLevel: 'healthy' | 'adequate' | 'stressed' | 'critical';
  maxAbsorbable: number;
  depletionRisk: number;
}

export interface MarginCallPosition {
  symbol: string;
  size: number;
  entryPrice: number;
  leverage: number;
  side: 'long' | 'short';
  maintenanceMargin: number;
}

export interface LiquidatedPosition {
  symbol: string;
  liqPrice: number;
  loss: number;
}

export interface ShockResult {
  shock: number;
  liquidated: LiquidatedPosition[];
  survivingMargin: number;
  pnl: number;
}

export interface MarginCallSimulationResult {
  results: ShockResult[];
  worstCase: { shock: number; totalLoss: number };
}

export interface EffectiveLeverageResult {
  grossLeverage: number;
  netLeverage: number;
  longLeverage: number;
  shortLeverage: number;
  marginUsed: number;
  freeMargin: number;
  marginLevel: number;
  distanceToLiquidation: number;
}

export interface FlowLevel {
  price: number;
  size: number;
}

export interface LiquidationFlowResult {
  totalFlow: number;
  flowDirection: 'buy' | 'sell';
  cascadeMultiplier: number;
  estimatedSlippage: number;
  affectedLevels: FlowLevel[];
}

export interface DeleveragingComponents {
  oiContraction: number;
  volumeSpike: number;
  priceVelocity: number;
  fundingReset: number;
}

export interface DeleveragingIndexResult {
  index: number;
  components: DeleveragingComponents;
  signal: 'active_deleveraging' | 'building_leverage' | 'neutral';
  severity: number;
}

export interface SafeMaxLeverageResult {
  maxLeverage: number;
  expectedMaxDrawdown: number;
  probabilityOfRuin: number;
  recommendedLeverage: number;
  reasoning: string;
}

// ── Default leverage distribution ─────────────────────────

const DEFAULT_LEVERAGE_DISTRIBUTION: LeverageBucket[] = [
  { leverage: 2, weight: 0.15 },
  { leverage: 3, weight: 0.15 },
  { leverage: 5, weight: 0.20 },
  { leverage: 10, weight: 0.20 },
  { leverage: 20, weight: 0.15 },
  { leverage: 50, weight: 0.10 },
  { leverage: 100, weight: 0.05 },
];

// ── Functions ─────────────────────────────────────────────

/**
 * Estimate liquidation price clusters based on current price,
 * open interest, and leverage distribution.
 */
export function estimateLiquidationLevels(params: {
  price: number;
  openInterest: number;
  leverageDistribution?: LeverageBucket[];
  maintenanceMargin?: number;
}): LiquidationLevelsResult {
  const { price, openInterest, maintenanceMargin = 0.005 } = params;
  const dist = params.leverageDistribution ?? DEFAULT_LEVERAGE_DISTRIBUTION;

  const levels: LiquidationLevel[] = [];

  for (const bucket of dist) {
    const sizeForBucket = openInterest * bucket.weight;
    // Liquidation distance = 1 / leverage - maintenanceMargin
    const liqDistance = 1 / bucket.leverage - maintenanceMargin;
    if (liqDistance <= 0) continue;

    // Long liquidation: price drops by liqDistance
    const longLiqPrice = price * (1 - liqDistance);
    if (longLiqPrice > 0) {
      levels.push({
        price: longLiqPrice,
        leverage: bucket.leverage,
        side: 'long',
        estimatedSize: sizeForBucket / 2,
        distanceFromCurrent: price - longLiqPrice,
        distancePct: liqDistance,
      });
    }

    // Short liquidation: price rises by liqDistance
    const shortLiqPrice = price * (1 + liqDistance);
    levels.push({
      price: shortLiqPrice,
      leverage: bucket.leverage,
      side: 'short',
      estimatedSize: sizeForBucket / 2,
      distanceFromCurrent: shortLiqPrice - price,
      distancePct: liqDistance,
    });
  }

  // Sort by distance from current price
  levels.sort((a, b) => a.distanceFromCurrent - b.distanceFromCurrent);

  const longLevels = levels.filter(l => l.side === 'long');
  const shortLevels = levels.filter(l => l.side === 'short');
  const nearestLong = longLevels.length > 0
    ? longLevels.reduce((best, l) => l.distanceFromCurrent < best.distanceFromCurrent ? l : best).price
    : 0;
  const nearestShort = shortLevels.length > 0
    ? shortLevels.reduce((best, l) => l.distanceFromCurrent < best.distanceFromCurrent ? l : best).price
    : 0;

  // Identify high density zones by clustering nearby levels
  const highDensityZones = findHighDensityZones(levels, price);

  return { levels, nearestLong, nearestShort, highDensityZones };
}

function findHighDensityZones(levels: LiquidationLevel[], currentPrice: number): HighDensityZone[] {
  if (levels.length === 0) return [];

  const bandWidth = currentPrice * 0.02; // 2% bands
  const sorted = [...levels].sort((a, b) => a.price - b.price);
  const zones: HighDensityZone[] = [];

  let zoneStart = sorted[0].price;
  let zoneEnd = zoneStart + bandWidth;
  let totalSize = 0;

  for (const level of sorted) {
    if (level.price <= zoneEnd) {
      totalSize += level.estimatedSize;
    } else {
      if (totalSize > 0) {
        zones.push({ priceFrom: zoneStart, priceTo: zoneEnd, totalSize });
      }
      zoneStart = level.price;
      zoneEnd = zoneStart + bandWidth;
      totalSize = level.estimatedSize;
    }
  }
  if (totalSize > 0) {
    zones.push({ priceFrom: zoneStart, priceTo: zoneEnd, totalSize });
  }

  // Return top zones by size
  zones.sort((a, b) => b.totalSize - a.totalSize);
  return zones.slice(0, 5);
}

/**
 * Model cascading liquidation risk: when one liquidation triggers
 * price movement that causes further liquidations.
 */
export function cascadeRisk(params: {
  price: number;
  levels: Array<{ price: number; size: number; side: 'long' | 'short' }>;
  dailyVolume: number;
  orderBookDepth?: number;
}): CascadeRiskResult {
  const { price, levels, dailyVolume, orderBookDepth = dailyVolume * 0.01 } = params;

  const cascadePaths: CascadePath[] = [];

  // Simulate downward cascade (liquidating longs)
  const longLevels = levels
    .filter(l => l.side === 'long' && l.price < price)
    .sort((a, b) => b.price - a.price); // nearest first

  const downPath = simulateCascade(price, longLevels, orderBookDepth, 'down');
  if (downPath.stages > 0) cascadePaths.push(downPath);

  // Simulate upward cascade (liquidating shorts)
  const shortLevels = levels
    .filter(l => l.side === 'short' && l.price > price)
    .sort((a, b) => a.price - b.price); // nearest first

  const upPath = simulateCascade(price, shortLevels, orderBookDepth, 'up');
  if (upPath.stages > 0) cascadePaths.push(upPath);

  const maxCascadeDepth = cascadePaths.reduce((max, p) => Math.max(max, p.stages), 0);
  const maxImpact = cascadePaths.reduce((max, p) => Math.max(max, p.priceImpact), 0);
  const totalLiquidatable = levels.reduce((s, l) => s + l.size, 0);

  // Cascade score: 0-100 based on cascade depth, volume ratio, and impact
  const volumeRatio = totalLiquidatable / (dailyVolume || 1);
  const cascadeScore = Math.min(100, (maxCascadeDepth * 15 + volumeRatio * 30 + maxImpact * 200));

  const riskLevel: CascadeRiskResult['riskLevel'] =
    cascadeScore >= 75 ? 'critical' :
    cascadeScore >= 50 ? 'high' :
    cascadeScore >= 25 ? 'medium' : 'low';

  return { cascadeScore, maxCascadeDepth, cascadePaths, riskLevel };
}

function simulateCascade(
  startPrice: number,
  sortedLevels: Array<{ price: number; size: number; side: 'long' | 'short' }>,
  orderBookDepth: number,
  direction: 'up' | 'down'
): CascadePath {
  if (sortedLevels.length === 0) {
    return { triggerPrice: startPrice, totalLiquidated: 0, priceImpact: 0, stages: 0 };
  }

  let currentPrice = startPrice;
  let totalLiquidated = 0;
  let stages = 0;
  const triggerPrice = sortedLevels[0].price;

  for (const level of sortedLevels) {
    // Check if price movement from accumulated liquidations reaches this level
    const impact = totalLiquidated / (orderBookDepth || 1);
    const projectedPrice = direction === 'down'
      ? startPrice * (1 - impact * 0.5)
      : startPrice * (1 + impact * 0.5);

    const reached = direction === 'down'
      ? projectedPrice <= level.price
      : projectedPrice >= level.price;

    // First level is always the trigger; subsequent levels need cascade to reach
    if (stages === 0 || reached) {
      totalLiquidated += level.size;
      stages++;
      currentPrice = level.price;
    } else {
      break;
    }
  }

  const priceImpact = Math.abs(currentPrice - startPrice) / startPrice;

  return { triggerPrice, totalLiquidated, priceImpact, stages };
}

/**
 * Generate a heatmap of liquidation density across price bands.
 */
export function leverageHeatmap(
  positions: Array<{ price: number; size: number; leverage: number; side: 'long' | 'short' }>,
  currentPrice: number,
  params?: { priceBands?: number; bandWidth?: number }
): HeatmapResult {
  const priceBands = params?.priceBands ?? 20;
  const bandWidth = params?.bandWidth ?? (currentPrice * 0.01); // 1% default
  const halfRange = (priceBands / 2) * bandWidth;
  const rangeStart = currentPrice - halfRange;

  const bands: HeatmapBand[] = [];

  for (let i = 0; i < priceBands; i++) {
    const priceFrom = rangeStart + i * bandWidth;
    const priceTo = priceFrom + bandWidth;
    let longLiqs = 0;
    let shortLiqs = 0;

    for (const pos of positions) {
      const liqPrice = computeLiquidationPrice(pos.price, pos.leverage, pos.side);
      if (liqPrice >= priceFrom && liqPrice < priceTo) {
        if (pos.side === 'long') {
          longLiqs += pos.size;
        } else {
          shortLiqs += pos.size;
        }
      }
    }

    bands.push({
      priceFrom,
      priceTo,
      longLiquidations: longLiqs,
      shortLiquidations: shortLiqs,
      netExposure: shortLiqs - longLiqs,
      intensity: longLiqs + shortLiqs,
    });
  }

  // Normalize intensity to 0-1
  const maxRawIntensity = Math.max(...bands.map(b => b.intensity), 1);
  for (const band of bands) {
    band.intensity = band.intensity / maxRawIntensity;
  }

  const maxBand = bands.reduce((best, b) => b.intensity > best.intensity ? b : best, bands[0]);
  const maxIntensityPrice = maxBand ? (maxBand.priceFrom + maxBand.priceTo) / 2 : currentPrice;

  const totalLong = bands.reduce((s, b) => s + b.longLiquidations, 0);
  const totalShort = bands.reduce((s, b) => s + b.shortLiquidations, 0);
  const total = totalLong + totalShort;
  const asymmetry = total === 0 ? 0 : (totalLong - totalShort) / total;

  return { bands, maxIntensityPrice, asymmetry };
}

function computeLiquidationPrice(entryPrice: number, leverage: number, side: 'long' | 'short'): number {
  const liqDistance = 1 / leverage;
  return side === 'long'
    ? entryPrice * (1 - liqDistance)
    : entryPrice * (1 + liqDistance);
}

/**
 * Analyze open interest changes relative to price and funding rate.
 */
export function openInterestAnalysis(
  snapshots: OiSnapshot[]
): OpenInterestAnalysisResult {
  if (snapshots.length < 2) {
    return {
      trend: 'stable',
      oiPriceCorrelation: 0,
      leverageBuildUp: false,
      delevaragingSignal: false,
      longOpenRatio: 0.5,
      changes: [],
    };
  }

  const sorted = [...snapshots].sort((a, b) => a.timestamp - b.timestamp);
  const oiValues = sorted.map(s => s.openInterest);
  const priceValues = sorted.map(s => s.price);
  const fundingRates = sorted.map(s => s.fundingRate);

  // OI trend
  const firstHalf = mean(oiValues.slice(0, Math.floor(oiValues.length / 2)));
  const secondHalf = mean(oiValues.slice(Math.floor(oiValues.length / 2)));
  const oiChangePct = firstHalf === 0 ? 0 : (secondHalf - firstHalf) / firstHalf;

  const trend: OpenInterestAnalysisResult['trend'] =
    oiChangePct > 0.05 ? 'increasing' :
    oiChangePct < -0.05 ? 'decreasing' : 'stable';

  // OI-price correlation
  const oiPriceCorrelation = correlation(oiValues, priceValues);

  // Leverage build-up: OI increasing while price is relatively stable
  const priceVol = standardDeviation(priceValues) / (mean(priceValues) || 1);
  const leverageBuildUp = oiChangePct > 0.1 && priceVol < 0.05;

  // Deleveraging: OI decreasing rapidly with high funding rate reversion
  const avgFunding = mean(fundingRates);
  const recentFunding = mean(fundingRates.slice(-Math.min(3, fundingRates.length)));
  const fundingReversal = Math.abs(avgFunding) > 0 && Math.sign(recentFunding) !== Math.sign(avgFunding);
  const delevaragingSignal = oiChangePct < -0.1 || (oiChangePct < -0.05 && fundingReversal);

  // Estimate long open ratio from funding rate (positive funding => more longs)
  const longOpenRatio = 0.5 + Math.min(0.4, Math.max(-0.4, avgFunding * 100));

  // Period-over-period changes
  const changes: OiChange[] = [];
  const periods = [
    { label: '1-period', lookback: 1 },
    { label: '3-period', lookback: 3 },
    { label: '5-period', lookback: 5 },
  ];

  for (const { label, lookback } of periods) {
    if (sorted.length <= lookback) continue;
    const endIdx = sorted.length - 1;
    const startIdx = endIdx - lookback;
    const oiChange = sorted[startIdx].openInterest === 0 ? 0
      : (sorted[endIdx].openInterest - sorted[startIdx].openInterest) / sorted[startIdx].openInterest;
    const priceChange = sorted[startIdx].price === 0 ? 0
      : (sorted[endIdx].price - sorted[startIdx].price) / sorted[startIdx].price;

    let interpretation: string;
    if (oiChange > 0 && priceChange > 0) interpretation = 'new longs opening (bullish)';
    else if (oiChange > 0 && priceChange < 0) interpretation = 'new shorts opening (bearish)';
    else if (oiChange < 0 && priceChange < 0) interpretation = 'long liquidations (bearish)';
    else if (oiChange < 0 && priceChange > 0) interpretation = 'short liquidations (bullish)';
    else interpretation = 'neutral';

    changes.push({ period: label, oiChange, priceChange, interpretation });
  }

  return {
    trend,
    oiPriceCorrelation,
    leverageBuildUp,
    delevaragingSignal,
    longOpenRatio,
    changes,
  };
}

/**
 * Assess the health of an exchange's insurance fund relative to
 * open interest and recent liquidation activity.
 */
export function insuranceFundHealth(params: {
  fundBalance: number;
  totalOpenInterest: number;
  recentLiquidations: number[];
  averageDailyVolume: number;
}): InsuranceFundHealthResult {
  const { fundBalance, totalOpenInterest, recentLiquidations, averageDailyVolume } = params;

  const coverageRatio = totalOpenInterest === 0 ? Infinity : fundBalance / totalOpenInterest;

  const avgDailyLiq = recentLiquidations.length === 0 ? 0 : mean(recentLiquidations);
  const daysOfCoverage = avgDailyLiq === 0 ? Infinity : fundBalance / avgDailyLiq;

  // Max single event the fund can absorb (conservative: 80% of balance)
  const maxAbsorbable = fundBalance * 0.8;

  // Depletion risk: how likely the fund is to run out based on recent liquidation trends
  const liqVolatility = recentLiquidations.length >= 2
    ? standardDeviation(recentLiquidations)
    : 0;
  const worstCaseDaily = avgDailyLiq + 2 * liqVolatility; // 2-sigma event
  const depletionRisk = worstCaseDaily === 0 ? 0
    : Math.min(1, worstCaseDaily / (fundBalance || 1));

  // Volume-adjusted coverage
  const volumeAdjustedCoverage = averageDailyVolume === 0 ? Infinity
    : fundBalance / averageDailyVolume;

  const riskLevel: InsuranceFundHealthResult['riskLevel'] =
    (coverageRatio > 0.02 && daysOfCoverage > 30 && volumeAdjustedCoverage > 0.1) ? 'healthy' :
    (coverageRatio > 0.01 && daysOfCoverage > 14) ? 'adequate' :
    (coverageRatio > 0.005 && daysOfCoverage > 7) ? 'stressed' : 'critical';

  return { coverageRatio, daysOfCoverage, riskLevel, maxAbsorbable, depletionRisk };
}

/**
 * Simulate which positions get liquidated under various price shocks.
 */
export function marginCallSimulation(params: {
  positions: MarginCallPosition[];
  priceShocks: number[];
}): MarginCallSimulationResult {
  const { positions, priceShocks } = params;

  const results: ShockResult[] = [];
  let worstCase = { shock: 0, totalLoss: 0 };

  for (const shock of priceShocks) {
    const liquidated: LiquidatedPosition[] = [];
    let totalPnl = 0;
    let totalSurvivingMargin = 0;

    for (const pos of positions) {
      const notional = pos.size * pos.entryPrice;
      const margin = notional / pos.leverage;
      const maintenanceReq = notional * pos.maintenanceMargin;

      // PnL under shock
      const shockedPrice = pos.entryPrice * (1 + shock);
      const pnl = pos.side === 'long'
        ? pos.size * (shockedPrice - pos.entryPrice)
        : pos.size * (pos.entryPrice - shockedPrice);

      const remainingMargin = margin + pnl;

      if (remainingMargin < maintenanceReq) {
        // Liquidated
        const liqPrice = computeLiquidationPriceFromMargin(pos);
        const loss = Math.max(0, margin - Math.max(0, remainingMargin));
        liquidated.push({ symbol: pos.symbol, liqPrice, loss });
        totalPnl += -margin; // Worst case: lose entire margin
      } else {
        totalPnl += pnl;
        totalSurvivingMargin += remainingMargin;
      }
    }

    const result: ShockResult = {
      shock,
      liquidated,
      survivingMargin: totalSurvivingMargin,
      pnl: totalPnl,
    };
    results.push(result);

    const totalLoss = liquidated.reduce((s, l) => s + l.loss, 0);
    if (totalLoss > worstCase.totalLoss) {
      worstCase = { shock, totalLoss };
    }
  }

  return { results, worstCase };
}

function computeLiquidationPriceFromMargin(pos: MarginCallPosition): number {
  const notional = pos.size * pos.entryPrice;
  const margin = notional / pos.leverage;
  const maintenanceReq = notional * pos.maintenanceMargin;

  // margin + pnl = maintenanceReq => pnl = maintenanceReq - margin
  const pnlAtLiq = maintenanceReq - margin;
  // For long: pnl = size * (liqPrice - entry) => liqPrice = entry + pnl/size
  // For short: pnl = size * (entry - liqPrice) => liqPrice = entry - pnl/size
  if (pos.size === 0) return pos.entryPrice;

  return pos.side === 'long'
    ? pos.entryPrice + pnlAtLiq / pos.size
    : pos.entryPrice - pnlAtLiq / pos.size;
}

/**
 * Calculate effective leverage across a portfolio of positions.
 */
export function effectiveLeverage(params: {
  positions: Array<{ notionalValue: number; margin: number; unrealizedPnl: number }>;
  accountEquity: number;
}): EffectiveLeverageResult {
  const { positions, accountEquity } = params;

  let totalNotional = 0;
  let totalMargin = 0;
  let totalLongNotional = 0;
  let totalShortNotional = 0;

  for (const pos of positions) {
    const absNotional = Math.abs(pos.notionalValue);
    totalNotional += absNotional;
    totalMargin += pos.margin;

    if (pos.notionalValue >= 0) {
      totalLongNotional += pos.notionalValue;
    } else {
      totalShortNotional += Math.abs(pos.notionalValue);
    }
  }

  const equity = accountEquity || 1;
  const grossLeverage = totalNotional / equity;
  const netLeverage = Math.abs(totalLongNotional - totalShortNotional) / equity;
  const longLeverage = totalLongNotional / equity;
  const shortLeverage = totalShortNotional / equity;
  const marginUsed = totalMargin;
  const freeMargin = Math.max(0, accountEquity - totalMargin);
  const marginLevel = totalMargin === 0 ? Infinity : accountEquity / totalMargin;

  // Distance to liquidation: approximate as free margin / total notional
  const distanceToLiquidation = totalNotional === 0 ? Infinity : freeMargin / totalNotional;

  return {
    grossLeverage,
    netLeverage,
    longLeverage,
    shortLeverage,
    marginUsed,
    freeMargin,
    marginLevel,
    distanceToLiquidation,
  };
}

/**
 * Predict liquidation-driven order flow given a price move.
 */
export function liquidationFlowPrediction(params: {
  currentPrice: number;
  direction: 'up' | 'down';
  magnitude: number;
  liquidationLevels: Array<{ price: number; size: number; side: 'long' | 'short' }>;
}): LiquidationFlowResult {
  const { currentPrice, direction, magnitude, liquidationLevels } = params;

  const targetPrice = direction === 'up'
    ? currentPrice * (1 + magnitude)
    : currentPrice * (1 - magnitude);

  const affectedLevels: FlowLevel[] = [];

  for (const level of liquidationLevels) {
    const triggered = direction === 'down'
      ? (level.side === 'long' && level.price >= targetPrice && level.price <= currentPrice)
      : (level.side === 'short' && level.price <= targetPrice && level.price >= currentPrice);

    if (triggered) {
      affectedLevels.push({ price: level.price, size: level.size });
    }
  }

  // Sort by price (nearest first)
  affectedLevels.sort((a, b) =>
    direction === 'down' ? b.price - a.price : a.price - b.price
  );

  const totalFlow = affectedLevels.reduce((s, l) => s + l.size, 0);

  // Liquidations create flow in the opposite direction of the position:
  // Long liquidations => sell orders, Short liquidations => buy orders
  const flowDirection: LiquidationFlowResult['flowDirection'] =
    direction === 'down' ? 'sell' : 'buy';

  // Cascade multiplier: more levels = more cascading potential
  const cascadeMultiplier = affectedLevels.length <= 1 ? 1
    : 1 + Math.log2(affectedLevels.length) * 0.3;

  // Estimated slippage as a fraction of price
  const estimatedSlippage = totalFlow === 0 ? 0
    : Math.min(0.1, (totalFlow / (currentPrice * 1000)) * 0.01);

  return { totalFlow, flowDirection, cascadeMultiplier, estimatedSlippage, affectedLevels };
}

/**
 * Composite deleveraging index combining OI contraction, volume spikes,
 * price velocity, and funding rate resets.
 */
export function deleveragingIndex(params: {
  openInterest: number;
  volume: number;
  priceChange: number;
  fundingRate: number;
}): DeleveragingIndexResult {
  const { openInterest, volume, priceChange, fundingRate } = params;

  // OI contraction: negative values indicate deleveraging
  // Normalized: OI / volume ratio (lower = more deleveraging relative to activity)
  const oiVolumeRatio = volume === 0 ? 1 : openInterest / volume;
  const oiContraction = Math.max(0, Math.min(1, 1 - oiVolumeRatio));

  // Volume spike: high volume relative to OI suggests forced liquidations
  const volumeSpike = openInterest === 0 ? 0
    : Math.min(1, (volume / openInterest) * 2);

  // Price velocity: large absolute price change
  const priceVelocity = Math.min(1, Math.abs(priceChange) * 10);

  // Funding rate reset: funding moving toward zero from extreme
  const fundingReset = Math.min(1, Math.abs(fundingRate) * 100);

  // Composite index (0-1)
  const index = (
    oiContraction * 0.30 +
    volumeSpike * 0.30 +
    priceVelocity * 0.25 +
    fundingReset * 0.15
  );

  const signal: DeleveragingIndexResult['signal'] =
    index > 0.6 ? 'active_deleveraging' :
    index < 0.3 ? 'building_leverage' : 'neutral';

  // Severity: 0-10 scale
  const severity = Math.min(10, index * 10);

  return {
    index,
    components: { oiContraction, volumeSpike, priceVelocity, fundingReset },
    signal,
    severity,
  };
}

/**
 * Calculate the safe maximum leverage given market volatility,
 * time horizon, and risk tolerance.
 */
export function safeMaxLeverage(params: {
  volatility: number;
  timeHorizon: number;
  maxLossThreshold: number;
  confidence?: number;
}): SafeMaxLeverageResult {
  const { volatility, timeHorizon, maxLossThreshold, confidence = 0.95 } = params;

  // Z-score for confidence level
  const z = confidence >= 0.99 ? 2.326
    : confidence >= 0.975 ? 1.96
    : confidence >= 0.95 ? 1.645
    : confidence >= 0.90 ? 1.282
    : 1.0;

  // Expected max drawdown at given confidence = z * vol * sqrt(timeHorizon)
  // For max leverage: leverage * z * vol * sqrt(T) <= maxLossThreshold
  const volOverHorizon = volatility * Math.sqrt(timeHorizon);
  const riskPerUnit = z * volOverHorizon;

  const maxLeverage = riskPerUnit === 0 ? 100 : maxLossThreshold / riskPerUnit;
  const clampedMax = Math.min(100, Math.max(1, maxLeverage));

  // Recommended: use 60% of max for safety buffer
  const recommendedLeverage = Math.max(1, clampedMax * 0.6);

  const expectedMaxDrawdown = recommendedLeverage * riskPerUnit;

  // Probability of ruin: approximate using normal distribution
  // P(loss > maxLossThreshold) at recommended leverage
  const ruinZScore = maxLossThreshold / (recommendedLeverage * volOverHorizon || 1);
  // Approximate normal CDF complement
  const probabilityOfRuin = Math.max(0, Math.min(1, approxNormalCdfComplement(ruinZScore)));

  const reasoning = `With ${(volatility * 100).toFixed(1)}% daily volatility over ${timeHorizon} day(s), `
    + `max safe leverage is ${clampedMax.toFixed(1)}x at ${(confidence * 100).toFixed(0)}% confidence. `
    + `Recommended ${recommendedLeverage.toFixed(1)}x includes a 40% safety buffer. `
    + `Expected max drawdown at recommended leverage: ${(expectedMaxDrawdown * 100).toFixed(1)}%.`;

  return {
    maxLeverage: clampedMax,
    expectedMaxDrawdown,
    probabilityOfRuin,
    recommendedLeverage,
    reasoning,
  };
}

/**
 * Approximate the complement of the standard normal CDF: P(Z > z).
 * Uses the Abramowitz and Stegun approximation.
 */
function approxNormalCdfComplement(z: number): number {
  if (z < 0) return 1 - approxNormalCdfComplement(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327; // 1/sqrt(2*pi)
  const p = d * Math.exp(-z * z / 2) * (
    0.319381530 * t
    - 0.356563782 * t * t
    + 1.781477937 * t * t * t
    - 1.821255978 * t * t * t * t
    + 1.330274429 * t * t * t * t * t
  );
  return Math.max(0, Math.min(1, p));
}
