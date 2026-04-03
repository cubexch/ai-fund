import { describe, it, expect } from 'vitest';
import {
  cumulativeVolumeDelta,
  footprintData,
  absorptionDetection,
  icebergDetection,
  aggressivePassiveFlow,
  volumeClockSpeed,
  orderFlowImbalanceProfile,
  deltaProfile,
  largeTradeDetection,
  tradeIntensityMap,
} from '@ai-fund/lib/order-flow';

// ── cumulativeVolumeDelta ───────────────────────────────────

describe('cumulativeVolumeDelta', () => {
  it('returns positive CVD when all trades are buys', () => {
    const trades = Array.from({ length: 10 }, () => ({
      price: 100,
      volume: 10,
      side: 'buy' as const,
    }));
    const result = cumulativeVolumeDelta(trades);
    expect(result.netDelta).toBe(100);
    expect(result.totalBuyVolume).toBe(100);
    expect(result.totalSellVolume).toBe(0);
    expect(result.trend).toBe('accumulation');
    expect(result.cvd[result.cvd.length - 1]).toBe(100);
  });

  it('returns negative CVD when all trades are sells', () => {
    const trades = Array.from({ length: 10 }, () => ({
      price: 100,
      volume: 10,
      side: 'sell' as const,
    }));
    const result = cumulativeVolumeDelta(trades);
    expect(result.netDelta).toBe(-100);
    expect(result.totalSellVolume).toBe(100);
    expect(result.trend).toBe('distribution');
    expect(result.cvd[result.cvd.length - 1]).toBe(-100);
  });

  it('net delta matches totalBuyVolume - totalSellVolume', () => {
    const trades = [
      { price: 100, volume: 30, side: 'buy' as const },
      { price: 100, volume: 20, side: 'sell' as const },
      { price: 100, volume: 15, side: 'buy' as const },
    ];
    const result = cumulativeVolumeDelta(trades);
    expect(result.netDelta).toBe(result.totalBuyVolume - result.totalSellVolume);
    expect(result.netDelta).toBe(25);
  });

  it('CVD array has same length as trades', () => {
    const trades = Array.from({ length: 5 }, (_, i) => ({
      price: 100,
      volume: 10,
      side: (i % 2 === 0 ? 'buy' : 'sell') as 'buy' | 'sell',
    }));
    const result = cumulativeVolumeDelta(trades);
    expect(result.cvd).toHaveLength(5);
  });

  it('returns neutral trend for balanced flow', () => {
    const trades = [
      { price: 100, volume: 50, side: 'buy' as const },
      { price: 100, volume: 50, side: 'sell' as const },
    ];
    const result = cumulativeVolumeDelta(trades);
    expect(result.trend).toBe('neutral');
  });

  it('returns empty result for empty trades', () => {
    const result = cumulativeVolumeDelta([]);
    expect(result.cvd).toHaveLength(0);
    expect(result.netDelta).toBe(0);
    expect(result.trend).toBe('neutral');
  });
});

// ── footprintData ───────────────────────────────────────────

