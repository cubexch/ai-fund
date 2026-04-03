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

function createMockIridium(overrides: Record<string, any> = {}) {
  return {
    getDefaultSubaccountId: vi.fn().mockResolvedValue(1),
    getMarkets: vi.fn().mockResolvedValue([]),
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
      iridium.getMarkets.mockResolvedValue([{ marketId: 1, symbol: 'BTCUSDC', priceTickSize: '0.01', quantityTickSize: '0.001' }]);
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
      iridium.getMarkets.mockResolvedValue([{ marketId: 1, symbol: 'BTCUSDC', priceTickSize: '0.01', quantityTickSize: '0.001' }]);
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
      const result = await handler({ marketId: 1, interval: '1h', limit: 100 });
      const data = JSON.parse(result.content[0].text);

      expect(data.freshnessWarning).toBeDefined();
      expect(data.freshnessWarning).toContain('day(s) old');
    });

    it('returns candles without warning when fresh', async () => {
      const candles = [{ startTime: Date.now() - 60_000, open: '100', high: '105', low: '95', close: '102', volume: '1000' }];
      iridium.getPriceHistory.mockResolvedValue(candles);

      const handler = server.getHandler('get_bars')!;
      const result = await handler({ marketId: 1, interval: '1h', limit: 100 });
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
      const result = await handler({ marketId: 1, interval: '1h', limit: 200, indicators: ['rsi'] });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Insufficient data');
    });

    it('computes RSI correctly for sinusoidal prices', async () => {
      // Sinusoidal prices oscillate → RSI should be near neutral (30-70)
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
        marketId: 1, interval: '1h', limit: 200, indicators: ['rsi'],
      });
      const data = JSON.parse(result.content[0].text);

      // RSI should be a number between 0-100
      expect(parseFloat(data.rsi.value)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(data.rsi.value)).toBeLessThanOrEqual(100);
      // Sinusoidal → expect NEUTRAL (not extreme)
      expect(data.rsi.signal).toBe('NEUTRAL');
      // recent should have 5 values
      expect(data.rsi.recent).toHaveLength(5);
      data.rsi.recent.forEach((v: number) => {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      });
    });

    it('computes MACD with histogram sign matching trend', async () => {
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
        marketId: 1, interval: '1h', limit: 200, indicators: ['macd'],
      });
      const data = JSON.parse(result.content[0].text);

      // MACD components are numbers (as strings with fixed decimals)
      expect(parseFloat(data.macd.macd)).toBeTypeOf('number');
      expect(parseFloat(data.macd.signal)).toBeTypeOf('number');
      expect(parseFloat(data.macd.histogram)).toBeTypeOf('number');
      // Trend matches histogram sign
      const hist = parseFloat(data.macd.histogram);
      expect(data.macd.trend).toBe(hist > 0 ? 'BULLISH' : 'BEARISH');
      // Recent histogram has 5 entries
      expect(data.macd.recentHistogram).toHaveLength(5);
    });

    it('computes Bollinger Bands with upper > middle > lower', async () => {
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
        marketId: 1, interval: '1h', limit: 200, indicators: ['bollinger'],
      });
      const data = JSON.parse(result.content[0].text);

      const upper = parseFloat(data.bollinger.upper);
      const middle = parseFloat(data.bollinger.middle);
      const lower = parseFloat(data.bollinger.lower);
      expect(upper).toBeGreaterThan(middle);
      expect(middle).toBeGreaterThan(lower);
      // Bandwidth should be positive
      expect(parseFloat(data.bollinger.bandwidth)).toBeGreaterThan(0);
      // Position should describe where price is relative to bands
      expect(data.bollinger.pricePosition).toMatch(/ABOVE_UPPER|UPPER_HALF|LOWER_HALF|BELOW_LOWER/);
    });

    it('computes ATR as a positive value', async () => {
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
        marketId: 1, interval: '1h', limit: 200, indicators: ['atr'],
      });
      const data = JSON.parse(result.content[0].text);

      expect(parseFloat(data.atr.value)).toBeGreaterThan(0);
      // Regime should be a valid string
      expect(data.atr.regime).toMatch(/CONTRACTING|STABLE|EXPANDING|SPIKE/);
      // Ratio should be a positive number
      expect(parseFloat(data.atr.ratio)).toBeGreaterThan(0);
    });

    it('computes RSI > 70 for monotonically rising prices', async () => {
      // Note: the tool reverses candles (most recent first after reverse)
      // So we generate candles in descending time order, with ascending prices
      // after reverse → closes will be ascending → RSI > 70
      const candles = Array.from({ length: 50 }, (_, i) => ({
        startTime: Date.now() - i * 3_600_000, // i=0 is most recent
        open: String(200 - i * 2),
        high: String(203 - i * 2),
        low: String(199 - i * 2),
        close: String(202 - i * 2),
        volume: '1000',
      }));
      iridium.getPriceHistory.mockResolvedValue(candles);

      const handler = server.getHandler('get_technical_analysis')!;
      const result = await handler({
        marketId: 1, interval: '1h', limit: 200, indicators: ['rsi'],
      });
      const data = JSON.parse(result.content[0].text);

      expect(parseFloat(data.rsi.value)).toBeGreaterThan(70);
      expect(data.rsi.signal).toBe('OVERBOUGHT');
    });
  });
});
