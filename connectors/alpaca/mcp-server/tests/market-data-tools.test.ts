import { describe, it, expect } from 'vitest';
import { AlpacaClient } from '../src/client/api';
import { registerMarketDataTools } from '../src/tools/market-data';
import { MockMcpServer, mockFetch } from './helpers';

function setup(responses: { status?: number; body?: unknown }[]) {
  const fetch = mockFetch(responses);
  const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', paper: true, fetchFn: fetch });
  const server = new MockMcpServer();
  registerMarketDataTools(server as any, client);
  return { server, fetch };
}

// ── get_bars ────────────────────────────────────────────────

describe('get_bars tool', () => {
  const mockBars = {
    bars: [
      { t: '2024-01-01T00:00:00Z', o: 150, h: 155, l: 148, c: 153, v: 1000, n: 50, vw: 151.5 },
      { t: '2024-01-02T00:00:00Z', o: 153, h: 158, l: 152, c: 157, v: 1200, n: 60, vw: 155.0 },
    ],
    next_page_token: null,
  };

  it('returns formatted bars', async () => {
    const { server } = setup([{ body: mockBars }]);
    const result = await server.callTool('get_bars', {
      symbol: 'AAPL', timeframe: '1Day', limit: 100,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('AAPL');
    expect(data.bars).toHaveLength(2);
    expect(data.bars[0].open).toBe(150);
    expect(data.bars[0].high).toBe(155);
    expect(data.bars[0].low).toBe(148);
    expect(data.bars[0].close).toBe(153);
    expect(data.bars[0].volume).toBe(1000);
    expect(data.bars[0].vwap).toBe(151.5);
    expect(data.bars[0].tradeCount).toBe(50);
  });

  it('passes start and end params', async () => {
    const { server, fetch } = setup([{ body: { bars: [], next_page_token: null } }]);
    await server.callTool('get_bars', {
      symbol: 'TSLA', timeframe: '1Hour', start: '2024-01-01', end: '2024-01-31', limit: 100,
    });

    const url = fetch.calls[0].url;
    expect(url).toContain('start=2024-01-01');
    expect(url).toContain('end=2024-01-31');
    expect(url).toContain('timeframe=1Hour');
  });

  it('returns empty bars array', async () => {
    const { server } = setup([{ body: { bars: [], next_page_token: null } }]);
    const result = await server.callTool('get_bars', {
      symbol: 'NOPE', timeframe: '1Day', limit: 100,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.bars).toEqual([]);
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 422, body: { message: 'invalid timeframe' } }]);
    const result = await server.callTool('get_bars', {
      symbol: 'AAPL', timeframe: 'bad', limit: 100,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('invalid timeframe');
  });
});

// ── get_quote ───────────────────────────────────────────────

describe('get_quote tool', () => {
  it('returns latest quote with bid/ask', async () => {
    const quoteResp = {
      quote: {
        t: '2024-01-01T10:00:00Z', ax: 'N', ap: 151.0, as: 100,
        bx: 'N', bp: 150.5, bs: 200,
      },
    };
    const { server } = setup([{ body: quoteResp }]);
    const result = await server.callTool('get_quote', { symbol: 'AAPL' });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('AAPL');
    expect(data.bidPrice).toBe(150.5);
    expect(data.askPrice).toBe(151.0);
    expect(data.bidSize).toBe(200);
    expect(data.askSize).toBe(100);
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 404, body: { message: 'symbol not found' } }]);
    const result = await server.callTool('get_quote', { symbol: 'INVALID' });

    expect(result.isError).toBe(true);
  });
});

// ── get_tickers ─────────────────────────────────────────────