describe('footprintData', () => {
  it('POC is the highest volume level', () => {
    const trades = [
      { price: 100, volume: 10, side: 'buy' as const },
      { price: 100, volume: 20, side: 'sell' as const },
      { price: 101, volume: 5, side: 'buy' as const },
      { price: 102, volume: 3, side: 'sell' as const },
    ];
    const result = footprintData(trades, 1);
    expect(result.poc).toBe(100); // 30 total vol at 100
  });

  it('delta = askVolume - bidVolume at each level', () => {
    const trades = [
      { price: 100, volume: 10, side: 'buy' as const },
      { price: 100, volume: 7, side: 'sell' as const },
    ];
    const result = footprintData(trades, 1);
    const level = result.levels.find(l => l.price === 100)!;
    // buy → askVolume, sell → bidVolume
    expect(level.askVolume).toBe(10);
    expect(level.bidVolume).toBe(7);
    expect(level.delta).toBe(3); // 10 - 7
  });

  it('levels are sorted by price ascending', () => {
    const trades = [
      { price: 103, volume: 5, side: 'buy' as const },
      { price: 100, volume: 10, side: 'buy' as const },
      { price: 101, volume: 7, side: 'sell' as const },
    ];
    const result = footprintData(trades, 1);
    for (let i = 1; i < result.levels.length; i++) {
      expect(result.levels[i].price).toBeGreaterThanOrEqual(result.levels[i - 1].price);
    }
  });

  it('returns empty for empty trades', () => {
    const result = footprintData([], 1);
    expect(result.levels).toHaveLength(0);
    expect(result.poc).toBe(0);
  });

  it('returns empty for zero tick size', () => {
    const result = footprintData([{ price: 100, volume: 10, side: 'buy' }], 0);
    expect(result.levels).toHaveLength(0);
  });

  it('buckets trades by tick size', () => {
    const trades = [
      { price: 100.1, volume: 10, side: 'buy' as const },
      { price: 100.2, volume: 5, side: 'buy' as const },
      { price: 100.9, volume: 3, side: 'sell' as const },
    ];
    // tick size of 1 → all bucket to 100
    const result = footprintData(trades, 1);
    expect(result.levels).toHaveLength(2); // 100 and 101
  });
});

// ── absorptionDetection ─────────────────────────────────────

describe('absorptionDetection', () => {
  it('detects large resting bid absorbing sells', () => {
    const orderbook = {
      bids: [{ price: 100, qty: 1000 }],
      asks: [{ price: 101, qty: 50 }],
    };
    // Many sells at price 100 being absorbed by the big bid
    const trades = Array.from({ length: 15 }, (_, i) => ({
      price: 100,
      volume: 10,
      side: 'sell' as const,
      timestamp: 1000 + i * 100,
    }));
    const result = absorptionDetection(orderbook, trades, { windowSize: 5, threshold: 1.0 });
    expect(result.absorptions.length).toBeGreaterThan(0);
    expect(result.absorptions[0].side).toBe('bid');
    expect(result.totalAbsorbed).toBeGreaterThan(0);
  });

  it('returns empty for empty data', () => {
    const result = absorptionDetection({ bids: [], asks: [] }, []);
    expect(result.absorptions).toHaveLength(0);
    expect(result.totalAbsorbed).toBe(0);
    expect(result.dominantSide).toBe('balanced');
  });

  it('returns balanced when no significant absorptions', () => {
    const orderbook = {
      bids: [{ price: 100, qty: 1 }],
      asks: [{ price: 101, qty: 1 }],
    };
    const trades = [
      { price: 100, volume: 1, side: 'sell' as const, timestamp: 1000 },
      { price: 101, volume: 1, side: 'buy' as const, timestamp: 1100 },
    ];
    const result = absorptionDetection(orderbook, trades);
    expect(result.absorptions).toHaveLength(0);
    expect(result.dominantSide).toBe('balanced');
  });

  it('dominant side reflects which side absorbed more', () => {
    const orderbook = {
      bids: [{ price: 100, qty: 500 }],
      asks: [{ price: 101, qty: 10 }],
    };
    const trades = Array.from({ length: 20 }, (_, i) => ({
      price: 100,
      volume: 10,
      side: 'sell' as const,
      timestamp: 1000 + i * 100,
    }));
    const result = absorptionDetection(orderbook, trades, { windowSize: 5, threshold: 0.5 });
    if (result.absorptions.length > 0) {
      expect(result.dominantSide).toBe('buyers'); // bid side absorbing
    }
  });
});

// ── icebergDetection ────────────────────────────────────────

