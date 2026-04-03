import { describe, it, expect } from 'vitest';
import { registerRegimeTools } from '../src/tools/regime';
import { createMockClient, MockMcpServer } from './helpers';
import { generateBars, TICKERS } from '@ai-fund/lib/test-fixtures/market-data';

// ── Fixtures ─────────────────────────────────────────────────

/** 250-bar BTC trending dataset used by single-symbol tools. */
const DEFAULT_BARS = generateBars({ count: 250, startPrice: 65000 });

/** Strongly trending-up bars: steady price increase for reliable regime detection. */
function trendingUpBars(count = 120): ReturnType<typeof generateBars> {
  const bars = [];
  let price = 30000;
  for (let i = 0; i < count; i++) {
    const open = price;
    price += 200 + (i % 3) * 50; // steady climb
    const close = price;
    const high = close + 100;
    const low = open - 50;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 1000,
    });
  }
  return bars as ReturnType<typeof generateBars>;
}

/** Ranging bars: oscillating price without net direction. */
function rangingBars(count = 120): ReturnType<typeof generateBars> {
  const bars = [];
  const center = 65000;
  const amplitude = 1500;
  for (let i = 0; i < count; i++) {
    const price = center + Math.sin(i * 0.15) * amplitude;
    const open = price - 200;
    const close = price + 200;
    const high = close + 300;
    const low = open - 300;
    bars.push({
      timestamp: 1700000000000 + i * 86400000,
      open, high, low, close,
      volume: 800,
    });
  }
  return bars as ReturnType<typeof generateBars>;
}

/** Insufficient-data bars (< 50) to trigger threshold errors. */
function shortBars(count = 10): ReturnType<typeof generateBars> {
  return generateBars({ count, startPrice: 65000 });
}

// ── Setup helpers ─────────────────────────────────────────────

function setup(overrides: Parameters<typeof createMockClient>[0] = {}) {
  const client = createMockClient({
    getBars: async () => DEFAULT_BARS,
    getTickers: async () => Object.values(TICKERS),
    ...overrides,
  });
  const server = new MockMcpServer();
  registerRegimeTools(server as any, client);
  return { server, client };
}

// ── detect_market_regime ──────────────────────────────────────

describe('detect_market_regime tool', () => {
  it('returns expected top-level shape', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_market_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.barsAnalyzed).toBe(250);
    expect(data.currentRegime).toBeTypeOf('string');
    expect(data.confidence).toBeTypeOf('number');
    expect(data.confidence).toBeGreaterThanOrEqual(0);
    expect(data.confidence).toBeLessThanOrEqual(1);
  });

  it('currentRegime is one of the valid regime labels', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_market_regime', {
      symbol: 'BTC/USDT',
      timeframe: '4h',
    });

    const data = JSON.parse(result.content[0].text);
    const validRegimes = ['trending_up', 'trending_down', 'ranging', 'volatile', 'quiet', 'breakout'];
    expect(validRegimes).toContain(data.currentRegime);
  });

  it('classifies strongly trending-up data as trending_up', async () => {
    const { server } = setup({ getBars: async () => trendingUpBars(200) });
    const result = await server.callTool('detect_market_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.currentRegime).toBe('trending_up');
    expect(data.confidence).toBeGreaterThan(0.5);
  });

  it('classifies oscillating data as ranging', async () => {
    const { server } = setup({ getBars: async () => rangingBars(200) });
    const result = await server.callTool('detect_market_regime', {
      symbol: 'ETH/USDT',
      timeframe: '1h',
    });

    const data = JSON.parse(result.content[0].text);
    expect(['ranging', 'volatile', 'quiet']).toContain(data.currentRegime);
  });

  it('returns indicator details in the response', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_market_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    // indicators may be nested; we just confirm the key exists and is an object
    expect(data.indicators).toBeDefined();
    expect(typeof data.indicators).toBe('object');
  });

  it('returns transitions array (even if empty)', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_market_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.transitions).toBeInstanceOf(Array);
  });

  it('returns regimeScores object with numeric values', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_market_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.regimeScores).toBeDefined();
    for (const score of Object.values(data.regimeScores as Record<string, number>)) {
      expect(typeof score).toBe('number');
    }
  });

  it('returns isError when bars are insufficient (< 50)', async () => {
    const { server } = setup({ getBars: async () => shortBars(20) });
    const result = await server.callTool('detect_market_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('50');
  });

  it('reflects symbol and timeframe passed in params', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_market_regime', {
      symbol: 'SOL/USDT',
      timeframe: '4h',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('SOL/USDT');
    expect(data.timeframe).toBe('4h');
  });
});

