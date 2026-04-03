import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDatastoreTools } from '../src/tools/datastore';
import { createMockClient, MockMcpServer } from './helpers';

// ── Mock MarketDataStore ─────────────────────────────────────

function createMockStore() {
  const rows: any[] = [];
  return {
    insertOHLCV: vi.fn(async (newRows: any[]) => { rows.push(...newRows); return newRows.length; }),
    query: vi.fn(async (opts: any) => {
      // Return mock candles for cross-symbol analysis
      const candles = [];
      let price = opts.symbol === 'ETH/USDT' ? 3500 : 65000;
      const count = opts.limit || 100;
      for (let i = 0; i < count; i++) {
        price *= 1 + (Math.sin(i * 0.2) * 0.02);
        candles.push({
          timestamp: 1700000000000 + i * 86400000,
          open: price * 0.99, high: price * 1.01,
          low: price * 0.98, close: price, volume: 1000 + i * 10,
        });
      }
      return candles;
    }),
    symbols: vi.fn(async () => [
      { symbol: 'BTC/USDT', exchange: 'coinbase', asset_type: 'crypto', intervals: ['1d', '1h'], rowCount: 500, firstDate: '2024-01-01', lastDate: '2024-06-01' },
      { symbol: 'ETH/USDT', exchange: 'coinbase', asset_type: 'crypto', intervals: ['1d'], rowCount: 365, firstDate: '2024-01-01', lastDate: '2024-06-01' },
    ]),
    count: vi.fn(async () => 865),
    lastTimestamp: vi.fn(async () => null),
    sql: vi.fn(async (query: string) => {
      if (query.includes('vwap')) {
        return [{ vwap: 65123.45, total_volume: 50000, candles: 24, start_ts: '2024-06-01', end_ts: '2024-06-02' }];
      }
      return [{ cnt: 100 }];
    }),
    _rows: rows,
  };
}

function setup(storeOverrides: any = {}, clientOverrides: any = {}) {
  const mockStore = { ...createMockStore(), ...storeOverrides };
  const client = createMockClient({
    getBars: async (symbol: string) => {
      const bars = [];
      let price = symbol === 'ETH/USDT' ? 3500 : 65000;
      for (let i = 0; i < 50; i++) {
        price += (Math.random() - 0.5) * 100;
        bars.push({
          timestamp: 1700000000000 + i * 86400000,
          open: price - 10, high: price + 20, low: price - 30, close: price, volume: 1000,
        });
      }
      return bars;
    },
    getTicker: async (symbol: string) => ({
      symbol, last: 65100, bid: 65090, ask: 65110,
      high: 66000, low: 64000, volume: 1234.5, timestamp: 1700000000000,
    }),
    store: mockStore,
    ...clientOverrides,
  } as any);
  const server = new MockMcpServer();
  registerDatastoreTools(server as any, client);
  return { server, client, store: mockStore };
}

// ── ingest_history ───────────────────────────────────────────

