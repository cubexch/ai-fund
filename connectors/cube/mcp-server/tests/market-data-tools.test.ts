import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerMarketDataTools } from '../src/tools/market-data';

function createMockServer() {
  const tools = new Map<string, Function>();
  return {
    tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
      tools.set(name, handler);
    }),
    getHandler: (name: string) => tools.get(name),
  };
}

const DEFAULT_MARKET = { marketId: 1, symbol: 'BTCUSDC', priceTickSize: '0.01', quantityTickSize: '0.001' };

function createMockIridium(overrides: Record<string, any> = {}) {
  return {
    getDefaultSubaccountId: vi.fn().mockResolvedValue(1),
    getMarkets: vi.fn().mockResolvedValue([DEFAULT_MARKET]),
    getTickers: vi.fn().mockResolvedValue([]),
    getOrderBook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    getRecentTrades: vi.fn().mockResolvedValue([]),
    getPriceHistory: vi.fn().mockResolvedValue([]),
    getEstimatedFees: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('registerMarketDataTools', () => {
  let server: ReturnType<typeof createMockServer>;
  let iridium: ReturnType<typeof createMockIridium>;

  beforeEach(() => {
    server = createMockServer();
    iridium = createMockIridium();
    registerMarketDataTools(server as any, iridium as any);
  });

  it('registers all 7 market data tools', () => {
    expect(server.tool).toHaveBeenCalledTimes(7);
    const names = server.tool.mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('get_assets');
    expect(names).toContain('get_tickers');
    expect(names).toContain('get_order_book');
    expect(names).toContain('get_trades');
    expect(names).toContain('get_bars');
    expect(names).toContain('get_fees');
    expect(names).toContain('get_technical_analysis');
  });

  describe('get_assets', () => {
    it('returns markets from iridium', async () => {
      const markets = [{ marketId: 1, symbol: 'BTCUSDC' }];
      iridium.getMarkets.mockResolvedValue(markets);

      const handler = server.getHandler('get_assets')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data).toEqual(markets);
    });

    it('returns error on failure', async () => {
      iridium.getMarkets.mockRejectedValue(new Error('Timeout'));

      const handler = server.getHandler('get_assets')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Timeout');
    });
  });

  describe('get_tickers', () => {
    it('returns tickers from iridium (no mendelev)', async () => {
      const tickers = [{ symbol: 'BTCUSDC', lastPrice: 60000, bidPrice: 59999, askPrice: 60001 }];
      iridium.getTickers.mockResolvedValue(tickers);

      const handler = server.getHandler('get_tickers')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data).toEqual(tickers);
    });
  });

  describe('get_order_book', () => {
    it('falls back to REST when no mendelev', async () => {
      const book = { bids: [[60000, 1]], asks: [[60001, 0.5]] };
      iridium.getOrderBook.mockResolvedValue(book);

      const handler = server.getHandler('get_order_book')!;
      const result = await handler({ symbol: 'BTCUSDC' });
      const data = JSON.parse(result.content[0].text);

      expect(data).toEqual(book);
      expect(iridium.getOrderBook).toHaveBeenCalledWith('BTCUSDC');
    });
  });

  describe('get_trades', () => {
    it('returns trades from REST fallback', async () => {
      const trades = [{ price: 60000, qty: 0.1, side: 'buy', ts: Date.now() }];
      iridium.getRecentTrades.mockResolvedValue(trades);

      const handler = server.getHandler('get_trades')!;
      const result = await handler({ symbol: 'BTCUSDC' });
      const data = JSON.parse(result.content[0].text);

      expect(data).toEqual(trades);
    });
  });

  describe('get_bars', () => {
    it('returns candles with freshness warning when stale', async () => {
      const staleTime = Date.now() - 3 * 86_400_000; // 3 days old
      const candles = [{ startTime: staleTime, open: '100', high: '105', low: '95', close: '102', volume: '1000' }];
      iridium.getPriceHistory.mockResolvedValue(candles);

      const handler = server.getHandler('get_bars')!;
      const result = await handler({ symbol: 'BTCUSDC', interval: '1h', limit: 100 });
      const data = JSON.parse(result.content[0].text);

      expect(data.freshnessWarning).toBeDefined();
      expect(data.freshnessWarning).toContain('day(s) old');
    });

    it('returns candles without warning when fresh', async () => {
      const candles = [{ startTime: Date.now() - 60_000, open: '100', high: '105', low: '95', close: '102', volume: '1000' }];
      iridium.getPriceHistory.mockResolvedValue(candles);

      const handler = server.getHandler('get_bars')!;
      const result = await handler({ symbol: 'BTCUSDC', interval: '1h', limit: 100 });
      const data = JSON.parse(result.content[0].text);

      expect(data.freshnessWarning).toBeUndefined();
    });
  });

  describe('get_technical_analysis', () => {
    it('returns error with insufficient data', async () => {
      // Only 10 candles — need at least 30
      const candles = Array.from({ length: 10 }, (_, i) => ({
        startTime: Date.now() - i * 3_600_000,
        open: '100', high: '105', low: '95', close: '102', volume: '1000',
      }));
      iridium.getPriceHistory.mockResolvedValue(candles);

      const handler = server.getHandler('get_technical_analysis')!;
      const result = await handler({ symbol: 'BTCUSDC', interval: '1h', limit: 200, indicators: ['rsi'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Insufficient data');
    });

    it('computes requested indicators with sufficient data', async () => {
      // Generate 50 candles with varying prices
      const candles = Array.from({ length: 50 }, (_, i) => ({
        startTime: Date.now() - (50 - i) * 3_600_000,
        open: String(100 + Math.sin(i * 0.3) * 5),
        high: String(105 + Math.sin(i * 0.3) * 5),
        low: String(95 + Math.sin(i * 0.3) * 5),
        close: String(102 + Math.sin(i * 0.3) * 5),
        volume: String(1000 + i * 10),
      }));
      iridium.getPriceHistory.mockResolvedValue(candles);

      const handler = server.getHandler('get_technical_analysis')!;
      const result = await handler({
        symbol: 'BTCUSDC',
        interval: '1h',
        limit: 200,
        indicators: ['rsi', 'macd', 'bollinger', 'atr'],
      });
      const data = JSON.parse(result.content[0].text);

      expect(data.rsi).toBeDefined();
      expect(data.rsi.signal).toMatch(/OVERBOUGHT|OVERSOLD|NEUTRAL/);
      expect(data.macd).toBeDefined();
      expect(data.macd.trend).toMatch(/BULLISH|BEARISH/);
      expect(data.bollinger).toBeDefined();
      expect(data.atr).toBeDefined();
    });
  });
});
