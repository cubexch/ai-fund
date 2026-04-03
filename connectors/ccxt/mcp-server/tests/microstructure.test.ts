import { describe, it, expect } from 'vitest';
import {
  computeVpin,
  kyleLambda,
  classifyTrades,
  adverseSelection,
  amihudIlliquidity,
  realizedSpreadDecomposition,
  rollSpread,
  pinModel,
  hasbrouckInfoShare,
  tradeFlowToxicity,
} from '@ai-fund/lib/microstructure';

// ── computeVpin ─────────────────────────────────────────────

describe('computeVpin', () => {
  it('returns VPIN near 1 when all trades are buys', () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({
      price: 100 + i * 0.01,
      volume: 10,
      side: 'buy' as const,
    }));
    const result = computeVpin(trades, 50);
    expect(result.vpin).toBeGreaterThan(0.9);
    expect(result.toxicityLevel).toBe('high');
  });

  it('returns VPIN near 0 when buy/sell volume is balanced', () => {
    const trades: Array<{ price: number; volume: number; side: 'buy' | 'sell' }> = [];
    for (let i = 0; i < 20; i++) {
      trades.push({ price: 100, volume: 10, side: i % 2 === 0 ? 'buy' : 'sell' });
    }
    const result = computeVpin(trades, 100);
    expect(result.vpin).toBeCloseTo(0, 1);
  });

  it('creates the correct number of full buckets', () => {
    const trades = Array.from({ length: 10 }, () => ({
      price: 100,
      volume: 10,
      side: 'buy' as const,
    }));
    // Total volume = 100, bucket size = 25 → 4 buckets
    const result = computeVpin(trades, 25);
    expect(result.buckets).toHaveLength(4);
  });

  it('returns empty result for empty trades', () => {
    const result = computeVpin([], 50);
    expect(result.vpin).toBe(0);
    expect(result.buckets).toHaveLength(0);
    expect(result.toxicityLevel).toBe('low');
  });

  it('returns empty result for zero bucket size', () => {
    const trades = [{ price: 100, volume: 10, side: 'buy' as const }];
    const result = computeVpin(trades, 0);
    expect(result.vpin).toBe(0);
  });

  it('classifies by price change when side is not provided', () => {
    // Rising prices → buys, falling → sells
    const trades = [
      { price: 100, volume: 10 },
      { price: 101, volume: 10 },
      { price: 102, volume: 10 },
      { price: 101, volume: 10 },
      { price: 100, volume: 10 },
    ];
    const result = computeVpin(trades, 50);
    // 3 buys (first + two rises), 2 sells → imbalance > 0
    expect(result.vpin).toBeGreaterThan(0);
  });

  it('returns medium toxicity for moderate imbalance', () => {
    const trades: Array<{ price: number; volume: number; side: 'buy' | 'sell' }> = [];
    // 70% buy, 30% sell
    for (let i = 0; i < 70; i++) trades.push({ price: 100, volume: 1, side: 'buy' });
    for (let i = 0; i < 30; i++) trades.push({ price: 100, volume: 1, side: 'sell' });
    const result = computeVpin(trades, 50);
    expect(result.toxicityLevel).toMatch(/medium|high/);
  });

  it('handles trades that span multiple buckets', () => {
    // Single large trade that fills 2 buckets
    const trades = [{ price: 100, volume: 100, side: 'buy' as const }];
    const result = computeVpin(trades, 50);
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0].buyVolume).toBe(50);
    expect(result.buckets[1].buyVolume).toBe(50);
  });
});

// ── kyleLambda ──────────────────────────────────────────────

