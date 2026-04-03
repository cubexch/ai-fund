import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerAccountTools } from '../src/tools/account';

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
    getPositions: vi.fn().mockResolvedValue({}),
    getTickers: vi.fn().mockResolvedValue([]),
    getAssetRegistry: vi.fn().mockResolvedValue({ getById: () => null }),
    getOrderHistory: vi.fn().mockResolvedValue([]),
    getFills: vi.fn().mockResolvedValue([]),
    getSubaccounts: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('registerAccountTools', () => {
  let server: ReturnType<typeof createMockServer>;
  let iridium: ReturnType<typeof createMockIridium>;

  beforeEach(() => {
    server = createMockServer();
    iridium = createMockIridium();
    registerAccountTools(server as any, iridium as any);
  });

  it('registers all 6 account tools', () => {
    expect(server.tool).toHaveBeenCalledTimes(6);
    const names = server.tool.mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('get_positions');
    expect(names).toContain('get_account');
    expect(names).toContain('get_order_history');
    expect(names).toContain('get_fills');
    expect(names).toContain('get_subaccounts');
    expect(names).toContain('get_deposit_address');
  });

  describe('get_positions', () => {
    it('returns positions from iridium', async () => {
      const positions = { spot: { inner: [{ assetId: 1, amount: '100' }] } };
      iridium.getPositions.mockResolvedValue(positions);

      const handler = server.getHandler('get_positions')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.spot).toBeDefined();
      expect(iridium.getPositions).toHaveBeenCalledWith(1);
    });

    it('uses custom subaccountId when provided', async () => {
      const handler = server.getHandler('get_positions')!;
      await handler({ subaccountId: 42 });

      expect(iridium.getPositions).toHaveBeenCalledWith(42);
    });

    it('returns error on failure', async () => {
      iridium.getPositions.mockRejectedValue(new Error('Auth required'));

      const handler = server.getHandler('get_positions')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Auth required');
    });
  });

  describe('get_account', () => {
    it('computes USD values and sorts by value descending', async () => {
      const mockRegistry = {
        getById: (id: number) =>
          id === 1 ? { symbol: 'BTC', icon: '₿' } : id === 2 ? { symbol: 'USDC', icon: '◉' } : null,
      };

      iridium.getPositions.mockResolvedValue({
        spot: {
          inner: [
            { assetId: 1, amount: '0.5' },
            { assetId: 2, amount: '5000' },
          ],
        },
      });
      iridium.getTickers.mockResolvedValue([
        { symbol: 'BTCUSDC', lastPrice: 60000 },
      ]);
      iridium.getAssetRegistry.mockResolvedValue(mockRegistry);

      const handler = server.getHandler('get_account')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.balances).toHaveLength(2);
      // BTC ($30k) should be before USDC ($5k)
      expect(data.balances[0].symbol).toBe('BTC');
      expect(data.balances[1].symbol).toBe('USDC');
      expect(data.totalValue).toBe('$35000.00');
    });
  });

  describe('get_subaccounts', () => {
    it('returns subaccounts list', async () => {
      const subaccounts = [{ id: 1, name: 'Main' }];
      iridium.getSubaccounts.mockResolvedValue(subaccounts);

      const handler = server.getHandler('get_subaccounts')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data).toEqual(subaccounts);
    });
  });

  describe('get_order_history', () => {
    it('passes marketId and limit filters', async () => {
      const handler = server.getHandler('get_order_history')!;
      await handler({ marketId: 100086, limit: 10 });

      expect(iridium.getOrderHistory).toHaveBeenCalledWith(1, { marketId: 100086, limit: 10 });
    });
  });

  describe('get_fills', () => {
    it('passes filters to iridium', async () => {
      const handler = server.getHandler('get_fills')!;
      await handler({ marketId: 100086, limit: 25 });

      expect(iridium.getFills).toHaveBeenCalledWith(1, { marketId: 100086, limit: 25 });
    });
  });
});