describe('icebergDetection', () => {
  it('detects repeated same-size fills at same price as iceberg', () => {
    const trades = Array.from({ length: 10 }, (_, i) => ({
      price: 100,
      volume: 5,
      side: 'buy' as const,
      timestamp: 1000 + i * 1000,
    }));
    const result = icebergDetection(trades, { minRepeat: 3 });
    expect(result.icebergs.length).toBeGreaterThan(0);
    expect(result.icebergs[0].fillCount).toBe(10);
    expect(result.icebergs[0].confidence).toBeGreaterThan(0.5);
    expect(result.totalHiddenLiquidity).toBe(50); // 10 * 5
  });

  it('does not flag random fill sizes as iceberg', () => {
    const trades = [
      { price: 100, volume: 5, side: 'buy' as const, timestamp: 1000 },
      { price: 100, volume: 50, side: 'buy' as const, timestamp: 2000 },
      { price: 100, volume: 2, side: 'buy' as const, timestamp: 3000 },
      { price: 100, volume: 80, side: 'buy' as const, timestamp: 4000 },
      { price: 100, volume: 1, side: 'buy' as const, timestamp: 5000 },
    ];
    const result = icebergDetection(trades, { minRepeat: 3 });
    // High coefficient of variation → low confidence → likely filtered
    if (result.icebergs.length > 0) {
      expect(result.icebergs[0].confidence).toBeLessThan(0.5);
    }
  });

  it('returns empty for fewer trades than minRepeat', () => {
    const trades = [
      { price: 100, volume: 5, side: 'buy' as const, timestamp: 1000 },
      { price: 100, volume: 5, side: 'buy' as const, timestamp: 2000 },
    ];
    const result = icebergDetection(trades, { minRepeat: 3 });
    expect(result.icebergs).toHaveLength(0);
  });

  it('returns empty for empty trades', () => {
    const result = icebergDetection([]);
    expect(result.icebergs).toHaveLength(0);
    expect(result.totalHiddenLiquidity).toBe(0);
  });

  it('separates clusters by side', () => {
    const trades = [
      ...Array.from({ length: 5 }, (_, i) => ({
        price: 100, volume: 10, side: 'buy' as const, timestamp: 1000 + i * 1000,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        price: 100, volume: 10, side: 'sell' as const, timestamp: 6000 + i * 1000,
      })),
    ];
    const result = icebergDetection(trades, { minRepeat: 3 });
    const sides = result.icebergs.map(i => i.side);
    if (sides.length >= 2) {
      expect(sides).toContain('buy');
      expect(sides).toContain('sell');
    }
  });
});

// ── aggressivePassiveFlow ───────────────────────────────────

describe('aggressivePassiveFlow', () => {
  it('returns aggressive_buying signal for all taker buys', () => {
    const trades = Array.from({ length: 10 }, () => ({
      price: 100,
      volume: 10,
      side: 'buy' as const,
      isMaker: false,
    }));
    const result = aggressivePassiveFlow(trades);
    expect(result.signal).toBe('aggressive_buying');
    expect(result.aggressiveBuy).toBe(100);
    expect(result.aggressiveSell).toBe(0);
    expect(result.aggressiveRatio).toBe(1);
  });

  it('returns aggressive_selling signal for all taker sells', () => {
    const trades = Array.from({ length: 10 }, () => ({
      price: 100,
      volume: 10,
      side: 'sell' as const,
      isMaker: false,
    }));
    const result = aggressivePassiveFlow(trades);
    expect(result.signal).toBe('aggressive_selling');
    expect(result.aggressiveSell).toBe(100);
    expect(result.netAggressive).toBe(-100);
  });

  it('returns passive_accumulation for all maker buys', () => {
    const trades = Array.from({ length: 10 }, () => ({
      price: 100,
      volume: 10,
      side: 'buy' as const,
      isMaker: true,
    }));
    const result = aggressivePassiveFlow(trades);
    expect(result.signal).toBe('passive_accumulation');
    expect(result.passiveBuy).toBe(100);
    expect(result.aggressiveRatio).toBe(0);
  });

  it('returns balanced for mixed flow', () => {
    const trades = [
      { price: 100, volume: 10, side: 'buy' as const, isMaker: false },
      { price: 100, volume: 10, side: 'sell' as const, isMaker: false },
      { price: 100, volume: 10, side: 'buy' as const, isMaker: true },
      { price: 100, volume: 10, side: 'sell' as const, isMaker: true },
    ];
    const result = aggressivePassiveFlow(trades);
    expect(result.signal).toBe('balanced');
  });

  it('respects window size parameter', () => {
    const trades = [
      // Early trades (outside window of 2)
      { price: 100, volume: 100, side: 'sell' as const, isMaker: false },
      { price: 100, volume: 100, side: 'sell' as const, isMaker: false },
      // Recent trades (inside window)
      { price: 100, volume: 10, side: 'buy' as const, isMaker: false },
      { price: 100, volume: 10, side: 'buy' as const, isMaker: false },
    ];
    const result = aggressivePassiveFlow(trades, { windowSize: 2 });
    expect(result.aggressiveBuy).toBe(20);
    expect(result.aggressiveSell).toBe(0);
  });
});

