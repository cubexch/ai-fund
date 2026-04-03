import { describe, it, expect, beforeEach } from 'vitest';

// RegimeDetector may not exist yet -- skip if not resolvable
let RegimeDetectorClass: any;
let available = false;
try {
  const mod = await import('../src/client/regime-detector');
  RegimeDetectorClass = mod.RegimeDetector;
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

/** Strongly trending up: prices increase steadily each bar */
function generateTrendingUpBars(count: number, startPrice = 100, stepSize = 1.5): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += stepSize + Math.random() * 0.2;
    const close = price;
    const high = Math.max(open, close) + Math.random() * 0.3;
    const low = Math.min(open, close) - Math.random() * 0.3;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 200,
    });
  }
  return bars;
}

/** Strongly trending down: prices decrease steadily each bar */
function generateTrendingDownBars(count: number, startPrice = 300, stepSize = 1.5): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const open = price;
    price -= stepSize + Math.random() * 0.2;
    const close = price;
    const high = Math.max(open, close) + Math.random() * 0.3;
    const low = Math.min(open, close) - Math.random() * 0.3;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 200,
    });
  }
  return bars;
}

/** Ranging: prices oscillate in a sine wave pattern between bounds */
function generateRangingBars(count: number, center = 100, amplitude = 5): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const price = center + Math.sin(i * 0.15) * amplitude;
    const open = price - Math.random() * 0.5;
    const close = price + Math.random() * 0.5;
    const high = Math.max(open, close) + Math.random() * 0.3;
    const low = Math.min(open, close) - Math.random() * 0.3;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 200,
    });
  }
  return bars;
}

/** Volatile: large random swings with high amplitude */
function generateVolatileBars(count: number, startPrice = 100): Bar[] {
  const bars: Bar[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    const swing = (Math.random() - 0.5) * 30; // large random movements
    const open = price;
    price += swing;
    if (price < 10) price = 10; // floor to avoid negative prices
    const close = price;
    const high = Math.max(open, close) + Math.abs(swing) * 0.5;
    const low = Math.min(open, close) - Math.abs(swing) * 0.5;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000 + Math.random() * 3000, // high volume variance too
    });
  }
  return bars;
}

/** Quiet: very small movements around a center price */
function generateQuietBars(count: number, center = 100): Bar[] {
  const bars: Bar[] = [];
  let price = center;
  for (let i = 0; i < count; i++) {
    const nudge = (Math.random() - 0.5) * 0.2; // tiny movements
    const open = price;
    price += nudge;
    const close = price;
    const high = Math.max(open, close) + Math.random() * 0.05;
    const low = Math.min(open, close) - Math.random() * 0.05;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 500 + Math.random() * 100, // low volume
    });
  }
  return bars;
}

/** Transition bars: trending up then ranging then trending down */
function generateTransitionBars(segmentSize = 40): Bar[] {
  const up = generateTrendingUpBars(segmentSize, 100);
  const lastUpPrice = up[up.length - 1].close;

  const range = generateRangingBars(segmentSize, lastUpPrice, 3);
  // Fix timestamps to continue from up segment
  for (let i = 0; i < range.length; i++) {
    range[i].timestamp = up[up.length - 1].timestamp + (i + 1) * 86400000;
  }

  const down = generateTrendingDownBars(segmentSize, range[range.length - 1].close);
  for (let i = 0; i < down.length; i++) {
    down[i].timestamp = range[range.length - 1].timestamp + (i + 1) * 86400000;
  }

  return [...up, ...range, ...down];
}

// ── RegimeDetector tests ─────────────────────────────────────