describe('ingest_history tool', () => {
  it('ingests multiple symbols', async () => {
    const { server, store } = setup();
    const result = await server.callTool('ingest_history', {
      symbols: 'BTC/USDT,ETH/USDT', timeframe: '1d', limit: 50,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.exchange).toBe('coinbase');
    expect(data.timeframe).toBe('1d');
    expect(data.symbols).toHaveLength(2);
    expect(data.totalRows).toBeGreaterThan(0);
  });

  it('fails without store', async () => {
    const { server } = setup({ __disabled: true }, { store: null });
    // Need to re-setup without store
    const client = createMockClient({ store: null } as any);
    const srv = new MockMcpServer();
    registerDatastoreTools(srv as any, client);
    const result = await srv.callTool('ingest_history', {
      symbols: 'BTC/USDT', timeframe: '1d', limit: 50,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not configured');
  });
});

// ── query_market_data ────────────────────────────────────────

describe('query_market_data tool', () => {
  it('executes SELECT query', async () => {
    const { server, store } = setup();
    const result = await server.callTool('query_market_data', {
      sql: 'SELECT COUNT(*) as cnt FROM ohlcv',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.rowCount).toBe(1);
    expect(store.sql).toHaveBeenCalled();
  });

  it('rejects non-SELECT queries', async () => {
    const { server } = setup();
    const result = await server.callTool('query_market_data', {
      sql: 'DROP TABLE ohlcv',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Only SELECT');
  });

  it('rejects INSERT disguised as SELECT', async () => {
    const { server } = setup();
    const result = await server.callTool('query_market_data', {
      sql: 'SELECT 1; INSERT INTO ohlcv VALUES (1)',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Write operations');
  });

  it('rejects DELETE queries', async () => {
    const { server } = setup();
    const result = await server.callTool('query_market_data', {
      sql: 'DELETE FROM ohlcv WHERE symbol = "BTC"',
    });
    expect(result.isError).toBe(true);
  });
});

// ── get_cached_symbols ───────────────────────────────────────

describe('get_cached_symbols tool', () => {
  it('returns symbol listing', async () => {
    const { server } = setup();
    const result = await server.callTool('get_cached_symbols', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.totalRows).toBe(865);
    expect(data.symbols).toHaveLength(2);
    expect(data.symbols[0].symbol).toBe('BTC/USDT');
    expect(data.symbols[0].intervals).toContain('1d');
  });
});

// ── analyze_cross_symbol ─────────────────────────────────────

describe('analyze_cross_symbol tool', () => {
  it('computes correlation and stats for 2 symbols', async () => {
    const { server } = setup();
    const result = await server.callTool('analyze_cross_symbol', {
      symbols: 'BTC/USDT,ETH/USDT', timeframe: '1d', period: 90,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.stats['BTC/USDT']).toBeDefined();
    expect(data.stats['ETH/USDT']).toBeDefined();
    expect(data.stats['BTC/USDT'].sharpe).toBeTypeOf('number');
    expect(data.stats['BTC/USDT'].maxDrawdown).toBeTypeOf('number');
    expect(data.correlations['BTC/USDT']['ETH/USDT']).toBeTypeOf('number');
    // Self-correlation should be 1
    expect(data.correlations['BTC/USDT']['BTC/USDT']).toBe(1);
  });

  it('rejects single symbol', async () => {
    const { server } = setup();
    const result = await server.callTool('analyze_cross_symbol', {
      symbols: 'BTC/USDT', timeframe: '1d', period: 90,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 2');
  });
});

// ── get_volume_profile ───────────────────────────────────────

describe('get_volume_profile tool', () => {
  it('returns volume profile with POC and value area', async () => {
    const { server } = setup();
    const result = await server.callTool('get_volume_profile', {
      symbol: 'BTC/USDT', timeframe: '1h', period: 200, bins: 10,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.pointOfControl).toBeTypeOf('number');
    expect(data.valueArea.high).toBeGreaterThanOrEqual(data.valueArea.low);
    expect(data.profile).toHaveLength(10);
    // Percentages should sum to ~100
    const totalPct = data.profile.reduce((s: number, b: any) => s + b.pct, 0);
    expect(totalPct).toBeGreaterThan(99);
    expect(totalPct).toBeLessThan(101);
  });
});

// ── get_vwap ─────────────────────────────────────────────────

describe('get_vwap tool', () => {
  it('returns VWAP with deviation signal', async () => {
    const { server, store } = setup();
    const result = await server.callTool('get_vwap', {
      symbol: 'BTC/USDT', timeframe: '1h', period: 24,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.vwap).toBe(65123.45);
    expect(data.totalVolume).toBe(50000);
    expect(data.currentPrice).toBe(65100);
    expect(data.deviationFromVwapPct).toBeTypeOf('number');
    expect(data.signal).toBeTypeOf('string');
  });
});

// ── backtest_strategy ───────────────────────────────────────

describe('backtest_strategy tool', () => {
  it('returns valid backtest results with trades', async () => {
    const { server } = setup();
    const result = await server.callTool('backtest_strategy', {
      symbol: 'BTC/USDT', timeframe: '1d', fast_period: 5, slow_period: 15,
      initial_capital: 10000, position_size_pct: 1.0,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.fastPeriod).toBe(5);
    expect(data.slowPeriod).toBe(15);
    expect(data.trades).toBeInstanceOf(Array);
    expect(data.totalBars).toBeGreaterThan(0);
    expect(data.initialCapital).toBe(10000);
    expect(data.finalCapital).toBeTypeOf('number');
  });

  it('returns positive number of trades', async () => {
    const { server } = setup();
    const result = await server.callTool('backtest_strategy', {
      symbol: 'BTC/USDT', timeframe: '1d', fast_period: 5, slow_period: 15,
      initial_capital: 10000, position_size_pct: 1.0,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.totalTrades).toBeGreaterThan(0);
    expect(data.winners + data.losers).toBe(data.totalTrades);
  });

  it('winRate is between 0 and 1', async () => {
    const { server } = setup();
    const result = await server.callTool('backtest_strategy', {
      symbol: 'BTC/USDT', timeframe: '1d', fast_period: 5, slow_period: 15,
      initial_capital: 10000, position_size_pct: 1.0,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.winRate).toBeGreaterThanOrEqual(0);
    expect(data.winRate).toBeLessThanOrEqual(1);
  });

  it('equity curve starts with initial capital', async () => {
    const { server } = setup();
    const result = await server.callTool('backtest_strategy', {
      symbol: 'BTC/USDT', timeframe: '1d', fast_period: 5, slow_period: 15,
      initial_capital: 10000, position_size_pct: 1.0,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.equityCurve[0]).toBe(10000);
    expect(data.equityCurve.length).toBeGreaterThan(0);
  });

  it('rejects when no store configured', async () => {
    const client = createMockClient({ store: null } as any);
    const srv = new MockMcpServer();
    registerDatastoreTools(srv as any, client);
    const result = await srv.callTool('backtest_strategy', {
      symbol: 'BTC/USDT', timeframe: '1d', fast_period: 5, slow_period: 15,
      initial_capital: 10000, position_size_pct: 1.0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not configured');
  });
});

// ── detect_correlation_regime ───────────────────────────────

describe('detect_correlation_regime tool', () => {
  it('returns correlation regime data for two symbols', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_correlation_regime', {
      symbol_a: 'BTC/USDT', symbol_b: 'ETH/USDT',
      timeframe: '1d', window: 10, lookback: 100,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.symbolA).toBe('BTC/USDT');
    expect(data.symbolB).toBe('ETH/USDT');
    expect(data.window).toBe(10);
    expect(data.currentCorrelation).toBeTypeOf('number');
    expect(data.currentRegime).toBeTypeOf('string');
    expect(['highly_correlated', 'moderately_correlated', 'uncorrelated', 'inversely_correlated']).toContain(data.currentRegime);
    expect(data.averageCorrelation).toBeTypeOf('number');
    expect(data.transitions).toBeInstanceOf(Array);
    expect(data.rollingSeries).toBeInstanceOf(Array);
    expect(data.rollingSeries.length).toBeGreaterThan(0);
  });

  it('fails without store', async () => {
    const client = createMockClient({ store: null } as any);
    const srv = new MockMcpServer();
    registerDatastoreTools(srv as any, client);
    const result = await srv.callTool('detect_correlation_regime', {
      symbol_a: 'BTC/USDT', symbol_b: 'ETH/USDT',
      timeframe: '1d', window: 10, lookback: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not configured');
  });
});

// ── export_to_parquet ───────────────────────────────────────

describe('export_to_parquet tool', () => {
  it('exports data and returns file path and row count', async () => {
    const mockExportParquet = vi.fn(async () => {});
    const { server, store } = setup({ exportParquet: mockExportParquet });
    store.sql.mockResolvedValueOnce([{ cnt: 42 }]);
    const result = await server.callTool('export_to_parquet', {
      symbol: 'BTC/USDT', timeframe: '1d',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.exchange).toBe('coinbase');
    expect(data.outputPath).toContain('BTC-USDT');
    expect(data.outputPath).toContain('.parquet');
    expect(mockExportParquet).toHaveBeenCalledOnce();
  });

  it('uses custom output path when provided', async () => {
    const mockExportParquet = vi.fn(async () => {});
    const { server, store } = setup({ exportParquet: mockExportParquet });
    store.sql.mockResolvedValueOnce([{ cnt: 10 }]);
    const result = await server.callTool('export_to_parquet', {
      symbol: 'BTC/USDT', timeframe: '1h', output_path: '/tmp/my-export.parquet',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.outputPath).toBe('/tmp/my-export.parquet');
  });

  it('fails without store', async () => {
    const client = createMockClient({ store: null } as any);
    const srv = new MockMcpServer();
    registerDatastoreTools(srv as any, client);
    const result = await srv.callTool('export_to_parquet', {
      symbol: 'BTC/USDT', timeframe: '1d',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not configured');
  });
});

// ── get_pnl_attribution ────────────────────────────────────

describe('get_pnl_attribution tool', () => {
  it('returns P&L grouped by symbol', async () => {
    const mockJournalSql = vi.fn(async () => [
      { dimension: 'BTC/USDT', pnl: 500, fees: 10, trades: 20 },
      { dimension: 'ETH/USDT', pnl: -100, fees: 5, trades: 10 },
    ]);
    const { server } = setup({}, {
      journal: { sql: mockJournalSql },
    });
    const result = await server.callTool('get_pnl_attribution', {
      group_by: 'symbol',
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.exchange).toBe('coinbase');
    expect(data.groupBy).toBe('symbol');
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0].dimension).toBe('BTC/USDT');
    expect(data.rows[0].pnl).toBe(500);
    expect(mockJournalSql).toHaveBeenCalledOnce();
  });

  it('passes since filter into SQL', async () => {
    const mockJournalSql = vi.fn(async () => []);
    const { server } = setup({}, {
      journal: { sql: mockJournalSql },
    });
    await server.callTool('get_pnl_attribution', {
      group_by: 'day',
      since: '2024-06-01',
    });
    const sqlArg = (mockJournalSql.mock.calls[0] as unknown[])[0] as string;
    expect(sqlArg).toContain('WHERE timestamp >=');
  });

  it('fails without journal', async () => {
    const { server } = setup({}, { journal: undefined });
    const result = await server.callTool('get_pnl_attribution', {
      group_by: 'symbol',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not configured');
  });
});
