import { describe, it, expect, beforeEach } from 'vitest';

// Backtester may not exist yet -- skip if not resolvable
let BacktesterClass: any;
let available = false;
try {
  const mod = await import('../src/client/backtester');
  BacktesterClass = mod.Backtester;
  available = true;
} catch {
  // module not created yet -- skip tests
}

// ── Synthetic data generators ────────────────────────────────

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function generateTrendingUpBars(count: number, startPrice = 100): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += 1 + Math.random() * 0.5;
    const close = price;
    const high = Math.max(open, close) + Math.random() * 0.5;
    const low = Math.min(open, close) - Math.random() * 0.5;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 500,
    });
  }
  return bars;
}

function generateTrendingDownBars(count: number, startPrice = 200): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    price -= 1 + Math.random() * 0.5;
    const close = price;
    const high = Math.max(open, close) + Math.random() * 0.5;
    const low = Math.min(open, close) - Math.random() * 0.5;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 500,
    });
  }
  return bars;
}

function generateRangingBars(count: number, center = 100, amplitude = 10): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const price = center + Math.sin(i * 0.2) * amplitude;
    const open = price - Math.random() * 2;
    const close = price + Math.random() * 2;
    const high = Math.max(open, close) + Math.random() * 1;
    const low = Math.min(open, close) - Math.random() * 1;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 500,
    });
  }
  return bars;
}

function generateSMACrossoverBars(count: number): Bar[] {
  const bars: Bar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    if (i < count / 3) {
      price -= 0.5;
    } else if (i < (2 * count) / 3) {
      price += 1.5;
    } else {
      price -= 1.5;
    }
    const open = price - 0.5;
    const close = price;
    const high = price + 1;
    const low = price - 1;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 200,
    });
  }
  return bars;
}

function generateVolatileBars(count: number, startPrice = 100): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const swing = (Math.random() - 0.5) * 20;
    const open = price;
    price += swing;
    const close = price;
    const high = Math.max(open, close) + Math.abs(swing) * 0.3;
    const low = Math.min(open, close) - Math.abs(swing) * 0.3;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 2000,
    });
  }
  return bars;
}

// ── Backtester tests ─────────────────────────────────────────

