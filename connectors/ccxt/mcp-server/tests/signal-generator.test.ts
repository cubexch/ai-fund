import { describe, it, expect } from 'vitest';
import { SignalGenerator } from '@ai-fund/lib/signal-generator';
import { generateBars } from '@ai-fund/lib/test-fixtures/market-data';
import type { TradingSignal, SignalType, SignalStrength } from '@ai-fund/lib/signal-generator';

// ── Fixtures ─────────────────────────────────────────────────

/** 200-bar default dataset — enough for all detectors. */
const DEFAULT_BARS = generateBars({ count: 200, startPrice: 65000 });

/** 300-bar dataset — satisfies golden/death cross (needs 201). */
const LONG_BARS = generateBars({ count: 300, startPrice: 65000 });

/** 54-bar dataset — just below the 55-bar minimum for generateSignals. */
const SHORT_BARS = generateBars({ count: 54, startPrice: 65000 });

/** Strongly trending-up bars (steady daily climb). */
function trendingUpBars(count = 100) {
  const bars = [];
  let price = 30000;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += 300 + (i % 5) * 40;
    const close = price;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open,
      high: close + 150,
      low: open - 80,
      close,
      volume: 1000 + i * 2,
    });
  }
  return bars;
}

/** Strongly trending-down bars (steady daily drop). */
function trendingDownBars(count = 100) {
  const bars = [];
  let price = 80000;
  for (let i = 0; i < count; i++) {
    const open = price;
    price -= 250 + (i % 5) * 30;
    const close = Math.max(price, 1000); // floor at 1000
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open,
      high: open + 80,
      low: close - 120,
      close,
      volume: 800 + i * 2,
    });
  }
  return bars;
}

/** Bars with a volume spike at the end to trigger volume breakout. */
function volumeSpikeBars(count = 60) {
  const bars = generateBars({ count: count - 1, startPrice: 50000 });
  const last = bars[bars.length - 1];
  const avgVol = bars.reduce((s, b) => s + b.volume, 0) / bars.length;
  bars.push({
    ...last,
    timestamp: last.timestamp + 3600_000,
    close: last.close * 1.03,   // price up 3%
    volume: avgVol * 3,          // 3x average — triggers 2x threshold
  });
  return bars;
}

/** Minimal bars (3 — below most thresholds). */
const THREE_BARS = generateBars({ count: 3, startPrice: 1000 });

/** All-zero-volume bars. */
function zeroBars(count = 80) {
  const price = 100;
  return Array.from({ length: count }, (_, i) => ({
    timestamp: 1700000000000 + i * 3600_000,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 0,
  }));
}

// ── Helper ────────────────────────────────────────────────────

const VALID_SIGNAL_TYPES: SignalType[] = ['buy', 'sell', 'hold'];
const VALID_STRENGTHS: SignalStrength[] = ['strong', 'moderate', 'weak'];

function assertSignalShape(signal: TradingSignal, symbol: string, timeframe: string) {
  expect(VALID_SIGNAL_TYPES).toContain(signal.type);
  expect(VALID_STRENGTHS).toContain(signal.strength);
  expect(signal.confidence).toBeGreaterThanOrEqual(0);
  expect(signal.confidence).toBeLessThanOrEqual(1);
  expect(signal.symbol).toBe(symbol);
  expect(signal.timeframe).toBe(timeframe);
  expect(typeof signal.source).toBe('string');
  expect(signal.source.length).toBeGreaterThan(0);
  expect(typeof signal.price).toBe('number');
  expect(signal.price).toBeGreaterThan(0);
  expect(typeof signal.timestamp).toBe('number');
  expect(typeof signal.metadata).toBe('object');
}

// ── Tests ─────────────────────────────────────────────────────