describe('kyleLambda', () => {
  it('returns positive lambda when buys push price up', () => {
    // Mix of buys and sells; buys at higher prices, sells at lower
    const trades: Array<{ price: number; volume: number; side: 'buy' | 'sell' }> = [];
    for (let i = 0; i < 40; i++) {
      const isBuy = i % 2 === 0;
      trades.push({
        price: 100 + i * 0.25 + (isBuy ? 0.5 : -0.3),
        volume: 10 + Math.abs(5 * Math.sin(i)),
        side: isBuy ? 'buy' : 'sell',
      });
    }
    const result = kyleLambda(trades);
    expect(result.lambda).toBeGreaterThanOrEqual(0);
  });

  it('returns low R-squared for random noise', () => {
    const trades = Array.from({ length: 50 }, (_, i) => ({
      price: 100 + Math.sin(i) * 2,
      volume: 10 + Math.cos(i * 7) * 5,
      side: (i % 3 === 0 ? 'sell' : 'buy') as 'buy' | 'sell',
    }));
    const result = kyleLambda(trades);
    expect(result.rSquared).toBeLessThan(0.5);
  });

  it('returns zero for fewer than 3 trades', () => {
    const trades = [
      { price: 100, volume: 10, side: 'buy' as const },
      { price: 101, volume: 10, side: 'buy' as const },
    ];
    const result = kyleLambda(trades);
    expect(result.lambda).toBe(0);
    expect(result.significantImpact).toBe(false);
  });

  it('respects window size parameter', () => {
    const trades = Array.from({ length: 30 }, (_, i) => ({
      price: 100 + i * 0.1,
      volume: 10,
      side: 'buy' as const,
    }));
    const resultFull = kyleLambda(trades);
    const resultWindow = kyleLambda(trades, 10);
    // Different windows may give different lambdas
    expect(typeof resultWindow.lambda).toBe('number');
    expect(resultWindow.tStatistic).toBeDefined();
  });

  it('significantImpact is true when |t| > 1.96', () => {
    // Strong linear relationship: buys consistently raise price
    const trades = Array.from({ length: 100 }, (_, i) => ({
      price: 100 + i * 1,
      volume: 10,
      side: 'buy' as const,
    }));
    const result = kyleLambda(trades);
    if (Math.abs(result.tStatistic) > 1.96) {
      expect(result.significantImpact).toBe(true);
    }
  });
});

// ── classifyTrades ──────────────────────────────────────────

describe('classifyTrades', () => {
  it('classifies trade above midpoint as buy (lee-ready)', () => {
    const trades = [{ price: 101, bid: 99, ask: 101 }];
    const result = classifyTrades(trades, 'lee-ready');
    expect(result[0].side).toBe('buy');
    expect(result[0].confidence).toBeGreaterThan(0.7);
  });

  it('classifies trade below midpoint as sell (lee-ready)', () => {
    const trades = [{ price: 99, bid: 99, ask: 101 }];
    const result = classifyTrades(trades, 'lee-ready');
    expect(result[0].side).toBe('sell');
  });

  it('falls back to tick test when price is at midpoint', () => {
    const trades = [
      { price: 99, bid: 99, ask: 101 },
      { price: 100, bid: 99, ask: 101 }, // at midpoint, prev was lower → buy
    ];
    const result = classifyTrades(trades, 'lee-ready');
    expect(result[1].side).toBe('buy');
    expect(result[1].confidence).toBe(0.6);
  });

  it('classifies using tick test method', () => {
    const trades = [
      { price: 100, bid: 99, ask: 101 },
      { price: 101, bid: 99, ask: 103 }, // up tick → buy
      { price: 99, bid: 98, ask: 100 },  // down tick → sell
    ];
    const result = classifyTrades(trades, 'tick');
    expect(result[1].side).toBe('buy');
    expect(result[1].confidence).toBe(0.85);
    expect(result[2].side).toBe('sell');
    expect(result[2].confidence).toBe(0.85);
  });

  it('handles tick test with no price change (looks back further)', () => {
    const trades = [
      { price: 100, bid: 99, ask: 101 },
      { price: 102, bid: 101, ask: 103 },
      { price: 102, bid: 101, ask: 103 }, // same as previous, looks back to 100 → buy
    ];
    const result = classifyTrades(trades, 'tick');
    expect(result[2].side).toBe('buy');
    expect(result[2].confidence).toBe(0.6);
  });

  it('classifies using bulk method', () => {
    const trades = [
      { price: 100, bid: 99, ask: 101 },
      { price: 102, bid: 101, ask: 103 }, // price up → buy
      { price: 99, bid: 98, ask: 100 },   // price down → sell
    ];
    const result = classifyTrades(trades, 'bulk');
    expect(result[1].side).toBe('buy');
    expect(result[2].side).toBe('sell');
  });

  it('returns empty array for empty input', () => {
    expect(classifyTrades([])).toEqual([]);
  });

  it('defaults to lee-ready method', () => {
    const trades = [{ price: 101, bid: 99, ask: 101 }];
    const defaultResult = classifyTrades(trades);
    const leeReady = classifyTrades(trades, 'lee-ready');
    expect(defaultResult[0].side).toBe(leeReady[0].side);
  });
});

