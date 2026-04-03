import { describe, it, expect } from 'vitest';
import { registerScannerTools } from '../src/tools/scanner';
import { createMockClient, MockMcpServer } from './helpers';
import { generateBars, TICKERS, ticker } from '@ai-fund/lib/test-fixtures/market-data';

// ── Setup ─────────────────────────────────────────────────────

const FULL_BARS = generateBars({ count: 250, startPrice: 65000 });
const ETH_FULL_BARS = generateBars({ count: 250, startPrice: 3400 });
const SOL_FULL_BARS = generateBars({ count: 250, startPrice: 175 });

function setup(overrides: Record<string, unknown> = {}) {
  const client = createMockClient({
    getBars: async (symbol: string, _timeframe: string, _since: unknown, _limit: number) => {
      if (symbol === 'ETH/USDT') return ETH_FULL_BARS;
      if (symbol === 'SOL/USDT') return SOL_FULL_BARS;
      return FULL_BARS;
    },
    getTicker: async (symbol: string) => ticker(symbol),
    getTickers: async (symbols: string[]) =>
      symbols.map(s => TICKERS[s] ?? { ...TICKERS['BTC/USDT'], symbol: s }),
    ...overrides,
  } as any);
  const server = new MockMcpServer();
  registerScannerTools(server as any, () => client);
  return { server, client };
}

// ── scan_signals ──────────────────────────────────────────────

describe('scan_signals tool', () => {
  it('returns full signal analysis with expected shape', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_signals', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      limit: 250,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.candlesAnalyzed).toBe(250);
    expect(typeof data.currentPrice).toBe('number');
    expect(data.currentPrice).toBeGreaterThan(0);
    expect(typeof data.overallBias).toBe('string');
    expect(['bullish', 'bearish', 'neutral']).toContain(data.overallBias);
    expect(typeof data.score).toBe('number');
    expect(data.score).toBeGreaterThanOrEqual(-100);
    expect(data.score).toBeLessThanOrEqual(100);
    expect(typeof data.signalCount).toBe('number');
    expect(Array.isArray(data.signals)).toBe(true);
  });

  it('returns topSignal with required fields when signals exist', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_signals', {
      symbol: 'BTC/USDT',
      timeframe: '1h',
    });

    const data = JSON.parse(result.content[0].text);
    if (data.topSignal !== null) {
      expect(data.topSignal).toHaveProperty('source');
      expect(data.topSignal).toHaveProperty('type');
      expect(data.topSignal).toHaveProperty('strength');
      expect(data.topSignal).toHaveProperty('confidence');
      expect(['buy', 'sell', 'hold']).toContain(data.topSignal.type);
      expect(['strong', 'moderate', 'weak']).toContain(data.topSignal.strength);
    }
  });

  it('throws when fewer than 55 candles returned', async () => {
    const { server } = setup({
      getBars: async () => generateBars({ count: 30, startPrice: 65000 }),
    });
    const result = await server.callTool('scan_signals', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('55');
  });

  it('each signal has the required structure', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_signals', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    for (const signal of data.signals) {
      expect(signal).toHaveProperty('source');
      expect(signal).toHaveProperty('type');
      expect(signal).toHaveProperty('strength');
      expect(signal).toHaveProperty('confidence');
      expect(typeof signal.confidence).toBe('number');
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
    }
  });
});

// ── scan_market ───────────────────────────────────────────────

describe('scan_market tool', () => {
  it('scans multiple symbols and returns ranked results', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_market', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
      minScore: 0,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.timeframe).toBe('1d');
    expect(data.scanned).toBe(3);
    expect(typeof data.matched).toBe('number');
    expect(data.matched).toBeLessThanOrEqual(3);
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('results are sorted by absolute score descending', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_market', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
      minScore: 0,
    });

    const data = JSON.parse(result.content[0].text);
    const scores = data.results.map((r: any) => Math.abs(r.score));
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
    }
  });

  it('result entries have expected fields', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_market', {
      symbols: ['BTC/USDT', 'ETH/USDT'],
      timeframe: '1d',
      minScore: 0,
    });

    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      expect(entry).toHaveProperty('symbol');
      expect(entry).toHaveProperty('bias');
      expect(entry).toHaveProperty('score');
      expect(entry).toHaveProperty('signalCount');
      expect(['bullish', 'bearish', 'neutral']).toContain(entry.bias);
    }
  });

  it('filters by minScore threshold', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_market', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
      minScore: 999,
    });

    const data = JSON.parse(result.content[0].text);
    // No symbol should have an absolute score >= 999
    expect(data.matched).toBe(0);
    expect(data.results).toHaveLength(0);
  });

  it('records errors for symbols with insufficient data', async () => {
    const { server } = setup({
      getBars: async (symbol: string) => {
        if (symbol === 'SOL/USDT') return generateBars({ count: 10, startPrice: 175 });
        return FULL_BARS;
      },
    });
    const result = await server.callTool('scan_market', {
      symbols: ['BTC/USDT', 'SOL/USDT'],
      timeframe: '1d',
      minScore: 0,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.errors).toBeDefined();
    expect(data.errors).toHaveLength(1);
    expect(data.errors[0].symbol).toBe('SOL/USDT');
  });
});