describe.skipIf(!available)('Backtester', () => {
  let backtester: any;

  beforeEach(() => {
    backtester = new BacktesterClass();
  });

  // ── SMA crossover strategy ──────────────────────────────

  describe('SMA crossover strategy', () => {
    it('generates buy signal on golden cross', () => {
      const bars = generateSMACrossoverBars(120);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result).toBeDefined();
      expect(result.trades).toBeInstanceOf(Array);
      expect(result.trades.length).toBeGreaterThan(0);

      const buys = result.trades.filter((t: any) => t.side === 'buy');
      expect(buys.length).toBeGreaterThan(0);
    });

    it('generates sell signal on death cross', () => {
      const bars = generateSMACrossoverBars(120);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      const sells = result.trades.filter((t: any) => t.side === 'sell');
      expect(sells.length).toBeGreaterThan(0);
    });

    it('buy and sell signals alternate', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      for (let i = 1; i < result.trades.length; i++) {
        expect(result.trades[i].side).not.toBe(result.trades[i - 1].side);
      }
    });

    it('does not trade before long SMA is ready', () => {
      const bars = generateSMACrossoverBars(120);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      // First trade should occur only after bar index >= longPeriod
      if (result.trades.length > 0) {
        const firstTradeTs = result.trades[0].timestamp;
        const startTs = bars[0].timestamp;
        const barDuration = bars[1].timestamp - bars[0].timestamp;
        const barIndex = Math.round((firstTradeTs - startTs) / barDuration);
        expect(barIndex).toBeGreaterThanOrEqual(29); // longPeriod - 1
      }
    });

    it('handles different period combinations', () => {
      const bars = generateSMACrossoverBars(200);
      const configs = [
        { shortPeriod: 5, longPeriod: 20 },
        { shortPeriod: 10, longPeriod: 50 },
        { shortPeriod: 20, longPeriod: 60 },
      ];

      for (const params of configs) {
        const result = backtester.run({
          strategy: 'sma_crossover',
          bars,
          params,
          initialCapital: 10000,
          commissionRate: 0.001,
        });
        expect(result.trades).toBeInstanceOf(Array);
        expect(result.metrics).toBeDefined();
      }
    });
  });

  // ── RSI mean reversion strategy ─────────────────────────

  describe('RSI mean reversion strategy', () => {
    it('buys when RSI is oversold', () => {
      const bars = generateTrendingDownBars(60, 300);
      let price = bars[bars.length - 1].close;
      for (let i = 0; i < 40; i++) {
        price += 2;
        bars.push({
          timestamp: bars[bars.length - 1].timestamp + 86400000,
          open: price - 1, high: price + 1, low: price - 2, close: price,
          volume: 1000,
        });
      }

      const result = backtester.run({
        strategy: 'rsi_mean_reversion',
        bars,
        params: { period: 14, oversold: 30, overbought: 70 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.trades).toBeInstanceOf(Array);
      const buys = result.trades.filter((t: any) => t.side === 'buy');
      expect(buys.length).toBeGreaterThan(0);
    });

    it('sells when RSI is overbought', () => {
      const bars = generateTrendingUpBars(80, 100);
      let price = bars[bars.length - 1].close;
      for (let i = 0; i < 20; i++) {
        price -= 2;
        bars.push({
          timestamp: bars[bars.length - 1].timestamp + 86400000,
          open: price + 1, high: price + 2, low: price - 1, close: price,
          volume: 1000,
        });
      }

      const result = backtester.run({
        strategy: 'rsi_mean_reversion',
        bars,
        params: { period: 14, oversold: 30, overbought: 70 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      const sells = result.trades.filter((t: any) => t.side === 'sell');
      expect(sells.length).toBeGreaterThan(0);
    });

    it('respects custom oversold/overbought thresholds', () => {
      const bars = generateVolatileBars(150, 100);
      const wideResult = backtester.run({
        strategy: 'rsi_mean_reversion',
        bars,
        params: { period: 14, oversold: 20, overbought: 80 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });
      const narrowResult = backtester.run({
        strategy: 'rsi_mean_reversion',
        bars,
        params: { period: 14, oversold: 40, overbought: 60 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      // Narrower thresholds should produce more trades
      expect(narrowResult.trades.length).toBeGreaterThanOrEqual(wideResult.trades.length);
    });
  });

  // ── MACD momentum strategy ──────────────────────────────

  describe('MACD momentum strategy', () => {
    it('follows MACD signal crossovers', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'macd_momentum',
        bars,
        params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.trades).toBeInstanceOf(Array);
      expect(result.trades.length).toBeGreaterThan(0);
    });

    it('generates trades with correct structure', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'macd_momentum',
        bars,
        params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      for (const trade of result.trades) {
        expect(trade).toHaveProperty('side');
        expect(trade).toHaveProperty('price');
        expect(trade).toHaveProperty('amount');
        expect(trade).toHaveProperty('timestamp');
        expect(['buy', 'sell']).toContain(trade.side);
        expect(trade.price).toBeGreaterThan(0);
        expect(trade.amount).toBeGreaterThan(0);
      }
    });

    it('does not trade with insufficient data for MACD calculation', () => {
      // MACD needs slowPeriod + signalPeriod bars minimum
      const bars = generateTrendingUpBars(20);
      const result = backtester.run({
        strategy: 'macd_momentum',
        bars,
        params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.trades).toHaveLength(0);
    });
  });

  // ── Commission and slippage ─────────────────────────────

  describe('commission and slippage', () => {
    it('deducts commission from each trade', () => {
      const bars = generateSMACrossoverBars(120);
      const resultNoFee = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0,
      });
      const resultWithFee = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.002,
      });

      expect(resultWithFee.metrics.finalEquity).toBeLessThan(resultNoFee.metrics.finalEquity);
    });

    it('applies slippage when configured', () => {
      const bars = generateSMACrossoverBars(120);
      const resultNoSlip = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0,
        slippageBps: 0,
      });
      const resultWithSlip = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0,
        slippageBps: 10,
      });

      expect(resultWithSlip.metrics.finalEquity).toBeLessThan(resultNoSlip.metrics.finalEquity);
    });

    it('higher commission produces lower final equity', () => {
      const bars = generateSMACrossoverBars(120);
      const lowFee = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });
      const highFee = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.01,
      });

      expect(highFee.metrics.finalEquity).toBeLessThanOrEqual(lowFee.metrics.finalEquity);
    });

    it('combined commission and slippage deduction is cumulative', () => {
      const bars = generateSMACrossoverBars(120);
      const commOnly = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.002,
        slippageBps: 0,
      });
      const both = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.002,
        slippageBps: 10,
      });

      expect(both.metrics.finalEquity).toBeLessThan(commOnly.metrics.finalEquity);
    });
  });

  // ── Equity curve ────────────────────────────────────────

  describe('equity curve', () => {
    it('is monotonically tracked (timestamps strictly increasing)', () => {
      const bars = generateTrendingUpBars(80);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 5, longPeriod: 20 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.equityCurve).toBeInstanceOf(Array);
      expect(result.equityCurve.length).toBeGreaterThan(0);

      for (let i = 1; i < result.equityCurve.length; i++) {
        expect(result.equityCurve[i].timestamp).toBeGreaterThan(
          result.equityCurve[i - 1].timestamp
        );
      }
    });

    it('starts at initial capital', () => {
      const bars = generateTrendingUpBars(80);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 5, longPeriod: 20 },
        initialCapital: 50000,
        commissionRate: 0,
      });

      expect(result.equityCurve[0].equity).toBe(50000);
    });

    it('each entry has both timestamp and equity fields', () => {
      const bars = generateSMACrossoverBars(100);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      for (const point of result.equityCurve) {
        expect(point).toHaveProperty('timestamp');
        expect(point).toHaveProperty('equity');
        expect(point.timestamp).toBeTypeOf('number');
        expect(point.equity).toBeTypeOf('number');
        expect(point.equity).toBeGreaterThan(0);
      }
    });

    it('final equity matches metrics.finalEquity', () => {
      const bars = generateSMACrossoverBars(120);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      if (result.equityCurve.length > 0) {
        const lastEquity = result.equityCurve[result.equityCurve.length - 1].equity;
        expect(lastEquity).toBeCloseTo(result.metrics.finalEquity, 2);
      }
    });
  });

  // ── Metrics calculation ─────────────────────────────────

  describe('metrics calculation', () => {
    it('calculates Sharpe ratio', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.metrics.sharpeRatio).toBeTypeOf('number');
      expect(Number.isFinite(result.metrics.sharpeRatio)).toBe(true);
    });

    it('calculates Sortino ratio', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.metrics.sortinoRatio).toBeTypeOf('number');
      expect(Number.isFinite(result.metrics.sortinoRatio)).toBe(true);
    });

    it('calculates max drawdown between 0 and 1', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.metrics.maxDrawdown).toBeTypeOf('number');
      expect(result.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
      expect(result.metrics.maxDrawdown).toBeLessThanOrEqual(1);
    });

    it('calculates win rate between 0 and 100', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.metrics.winRate).toBeTypeOf('number');
      expect(result.metrics.winRate).toBeGreaterThanOrEqual(0);
      expect(result.metrics.winRate).toBeLessThanOrEqual(100);
    });

    it('calculates profit factor', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.metrics.profitFactor).toBeTypeOf('number');
      expect(result.metrics.profitFactor).toBeGreaterThanOrEqual(0);
    });

    it('reports total trades and total return', () => {
      const bars = generateSMACrossoverBars(150);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.metrics.totalTrades).toBeTypeOf('number');
      expect(result.metrics.totalTrades).toBeGreaterThanOrEqual(0);
      expect(result.metrics.totalReturn).toBeTypeOf('number');
    });

    it('total return sign matches equity change direction', () => {
      const bars = generateSMACrossoverBars(150);
      const initialCapital = 10000;
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital,
        commissionRate: 0.001,
      });

      if (result.metrics.finalEquity > initialCapital) {
        expect(result.metrics.totalReturn).toBeGreaterThan(0);
      } else if (result.metrics.finalEquity < initialCapital) {
        expect(result.metrics.totalReturn).toBeLessThan(0);
      }
    });

    it('max drawdown is zero for zero-trade scenarios', () => {
      // Not enough data for any signals
      const bars = generateTrendingUpBars(5);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.metrics.maxDrawdown).toBe(0);
      expect(result.metrics.totalTrades).toBe(0);
    });
  });

  // ── Edge cases ──────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty results for empty bars', () => {
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars: [],
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.trades).toHaveLength(0);
      expect(result.equityCurve).toHaveLength(0);
      expect(result.metrics.totalTrades).toBe(0);
    });

    it('throws error for unknown strategy', () => {
      const bars = generateTrendingUpBars(50);
      expect(() => backtester.run({
        strategy: 'nonexistent_strategy',
        bars,
        params: {},
        initialCapital: 10000,
        commissionRate: 0.001,
      })).toThrow();
    });

    it('handles single bar without crashing', () => {
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars: [{
          timestamp: 1700000000000,
          open: 100, high: 101, low: 99, close: 100, volume: 1000,
        }],
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      expect(result.trades).toHaveLength(0);
    });

    it('handles very small initial capital', () => {
      const bars = generateSMACrossoverBars(80);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 1,
        commissionRate: 0.001,
      });

      expect(result.metrics.finalEquity).toBeTypeOf('number');
      expect(result.metrics.finalEquity).toBeGreaterThan(0);
    });

    it('handles very large initial capital', () => {
      const bars = generateSMACrossoverBars(80);
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 1_000_000_000,
        commissionRate: 0.001,
      });

      expect(result.metrics.finalEquity).toBeTypeOf('number');
      expect(Number.isFinite(result.metrics.finalEquity)).toBe(true);
    });

    it('bars with identical prices produce no trades for SMA crossover', () => {
      const bars: Bar[] = [];
      for (let i = 0; i < 100; i++) {
        bars.push({
          timestamp: 1700000000000 + i * 86400000,
          open: 100, high: 100, low: 100, close: 100, volume: 1000,
        });
      }
      const result = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      // Flat prices mean short SMA equals long SMA -- no crossovers
      expect(result.trades).toHaveLength(0);
    });
  });

  // ── Walk-forward optimization ───────────────────────────

  describe('walk-forward', () => {
    it('splits data into in-sample and out-of-sample', () => {
      const bars = generateSMACrossoverBars(200);
      const result = backtester.walkForward({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
        inSampleRatio: 0.7,
      });

      expect(result).toBeDefined();
      expect(result.inSample).toBeDefined();
      expect(result.outOfSample).toBeDefined();
      expect(result.inSample.barCount).toBeCloseTo(140, -1);
      expect(result.outOfSample.barCount).toBeCloseTo(60, -1);
    });

    it('uses correct data split boundaries', () => {
      const bars = generateTrendingUpBars(100);
      const result = backtester.walkForward({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 5, longPeriod: 20 },
        initialCapital: 10000,
        commissionRate: 0.001,
        inSampleRatio: 0.5,
      });

      expect(result.inSample.endTimestamp).toBeLessThanOrEqual(
        result.outOfSample.startTimestamp
      );
    });

    it('in-sample and out-of-sample bar counts sum to total', () => {
      const totalBars = 200;
      const bars = generateSMACrossoverBars(totalBars);
      const result = backtester.walkForward({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
        inSampleRatio: 0.6,
      });

      expect(result.inSample.barCount + result.outOfSample.barCount).toBe(totalBars);
    });
  });

  // ── Parameter optimization ──────────────────────────────

  describe('parameter optimization', () => {
    it('finds params with better or equal Sharpe than defaults', () => {
      const bars = generateSMACrossoverBars(200);

      const defaultResult = backtester.run({
        strategy: 'sma_crossover',
        bars,
        params: { shortPeriod: 10, longPeriod: 30 },
        initialCapital: 10000,
        commissionRate: 0.001,
      });

      const optimized = backtester.optimize({
        strategy: 'sma_crossover',
        bars,
        paramGrid: {
          shortPeriod: [5, 10, 15],
          longPeriod: [20, 30, 40],
        },
        initialCapital: 10000,
        commissionRate: 0.001,
        metric: 'sharpeRatio',
      });

      expect(optimized).toBeDefined();
      expect(optimized.bestParams).toBeDefined();
      expect(optimized.bestMetric).toBeTypeOf('number');
      expect(optimized.bestMetric).toBeGreaterThanOrEqual(
        defaultResult.metrics.sharpeRatio
      );
    });

    it('returns all parameter combination results', () => {
      const bars = generateSMACrossoverBars(100);
      const optimized = backtester.optimize({
        strategy: 'sma_crossover',
        bars,
        paramGrid: {
          shortPeriod: [5, 10],
          longPeriod: [20, 30],
        },
        initialCapital: 10000,
        commissionRate: 0.001,
        metric: 'sharpeRatio',
      });

      // 2 x 2 = 4 combinations
      expect(optimized.allResults).toHaveLength(4);
      for (const r of optimized.allResults) {
        expect(r.params).toBeDefined();
        expect(r.metric).toBeTypeOf('number');
      }
    });

    it('best params are included in allResults', () => {
      const bars = generateSMACrossoverBars(150);
      const optimized = backtester.optimize({
        strategy: 'sma_crossover',
        bars,
        paramGrid: {
          shortPeriod: [5, 10, 15],
          longPeriod: [20, 30],
        },
        initialCapital: 10000,
        commissionRate: 0.001,
        metric: 'sharpeRatio',
      });

      const bestInAll = optimized.allResults.find(
        (r: any) => JSON.stringify(r.params) === JSON.stringify(optimized.bestParams)
      );
      expect(bestInAll).toBeDefined();
      expect(bestInAll.metric).toBe(optimized.bestMetric);
    });
  });
});
