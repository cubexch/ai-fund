import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRiskTools } from '../src/tools/risk.js';

// ── Mock helpers ────────────────────────────────────────────

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
    getAssetRegistry: vi.fn().mockResolvedValue({
      getById: () => null,
    }),
    ...overrides,
  };
}

describe('registerRiskTools', () => {
  let server: ReturnType<typeof createMockServer>;
  let iridium: ReturnType<typeof createMockIridium>;

  beforeEach(() => {
    server = createMockServer();
    iridium = createMockIridium();
    registerRiskTools(server as any, iridium as any);
  });

  it('registers get_portfolio_summary and calculate_position_size tools', () => {
    expect(server.tool).toHaveBeenCalledTimes(2);
    const names = server.tool.mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('get_portfolio_summary');
    expect(names).toContain('calculate_position_size');
  });

  describe('calculate_position_size', () => {
    it('calculates fixed fractional size for a long trade', async () => {
      const handler = server.getHandler('calculate_position_size')!;
      const result = await handler({
        portfolioValue: 100_000,
        riskPerTrade: 0.02,
        entryPrice: 50,
        stopLossPrice: 48,
      });

      const data = JSON.parse(result.content[0].text);
      // maxLoss = 100000 * 0.02 = 2000, riskPerUnit = 2, size = 1000
      expect(parseFloat(data.fixedFractional.size)).toBeCloseTo(1000);
      expect(data.params.direction).toBe('LONG');
    });

    it('calculates short direction correctly', async () => {
      const handler = server.getHandler('calculate_position_size')!;
      const result = await handler({
        portfolioValue: 100_000,
        riskPerTrade: 0.02,
        entryPrice: 50,
        stopLossPrice: 52,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.params.direction).toBe('SHORT');
    });

    it('returns error when entry equals stop loss', async () => {
      const handler = server.getHandler('calculate_position_size')!;
      const result = await handler({
        portfolioValue: 100_000,
        riskPerTrade: 0.02,
        entryPrice: 50,
        stopLossPrice: 50,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('cannot be the same');
    });

    it('includes Kelly sizing when winRate and avgWinLoss provided', async () => {
      const handler = server.getHandler('calculate_position_size')!;
      const result = await handler({
        portfolioValue: 100_000,
        riskPerTrade: 0.02,
        entryPrice: 50,
        stopLossPrice: 48,
        winRate: 0.6,
        avgWinLoss: 2,
      });

      const data = JSON.parse(result.content[0].text);
      expect(data.kelly).toBeDefined();
      expect(data.recommended.method).toBe('min(fixedFractional, halfKelly)');
    });
  });

  describe('get_portfolio_summary', () => {
    it('returns portfolio summary with positions', async () => {
      const mockRegistry = {
        getById: (id: number) =>
          id === 1 ? { symbol: 'BTC', icon: '₿' } : id === 2 ? { symbol: 'USDC', icon: '◉' } : null,
      };

      iridium.getPositions.mockResolvedValue({
        spot: {
          inner: [
            { assetId: 1, amount: '0.5' },
            { assetId: 2, amount: '10000' },
          ],
        },
      });
      iridium.getTickers.mockResolvedValue([
        { symbol: 'BTCUSDC', lastPrice: 60000 },
      ]);
      iridium.getAssetRegistry.mockResolvedValue(mockRegistry);

      const handler = server.getHandler('get_portfolio_summary')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.positionCount).toBe(2);
      expect(parseFloat(data.totalPortfolioValue.replace('$', ''))).toBeGreaterThan(0);
    });

    it('returns error on failure', async () => {
      iridium.getPositions.mockRejectedValue(new Error('Network error'));

      const handler = server.getHandler('get_portfolio_summary')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });
  });
});
