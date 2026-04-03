import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerRiskTools } from '../src/tools/risk';

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

  it('registers get_portfolio and calculate_position_size tools', () => {
    expect(server.tool).toHaveBeenCalledTimes(2);
    const names = server.tool.mock.calls.map((c: any[]) => c[0]);
    expect(names).toContain('get_portfolio');
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
      // maxLoss = 100000 * 0.02 = 2000, riskPerUnit = |50-48| = 2, size = 2000/2 = 1000
      expect(parseFloat(data.fixedFractional.size)).toBeCloseTo(1000, 0);
      expect(data.fixedFractional.maxLoss).toBe('$2000.00');
      expect(data.fixedFractional.riskPercent).toBe('2.0%');
      expect(data.fixedFractional.value).toBe('$50000.00'); // 1000 * $50
      expect(data.params.direction).toBe('LONG');
      expect(data.params.riskPerUnit).toBe('2.00');
      expect(data.recommended.method).toBe('fixedFractional');
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
      // riskPerUnit = |50-52| = 2, size = 2000/2 = 1000
      expect(parseFloat(data.fixedFractional.size)).toBeCloseTo(1000, 0);
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
      // Kelly = 0.6 - (0.4)/2 = 0.4, half-Kelly = 0.2
      expect(data.kelly.fullKelly).toBe('40.0%');
      expect(data.kelly.halfKelly).toBe('20.0%');
      // Kelly size = (100000 * 0.2) / 50 = 400
      expect(parseFloat(data.kelly.size)).toBeCloseTo(400, 0);
      expect(data.kelly.value).toBe('$20000.00');
      // Recommended = min(1000, 400) = 400
      expect(parseFloat(data.recommended.size)).toBeCloseTo(400, 0);
      expect(data.recommended.method).toBe('min(fixedFractional, halfKelly)');
    });

    it('uses fixed fractional when Kelly fraction is negative', async () => {
      const handler = server.getHandler('calculate_position_size')!;
      const result = await handler({
        portfolioValue: 100_000,
        riskPerTrade: 0.02,
        entryPrice: 50,
        stopLossPrice: 48,
        winRate: 0.2, // poor win rate
        avgWinLoss: 1,
      });

      const data = JSON.parse(result.content[0].text);
      // Kelly = 0.2 - 0.8/1 = -0.6, half-Kelly = max(0, -0.3) = 0
      // Kelly size = 0, so recommended = fixedFractional = 1000
      expect(parseFloat(data.recommended.size)).toBeCloseTo(1000, 0);
    });

    it('handles tiny risk with precision', async () => {
      const handler = server.getHandler('calculate_position_size')!;
      const result = await handler({
        portfolioValue: 10_000,
        riskPerTrade: 0.005, // 0.5%
        entryPrice: 65000,
        stopLossPrice: 64000,
      });

      const data = JSON.parse(result.content[0].text);
      // maxLoss = 10000 * 0.005 = 50, riskPerUnit = 1000, size = 0.05
      expect(parseFloat(data.fixedFractional.size)).toBeCloseTo(0.05, 4);
      expect(data.fixedFractional.maxLoss).toBe('$50.00');
    });
  });

  describe('get_portfolio', () => {
    it('returns portfolio summary with correct value calculations', async () => {
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

      const handler = server.getHandler('get_portfolio')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      // BTC: 0.5 * 60000 = 30000, USDC: 10000 * 1 = 10000, total = 40000
      expect(data.positionCount).toBe(2);
      expect(data.totalPortfolioValue).toBe('$40000.00');
      expect(data.positions[0].asset).toBe('BTC');
      expect(data.positions[0].amount).toBe(0.5);
      expect(data.positions[0].price).toBe(60000);
      expect(data.positions[0].value).toBe('30000.00');
      expect(data.positions[0].allocation).toBe('75.0%'); // 30000/40000
      expect(data.positions[1].asset).toBe('USDC');
      expect(data.positions[1].price).toBe(1); // stablecoin
      expect(data.positions[1].value).toBe('10000.00');
      expect(data.positions[1].allocation).toBe('25.0%');
    });

    it('handles unknown assets with fallback symbol', async () => {
      iridium.getPositions.mockResolvedValue({
        spot: { inner: [{ assetId: 999, amount: '100' }] },
      });
      iridium.getTickers.mockResolvedValue([]);
      iridium.getAssetRegistry.mockResolvedValue({
        getById: () => null,
      });

      const handler = server.getHandler('get_portfolio')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.positionCount).toBe(1);
      expect(data.positions[0].asset).toBe('ASSET-999');
      expect(data.positions[0].price).toBe('N/A'); // no ticker, no stablecoin
    });

    it('skips zero-amount positions', async () => {
      iridium.getPositions.mockResolvedValue({
        spot: {
          inner: [
            { assetId: 1, amount: '0' },
            { assetId: 2, amount: '5000' },
          ],
        },
      });
      iridium.getAssetRegistry.mockResolvedValue({
        getById: (id: number) =>
          id === 2 ? { symbol: 'USDC', icon: '◉' } : null,
      });

      const handler = server.getHandler('get_portfolio')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.positionCount).toBe(1);
      expect(data.positions[0].asset).toBe('USDC');
    });

    it('uses custom subaccountId', async () => {
      iridium.getPositions.mockResolvedValue({});
      iridium.getAssetRegistry.mockResolvedValue({ getById: () => null });

      const handler = server.getHandler('get_portfolio')!;
      await handler({ subaccountId: 42 });

      expect(iridium.getPositions).toHaveBeenCalledWith(42);
    });

    it('returns error on failure', async () => {
      iridium.getPositions.mockRejectedValue(new Error('Network error'));

      const handler = server.getHandler('get_portfolio')!;
      const result = await handler({});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network error');
    });

    it('handles empty portfolio', async () => {
      iridium.getPositions.mockResolvedValue({});
      iridium.getAssetRegistry.mockResolvedValue({ getById: () => null });

      const handler = server.getHandler('get_portfolio')!;
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);

      expect(data.positionCount).toBe(0);
      expect(data.totalPortfolioValue).toBe('$0.00');
      expect(data.positions).toHaveLength(0);
    });
  });
});
