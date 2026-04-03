import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerAnalysisTools } from '../src/tools/analysis';

function createMockServer() {
  const tools = new Map<string, Function>();
  return {
    tool: vi.fn((name: string, _desc: string, _schema: any, handler: Function) => {
      tools.set(name, handler);
    }),
    getHandler: (name: string) => tools.get(name),
  };
}

function createBars(length: number) {
  return Array.from({ length }, (_, i) => ({
    t: `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    o: 100 + i,
    h: 101 + i,
    l: 99 + i,
    c: 100 + i,
    v: 1000 + i,
  }));
}

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    getBars: vi.fn().mockResolvedValue(createBars(200)),
    getPositions: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({ portfolio_value: '100000' }),
    getSnapshots: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe('registerAnalysisTools', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerAnalysisTools(server as any, client as any);
  });

  it('rejects technical analysis requests without enough bars for the requested indicators', async () => {
    client.getBars.mockResolvedValue(createBars(10));

    const handler = server.getHandler('get_technical_analysis')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframe: '1Day',
      limit: 10,
      indicators: ['macd'],
      sma_period: 20,
      ema_period: 20,
      rsi_period: 14,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 26 bars');
  });

  it('rejects confluence requests when a timeframe has fewer than 51 bars', async () => {
    client.getBars.mockResolvedValue(createBars(40));

    const handler = server.getHandler('detect_confluence')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframes: ['15Min', '1Hour'],
      limit: 40,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 51 bars');
  });
});