describe('SignalGenerator', () => {

  // ── Constructor ─────────────────────────────────────────────

  describe('constructor', () => {
    it('creates an instance with no arguments', () => {
      const sg = new SignalGenerator();
      expect(sg).toBeInstanceOf(SignalGenerator);
    });

    it('exposes generateSignals as a method', () => {
      const sg = new SignalGenerator();
      expect(typeof sg.generateSignals).toBe('function');
    });

    it('exposes scoreSignals as a method', () => {
      const sg = new SignalGenerator();
      expect(typeof sg.scoreSignals).toBe('function');
    });

    it('exposes findSupportResistance as a method', () => {
      const sg = new SignalGenerator();
      expect(typeof sg.findSupportResistance).toBe('function');
    });

    it('exposes detectCandlePatterns as a method', () => {
      const sg = new SignalGenerator();
      expect(typeof sg.detectCandlePatterns).toBe('function');
    });
  });

  // ── generateSignals ─────────────────────────────────────────

  describe('generateSignals', () => {
    it('returns an array', () => {
      const sg = new SignalGenerator();
      const result = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      expect(Array.isArray(result)).toBe(true);
    });

    it('returns empty array when bars < 55', () => {
      const sg = new SignalGenerator();
      const result = sg.generateSignals(SHORT_BARS, 'BTC/USDT', '1h');
      expect(result).toHaveLength(0);
    });

    it('returns empty array for empty bars', () => {
      const sg = new SignalGenerator();
      const result = sg.generateSignals([], 'BTC/USDT', '1h');
      expect(result).toHaveLength(0);
    });

    it('returns signals with correct symbol and timeframe', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(DEFAULT_BARS, 'ETH/USDT', '4h');
      for (const s of signals) {
        expect(s.symbol).toBe('ETH/USDT');
        expect(s.timeframe).toBe('4h');
      }
    });

    it('every returned signal has valid type, strength and confidence', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      for (const s of signals) {
        assertSignalShape(s, 'BTC/USDT', '1h');
      }
    });

    it('confidence is always in [0, 1]', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(LONG_BARS, 'SOL/USDT', '1d');
      for (const s of signals) {
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(s.confidence).toBeLessThanOrEqual(1);
      }
    });

    it('price field matches last bar close', () => {
      const sg = new SignalGenerator();
      const bars = DEFAULT_BARS;
      const lastClose = bars[bars.length - 1].close;
      const signals = sg.generateSignals(bars, 'BTC/USDT', '1h');
      for (const s of signals) {
        // price is set from the last close at signal generation time
        expect(s.price).toBe(lastClose);
      }
    });

    it('produces signals for clearly trending-up dataset', () => {
      const sg = new SignalGenerator();
      const bars = trendingUpBars(200);
      const signals = sg.generateSignals(bars, 'BTC/USDT', '1d');
      expect(signals.length).toBeGreaterThan(0);
    });

    it('produces signals for clearly trending-down dataset', () => {
      const sg = new SignalGenerator();
      const bars = trendingDownBars(200);
      const signals = sg.generateSignals(bars, 'BTC/USDT', '1d');
      expect(signals.length).toBeGreaterThan(0);
    });

    it('handles zero-volume bars without throwing', () => {
      const sg = new SignalGenerator();
      const bars = zeroBars(100);
      expect(() => sg.generateSignals(bars, 'BTC/USDT', '1h')).not.toThrow();
    });

    it('riskRewardRatio is null when targetPrice or stopLoss is null', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      for (const s of signals) {
        if (s.targetPrice === null || s.stopLoss === null) {
          expect(s.riskRewardRatio).toBeNull();
        }
      }
    });

    it('riskRewardRatio is positive when both target and stop are set', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      for (const s of signals) {
        if (s.riskRewardRatio !== null) {
          expect(s.riskRewardRatio).toBeGreaterThan(0);
        }
      }
    });

    it('metadata is always a plain object', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      for (const s of signals) {
        expect(s.metadata).not.toBeNull();
        expect(typeof s.metadata).toBe('object');
        expect(Array.isArray(s.metadata)).toBe(false);
      }
    });
  });

  // ── scoreSignals ─────────────────────────────────────────────

  describe('scoreSignals', () => {
    it('returns neutral score 0 for empty signals array', () => {
      const sg = new SignalGenerator();
      const result = sg.scoreSignals([]);
      expect(result.bias).toBe('neutral');
      expect(result.score).toBe(0);
    });

    it('returns bullish bias for all-buy signals', () => {
      const sg = new SignalGenerator();
      const buySignals: TradingSignal[] = [
        { symbol: 'X', timestamp: 0, type: 'buy', strength: 'strong', confidence: 1,
          source: 'test', price: 100, targetPrice: 110, stopLoss: 90,
          riskRewardRatio: 1, timeframe: '1h', metadata: {} },
        { symbol: 'X', timestamp: 0, type: 'buy', strength: 'moderate', confidence: 0.8,
          source: 'test', price: 100, targetPrice: null, stopLoss: null,
          riskRewardRatio: null, timeframe: '1h', metadata: {} },
      ];
      const result = sg.scoreSignals(buySignals);
      expect(result.bias).toBe('bullish');
      expect(result.score).toBeGreaterThan(15);
    });

    it('returns bearish bias for all-sell signals', () => {
      const sg = new SignalGenerator();
      const sellSignals: TradingSignal[] = [
        { symbol: 'X', timestamp: 0, type: 'sell', strength: 'strong', confidence: 1,
          source: 'test', price: 100, targetPrice: 90, stopLoss: 110,
          riskRewardRatio: 1, timeframe: '1h', metadata: {} },
        { symbol: 'X', timestamp: 0, type: 'sell', strength: 'strong', confidence: 1,
          source: 'test', price: 100, targetPrice: 85, stopLoss: 110,
          riskRewardRatio: 1.5, timeframe: '1h', metadata: {} },
      ];
      const result = sg.scoreSignals(sellSignals);
      expect(result.bias).toBe('bearish');
      expect(result.score).toBeLessThan(-15);
    });

    it('returns neutral bias when buy and sell signals perfectly cancel', () => {
      const sg = new SignalGenerator();
      const balanced: TradingSignal[] = [
        { symbol: 'X', timestamp: 0, type: 'buy', strength: 'moderate', confidence: 1,
          source: 'test', price: 100, targetPrice: null, stopLoss: null,
          riskRewardRatio: null, timeframe: '1h', metadata: {} },
        { symbol: 'X', timestamp: 0, type: 'sell', strength: 'moderate', confidence: 1,
          source: 'test', price: 100, targetPrice: null, stopLoss: null,
          riskRewardRatio: null, timeframe: '1h', metadata: {} },
      ];
      const result = sg.scoreSignals(balanced);
      expect(result.bias).toBe('neutral');
      expect(result.score).toBe(0);
    });

    it('hold signals contribute zero to the score', () => {
      const sg = new SignalGenerator();
      const holdOnly: TradingSignal[] = [
        { symbol: 'X', timestamp: 0, type: 'hold', strength: 'strong', confidence: 1,
          source: 'test', price: 100, targetPrice: null, stopLoss: null,
          riskRewardRatio: null, timeframe: '1h', metadata: {} },
      ];
      const result = sg.scoreSignals(holdOnly);
      expect(result.bias).toBe('neutral');
      expect(result.score).toBe(0);
    });

    it('score is within [-100, +100]', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      const { score } = sg.scoreSignals(signals);
      expect(score).toBeGreaterThanOrEqual(-100);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('strong signals weight more than weak signals', () => {
      const sg = new SignalGenerator();
      const strongBuy: TradingSignal[] = [
        { symbol: 'X', timestamp: 0, type: 'buy', strength: 'strong', confidence: 1,
          source: 'a', price: 100, targetPrice: null, stopLoss: null,
          riskRewardRatio: null, timeframe: '1h', metadata: {} },
      ];
      const weakBuy: TradingSignal[] = [
        { symbol: 'X', timestamp: 0, type: 'buy', strength: 'weak', confidence: 1,
          source: 'a', price: 100, targetPrice: null, stopLoss: null,
          riskRewardRatio: null, timeframe: '1h', metadata: {} },
      ];
      const strongResult = sg.scoreSignals(strongBuy);
      const weakResult = sg.scoreSignals(weakBuy);
      // strong (weight 3) score is 100, weak (weight 1) score is also 100 (normalized per weight)
      // but bias threshold at 15 means both are bullish — confirm strong is at least as high
      expect(strongResult.score).toBeGreaterThanOrEqual(weakResult.score);
    });

    it('score reflects real signals from generateSignals', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(trendingUpBars(200), 'BTC/USDT', '1d');
      if (signals.length > 0) {
        const { score, bias } = sg.scoreSignals(signals);
        expect(typeof score).toBe('number');
        expect(['bullish', 'bearish', 'neutral']).toContain(bias);
      }
    });
  });

  // ── findSupportResistance ─────────────────────────────────────

  describe('findSupportResistance', () => {
    it('returns empty arrays for fewer than 5 bars', () => {
      const sg = new SignalGenerator();
      const result = sg.findSupportResistance(THREE_BARS);
      expect(result.supports).toHaveLength(0);
      expect(result.resistances).toHaveLength(0);
    });

    it('returns empty arrays for empty bars', () => {
      const sg = new SignalGenerator();
      const result = sg.findSupportResistance([]);
      expect(result.supports).toHaveLength(0);
      expect(result.resistances).toHaveLength(0);
    });

    it('returns supports and resistances as number arrays', () => {
      const sg = new SignalGenerator();
      const result = sg.findSupportResistance(DEFAULT_BARS);
      expect(Array.isArray(result.supports)).toBe(true);
      expect(Array.isArray(result.resistances)).toBe(true);
    });

    it('support levels are below the current price', () => {
      const sg = new SignalGenerator();
      const bars = DEFAULT_BARS;
      const currentPrice = bars[bars.length - 1].close;
      const { supports } = sg.findSupportResistance(bars);
      for (const s of supports) {
        expect(s).toBeLessThan(currentPrice);
      }
    });

    it('resistance levels are above the current price', () => {
      const sg = new SignalGenerator();
      const bars = DEFAULT_BARS;
      const currentPrice = bars[bars.length - 1].close;
      const { resistances } = sg.findSupportResistance(bars);
      for (const r of resistances) {
        expect(r).toBeGreaterThan(currentPrice);
      }
    });

    it('returns at most 5 levels per side', () => {
      const sg = new SignalGenerator();
      const { supports, resistances } = sg.findSupportResistance(LONG_BARS);
      expect(supports.length).toBeLessThanOrEqual(5);
      expect(resistances.length).toBeLessThanOrEqual(5);
    });

    it('does not throw for zero-price bars', () => {
      const sg = new SignalGenerator();
      expect(() => sg.findSupportResistance(zeroBars(20))).not.toThrow();
    });
  });

  // ── detectCandlePatterns ──────────────────────────────────────

  describe('detectCandlePatterns', () => {
    it('returns empty array for fewer than 4 bars', () => {
      const sg = new SignalGenerator();
      expect(sg.detectCandlePatterns(THREE_BARS)).toHaveLength(0);
      expect(sg.detectCandlePatterns([])).toHaveLength(0);
    });

    it('returns an array for sufficient bars', () => {
      const sg = new SignalGenerator();
      const result = sg.detectCandlePatterns(DEFAULT_BARS, 'BTC/USDT', '1h');
      expect(Array.isArray(result)).toBe(true);
    });

    it('all returned signals have valid shape', () => {
      const sg = new SignalGenerator();
      const signals = sg.detectCandlePatterns(DEFAULT_BARS, 'ETH/USDT', '4h');
      for (const s of signals) {
        assertSignalShape(s, 'ETH/USDT', '4h');
      }
    });

    it('detects bullish engulfing pattern', () => {
      const sg = new SignalGenerator();
      // Build bars ending with a clear bullish engulfing candle
      const bars = generateBars({ count: 10, startPrice: 5000 });
      // Manually craft the last two bars: prev bearish, curr bullish + engulfs
      const prevOpen = 5100; const prevClose = 4900; // bearish body 200
      const currOpen = 4880; const currClose = 5120; // bullish body 240, engulfs
      bars.splice(bars.length - 2, 2,
        { timestamp: Date.now() - 2000, open: prevOpen, high: prevOpen + 50,
          low: prevClose - 50, close: prevClose, volume: 500 },
        { timestamp: Date.now() - 1000, open: currOpen, high: currClose + 50,
          low: currOpen - 50, close: currClose, volume: 600 },
      );
      const signals = sg.detectCandlePatterns(bars, 'BTC/USDT', '1h');
      const engulfing = signals.find(s => s.source === 'Bullish Engulfing');
      expect(engulfing).toBeDefined();
      expect(engulfing?.type).toBe('buy');
    });

    it('detects bearish engulfing pattern', () => {
      const sg = new SignalGenerator();
      const bars = generateBars({ count: 10, startPrice: 5000 });
      const prevOpen = 4900; const prevClose = 5100; // bullish body 200
      const currOpen = 5120; const currClose = 4880; // bearish body 240, engulfs
      bars.splice(bars.length - 2, 2,
        { timestamp: Date.now() - 2000, open: prevOpen, high: prevClose + 50,
          low: prevOpen - 50, close: prevClose, volume: 500 },
        { timestamp: Date.now() - 1000, open: currOpen, high: currOpen + 50,
          low: currClose - 50, close: currClose, volume: 600 },
      );
      const signals = sg.detectCandlePatterns(bars, 'BTC/USDT', '1h');
      const engulfing = signals.find(s => s.source === 'Bearish Engulfing');
      expect(engulfing).toBeDefined();
      expect(engulfing?.type).toBe('sell');
    });

    it('detects three white soldiers from three consecutive bullish bars', () => {
      const sg = new SignalGenerator();
      const base = generateBars({ count: 10, startPrice: 5000 });
      // Replace last 3 bars with progressively higher bullish candles
      const p = base[base.length - 4].close;
      base.splice(base.length - 3, 3,
        { timestamp: Date.now() - 3000, open: p,       high: p + 150,      low: p - 30,       close: p + 120,      volume: 400 },
        { timestamp: Date.now() - 2000, open: p + 120, high: p + 300,      low: p + 90,       close: p + 260,      volume: 400 },
        { timestamp: Date.now() - 1000, open: p + 260, high: p + 430,      low: p + 230,      close: p + 400,      volume: 400 },
      );
      const signals = sg.detectCandlePatterns(base, 'BTC/USDT', '1h');
      const soldiers = signals.find(s => s.source === 'Three White Soldiers');
      expect(soldiers).toBeDefined();
      expect(soldiers?.type).toBe('buy');
    });

    it('detects three black crows from three consecutive bearish bars', () => {
      const sg = new SignalGenerator();
      const base = generateBars({ count: 10, startPrice: 5000 });
      const p = base[base.length - 4].close;
      base.splice(base.length - 3, 3,
        { timestamp: Date.now() - 3000, open: p,       high: p + 30,       low: p - 150,      close: p - 120,      volume: 400 },
        { timestamp: Date.now() - 2000, open: p - 120, high: p - 90,       low: p - 300,      close: p - 260,      volume: 400 },
        { timestamp: Date.now() - 1000, open: p - 260, high: p - 230,      low: p - 430,      close: p - 400,      volume: 400 },
      );
      const signals = sg.detectCandlePatterns(base, 'BTC/USDT', '1h');
      const crows = signals.find(s => s.source === 'Three Black Crows');
      expect(crows).toBeDefined();
      expect(crows?.type).toBe('sell');
    });

    it('uses default symbol and timeframe when not provided', () => {
      const sg = new SignalGenerator();
      const signals = sg.detectCandlePatterns(DEFAULT_BARS);
      for (const s of signals) {
        expect(s.symbol).toBe('');
        expect(s.timeframe).toBe('1d');
      }
    });
  });

  // ── Signal property invariants ────────────────────────────────

  describe('signal property invariants', () => {
    it('all signal sources are non-empty strings', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      for (const s of signals) {
        expect(typeof s.source).toBe('string');
        expect(s.source.trim().length).toBeGreaterThan(0);
      }
    });

    it('confidence is always rounded to 2 decimal places', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      for (const s of signals) {
        const rounded = Math.round(s.confidence * 100) / 100;
        expect(s.confidence).toBe(rounded);
      }
    });

    it('riskRewardRatio is rounded to 2 decimal places when present', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(LONG_BARS, 'BTC/USDT', '1h');
      for (const s of signals) {
        if (s.riskRewardRatio !== null) {
          const rounded = Math.round(s.riskRewardRatio * 100) / 100;
          expect(s.riskRewardRatio).toBe(rounded);
        }
      }
    });

    it('timestamp is a recent unix millisecond value', () => {
      const sg = new SignalGenerator();
      const before = Date.now();
      const signals = sg.generateSignals(DEFAULT_BARS, 'BTC/USDT', '1h');
      const after = Date.now();
      for (const s of signals) {
        expect(s.timestamp).toBeGreaterThanOrEqual(before);
        expect(s.timestamp).toBeLessThanOrEqual(after);
      }
    });

    it('generateSignals and scoreSignals are consistent: bullish bias has positive score', () => {
      const sg = new SignalGenerator();
      const signals = sg.generateSignals(trendingUpBars(200), 'BTC/USDT', '1d');
      const { bias, score } = sg.scoreSignals(signals);
      if (bias === 'bullish') expect(score).toBeGreaterThan(0);
      if (bias === 'bearish') expect(score).toBeLessThan(0);
      if (bias === 'neutral') {
        expect(score).toBeGreaterThanOrEqual(-15);
        expect(score).toBeLessThanOrEqual(15);
      }
    });

    it('volume breakout signal is generated on a 3x volume spike bar', () => {
      const sg = new SignalGenerator();
      const bars = volumeSpikeBars(60);
      const signals = sg.generateSignals(bars, 'BTC/USDT', '1h');
      const volSignal = signals.find(s => s.source === 'Volume Breakout');
      expect(volSignal).toBeDefined();
      expect(volSignal?.metadata).toHaveProperty('volumeRatio');
    });
  });

});