// ── adverseSelection ────────────────────────────────────────

describe('adverseSelection', () => {
  it('shows high adverse selection when buys precede price increases', () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({
      price: 100 + i,
      side: 'buy' as const,
      midPrice: 100 + i,
    }));
    const result = adverseSelection(trades, [1, 5]);
    // Buys before price increases → positive adverse selection cost
    expect(result.costs[0].cost).toBeGreaterThan(0);
  });

  it('returns zero costs for fewer than 2 trades', () => {
    const trades = [{ price: 100, side: 'buy' as const, midPrice: 100 }];
    const result = adverseSelection(trades);
    expect(result.averageCost).toBe(0);
    expect(result.informedFlowPct).toBe(0);
  });

  it('uses default horizons [1, 5, 10]', () => {
    const trades = Array.from({ length: 15 }, (_, i) => ({
      price: 100 + i * 0.1,
      side: 'buy' as const,
      midPrice: 100 + i * 0.1,
    }));
    const result = adverseSelection(trades);
    expect(result.costs).toHaveLength(3);
    expect(result.costs[0].horizon).toBe(1);
    expect(result.costs[1].horizon).toBe(5);
    expect(result.costs[2].horizon).toBe(10);
  });

  it('computes informedFlowPct as fraction of positive-cost horizons', () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({
      price: 100 + i,
      side: 'buy' as const,
      midPrice: 100 + i,
    }));
    const result = adverseSelection(trades, [1]);
    // All buys before price rise → cost > 0 → 100% informed
    expect(result.informedFlowPct).toBe(1);
  });
});

// ── amihudIlliquidity ───────────────────────────────────────

describe('amihudIlliquidity', () => {
  it('returns low ratio (high liquidity) for high volume + low returns', () => {
    const prices = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 0.01);
    const volumes = Array.from({ length: 20 }, () => 1_000_000);
    const result = amihudIlliquidity(prices, volumes);
    expect(result.ratio).toBeLessThan(1e-6);
    expect(result.liquidityScore).toMatch(/high|medium/);
  });

  it('returns high ratio (low liquidity) for low volume + high returns', () => {
    const prices = [100, 120, 80, 130, 70]; // big swings
    const volumes = [1, 1, 1, 1, 1]; // tiny volume
    const result = amihudIlliquidity(prices, volumes);
    expect(result.ratio).toBeGreaterThan(0.01);
    expect(result.liquidityScore).toBe('low');
  });

  it('returns zero for fewer than 2 prices', () => {
    const result = amihudIlliquidity([100], [1000]);
    expect(result.ratio).toBe(0);
    expect(result.rollingRatios).toHaveLength(0);
    expect(result.liquidityScore).toBe('high');
  });

  it('handles zero volume gracefully', () => {
    const prices = [100, 110, 120];
    const volumes = [0, 0, 0];
    const result = amihudIlliquidity(prices, volumes);
    expect(result.ratio).toBe(0);
  });

  it('rollingRatios has length prices.length - 1', () => {
    const prices = [100, 110, 105, 115, 120];
    const volumes = [1000, 2000, 1500, 3000, 2500];
    const result = amihudIlliquidity(prices, volumes);
    expect(result.rollingRatios).toHaveLength(4);
  });
});

// ── realizedSpreadDecomposition ──────────────────────────────