describe('get_tickers tool', () => {
  const mockSnapshots = {
    AAPL: {
      latestTrade: { t: '2024-01-01T10:00:00Z', p: 170, s: 100 },
      latestQuote: { t: '2024-01-01T10:00:00Z', ax: 'N', ap: 170.5, as: 100, bx: 'N', bp: 169.5, bs: 200 },
      minuteBar: { t: '2024-01-01T10:00:00Z', o: 169, h: 171, l: 168, c: 170, v: 500, n: 20, vw: 169.5 },
      dailyBar: { t: '2024-01-01T00:00:00Z', o: 168, h: 172, l: 167, c: 170, v: 10000, n: 500, vw: 169.8 },
      prevDailyBar: { t: '2023-12-31T00:00:00Z', o: 165, h: 169, l: 164, c: 168, v: 9000, n: 450, vw: 167.0 },
    },
    TSLA: {
      latestTrade: { t: '2024-01-01T10:00:00Z', p: 250, s: 50 },
      latestQuote: { t: '2024-01-01T10:00:00Z', ax: 'N', ap: 250.5, as: 50, bx: 'N', bp: 249.5, bs: 100 },
      minuteBar: { t: '2024-01-01T10:00:00Z', o: 249, h: 251, l: 248, c: 250, v: 300, n: 15, vw: 249.8 },
      dailyBar: { t: '2024-01-01T00:00:00Z', o: 245, h: 252, l: 244, c: 250, v: 8000, n: 400, vw: 248.5 },
      prevDailyBar: { t: '2023-12-31T00:00:00Z', o: 240, h: 247, l: 239, c: 245, v: 7500, n: 380, vw: 243.0 },
    },
  };

  it('returns formatted snapshots for multiple symbols', async () => {
    const { server } = setup([{ body: mockSnapshots }]);
    const result = await server.callTool('get_tickers', { symbols: 'AAPL,TSLA' });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(2);

    const aapl = data.find((d: any) => d.symbol === 'AAPL');
    expect(aapl.lastPrice).toBe(170);
    expect(aapl.bidPrice).toBe(169.5);
    expect(aapl.askPrice).toBe(170.5);
    expect(aapl.dailyOpen).toBe(168);
    expect(aapl.dailyVolume).toBe(10000);
    expect(aapl.prevClose).toBe(168);
    expect(aapl.changeFromPrevClose).toBe(2);
    expect(aapl.changePct).toBe('1.19%');
  });

  it('handles single symbol', async () => {
    const { server, fetch } = setup([{ body: { AAPL: mockSnapshots.AAPL } }]);
    const result = await server.callTool('get_tickers', { symbols: 'AAPL' });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(fetch.calls[0].url).toContain('symbols=AAPL');
  });

  it('trims whitespace from symbols', async () => {
    const { server, fetch } = setup([{ body: mockSnapshots }]);
    await server.callTool('get_tickers', { symbols: ' AAPL , TSLA ' });

    expect(fetch.calls[0].url).toContain('symbols=AAPL%2CTSLA');
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'server error' } }]);
    const result = await server.callTool('get_tickers', { symbols: 'AAPL' });

    expect(result.isError).toBe(true);
  });
});

// ── search_assets ───────────────────────────────────────────