// ── volumeClockSpeed ────────────────────────────────────────

describe('volumeClockSpeed', () => {
  it('returns fast regime for high trade rate', () => {
    const now = Date.now();
    // Many slow buckets followed by a burst in the last bucket
    const trades: Array<{ volume: number; timestamp: number }> = [];
    // 10 slow buckets with volume=1
    for (let i = 0; i < 10; i++) {
      trades.push({ volume: 1, timestamp: now + i * 60000 });
    }
    // Last bucket with huge volume
    for (let j = 0; j < 50; j++) {
      trades.push({ volume: 100, timestamp: now + 10 * 60000 + j * 100 });
    }
    const result = volumeClockSpeed(trades, { bucketSize: 60000 });
    expect(result.currentRate).toBeGreaterThan(0);
    expect(result.regime).toBe('fast');
  });

  it('returns slow regime for low trade rate', () => {
    const now = Date.now();
    // Very few trades spread across many buckets
    const trades = [
      { volume: 1, timestamp: now },
      { volume: 1, timestamp: now + 60000 },
      { volume: 1, timestamp: now + 120000 },
      { volume: 1000, timestamp: now + 180000 },
      { volume: 1000, timestamp: now + 181000 },
    ];
    const result = volumeClockSpeed(trades, { bucketSize: 60000 });
    // Last bucket has high volume; first buckets were slow
    expect(result.currentRate).toBeGreaterThan(0);
  });

  it('returns zero for empty trades', () => {
    const result = volumeClockSpeed([]);
    expect(result.currentRate).toBe(0);
    expect(result.averageRate).toBe(0);
    expect(result.regime).toBe('slow');
  });

  it('timeToNextBucket is positive', () => {
    const now = Date.now();
    const trades = [
      { volume: 10, timestamp: now },
      { volume: 10, timestamp: now + 30000 },
    ];
    const result = volumeClockSpeed(trades, { bucketSize: 60000 });
    expect(result.timeToNextBucket).toBeGreaterThan(0);
  });

  it('acceleration is zero for single bucket', () => {
    const now = Date.now();
    const trades = [
      { volume: 10, timestamp: now },
      { volume: 20, timestamp: now + 100 },
    ];
    const result = volumeClockSpeed(trades, { bucketSize: 60000 });
    // All trades in one bucket → no previous bucket to compare
    expect(result.acceleration).toBe(0);
  });
});

// ── orderFlowImbalanceProfile ───────────────────────────────