// ── scan_regime_changes ───────────────────────────────────────

describe('scan_regime_changes tool', () => {
  it('returns expected top-level structure', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_regime_changes', {
      symbols: ['BTC/USDT', 'ETH/USDT'],
      timeframe: '1d',
      lookbackBars: 30,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);

    expect(data.timeframe).toBe('1d');
    expect(data.lookbackBars).toBe(30);
    expect(data.symbolsScanned).toBe(2);
    expect(data.symbolsWithChanges).toBeTypeOf('number');
    expect(data.results).toBeInstanceOf(Array);
  });

  it('symbolsWithChanges equals results array length', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_regime_changes', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbolsWithChanges).toBe(data.results.length);
  });

  it('result entries have required fields when changes are present', async () => {
    // Use trending-up data so transitions are likely to appear
    const { server } = setup({ getBars: async () => trendingUpBars(250) });
    const result = await server.callTool('scan_regime_changes', {
      symbols: ['BTC/USDT'],
      timeframe: '1d',
      lookbackBars: 249, // wide window to capture any transition
    });

    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      expect(entry.symbol).toBeTypeOf('string');
      expect(entry.currentRegime).toBeTypeOf('string');
      expect(entry.confidence).toBeTypeOf('number');
      expect(entry.recentTransitions).toBeInstanceOf(Array);
    }
  });

  it('recentTransitions respect the lookback window', async () => {
    const { server } = setup({ getBars: async () => trendingUpBars(250) });
    const lookbackBars = 5;
    const result = await server.callTool('scan_regime_changes', {
      symbols: ['BTC/USDT'],
      timeframe: '1d',
      lookbackBars,
    });

    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      for (const t of entry.recentTransitions) {
        expect(t.barsAgo).toBeLessThanOrEqual(lookbackBars);
      }
    }
  });

  it('handles empty symbols array gracefully', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_regime_changes', {
      symbols: [],
      timeframe: '1d',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.symbolsScanned).toBe(0);
    expect(data.results).toHaveLength(0);
  });

  it('skips symbols that return insufficient bars (< 50) silently', async () => {
    let callCount = 0;
    const { server } = setup({
      getBars: async () => {
        callCount++;
        // First symbol returns short data, second returns enough
        return callCount === 1 ? shortBars(20) : DEFAULT_BARS;
      },
    });

    const result = await server.callTool('scan_regime_changes', {
      symbols: ['BAD/USDT', 'BTC/USDT'],
      timeframe: '1d',
      lookbackBars: 249,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    // symbolsScanned is total passed in, not those with enough data
    expect(data.symbolsScanned).toBe(2);
  });
});

// ── get_regime_history ────────────────────────────────────────

