import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerMarketResources } from '../src/resources/markets.js';
import { registerPortfolioResources } from '../src/resources/portfolio.js';

function createMockServer() {
  const resources = new Map<string, Function>();
  return {
    resource: vi.fn((name: string, _uri: string, _opts: any, handler: Function) => {
      resources.set(name, handler);
    }),
    getHandler: (name: string) => resources.get(name),
  };
}

function createMockIridium(overrides: Record<string, any> = {}) {
  return {
    getDefaultSubaccountId: vi.fn().mockResolvedValue(1),
    getMarkets: vi.fn().mockResolvedValue([]),
    getTickers: vi.fn().mockResolvedValue([]),
    getPositions: vi.fn().mockResolvedValue({}),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ── Market Resources ────────────────────────────────────────

describe('registerMarketResources', () => {
  let server: ReturnType<typeof createMockServer>;
  let iridium: ReturnType<typeof createMockIridium>;

  beforeEach(() => {
    server = createMockServer();
    iridium = createMockIridium();
    registerMarketResources(server as any, iridium as any);
  });

  it('registers markets and tickers resources', () => {
    expect(server.resource).toHaveBeenCalledTimes(2);
    const names = server.resource.mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('markets');
    expect(names).toContain('tickers');
  });

  describe('markets resource', () => {
    it('returns markets data as JSON', async () => {
      const markets = [{ marketId: 1, symbol: 'BTCUSDC' }, { marketId: 2, symbol: 'ETHUSDC' }];
      iridium.getMarkets.mockResolvedValue(markets);

      const handler = server.getHandler('markets')!;
      const result = await handler();

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('cube://markets');
      expect(result.contents[0].mimeType).toBe('application/json');
      const data = JSON.parse(result.contents[0].text);
      expect(data).toEqual(markets);
    });
  });

  describe('tickers resource', () => {
    it('returns ticker data as JSON', async () => {
      const tickers = [{ symbol: 'BTCUSDC', lastPrice: 60000 }];
      iridium.getTickers.mockResolvedValue(tickers);

      const handler = server.getHandler('tickers')!;
      const result = await handler();

      expect(result.contents[0].uri).toBe('cube://tickers');
      const data = JSON.parse(result.contents[0].text);
      expect(data).toEqual(tickers);
    });
  });
});

// ── Portfolio Resources ────────────────────────────────────

describe('registerPortfolioResources', () => {
  let server: ReturnType<typeof createMockServer>;
  let iridium: ReturnType<typeof createMockIridium>;

  beforeEach(() => {
    server = createMockServer();
    iridium = createMockIridium();
    registerPortfolioResources(server as any, iridium as any);
  });

  it('registers portfolio resource', () => {
    expect(server.resource).toHaveBeenCalledTimes(1);
    expect(server.resource.mock.calls[0][0]).toBe('portfolio');
  });

  describe('portfolio resource', () => {
    it('returns positions and recent orders', async () => {
      const positions = { spot: { inner: [{ assetId: 1, amount: '100' }] } };
      const orders = [{ orderId: '123', status: 'filled' }];
      iridium.getPositions.mockResolvedValue(positions);
      iridium.getOrderHistory.mockResolvedValue(orders);

      const handler = server.getHandler('portfolio')!;
      const result = await handler();

      const data = JSON.parse(result.contents[0].text);
      expect(data.subaccountId).toBe(1);
      expect(data.positions).toEqual(positions);
      expect(data.recentOrders).toEqual(orders);
    });

    it('gracefully handles API errors', async () => {
      iridium.getPositions.mockRejectedValue(new Error('Auth failed'));
      iridium.getOrderHistory.mockRejectedValue(new Error('Auth failed'));

      const handler = server.getHandler('portfolio')!;
      const result = await handler();

      const data = JSON.parse(result.contents[0].text);
      // Errors are caught and return empty defaults
      expect(data.positions).toEqual({});
      expect(data.recentOrders).toEqual([]);
    });
  });
});