// ── find_support_resistance ───────────────────────────────────

describe('find_support_resistance tool', () => {
  it('returns support and resistance levels with distance calculations', async () => {
    const { server } = setup();
    const result = await server.callTool('find_support_resistance', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      limit: 250,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.candlesAnalyzed).toBe(250);
    expect(typeof data.currentPrice).toBe('number');
    expect(data.currentPrice).toBeGreaterThan(0);
    expect(Array.isArray(data.supports)).toBe(true);
    expect(Array.isArray(data.resistances)).toBe(true);
  });

  it('support and resistance entries include level and distancePercent', async () => {
    const { server } = setup();
    const result = await server.callTool('find_support_resistance', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);

    for (const s of data.supports) {
      expect(s).toHaveProperty('level');
      expect(s).toHaveProperty('distancePercent');
      expect(typeof s.level).toBe('number');
      expect(typeof s.distancePercent).toBe('number');
    }

    for (const r of data.resistances) {
      expect(r).toHaveProperty('level');
      expect(r).toHaveProperty('distancePercent');
    }
  });

  it('nearestSupport and nearestResistance are numbers or null', async () => {
    const { server } = setup();
    const result = await server.callTool('find_support_resistance', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    if (data.nearestSupport !== null) {
      expect(typeof data.nearestSupport).toBe('number');
    }
    if (data.nearestResistance !== null) {
      expect(typeof data.nearestResistance).toBe('number');
    }
  });

  it('throws when fewer than 10 candles returned', async () => {
    const { server } = setup({
      getBars: async () => generateBars({ count: 5, startPrice: 65000 }),
    });
    const result = await server.callTool('find_support_resistance', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('10');
  });
});

// ── detect_patterns ───────────────────────────────────────────

describe('detect_patterns tool', () => {
  it('returns detected patterns with metadata', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_patterns', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      lookbackBars: 100,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(typeof data.currentPrice).toBe('number');
    expect(typeof data.candlesAnalyzed).toBe('number');
    expect(typeof data.patternsDetected).toBe('number');
    expect(Array.isArray(data.patterns)).toBe(true);
    expect(data.patternsDetected).toBe(data.patterns.length);
  });

  it('each pattern has source, type, strength, confidence, metadata', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_patterns', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
      lookbackBars: 250,
    });

    const data = JSON.parse(result.content[0].text);
    for (const p of data.patterns) {
      expect(p).toHaveProperty('source');
      expect(p).toHaveProperty('type');
      expect(p).toHaveProperty('strength');
      expect(p).toHaveProperty('confidence');
      expect(p).toHaveProperty('metadata');
      expect(['buy', 'sell', 'hold']).toContain(p.type);
      expect(['strong', 'moderate', 'weak']).toContain(p.strength);
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('throws when fewer than 5 candles returned', async () => {
    const { server } = setup({
      getBars: async () => generateBars({ count: 3, startPrice: 65000 }),
    });
    const result = await server.callTool('detect_patterns', {
      symbol: 'BTC/USDT',
      timeframe: '1d',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('5');
  });
});

// ── get_signal_dashboard ──────────────────────────────────────

describe('get_signal_dashboard tool', () => {
  it('returns dashboard entries for each symbol', async () => {
    const { server } = setup();
    const result = await server.callTool('get_signal_dashboard', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.timeframe).toBe('1d');
    expect(data.symbolCount).toBe(3);
    expect(Array.isArray(data.dashboard)).toBe(true);
  });

  it('dashboard entries are sorted by absolute score descending', async () => {
    const { server } = setup();
    const result = await server.callTool('get_signal_dashboard', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    const scores = data.dashboard.map((e: any) => Math.abs(e.score));
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]).toBeGreaterThanOrEqual(scores[i + 1]);
    }
  });

  it('each dashboard entry has complete fields', async () => {
    const { server } = setup();
    const result = await server.callTool('get_signal_dashboard', {
      symbols: ['BTC/USDT', 'ETH/USDT'],
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    for (const entry of data.dashboard) {
      expect(entry).toHaveProperty('symbol');
      expect(entry).toHaveProperty('currentPrice');
      expect(entry).toHaveProperty('bias');
      expect(entry).toHaveProperty('score');
      expect(entry).toHaveProperty('signalCount');
      expect(entry).toHaveProperty('topSignal');
      expect(entry).toHaveProperty('nearestSupport');
      expect(entry).toHaveProperty('nearestResistance');
      expect(entry).toHaveProperty('supportDistance');
      expect(entry).toHaveProperty('resistanceDistance');
      expect(typeof entry.currentPrice).toBe('number');
      expect(entry.currentPrice).toBeGreaterThan(0);
    }
  });

  it('records errors for symbols with insufficient data', async () => {
    const { server } = setup({
      getBars: async (symbol: string) => {
        if (symbol === 'ETH/USDT') return generateBars({ count: 20, startPrice: 3400 });
        return FULL_BARS;
      },
    });
    const result = await server.callTool('get_signal_dashboard', {
      symbols: ['BTC/USDT', 'ETH/USDT'],
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.errors).toBeDefined();
    expect(data.errors.some((e: any) => e.symbol === 'ETH/USDT')).toBe(true);
  });
});

// ── scan_divergences ──────────────────────────────────────────

describe('scan_divergences tool', () => {
  it('returns scanned count and divergence results', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_divergences', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.timeframe).toBe('1d');
    expect(data.scanned).toBe(3);
    expect(typeof data.withDivergences).toBe('number');
    expect(data.withDivergences).toBeGreaterThanOrEqual(0);
    expect(data.withDivergences).toBeLessThanOrEqual(3);
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(data.withDivergences);
  });

  it('divergence entries have complete signal metadata', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_divergences', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      expect(entry).toHaveProperty('symbol');
      expect(entry).toHaveProperty('currentPrice');
      expect(entry).toHaveProperty('divergences');
      expect(Array.isArray(entry.divergences)).toBe(true);
      expect(entry.divergences.length).toBeGreaterThan(0);
      for (const div of entry.divergences) {
        expect(div).toHaveProperty('source');
        expect(div).toHaveProperty('type');
        expect(div).toHaveProperty('strength');
        expect(div).toHaveProperty('confidence');
      }
    }
  });

  it('records errors for symbols with insufficient data', async () => {
    const { server } = setup({
      getBars: async (symbol: string) => {
        if (symbol === 'SOL/USDT') return generateBars({ count: 10, startPrice: 175 });
        return FULL_BARS;
      },
    });
    const result = await server.callTool('scan_divergences', {
      symbols: ['BTC/USDT', 'SOL/USDT'],
      timeframe: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.errors).toBeDefined();
    expect(data.errors[0].symbol).toBe('SOL/USDT');
  });
});

// ── get_multi_timeframe_signals ───────────────────────────────

describe('get_multi_timeframe_signals tool', () => {
  it('returns alignment and per-timeframe results', async () => {
    const { server } = setup();
    const result = await server.callTool('get_multi_timeframe_signals', {
      symbol: 'BTC/USDT',
      timeframes: ['1h', '4h', '1d'],
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(typeof data.alignment).toBe('string');
    expect(['strong_bullish', 'strong_bearish', 'mixed', 'neutral']).toContain(data.alignment);
    expect(typeof data.averageScore).toBe('number');
    expect(Array.isArray(data.timeframes)).toBe(true);
  });

  it('each timeframe entry has expected fields', async () => {
    const { server } = setup();
    const result = await server.callTool('get_multi_timeframe_signals', {
      symbol: 'BTC/USDT',
      timeframes: ['1h', '4h', '1d'],
    });

    const data = JSON.parse(result.content[0].text);
    for (const tf of data.timeframes) {
      expect(tf).toHaveProperty('timeframe');
      expect(tf).toHaveProperty('candlesAnalyzed');
      expect(tf).toHaveProperty('currentPrice');
      expect(tf).toHaveProperty('bias');
      expect(tf).toHaveProperty('score');
      expect(tf).toHaveProperty('signalCount');
      expect(tf).toHaveProperty('signals');
      expect(Array.isArray(tf.signals)).toBe(true);
      expect(tf.candlesAnalyzed).toBe(250);
      expect(tf.currentPrice).toBeGreaterThan(0);
    }
  });

  it('handles timeframes with insufficient data gracefully', async () => {
    const { server } = setup({
      getBars: async (_symbol: string, timeframe: string) => {
        if (timeframe === '1h') return generateBars({ count: 20, startPrice: 65000 });
        return FULL_BARS;
      },
    });
    const result = await server.callTool('get_multi_timeframe_signals', {
      symbol: 'BTC/USDT',
      timeframes: ['1h', '1d'],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.errors).toBeDefined();
    expect(data.errors[0].timeframe).toBe('1h');
    // 1d should still be analyzed
    expect(data.timeframes).toHaveLength(1);
    expect(data.timeframes[0].timeframe).toBe('1d');
  });

  it('analyzes all three timeframes when all are provided', async () => {
    const { server } = setup();
    const result = await server.callTool('get_multi_timeframe_signals', {
      symbol: 'BTC/USDT',
      timeframes: ['1h', '4h', '1d'],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.timeframes).toHaveLength(3);
    const tfNames = data.timeframes.map((t: any) => t.timeframe);
    expect(tfNames).toContain('1h');
    expect(tfNames).toContain('4h');
    expect(tfNames).toContain('1d');
  });
});

// ── scan_breakouts ────────────────────────────────────────────

describe('scan_breakouts tool', () => {
  it('returns scanned count and breakout candidates', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_breakouts', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
      proximityPercent: 5,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.timeframe).toBe('1d');
    expect(data.scanned).toBe(3);
    expect(typeof data.breakoutCandidates).toBe('number');
    expect(data.proximityThreshold).toBe('5%');
    expect(Array.isArray(data.results)).toBe(true);
    expect(data.results).toHaveLength(data.breakoutCandidates);
  });

  it('breakout entries have required fields', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_breakouts', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
      proximityPercent: 10,
    });

    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      expect(entry).toHaveProperty('symbol');
      expect(entry).toHaveProperty('currentPrice');
      expect(entry).toHaveProperty('direction');
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('distancePercent');
      expect(entry).toHaveProperty('volumeRatio');
      expect(entry).toHaveProperty('volumeConfirmation');
      expect(entry).toHaveProperty('allSupports');
      expect(entry).toHaveProperty('allResistances');
      expect(['bullish_breakout', 'bearish_breakdown']).toContain(entry.direction);
      expect(typeof entry.volumeConfirmation).toBe('boolean');
      expect(typeof entry.volumeRatio).toBe('number');
    }
  });

  it('volume-confirmed breakouts appear first', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_breakouts', {
      symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
      timeframe: '1d',
      proximityPercent: 10,
    });

    const data = JSON.parse(result.content[0].text);
    const confirmed = data.results.filter((r: any) => r.volumeConfirmation);
    const unconfirmed = data.results.filter((r: any) => !r.volumeConfirmation);

    if (confirmed.length > 0 && unconfirmed.length > 0) {
      const lastConfirmedIdx = data.results.lastIndexOf(
        data.results.find((r: any) => r.volumeConfirmation),
      );
      const firstUnconfirmedIdx = data.results.findIndex(
        (r: any) => !r.volumeConfirmation,
      );
      // All confirmed entries should appear before unconfirmed
      expect(lastConfirmedIdx).toBeLessThan(firstUnconfirmedIdx);
    }
  });

  it('records errors for symbols with insufficient data', async () => {
    const { server } = setup({
      getBars: async (symbol: string) => {
        if (symbol === 'SOL/USDT') return generateBars({ count: 5, startPrice: 175 });
        return FULL_BARS;
      },
    });
    const result = await server.callTool('scan_breakouts', {
      symbols: ['BTC/USDT', 'SOL/USDT'],
      timeframe: '1d',
      proximityPercent: 2,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.errors).toBeDefined();
    expect(data.errors[0].symbol).toBe('SOL/USDT');
  });

  it('reflects proximityPercent in the proximityThreshold field', async () => {
    const { server } = setup();
    const result = await server.callTool('scan_breakouts', {
      symbols: ['BTC/USDT'],
      timeframe: '1d',
      proximityPercent: 3,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.proximityThreshold).toBe('3%');
  });
});

// ── Tool registration ─────────────────────────────────────────

describe('registerScannerTools', () => {
  it('registers all 8 scanner tools', () => {
    const { server } = setup();
    const expected = [
      'scan_signals',
      'scan_market',
      'find_support_resistance',
      'detect_patterns',
      'get_signal_dashboard',
      'scan_divergences',
      'get_multi_timeframe_signals',
      'scan_breakouts',
    ];
    for (const name of expected) {
      expect(server.hasTool(name)).toBe(true);
    }
    expect(server.toolNames).toHaveLength(8);
  });
});