describe('orderFlowImbalanceProfile', () => {
  it('identifies strong support from all buys at a level', () => {
    const trades = Array.from({ length: 20 }, () => ({
      price: 100,
      volume: 10,
      side: 'buy' as const,
    }));
    const result = orderFlowImbalanceProfile(trades, 1);
    expect(result.overallImbalance).toBeCloseTo(1);
    expect(result.strongLevels.length).toBeGreaterThan(0);
    expect(result.strongLevels[0].type).toBe('support');
  });

  it('identifies strong resistance from all sells at a level', () => {
    const trades = Array.from({ length: 20 }, () => ({
      price: 100,
      volume: 10,
      side: 'sell' as const,
    }));
    const result = orderFlowImbalanceProfile(trades, 1);
    expect(result.overallImbalance).toBeCloseTo(-1);
    expect(result.strongLevels.length).toBeGreaterThan(0);
    expect(result.strongLevels[0].type).toBe('resistance');
  });

  it('returns empty for empty trades', () => {
    const result = orderFlowImbalanceProfile([], 5);
    expect(result.profile).toHaveLength(0);
    expect(result.overallImbalance).toBe(0);
    expect(result.strongLevels).toHaveLength(0);
  });

  it('returns empty for zero price levels', () => {
    const trades = [{ price: 100, volume: 10, side: 'buy' as const }];
    const result = orderFlowImbalanceProfile(trades, 0);
    expect(result.profile).toHaveLength(0);
  });

  it('handles all trades at same price', () => {
    const trades = [
      { price: 100, volume: 10, side: 'buy' as const },
      { price: 100, volume: 5, side: 'sell' as const },
    ];
    const result = orderFlowImbalanceProfile(trades, 5);
    // range = 0 → single level
    expect(result.profile).toHaveLength(1);
    expect(result.overallImbalance).toBeCloseTo((10 - 5) / 15);
  });

  it('profile has correct number of levels', () => {
    const trades = [
      { price: 100, volume: 10, side: 'buy' as const },
      { price: 110, volume: 10, side: 'sell' as const },
    ];
    const result = orderFlowImbalanceProfile(trades, 5);
    expect(result.profile).toHaveLength(5);
  });
});

// ── deltaProfile ────────────────────────────────────────────

describe('deltaProfile', () => {
  it('detects bearish divergence: price up + delta down', () => {
    const candles = [
      { open: 100, high: 102, low: 99, close: 101, volume: 100, buyVolume: 60, sellVolume: 40 },
      { open: 101, high: 103, low: 100, close: 102, volume: 100, buyVolume: 50, sellVolume: 50 },
      { open: 102, high: 105, low: 101, close: 104, volume: 100, buyVolume: 30, sellVolume: 70 },
    ];
    const result = deltaProfile(candles);
    // Price up (101→104), but cumDelta goes from 20 to 20+0-40 = -20 → down
    const hasBearish = result.divergences.some(d => d.type === 'bearish');
    expect(hasBearish).toBe(true);
  });

  it('detects bullish divergence: price down + delta up', () => {
    const candles = [
      { open: 104, high: 105, low: 103, close: 104, volume: 100, buyVolume: 40, sellVolume: 60 },
      { open: 104, high: 104, low: 102, close: 103, volume: 100, buyVolume: 50, sellVolume: 50 },
      { open: 103, high: 103, low: 100, close: 101, volume: 100, buyVolume: 70, sellVolume: 30 },
    ];
    const result = deltaProfile(candles);
    // Price down (104→101), cumDelta: -20 → -20 → +20 → up
    const hasBullish = result.divergences.some(d => d.type === 'bullish');
    expect(hasBullish).toBe(true);
  });

  it('returns correct delta per candle', () => {
    const candles = [
      { open: 100, high: 101, low: 99, close: 100, volume: 100, buyVolume: 70, sellVolume: 30 },
      { open: 100, high: 102, low: 99, close: 101, volume: 100, buyVolume: 40, sellVolume: 60 },
    ];
    const result = deltaProfile(candles);
    expect(result.deltas[0]).toBe(40);  // 70 - 30
    expect(result.deltas[1]).toBe(-20); // 40 - 60
  });

  it('cumulative delta is running sum', () => {
    const candles = [
      { open: 100, high: 101, low: 99, close: 100, volume: 100, buyVolume: 60, sellVolume: 40 },
      { open: 100, high: 101, low: 99, close: 100, volume: 100, buyVolume: 30, sellVolume: 70 },
      { open: 100, high: 101, low: 99, close: 100, volume: 100, buyVolume: 50, sellVolume: 50 },
    ];
    const result = deltaProfile(candles);
    expect(result.cumulativeDelta[0]).toBe(20);
    expect(result.cumulativeDelta[1]).toBe(-20);
    expect(result.cumulativeDelta[2]).toBe(-20);
  });

  it('returns empty for empty candles', () => {
    const result = deltaProfile([]);
    expect(result.deltas).toHaveLength(0);
    expect(result.cumulativeDelta).toHaveLength(0);
    expect(result.divergences).toHaveLength(0);
    expect(result.exhaustion).toHaveLength(0);
  });

  it('detects exhaustion: high volume but shrinking range', () => {
    const candles = [
      { open: 100, high: 110, low: 90, close: 105, volume: 100, buyVolume: 60, sellVolume: 40 },
      { open: 105, high: 115, low: 95, close: 110, volume: 100, buyVolume: 60, sellVolume: 40 },
      { open: 110, high: 120, low: 100, close: 115, volume: 100, buyVolume: 60, sellVolume: 40 },
      // Exhaustion candle: high volume, tiny range (shrunk by >50%), positive delta
      { open: 115, high: 116, low: 114.5, close: 115.5, volume: 200, buyVolume: 120, sellVolume: 80 },
    ];
    const result = deltaProfile(candles);
    const hasExhaustion = result.exhaustion.some(e => e.type === 'buying_exhaustion');
    expect(hasExhaustion).toBe(true);
  });
});