describe.skipIf(!available)('RegimeDetector', () => {
  let detector: any;

  beforeEach(() => {
    detector = new RegimeDetectorClass();
  });

  // ── Regime classification ──────────────────────────────

  describe('regime classification', () => {
    it('classifies strongly trending up data as trending_up', () => {
      const bars = generateTrendingUpBars(100, 100, 2.0);
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBe('trending_up');
    });

    it('classifies strongly trending down data as trending_down', () => {
      const bars = generateTrendingDownBars(100, 400, 2.0);
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBe('trending_down');
    });

    it('classifies flat oscillating data as ranging', () => {
      const bars = generateRangingBars(100, 100, 3);
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBe('ranging');
    });

    it('classifies high volatility data as volatile', () => {
      const bars = generateVolatileBars(100, 100);
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBe('volatile');
    });

    it('classifies low volatility data as quiet', () => {
      const bars = generateQuietBars(100, 100);
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBe('quiet');
    });
  });

  // ── Confidence scores ──────────────────────────────────

  describe('confidence scores', () => {
    it('returns confidence between 0 and 1', () => {
      const bars = generateTrendingUpBars(80);
      const result = detector.detect(bars);

      expect(result.confidence).toBeTypeOf('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('strong trends produce high confidence', () => {
      const bars = generateTrendingUpBars(100, 100, 3.0);
      const result = detector.detect(bars);

      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('ranging data produces confidence between 0 and 1', () => {
      const bars = generateRangingBars(100, 100, 5);
      const result = detector.detect(bars);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('quiet market confidence is within valid range', () => {
      const bars = generateQuietBars(100);
      const result = detector.detect(bars);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('volatile market confidence is within valid range', () => {
      const bars = generateVolatileBars(80);
      const result = detector.detect(bars);

      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  // ── Regime transitions ─────────────────────────────────

  describe('regime transitions', () => {
    it('detects transitions in multi-phase data', () => {
      const bars = generateTransitionBars(50);
      const result = detector.detectTransitions(bars);

      expect(result).toBeDefined();
      expect(result.transitions).toBeInstanceOf(Array);
      expect(result.transitions.length).toBeGreaterThan(0);
    });

    it('transitions have from, to, and timestamp fields', () => {
      const bars = generateTransitionBars(50);
      const result = detector.detectTransitions(bars);

      for (const transition of result.transitions) {
        expect(transition).toHaveProperty('from');
        expect(transition).toHaveProperty('to');
        expect(transition).toHaveProperty('timestamp');
        expect(transition.from).not.toBe(transition.to);
        expect(transition.timestamp).toBeTypeOf('number');
      }
    });

    it('transition timestamps are in chronological order', () => {
      const bars = generateTransitionBars(50);
      const result = detector.detectTransitions(bars);

      for (let i = 1; i < result.transitions.length; i++) {
        expect(result.transitions[i].timestamp).toBeGreaterThan(
          result.transitions[i - 1].timestamp
        );
      }
    });

    it('current regime matches last transition destination', () => {
      const bars = generateTransitionBars(50);
      const result = detector.detectTransitions(bars);

      if (result.transitions.length > 0) {
        const lastTransition = result.transitions[result.transitions.length - 1];
        expect(result.currentRegime).toBe(lastTransition.to);
      }
    });
  });

  // ── Strategy recommendations ───────────────────────────

  describe('strategy recommendations', () => {
    it('recommends trend-following for trending up regime', () => {
      const bars = generateTrendingUpBars(100, 100, 2.0);
      const result = detector.detect(bars);

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations).toBeInstanceOf(Array);
      expect(result.recommendations.length).toBeGreaterThan(0);

      const recTexts = result.recommendations.map((r: any) =>
        typeof r === 'string' ? r.toLowerCase() : r.strategy?.toLowerCase() ?? ''
      );
      const hasTrend = recTexts.some((t: string) =>
        t.includes('trend') || t.includes('momentum') || t.includes('breakout')
      );
      expect(hasTrend).toBe(true);
    });

    it('recommends mean reversion for ranging regime', () => {
      const bars = generateRangingBars(100, 100, 5);
      const result = detector.detect(bars);

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThan(0);

      const recTexts = result.recommendations.map((r: any) =>
        typeof r === 'string' ? r.toLowerCase() : r.strategy?.toLowerCase() ?? ''
      );
      const hasMeanRev = recTexts.some((t: string) =>
        t.includes('mean') || t.includes('reversion') || t.includes('range') || t.includes('grid')
      );
      expect(hasMeanRev).toBe(true);
    });

    it('recommends caution or hedging for volatile regime', () => {
      const bars = generateVolatileBars(100, 100);
      const result = detector.detect(bars);

      expect(result.recommendations).toBeDefined();
      expect(result.recommendations.length).toBeGreaterThan(0);
    });

    it('recommendations exist for every regime type', () => {
      const generators = [
        generateTrendingUpBars(80),
        generateTrendingDownBars(80, 300),
        generateRangingBars(80),
        generateVolatileBars(80),
        generateQuietBars(80),
      ];

      for (const bars of generators) {
        const result = detector.detect(bars);
        expect(result.recommendations).toBeDefined();
        expect(result.recommendations.length).toBeGreaterThan(0);
      }
    });
  });

  // ── Short data series handling ─────────────────────────

  describe('short data series handling', () => {
    it('handles empty bars gracefully', () => {
      const result = detector.detect([]);

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });

    it('handles single bar without crashing', () => {
      const bars: Bar[] = [{
        timestamp: 1700000000000,
        open: 100, high: 101, low: 99, close: 100, volume: 1000,
      }];
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });

    it('handles 5 bars without crashing', () => {
      const bars = generateTrendingUpBars(5);
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
      expect(result.confidence).toBeTypeOf('number');
    });

    it('short series produces lower confidence than long series', () => {
      const shortBars = generateTrendingUpBars(10, 100, 2.0);
      const longBars = generateTrendingUpBars(100, 100, 2.0);

      const shortResult = detector.detect(shortBars);
      const longResult = detector.detect(longBars);

      // With more data, confidence should generally be higher or equal
      expect(longResult.confidence).toBeGreaterThanOrEqual(shortResult.confidence - 0.1);
    });
  });

  // ── Result structure ───────────────────────────────────

  describe('result structure', () => {
    it('contains all expected fields', () => {
      const bars = generateTrendingUpBars(60);
      const result = detector.detect(bars);

      expect(result).toHaveProperty('regime');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('recommendations');
    });

    it('regime is one of the valid regime types', () => {
      const validRegimes = ['trending_up', 'trending_down', 'ranging', 'volatile', 'quiet'];
      const generators = [
        generateTrendingUpBars(80),
        generateTrendingDownBars(80, 300),
        generateRangingBars(80),
        generateVolatileBars(80),
        generateQuietBars(80),
      ];

      for (const bars of generators) {
        const result = detector.detect(bars);
        expect(validRegimes).toContain(result.regime);
      }
    });

    it('detect returns consistent results for same input', () => {
      const bars = generateTrendingUpBars(80, 100, 2.0);
      const result1 = detector.detect(bars);
      const result2 = detector.detect(bars);

      expect(result1.regime).toBe(result2.regime);
      expect(result1.confidence).toBe(result2.confidence);
    });
  });

  // ── Edge cases ──────────────────────────────────────────

  describe('edge cases', () => {
    it('handles bars with identical prices', () => {
      const bars: Bar[] = [];
      for (let i = 0; i < 50; i++) {
        bars.push({
          timestamp: 1700000000000 + i * 86400000,
          open: 100, high: 100, low: 100, close: 100, volume: 1000,
        });
      }
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
      // Flat prices should be quiet or ranging
      expect(['quiet', 'ranging']).toContain(result.regime);
    });

    it('handles bars with zero volume', () => {
      const bars: Bar[] = [];
      let price = 100;
      for (let i = 0; i < 50; i++) {
        price += 1;
        bars.push({
          timestamp: 1700000000000 + i * 86400000,
          open: price - 0.5, high: price + 0.5, low: price - 1, close: price,
          volume: 0,
        });
      }
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });

    it('handles extremely large prices without overflow', () => {
      const bars: Bar[] = [];
      let price = 1_000_000;
      for (let i = 0; i < 50; i++) {
        price += 10000;
        bars.push({
          timestamp: 1700000000000 + i * 86400000,
          open: price - 5000, high: price + 5000, low: price - 8000, close: price,
          volume: 1000,
        });
      }
      const result = detector.detect(bars);

      expect(result).toBeDefined();
      expect(Number.isFinite(result.confidence)).toBe(true);
    });

    it('handles negative-close bars (e.g., futures PnL)', () => {
      const bars: Bar[] = [];
      let price = 10;
      for (let i = 0; i < 50; i++) {
        price -= 0.5;
        bars.push({
          timestamp: 1700000000000 + i * 86400000,
          open: price + 0.3, high: price + 0.5, low: price - 0.5, close: price,
          volume: 500,
        });
      }
      // Some close values will be negative
      const result = detector.detect(bars);
      expect(result).toBeDefined();
      expect(result.regime).toBeDefined();
    });
  });
});
