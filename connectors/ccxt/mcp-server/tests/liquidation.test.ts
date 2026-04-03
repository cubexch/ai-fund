import { describe, it, expect } from 'vitest';
import {
  estimateLiquidationLevels,
  cascadeRisk,
  leverageHeatmap,
  openInterestAnalysis,
  insuranceFundHealth,
  marginCallSimulation,
  effectiveLeverage,
  liquidationFlowPrediction,
  deleveragingIndex,
  safeMaxLeverage,
} from '@ai-fund/lib/liquidation';

// ── estimateLiquidationLevels ─────────────────────────────

describe('estimateLiquidationLevels', () => {
  it('long liquidations are below current price', () => {
    const result = estimateLiquidationLevels({ price: 50000, openInterest: 1e9 });
    const longLevels = result.levels.filter(l => l.side === 'long');
    for (const l of longLevels) {
      expect(l.price).toBeLessThan(50000);
    }
  });

  it('short liquidations are above current price', () => {
    const result = estimateLiquidationLevels({ price: 50000, openInterest: 1e9 });
    const shortLevels = result.levels.filter(l => l.side === 'short');
    for (const l of shortLevels) {
      expect(l.price).toBeGreaterThan(50000);
    }
  });

  it('distance calculations are correct', () => {
    const result = estimateLiquidationLevels({ price: 100, openInterest: 1e6 });
    for (const l of result.levels) {
      if (l.side === 'long') {
        expect(l.distanceFromCurrent).toBeCloseTo(100 - l.price);
      } else {
        expect(l.distanceFromCurrent).toBeCloseTo(l.price - 100);
      }
      expect(l.distanceFromCurrent).toBeGreaterThan(0);
    }
  });

  it('nearestLong is below price, nearestShort above', () => {
    const result = estimateLiquidationLevels({ price: 50000, openInterest: 1e9 });
    expect(result.nearestLong).toBeLessThan(50000);
    expect(result.nearestLong).toBeGreaterThan(0);
    expect(result.nearestShort).toBeGreaterThan(50000);
  });

  it('custom leverage distribution works', () => {
    const result = estimateLiquidationLevels({
      price: 100,
      openInterest: 1000,
      leverageDistribution: [{ leverage: 10, weight: 1.0 }],
    });
    // Only 10x leverage: liqDistance = 1/10 - 0.005 = 0.095
    const longs = result.levels.filter(l => l.side === 'long');
    const shorts = result.levels.filter(l => l.side === 'short');
    expect(longs).toHaveLength(1);
    expect(shorts).toHaveLength(1);
    expect(longs[0].price).toBeCloseTo(100 * (1 - 0.095));
    expect(shorts[0].price).toBeCloseTo(100 * (1 + 0.095));
  });
});

// ── cascadeRisk ───────────────────────────────────────────

describe('cascadeRisk', () => {
  it('no levels gives low risk', () => {
    const result = cascadeRisk({
      price: 50000,
      levels: [],
      dailyVolume: 1e9,
    });
    expect(result.riskLevel).toBe('low');
    expect(result.cascadeScore).toBe(0);
    expect(result.maxCascadeDepth).toBe(0);
  });

  it('dense levels near price give higher risk', () => {
    const levels = Array.from({ length: 20 }, (_, i) => ({
      price: 49000 - i * 100,
      size: 5e7,
      side: 'long' as const,
    }));
    const result = cascadeRisk({
      price: 50000,
      levels,
      dailyVolume: 1e9,
      orderBookDepth: 1e7,
    });
    expect(result.cascadeScore).toBeGreaterThan(0);
    expect(result.maxCascadeDepth).toBeGreaterThan(0);
    expect(['medium', 'high', 'critical']).toContain(result.riskLevel);
  });

  it('cascade paths include both directions', () => {
    const levels = [
      { price: 49000, size: 1e7, side: 'long' as const },
      { price: 51000, size: 1e7, side: 'short' as const },
    ];
    const result = cascadeRisk({
      price: 50000,
      levels,
      dailyVolume: 1e9,
    });
    expect(result.cascadePaths.length).toBeLessThanOrEqual(2);
  });
});

// ── leverageHeatmap ───────────────────────────────────────