describe('get_regime_history tool', () => {
  it('returns expected top-level shape', async () => {
    const { server } = setup();
    const result = await server.callTool('get_regime_history', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.barsAnalyzed).toBeTypeOf('number');
    expect(data.totalRegimePeriods).toBeTypeOf('number');
    expect(data.summary).toBeDefined();
    expect(data.history).toBeInstanceOf(Array);
  });

  it('history entries contain required fields', async () => {
    const { server } = setup();
    const result = await server.callTool('get_regime_history', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.history.length).toBeGreaterThan(0);

    for (const entry of data.history) {
      expect(entry.regime).toBeTypeOf('string');
      expect(entry.startTimestamp).toBeTypeOf('number');
      expect(entry.endTimestamp).toBeTypeOf('number');
      expect(entry.durationBars).toBeTypeOf('number');
      expect(entry.durationBars).toBeGreaterThan(0);
      expect(entry.confidence).toBeTypeOf('number');
      expect(entry.startTimestamp).toBeLessThanOrEqual(entry.endTimestamp);
    }
  });

  it('summary stats are consistent with history entries', async () => {
    const { server } = setup();
    const result = await server.callTool('get_regime_history', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    // totalRegimePeriods should equal history.length
    expect(data.totalRegimePeriods).toBe(data.history.length);

    // Every regime appearing in history should have a summary entry
    const regimesInHistory = new Set(data.history.map((h: any) => h.regime));
    for (const regime of regimesInHistory) {
      expect(data.summary[regime as string]).toBeDefined();
      expect(data.summary[regime as string].count).toBeGreaterThan(0);
      expect(data.summary[regime as string].avgDurationBars).toBeGreaterThan(0);
      expect(data.summary[regime as string].totalBars).toBeGreaterThan(0);
    }
  });

  it('returns isError when bars are insufficient (< 50)', async () => {
    const { server } = setup({ getBars: async () => shortBars(30) });
    const result = await server.callTool('get_regime_history', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('50');
  });

  it('barsAnalyzed reflects actual bar count returned by client', async () => {
    const customBars = generateBars({ count: 80, startPrice: 65000 });
    const { server } = setup({ getBars: async () => customBars });
    const result = await server.callTool('get_regime_history', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      lookbackBars: 80,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.barsAnalyzed).toBe(80);
  });

  it('history timestamps are in chronological order', async () => {
    const { server } = setup();
    const result = await server.callTool('get_regime_history', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    for (let i = 1; i < data.history.length; i++) {
      expect(data.history[i].startTimestamp).toBeGreaterThanOrEqual(
        data.history[i - 1].startTimestamp
      );
    }
  });
});

// ── match_strategy_to_regime ──────────────────────────────────

describe('match_strategy_to_regime tool', () => {
  it('returns expected top-level shape', async () => {
    const { server } = setup();
    const result = await server.callTool('match_strategy_to_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      riskTolerance: 'moderate',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.riskTolerance).toBe('moderate');
    expect(data.barsAnalyzed).toBe(250);
    expect(data.currentRegime).toBeTypeOf('string');
    expect(data.confidence).toBeTypeOf('number');
  });

  it('recommendation is present and non-empty', async () => {
    const { server } = setup();
    const result = await server.callTool('match_strategy_to_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      riskTolerance: 'moderate',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.recommendation).toBeDefined();
    // recommendation may be a string or an object — either is non-null
    expect(data.recommendation).not.toBeNull();
  });

  it('accepts all three riskTolerance values', async () => {
    const { server } = setup();
    for (const risk of ['conservative', 'moderate', 'aggressive'] as const) {
      const result = await server.callTool('match_strategy_to_regime', {
        symbol: 'BTC/USDT',
        timeframe: '1d',
        riskTolerance: risk,
      });

      expect(result.isError).toBeFalsy();
      const data = JSON.parse(result.content[0].text);
      expect(data.riskTolerance).toBe(risk);
    }
  });

  it('includes indicators and regimeScores in response', async () => {
    const { server } = setup();
    const result = await server.callTool('match_strategy_to_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      riskTolerance: 'aggressive',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.indicators).toBeDefined();
    expect(data.regimeScores).toBeDefined();
  });

  it('returns isError when bars are insufficient (< 50)', async () => {
    const { server } = setup({ getBars: async () => shortBars(25) });
    const result = await server.callTool('match_strategy_to_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      riskTolerance: 'moderate',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('50');
  });

  it('trending-up regime surfaces trend-following recommendation', async () => {
    const { server } = setup({ getBars: async () => trendingUpBars(250) });
    const result = await server.callTool('match_strategy_to_regime', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      riskTolerance: 'moderate',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.currentRegime).toBe('trending_up');

    // recommendation should mention trend/momentum (string or object with strategies array)
    const recStr = JSON.stringify(data.recommendation).toLowerCase();
    expect(
      recStr.includes('trend') || recStr.includes('momentum') || recStr.includes('breakout')
    ).toBe(true);
  });

  it('confidence is a finite number between 0 and 1', async () => {
    const { server } = setup();
    const result = await server.callTool('match_strategy_to_regime', {
      symbol: 'ETH/USDT',
      timeframe: '4h',
      riskTolerance: 'conservative',
    });

    const data = JSON.parse(result.content[0].text);
    expect(Number.isFinite(data.confidence)).toBe(true);
    expect(data.confidence).toBeGreaterThanOrEqual(0);
    expect(data.confidence).toBeLessThanOrEqual(1);
  });
});