describe('realizedSpreadDecomposition', () => {
  it('effective spread equals realized spread + price impact', () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({
      price: 100.05 + i * 0.01,
      side: 'buy' as const,
      midPrice: 100 + i * 0.01,
    }));
    const result = realizedSpreadDecomposition(trades, 5);
    expect(result.effectiveSpread).toBeCloseTo(
      result.realizedSpread + result.priceImpact,
      6,
    );
  });

  it('returns zeros when not enough trades for horizon', () => {
    const trades = [
      { price: 100.05, side: 'buy' as const, midPrice: 100 },
      { price: 100.10, side: 'buy' as const, midPrice: 100.05 },
    ];
    const result = realizedSpreadDecomposition(trades, 5);
    expect(result.effectiveSpread).toBe(0);
    expect(result.realizedSpread).toBe(0);
    expect(result.priceImpact).toBe(0);
  });

  it('adverseSelectionPct is between 0 and 1', () => {
    const trades = Array.from({ length: 20 }, (_, i) => ({
      price: 100.05 + i * 0.01,
      side: 'buy' as const,
      midPrice: 100 + i * 0.01,
    }));
    const result = realizedSpreadDecomposition(trades, 5);
    expect(result.adverseSelectionPct).toBeGreaterThanOrEqual(0);
    expect(result.adverseSelectionPct).toBeLessThanOrEqual(1);
  });
});

// ── rollSpread ──────────────────────────────────────────────

describe('rollSpread', () => {
  it('returns 0 spread for positive serial covariance', () => {
    // Trending prices: positive covariance between consecutive changes
    const prices = [100, 101, 102, 103, 104, 105];
    const result = rollSpread(prices);
    // All changes = +1, product of consecutive changes = 1 → positive covariance
    expect(result.serialCovariance).toBeGreaterThanOrEqual(0);
    expect(result.impliedSpread).toBe(0);
  });

  it('returns positive spread for negative serial covariance', () => {
    // Bouncing prices: alternating up/down creates negative covariance
    const prices = [100, 101, 100, 101, 100, 101, 100, 101, 100];
    const result = rollSpread(prices);
    expect(result.serialCovariance).toBeLessThan(0);
    expect(result.impliedSpread).toBeGreaterThan(0);
  });

  it('returns zero for fewer than 3 prices', () => {
    expect(rollSpread([100, 101]).impliedSpread).toBe(0);
    expect(rollSpread([100]).impliedSpread).toBe(0);
    expect(rollSpread([]).impliedSpread).toBe(0);
  });

  it('spread equals 2 * sqrt(-covariance) when negative', () => {
    const prices = [100, 101, 100, 101, 100, 101, 100];
    const result = rollSpread(prices);
    if (result.serialCovariance < 0) {
      expect(result.impliedSpread).toBeCloseTo(
        2 * Math.sqrt(-result.serialCovariance),
      );
    }
  });
});

// ── pinModel ────────────────────────────────────────────────

describe('pinModel', () => {
  it('returns low PIN for balanced buy/sell', () => {
    const result = pinModel({ buyTrades: 500, sellTrades: 500, totalPeriods: 100 });
    expect(result.pin).toBeLessThan(0.1);
  });

  it('returns higher PIN for skewed trades', () => {
    const balanced = pinModel({ buyTrades: 500, sellTrades: 500, totalPeriods: 100 });
    const skewed = pinModel({ buyTrades: 900, sellTrades: 100, totalPeriods: 100 });
    expect(skewed.pin).toBeGreaterThan(balanced.pin);
  });

  it('returns zero for zero total periods', () => {
    const result = pinModel({ buyTrades: 100, sellTrades: 100, totalPeriods: 0 });
    expect(result.pin).toBe(0);
  });

  it('returns zero for zero trades', () => {
    const result = pinModel({ buyTrades: 0, sellTrades: 0, totalPeriods: 10 });
    expect(result.pin).toBe(0);
  });

  it('delta is 0.5 when mu is 0 (balanced)', () => {
    const result = pinModel({ buyTrades: 100, sellTrades: 100, totalPeriods: 10 });
    expect(result.delta).toBe(0.5);
  });

  it('all parameters are non-negative', () => {
    const result = pinModel({ buyTrades: 800, sellTrades: 200, totalPeriods: 50 });
    expect(result.pin).toBeGreaterThanOrEqual(0);
    expect(result.alpha).toBeGreaterThanOrEqual(0);
    expect(result.mu).toBeGreaterThanOrEqual(0);
    expect(result.epsilonBuy).toBeGreaterThanOrEqual(0);
    expect(result.epsilonSell).toBeGreaterThanOrEqual(0);
  });
});