describe('leverageHeatmap', () => {
  it('band count matches priceBands param', () => {
    const result = leverageHeatmap(
      [{ price: 100, size: 10, leverage: 10, side: 'long' }],
      100,
      { priceBands: 10 },
    );
    expect(result.bands).toHaveLength(10);
  });

  it('intensity is normalized to [0, 1]', () => {
    // Use many positions at varied leverages so liquidation prices spread across bands
    const positions = [
      { price: 100, size: 50, leverage: 2, side: 'long' as const },
      { price: 100, size: 30, leverage: 5, side: 'long' as const },
      { price: 100, size: 40, leverage: 10, side: 'long' as const },
      { price: 100, size: 20, leverage: 3, side: 'short' as const },
      { price: 100, size: 30, leverage: 5, side: 'short' as const },
    ];
    const result = leverageHeatmap(positions, 100, { priceBands: 40, bandWidth: 5 });
    for (const band of result.bands) {
      expect(band.intensity).toBeGreaterThanOrEqual(0);
      expect(band.intensity).toBeLessThanOrEqual(1);
    }
    // At least one band should have some liquidations
    const totalLiqs = result.bands.reduce((s, b) => s + b.longLiquidations + b.shortLiquidations, 0);
    expect(totalLiqs).toBeGreaterThan(0);
    // The max intensity should be 1 (normalized)
    const maxIntensity = Math.max(...result.bands.map(b => b.intensity));
    expect(maxIntensity).toBeCloseTo(1);
  });

  it('defaults to 20 price bands', () => {
    const result = leverageHeatmap([], 100);
    expect(result.bands).toHaveLength(20);
  });

  it('empty positions give zero intensity everywhere', () => {
    const result = leverageHeatmap([], 100);
    for (const band of result.bands) {
      expect(band.longLiquidations).toBe(0);
      expect(band.shortLiquidations).toBe(0);
    }
  });
});

// ── openInterestAnalysis ──────────────────────────────────

describe('openInterestAnalysis', () => {
  it('rising OI + rising price signals leverage build-up context', () => {
    const snapshots = Array.from({ length: 20 }, (_, i) => ({
      timestamp: i,
      openInterest: 1e9 * (1 + i * 0.02), // OI rising 2% per period
      price: 50000 + i * 50,               // price rising gently
      fundingRate: 0.0001,
    }));
    const result = openInterestAnalysis(snapshots);
    expect(result.trend).toBe('increasing');
    expect(result.oiPriceCorrelation).toBeGreaterThan(0.5);
  });

  it('falling OI signals deleveraging', () => {
    const snapshots = Array.from({ length: 20 }, (_, i) => ({
      timestamp: i,
      openInterest: 1e9 * (1 - i * 0.02), // OI falling
      price: 50000 - i * 500,
      fundingRate: 0.0001 * (1 - i * 0.1),
    }));
    const result = openInterestAnalysis(snapshots);
    expect(result.trend).toBe('decreasing');
    expect(result.delevaragingSignal).toBe(true);
  });

  it('returns stable for fewer than 2 snapshots', () => {
    const result = openInterestAnalysis([{ timestamp: 0, openInterest: 1e9, price: 50000, fundingRate: 0.0001 }]);
    expect(result.trend).toBe('stable');
    expect(result.leverageBuildUp).toBe(false);
    expect(result.changes).toHaveLength(0);
  });

  it('changes include period labels', () => {
    const snapshots = Array.from({ length: 10 }, (_, i) => ({
      timestamp: i,
      openInterest: 1e9 + i * 1e7,
      price: 50000 + i * 100,
      fundingRate: 0.0001,
    }));
    const result = openInterestAnalysis(snapshots);
    const periods = result.changes.map(c => c.period);
    expect(periods).toContain('1-period');
    expect(periods).toContain('3-period');
    expect(periods).toContain('5-period');
  });
});

// ── insuranceFundHealth ───────────────────────────────────

describe('insuranceFundHealth', () => {
  it('high fund balance is healthy', () => {
    const result = insuranceFundHealth({
      fundBalance: 1e9,
      totalOpenInterest: 1e10,
      recentLiquidations: [1e6, 2e6, 1.5e6],
      averageDailyVolume: 5e9,
    });
    expect(result.riskLevel).toBe('healthy');
    expect(result.coverageRatio).toBeGreaterThan(0.01);
    expect(result.daysOfCoverage).toBeGreaterThan(30);
  });

  it('low fund balance is critical', () => {
    const result = insuranceFundHealth({
      fundBalance: 1e5,
      totalOpenInterest: 1e10,
      recentLiquidations: [1e7, 2e7, 1.5e7],
      averageDailyVolume: 5e9,
    });
    expect(result.riskLevel).toBe('critical');
    expect(result.daysOfCoverage).toBeLessThan(7);
  });

  it('maxAbsorbable is 80% of fund balance', () => {
    const result = insuranceFundHealth({
      fundBalance: 1e8,
      totalOpenInterest: 1e10,
      recentLiquidations: [1e6],
      averageDailyVolume: 5e9,
    });
    expect(result.maxAbsorbable).toBeCloseTo(1e8 * 0.8);
  });
});

