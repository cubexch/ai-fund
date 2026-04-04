import { describe, it, expect } from 'vitest';
import {
  classifyVolRegime, computeDcaSchedule, optimizeGridParams, analyzeBasisTrade,
} from '@ai-fund/lib/grid-trading';

// ── classifyVolRegime ──────────────────────────────────────

describe('classifyVolRegime', () => {
  it('returns high for ratio > 1.5', () => {
    expect(classifyVolRegime(3, 1.5)).toBe('high');
  });

  it('returns low for ratio < 0.7', () => {
    expect(classifyVolRegime(0.5, 1)).toBe('low');
  });

  it('returns normal for ratio in between', () => {
    expect(classifyVolRegime(1, 1)).toBe('normal');
  });

  it('returns normal for zero average ATR', () => {
    expect(classifyVolRegime(5, 0)).toBe('normal');
  });
});

// ── computeDcaSchedule ─────────────────────────────────────

describe('computeDcaSchedule', () => {
  it('splits equally without vol adjustment', () => {
    const orders = computeDcaSchedule({
      totalAmount: 1000,
      numOrders: 4,
      currentPrice: 100,
      closes: [],
      volAdjust: false,
    });
    expect(orders).toHaveLength(4);
    expect(orders[0].amountQuote).toBeCloseTo(250);
    expect(orders[0].estimatedAmountBase).toBeCloseTo(2.5);
    expect(orders[0].sizeReason).toBe('equal split');
  });

  it('returns empty for zero orders', () => {
    expect(computeDcaSchedule({
      totalAmount: 1000,
      numOrders: 0,
      currentPrice: 100,
      closes: [],
      volAdjust: false,
    })).toEqual([]);
  });

  it('total amount sums to input', () => {
    const orders = computeDcaSchedule({
      totalAmount: 5000,
      numOrders: 5,
      currentPrice: 50,
      closes: [],
      volAdjust: false,
    });
    const totalQuote = orders.reduce((s, o) => s + o.amountQuote, 0);
    expect(totalQuote).toBeCloseTo(5000);
  });

  it('vol-adjusted allocations sum to total', () => {
    // Generate enough closes for vol adjustment to kick in
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
    const orders = computeDcaSchedule({
      totalAmount: 10000,
      numOrders: 5,
      currentPrice: 100,
      closes,
      volAdjust: true,
    });
    expect(orders).toHaveLength(5);
    const totalQuote = orders.reduce((s, o) => s + o.amountQuote, 0);
    expect(totalQuote).toBeCloseTo(10000, 5);
    expect(orders[0].sizeReason).toContain('vol-adjusted');
  });

  it('falls back to equal split with insufficient closes for vol-adjust', () => {
    const orders = computeDcaSchedule({
      totalAmount: 1000,
      numOrders: 3,
      currentPrice: 50,
      closes: [50, 51, 49, 50], // < 12 closes
      volAdjust: true,
    });
    expect(orders[0].sizeReason).toBe('equal split');
  });
});

// ── optimizeGridParams ─────────────────────────────────────

describe('optimizeGridParams', () => {
  // Generate candles for testing (need 20+ for Bollinger, 14+ for ATR)
  const candles = Array.from({ length: 40 }, (_, i) => ({
    open: 100 + Math.sin(i / 3) * 5,
    high: 105 + Math.sin(i / 3) * 5,
    low: 95 + Math.sin(i / 3) * 5,
    close: 100 + Math.sin(i / 3) * 5,
    volume: 1000,
  }));

  it('returns correct number of grid levels', () => {
    const result = optimizeGridParams(candles, 10);
    expect(result.numGrids).toBe(10);
    expect(result.levels).toHaveLength(10);
  });

  it('grid levels have buy below and sell above current price', () => {
    const result = optimizeGridParams(candles, 10);
    const current = result.priceRange.current;
    for (const level of result.levels) {
      if (level.price < current) expect(level.side).toBe('buy');
      if (level.price > current) expect(level.side).toBe('sell');
    }
  });

  it('gridTop > gridBottom', () => {
    const result = optimizeGridParams(candles, 5);
    expect(result.gridTop).toBeGreaterThan(result.gridBottom);
  });

  it('spacing is positive', () => {
    const result = optimizeGridParams(candles, 5);
    expect(result.spacing).toBeGreaterThan(0);
  });

  it('ATR values are positive', () => {
    const result = optimizeGridParams(candles, 5);
    expect(result.atr.current).toBeGreaterThan(0);
    expect(result.atr.average).toBeGreaterThan(0);
  });

  it('throws for numGrids <= 0', () => {
    expect(() => optimizeGridParams(candles, 0)).toThrow('numGrids must be positive');
  });
});

// ── analyzeBasisTrade ──────────────────────────────────────

describe('analyzeBasisTrade', () => {
  it('detects strong positive carry', () => {
    const result = analyzeBasisTrade({
      spotPrice: 100,
      perpPrice: 100.05, // 5bps premium
      fundingRate: 0.0001, // positive funding
    });
    expect(result.basis).toBeGreaterThan(0);
    expect(result.basisAnnualized).toBeGreaterThan(0);
    expect(result.fundingRateAnnualized).toBeGreaterThan(0);
    expect(result.actionable).toBe(true);
  });

  it('detects neutral carry', () => {
    const result = analyzeBasisTrade({
      spotPrice: 100,
      perpPrice: 100.0001,
      fundingRate: 0,
    });
    expect(result.signal).toContain('neutral');
    expect(result.actionable).toBe(false);
  });

  it('detects negative carry', () => {
    const result = analyzeBasisTrade({
      spotPrice: 100,
      perpPrice: 99.95,
      fundingRate: -0.0003,
    });
    expect(result.basis).toBeLessThan(0);
    expect(result.signal).toContain('negative carry');
  });

  it('handles null funding rate', () => {
    const result = analyzeBasisTrade({
      spotPrice: 100,
      perpPrice: 100.1,
      fundingRate: null,
    });
    expect(result.fundingRateAnnualized).toBeNull();
    expect(result.totalCarryAnnualized).toBe(result.basisAnnualized);
  });

  it('applies estimated fees', () => {
    const result = analyzeBasisTrade({
      spotPrice: 100,
      perpPrice: 100.01,
      fundingRate: 0.0001,
      estimatedFeePct: 1,
    });
    expect(result.estimatedFees).toBe(1);
    expect(result.netCarryAnnualized).toBeLessThan(result.totalCarryAnnualized);
  });
});