// ── hasbrouckInfoShare ──────────────────────────────────────

describe('hasbrouckInfoShare', () => {
  it('shares sum to 1', () => {
    const a = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    const b = [100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5];
    const result = hasbrouckInfoShare(a, b);
    expect(result.shareA + result.shareB).toBeCloseTo(1);
  });

  it('returns 50/50 for identical series', () => {
    const prices = [100, 101, 99, 102, 98, 103, 97, 104];
    const result = hasbrouckInfoShare(prices, prices);
    expect(result.shareA).toBeCloseTo(0.5, 1);
    expect(result.shareB).toBeCloseTo(0.5, 1);
  });

  it('returns 50/50 for fewer than 3 prices', () => {
    const result = hasbrouckInfoShare([100, 101], [100, 101]);
    expect(result.shareA).toBe(0.5);
    expect(result.shareB).toBe(0.5);
  });

  it('dominant venue is A when shareA > shareB', () => {
    const a = [100, 105, 110, 115, 120, 125, 130, 135, 140, 145];
    // B is a lagged/dampened version of A
    const b = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    const result = hasbrouckInfoShare(a, b);
    expect(result.shareA + result.shareB).toBeCloseTo(1);
    if (result.shareA > result.shareB) {
      expect(result.dominantVenue).toBe('A');
    } else {
      expect(result.dominantVenue).toBe('B');
    }
  });

  it('handles different length series (uses shorter)', () => {
    const a = [100, 101, 102, 103, 104];
    const b = [100, 101, 102];
    const result = hasbrouckInfoShare(a, b);
    expect(result.shareA + result.shareB).toBeCloseTo(1);
  });
});

// ── tradeFlowToxicity ───────────────────────────────────────

describe('tradeFlowToxicity', () => {
  it('returns toxic regime when all trades are buys', () => {
    const now = Date.now();
    const trades = Array.from({ length: 20 }, (_, i) => ({
      price: 100,
      volume: 10,
      side: 'buy' as const,
      timestamp: now - 50000 + i * 1000,
    }));
    const result = tradeFlowToxicity(trades);
    expect(result.toxicity).toBeCloseTo(1);
    expect(result.flowImbalance).toBeCloseTo(1);
    expect(result.regime).toBe('toxic');
  });

  it('returns benign regime when buy/sell are balanced', () => {
    const now = Date.now();
    const trades: Array<{ price: number; volume: number; side: 'buy' | 'sell'; timestamp: number }> = [];
    for (let i = 0; i < 20; i++) {
      trades.push({
        price: 100,
        volume: 10,
        side: i % 2 === 0 ? 'buy' : 'sell',
        timestamp: now - 50000 + i * 1000,
      });
    }
    const result = tradeFlowToxicity(trades);
    expect(result.toxicity).toBeCloseTo(0, 1);
    expect(result.regime).toBe('benign');
  });

  it('returns zero for empty trades', () => {
    const result = tradeFlowToxicity([]);
    expect(result.toxicity).toBe(0);
    expect(result.arrivalRate).toBe(0);
    expect(result.regime).toBe('benign');
  });

  it('filters trades to the window', () => {
    const now = Date.now();
    // Old trades outside window + recent trades
    const trades = [
      { price: 100, volume: 100, side: 'sell' as const, timestamp: now - 200000 },
      { price: 100, volume: 10, side: 'buy' as const, timestamp: now - 30000 },
      { price: 100, volume: 10, side: 'buy' as const, timestamp: now },
    ];
    const result = tradeFlowToxicity(trades, 60000);
    // Only the last 2 trades are in the window (all buys)
    expect(result.toxicity).toBeCloseTo(1);
  });

  it('computes arrival rate in trades per second', () => {
    const now = Date.now();
    const trades = Array.from({ length: 10 }, (_, i) => ({
      price: 100,
      volume: 10,
      side: 'buy' as const,
      timestamp: now - 9000 + i * 1000,
    }));
    const result = tradeFlowToxicity(trades);
    // 10 trades over ~9 seconds ≈ ~1.1 trades/sec
    expect(result.arrivalRate).toBeGreaterThan(0.5);
    expect(result.arrivalRate).toBeLessThan(5);
  });
});