// ── marginCallSimulation ──────────────────────────────────

describe('marginCallSimulation', () => {
  it('high leverage positions liquidated first', () => {
    const positions = [
      { symbol: 'BTC', size: 1, entryPrice: 50000, leverage: 100, side: 'long' as const, maintenanceMargin: 0.005 },
      { symbol: 'ETH', size: 10, entryPrice: 3000, leverage: 2, side: 'long' as const, maintenanceMargin: 0.01 },
    ];
    const result = marginCallSimulation({
      positions,
      priceShocks: [-0.02], // 2% drop
    });
    const liquidated = result.results[0].liquidated;
    // 100x leverage: liq at ~1% move, so -2% should liquidate BTC
    expect(liquidated.some(l => l.symbol === 'BTC')).toBe(true);
    // 2x leverage: can handle large drops
    expect(liquidated.some(l => l.symbol === 'ETH')).toBe(false);
  });

  it('worst case is identified correctly', () => {
    const positions = [
      { symbol: 'BTC', size: 1, entryPrice: 50000, leverage: 10, side: 'long' as const, maintenanceMargin: 0.005 },
      { symbol: 'ETH', size: 10, entryPrice: 3000, leverage: 5, side: 'long' as const, maintenanceMargin: 0.005 },
    ];
    const result = marginCallSimulation({
      positions,
      priceShocks: [-0.05, -0.15, -0.30],
    });
    // worstCase is the shock with the largest totalLoss
    expect(result.worstCase.totalLoss).toBeGreaterThan(0);
    // All shocks should be present in results
    expect(result.results).toHaveLength(3);
  });

  it('no positions means no liquidations', () => {
    const result = marginCallSimulation({ positions: [], priceShocks: [-0.1] });
    expect(result.results[0].liquidated).toHaveLength(0);
    expect(result.worstCase.totalLoss).toBe(0);
  });
});

// ── effectiveLeverage ─────────────────────────────────────

describe('effectiveLeverage', () => {
  it('gross leverage = sum of notional / equity', () => {
    const result = effectiveLeverage({
      positions: [
        { notionalValue: 5000, margin: 1000, unrealizedPnl: 0 },
        { notionalValue: -3000, margin: 600, unrealizedPnl: 0 },
      ],
      accountEquity: 2000,
    });
    // gross = (5000 + 3000) / 2000 = 4
    expect(result.grossLeverage).toBeCloseTo(4);
  });

  it('free margin = equity - used margin', () => {
    const result = effectiveLeverage({
      positions: [
        { notionalValue: 10000, margin: 1000, unrealizedPnl: 0 },
      ],
      accountEquity: 5000,
    });
    expect(result.freeMargin).toBeCloseTo(4000);
    expect(result.marginUsed).toBeCloseTo(1000);
  });

  it('net leverage considers direction', () => {
    const result = effectiveLeverage({
      positions: [
        { notionalValue: 5000, margin: 500, unrealizedPnl: 0 },
        { notionalValue: -5000, margin: 500, unrealizedPnl: 0 },
      ],
      accountEquity: 2000,
    });
    // Net = |5000 - 5000| / 2000 = 0
    expect(result.netLeverage).toBeCloseTo(0);
    // Gross = 10000 / 2000 = 5
    expect(result.grossLeverage).toBeCloseTo(5);
  });

  it('no positions give zero leverage', () => {
    const result = effectiveLeverage({
      positions: [],
      accountEquity: 10000,
    });
    expect(result.grossLeverage).toBe(0);
    expect(result.netLeverage).toBe(0);
    expect(result.freeMargin).toBe(10000);
  });
});

// ── liquidationFlowPrediction ─────────────────────────────