describe('search_assets tool', () => {
  const mockAssets = [
    { id: 'a1', class: 'us_equity', exchange: 'NASDAQ', symbol: 'AAPL', name: 'Apple Inc.',
      status: 'active', tradable: true, marginable: true, shortable: true, fractionable: true },
    { id: 'a2', class: 'us_equity', exchange: 'NYSE', symbol: 'APLE', name: 'Apple Hospitality REIT',
      status: 'active', tradable: true, marginable: true, shortable: false, fractionable: true },
    { id: 'a3', class: 'us_equity', exchange: 'NASDAQ', symbol: 'MSFT', name: 'Microsoft Corp',
      status: 'active', tradable: true, marginable: true, shortable: true, fractionable: true },
    { id: 'a4', class: 'us_equity', exchange: 'NASDAQ', symbol: 'AADR', name: 'AdvisorShares Dorsey Wright',
      status: 'active', tradable: false, marginable: false, shortable: false, fractionable: false },
  ];

  it('searches by symbol substring', async () => {
    const { server } = setup([{ body: mockAssets }]);
    const result = await server.callTool('search_assets', { query: 'aapl' });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1); // AAPL (tradable), not APLE (different symbol match), not AADR (not tradable)
    expect(data[0].symbol).toBe('AAPL');
  });

  it('searches by name substring', async () => {
    const { server } = setup([{ body: mockAssets }]);
    const result = await server.callTool('search_assets', { query: 'apple' });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(2); // AAPL and APLE (both tradable, both contain 'apple')
    expect(data.map((d: any) => d.symbol)).toContain('AAPL');
    expect(data.map((d: any) => d.symbol)).toContain('APLE');
  });

  it('excludes non-tradable assets', async () => {
    const { server } = setup([{ body: mockAssets }]);
    const result = await server.callTool('search_assets', { query: 'aa' });

    const data = JSON.parse(result.content[0].text);
    // Should include AAPL but not AADR (not tradable)
    const symbols = data.map((d: any) => d.symbol);
    expect(symbols).toContain('AAPL');
    expect(symbols).not.toContain('AADR');
  });

  it('limits results to 20', async () => {
    const manyAssets = Array.from({ length: 30 }, (_, i) => ({
      id: `a${i}`, class: 'us_equity', exchange: 'NASDAQ',
      symbol: `TEST${i}`, name: `Test Company ${i}`,
      status: 'active', tradable: true, marginable: true,
      shortable: true, fractionable: true,
    }));
    const { server } = setup([{ body: manyAssets }]);
    const result = await server.callTool('search_assets', { query: 'test' });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(20);
  });

  it('passes asset_class filter', async () => {
    const { server, fetch } = setup([{ body: [] }]);
    await server.callTool('search_assets', { query: 'btc', asset_class: 'crypto' });

    expect(fetch.calls[0].url).toContain('asset_class=crypto');
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'server error' } }]);
    const result = await server.callTool('search_assets', { query: 'aapl' });

    expect(result.isError).toBe(true);
  });
});

// ── get_trades ──────────────────────────────────────────────

describe('get_trades tool', () => {
  const mockTradesResp = {
    trades: [
      { t: '2024-01-01T10:00:00Z', x: 'N', p: 150.5, s: 100, c: ['@'], i: 1, z: 'A' },
      { t: '2024-01-01T10:00:01Z', x: 'Q', p: 150.6, s: 50, c: ['@', 'T'], i: 2, z: 'A' },
    ],
    next_page_token: null,
  };

  it('returns formatted trades', async () => {
    const { server } = setup([{ body: mockTradesResp }]);
    const result = await server.callTool('get_trades', { symbol: 'AAPL', limit: 100 });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('AAPL');
    expect(data.trades).toHaveLength(2);
    expect(data.trades[0].price).toBe(150.5);
    expect(data.trades[0].size).toBe(100);
    expect(data.trades[0].exchange).toBe('N');
    expect(data.trades[0].conditions).toEqual(['@']);
    expect(data.trades[1].conditions).toEqual(['@', 'T']);
  });

  it('passes start and end params', async () => {
    const { server, fetch } = setup([{ body: { trades: [], next_page_token: null } }]);
    await server.callTool('get_trades', {
      symbol: 'AAPL', start: '2024-01-01', end: '2024-01-31', limit: 100,
    });

    const url = fetch.calls[0].url;
    expect(url).toContain('start=2024-01-01');
    expect(url).toContain('end=2024-01-31');
  });

  it('returns empty trades', async () => {
    const { server } = setup([{ body: { trades: [], next_page_token: null } }]);
    const result = await server.callTool('get_trades', { symbol: 'NOPE', limit: 100 });

    const data = JSON.parse(result.content[0].text);
    expect(data.trades).toEqual([]);
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'server error' } }]);
    const result = await server.callTool('get_trades', { symbol: 'AAPL', limit: 100 });

    expect(result.isError).toBe(true);
  });
});