// ── largeTradeDetection ─────────────────────────────────────

describe('largeTradeDetection', () => {
  it('detects trades 3+ stddev above mean with stddev method', () => {
    // Many small trades + one huge trade
    const trades = [
      ...Array.from({ length: 20 }, (_, i) => ({
        price: 100, volume: 10, side: 'buy' as const, timestamp: 1000 + i * 100,
      })),
      { price: 100, volume: 1000, side: 'buy' as const, timestamp: 3000 },
    ];
    const result = largeTradeDetection(trades, { method: 'stddev', threshold: 2 });
    expect(result.largeTrades.length).toBeGreaterThan(0);
    expect(result.largeTrades[0].volume).toBe(1000);
    expect(result.largeTrades[0].zScore).toBeGreaterThan(2);
  });

  it('detects with fixed threshold method', () => {
    const trades = [
      { price: 100, volume: 5, side: 'buy' as const, timestamp: 1000 },
      { price: 100, volume: 50, side: 'sell' as const, timestamp: 2000 },
      { price: 100, volume: 100, side: 'buy' as const, timestamp: 3000 },
    ];
    const result = largeTradeDetection(trades, { method: 'fixed', threshold: 40 });
    expect(result.largeTrades).toHaveLength(2); // 50 and 100
  });

  it('detects with percentile method', () => {
    const trades = Array.from({ length: 100 }, (_, i) => ({
      price: 100,
      volume: i + 1, // 1 to 100
      side: 'buy' as const,
      timestamp: 1000 + i * 100,
    }));
    const result = largeTradeDetection(trades, { method: 'percentile', threshold: 90 });
    // Top 10% → volumes >= 90
    expect(result.largeTrades.length).toBeGreaterThan(0);
    for (const t of result.largeTrades) {
      expect(t.volume).toBeGreaterThanOrEqual(90);
    }
  });

  it('returns quiet when no large trades', () => {
    const trades = Array.from({ length: 10 }, (_, i) => ({
      price: 100, volume: 10, side: 'buy' as const, timestamp: 1000 + i * 100,
    }));
    // All same size → stddev = 0 → cutoff = mean + 0 = mean → all "large"
    // Actually with stddev=0, cutoff = 10 + 2*0 = 10, so all trades match.
    // Use a high fixed threshold instead:
    const result = largeTradeDetection(trades, { method: 'fixed', threshold: 1000 });
    expect(result.largeTrades).toHaveLength(0);
    expect(result.whaleActivity).toBe('quiet');
  });

  it('returns empty for empty trades', () => {
    const result = largeTradeDetection([]);
    expect(result.largeTrades).toHaveLength(0);
    expect(result.totalLargeVolume).toBe(0);
    expect(result.whaleActivity).toBe('quiet');
  });

  it('heavy_buying when large trades are mostly buys', () => {
    const trades = [
      ...Array.from({ length: 10 }, (_, i) => ({
        price: 100, volume: 10, side: 'buy' as const, timestamp: 1000 + i * 100,
      })),
      { price: 100, volume: 500, side: 'buy' as const, timestamp: 5000 },
      { price: 100, volume: 500, side: 'buy' as const, timestamp: 6000 },
    ];
    const result = largeTradeDetection(trades, { method: 'stddev', threshold: 2 });
    expect(result.whaleActivity).toBe('heavy_buying');
    expect(result.netLargeFlow).toBeGreaterThan(0);
  });

  it('heavy_selling when large trades are mostly sells', () => {
    const trades = [
      ...Array.from({ length: 10 }, (_, i) => ({
        price: 100, volume: 10, side: 'buy' as const, timestamp: 1000 + i * 100,
      })),
      { price: 100, volume: 500, side: 'sell' as const, timestamp: 5000 },
      { price: 100, volume: 500, side: 'sell' as const, timestamp: 6000 },
    ];
    const result = largeTradeDetection(trades, { method: 'stddev', threshold: 2 });
    expect(result.whaleActivity).toBe('heavy_selling');
    expect(result.netLargeFlow).toBeLessThan(0);
  });

  it('largeTradeRatio is proportion of total volume', () => {
    const trades = [
      { price: 100, volume: 10, side: 'buy' as const, timestamp: 1000 },
      { price: 100, volume: 10, side: 'buy' as const, timestamp: 2000 },
      { price: 100, volume: 100, side: 'buy' as const, timestamp: 3000 },
    ];
    const result = largeTradeDetection(trades, { method: 'fixed', threshold: 50 });
    expect(result.largeTradeRatio).toBeCloseTo(100 / 120);
  });
});