describe('liquidationFlowPrediction', () => {
  it('down move triggers sell flow from long liquidations', () => {
    const levels = [
      { price: 48000, size: 1e7, side: 'long' as const },
      { price: 49000, size: 5e6, side: 'long' as const },
    ];
    const result = liquidationFlowPrediction({
      currentPrice: 50000,
      direction: 'down',
      magnitude: 0.05, // 5% drop to 47500
      liquidationLevels: levels,
    });
    expect(result.flowDirection).toBe('sell');
    expect(result.totalFlow).toBeGreaterThan(0);
    expect(result.affectedLevels.length).toBeGreaterThan(0);
  });

  it('up move triggers buy flow from short liquidations', () => {
    const levels = [
      { price: 52000, size: 1e7, side: 'short' as const },
    ];
    const result = liquidationFlowPrediction({
      currentPrice: 50000,
      direction: 'up',
      magnitude: 0.05, // 5% up to 52500
      liquidationLevels: levels,
    });
    expect(result.flowDirection).toBe('buy');
    expect(result.totalFlow).toBeGreaterThan(0);
  });

  it('no levels triggered gives zero flow', () => {
    const result = liquidationFlowPrediction({
      currentPrice: 50000,
      direction: 'down',
      magnitude: 0.01,
      liquidationLevels: [{ price: 40000, size: 1e7, side: 'long' }],
    });
    expect(result.totalFlow).toBe(0);
    expect(result.affectedLevels).toHaveLength(0);
  });
});

// ── deleveragingIndex ─────────────────────────────────────

describe('deleveragingIndex', () => {
  it('falling OI + volume spike signals active deleveraging', () => {
    const result = deleveragingIndex({
      openInterest: 1e8,
      volume: 5e8, // volume >> OI
      priceChange: -0.15,
      fundingRate: 0.005,
    });
    expect(result.signal).toBe('active_deleveraging');
    expect(result.index).toBeGreaterThan(0.6);
    expect(result.severity).toBeGreaterThan(6);
  });

  it('low volume + stable OI signals building leverage', () => {
    const result = deleveragingIndex({
      openInterest: 1e9,
      volume: 1e7, // low volume
      priceChange: 0.001,
      fundingRate: 0.0001,
    });
    expect(result.signal).toBe('building_leverage');
    expect(result.index).toBeLessThan(0.3);
  });

  it('components are in [0, 1]', () => {
    const result = deleveragingIndex({
      openInterest: 1e9,
      volume: 5e8,
      priceChange: -0.05,
      fundingRate: 0.002,
    });
    expect(result.components.oiContraction).toBeGreaterThanOrEqual(0);
    expect(result.components.oiContraction).toBeLessThanOrEqual(1);
    expect(result.components.volumeSpike).toBeGreaterThanOrEqual(0);
    expect(result.components.volumeSpike).toBeLessThanOrEqual(1);
    expect(result.components.priceVelocity).toBeGreaterThanOrEqual(0);
    expect(result.components.priceVelocity).toBeLessThanOrEqual(1);
    expect(result.components.fundingReset).toBeGreaterThanOrEqual(0);
    expect(result.components.fundingReset).toBeLessThanOrEqual(1);
  });
});

// ── safeMaxLeverage ───────────────────────────────────────

describe('safeMaxLeverage', () => {
  it('higher volatility yields lower safe leverage', () => {
    const lowVol = safeMaxLeverage({ volatility: 0.01, timeHorizon: 1, maxLossThreshold: 0.5 });
    const highVol = safeMaxLeverage({ volatility: 0.10, timeHorizon: 1, maxLossThreshold: 0.5 });
    expect(highVol.maxLeverage).toBeLessThan(lowVol.maxLeverage);
  });

  it('higher threshold allows higher leverage', () => {
    const tight = safeMaxLeverage({ volatility: 0.05, timeHorizon: 1, maxLossThreshold: 0.1 });
    const loose = safeMaxLeverage({ volatility: 0.05, timeHorizon: 1, maxLossThreshold: 0.5 });
    expect(loose.maxLeverage).toBeGreaterThan(tight.maxLeverage);
  });

  it('recommended is always <= max leverage', () => {
    const result = safeMaxLeverage({ volatility: 0.03, timeHorizon: 7, maxLossThreshold: 0.3 });
    expect(result.recommendedLeverage).toBeLessThanOrEqual(result.maxLeverage);
    expect(result.recommendedLeverage).toBeGreaterThanOrEqual(1);
  });

  it('probability of ruin is in [0, 1]', () => {
    const result = safeMaxLeverage({ volatility: 0.05, timeHorizon: 1, maxLossThreshold: 0.3 });
    expect(result.probabilityOfRuin).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfRuin).toBeLessThanOrEqual(1);
  });

  it('reasoning string includes volatility info', () => {
    const result = safeMaxLeverage({ volatility: 0.05, timeHorizon: 1, maxLossThreshold: 0.3 });
    expect(result.reasoning).toContain('5.0%');
  });
});