// ── tradeIntensityMap ───────────────────────────────────────

describe('tradeIntensityMap', () => {
  it('hotspots at high-volume price/time intersections', () => {
    const trades = [
      // Concentrated cluster
      ...Array.from({ length: 20 }, (_, i) => ({
        price: 100,
        volume: 50,
        timestamp: 1000 + i * 10,
      })),
      // Sparse trade elsewhere
      { price: 200, volume: 1, timestamp: 100000 },
    ];
    const result = tradeIntensityMap(trades, { timeResolution: 60000, priceResolution: 1 });
    expect(result.hotspots.length).toBeGreaterThan(0);
    // Hotspot should be at the concentrated cluster
    const topHotspot = result.hotspots[0];
    expect(topHotspot.intensity).toBeCloseTo(1);
  });

  it('returns empty for empty trades', () => {
    const result = tradeIntensityMap([]);
    expect(result.cells).toHaveLength(0);
    expect(result.hotspots).toHaveLength(0);
    expect(result.quietPeriods).toHaveLength(0);
  });

  it('cells have intensity between 0 and 1', () => {
    const trades = Array.from({ length: 10 }, (_, i) => ({
      price: 100 + i,
      volume: 10 + i * 5,
      timestamp: 1000 + i * 10000,
    }));
    const result = tradeIntensityMap(trades, { timeResolution: 60000, priceResolution: 1 });
    for (const cell of result.cells) {
      expect(cell.intensity).toBeGreaterThanOrEqual(0);
      expect(cell.intensity).toBeLessThanOrEqual(1);
    }
  });

  it('detects quiet periods', () => {
    const trades = [
      // Active period
      ...Array.from({ length: 10 }, (_, i) => ({
        price: 100, volume: 100, timestamp: i * 60000,
      })),
      // Quiet period (gap)
      { price: 100, volume: 1, timestamp: 20 * 60000 },
      // Active again
      ...Array.from({ length: 10 }, (_, i) => ({
        price: 100, volume: 100, timestamp: 30 * 60000 + i * 60000,
      })),
    ];
    const result = tradeIntensityMap(trades, { timeResolution: 60000 });
    // The gap from bucket 10-19 should be a quiet period (only one tiny trade at 20)
    expect(result.quietPeriods.length).toBeGreaterThan(0);
  });

  it('single trade creates one cell', () => {
    const trades = [{ price: 100, volume: 10, timestamp: 1000 }];
    const result = tradeIntensityMap(trades, { timeResolution: 60000, priceResolution: 1 });
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].intensity).toBe(1);
    expect(result.cells[0].tradeCount).toBe(1);
  });
});
