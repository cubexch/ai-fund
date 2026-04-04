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

function createSnapshot(price: number, volume: number) {
  return {
    latestTrade: { p: price },
    dailyBar: { v: volume },
  };
}

function createMockClient(overrides: Record<string, any> = {}) {
  return {
    getBars: vi.fn().mockResolvedValue(createBars(200)),
    getPositions: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({ portfolio_value: '100000' }),
    getSnapshots: vi.fn().mockResolvedValue({
      AAPL: createSnapshot(150, 50_000_000),
    }),
    ...overrides,
  };
}

// ── Error Path Tests ─────────────────────────────────────

describe('registerAnalysisTools — error paths', () => {
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

// ── get_technical_analysis ───���───────────────────────────

describe('get_technical_analysis — happy path', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerAnalysisTools(server as any, client as any);
  });

  it('returns SMA and EMA for sufficient data', async () => {
    const handler = server.getHandler('get_technical_analysis')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframe: '1Day',
      limit: 200,
      indicators: ['sma', 'ema'],
      sma_period: 20,
      ema_period: 20,
      rsi_period: 14,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('AAPL');
    expect(data.sma).toBeDefined();
    expect(data.sma.period).toBe(20);
    expect(typeof data.sma.current).toBe('number');
    expect(data.ema).toBeDefined();
    expect(data.ema.period).toBe(20);
  });

  it('returns RSI with overbought/oversold signal', async () => {
    const handler = server.getHandler('get_technical_analysis')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframe: '1Day',
      limit: 200,
      indicators: ['rsi'],
      sma_period: 20,
      ema_period: 20,
      rsi_period: 14,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.rsi).toBeDefined();
    expect(data.rsi.period).toBe(14);
    expect(['overbought', 'oversold', 'neutral']).toContain(data.rsi.signal);
  });

  it('returns MACD with trend signal', async () => {
    const handler = server.getHandler('get_technical_analysis')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframe: '1Day',
      limit: 200,
      indicators: ['macd'],
      sma_period: 20,
      ema_period: 20,
      rsi_period: 14,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.macd).toBeDefined();
    expect(['bullish', 'bearish']).toContain(data.macd.trend);
    expect(typeof data.macd.macd).toBe('number');
    expect(typeof data.macd.signal).toBe('number');
    expect(typeof data.macd.histogram).toBe('number');
  });

  it('returns Bollinger Bands with position', async () => {
    const handler = server.getHandler('get_technical_analysis')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframe: '1Day',
      limit: 200,
      indicators: ['bbands'],
      sma_period: 20,
      ema_period: 20,
      rsi_period: 14,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.bollingerBands).toBeDefined();
    expect(data.bollingerBands.upper).toBeGreaterThan(data.bollingerBands.middle);
    expect(data.bollingerBands.middle).toBeGreaterThan(data.bollingerBands.lower);
    expect(['above_upper', 'below_lower', 'inside']).toContain(data.bollingerBands.position);
  });

  it('returns ATR values', async () => {
    const handler = server.getHandler('get_technical_analysis')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframe: '1Day',
      limit: 200,
      indicators: ['atr'],
      sma_period: 20,
      ema_period: 20,
      rsi_period: 14,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.atr).toBeDefined();
    expect(data.atr.current).toBeGreaterThan(0);
    expect(data.atr.values).toHaveLength(5);
  });

  it('returns stochastic with signal', async () => {
    const handler = server.getHandler('get_technical_analysis')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframe: '1Day',
      limit: 200,
      indicators: ['stochastic'],
      sma_period: 20,
      ema_period: 20,
      rsi_period: 14,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.stochastic).toBeDefined();
    expect(typeof data.stochastic.k).toBe('number');
    expect(typeof data.stochastic.d).toBe('number');
    expect(['overbought', 'oversold', 'neutral']).toContain(data.stochastic.signal);
  });

  it('handles client errors gracefully', async () => {
    client.getBars.mockRejectedValue(new Error('Network timeout'));

    const handler = server.getHandler('get_technical_analysis')!;
    const result = await handler({
      symbol: 'AAPL',
      timeframe: '1Day',
      limit: 200,
      indicators: ['sma'],
      sma_period: 20,
      ema_period: 20,
      rsi_period: 14,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Network timeout');
  });
});

// ── plan_twap ────────────────────────────────────────────

describe('plan_twap', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerAnalysisTools(server as any, client as any);
  });

  it('returns a TWAP plan with slices', async () => {
    const handler = server.getHandler('plan_twap')!;
    const result = await handler({
      symbol: 'AAPL',
      total_amount: 1000,
      duration_minutes: 60,
      num_slices: 10,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('AAPL');
    expect(data.slices).toHaveLength(10);
    expect(data.slices[0].amount).toBe(100); // 1000/10
  });

  it('errors when no snapshot available', async () => {
    client.getSnapshots.mockResolvedValue({});

    const handler = server.getHandler('plan_twap')!;
    const result = await handler({
      symbol: 'UNKNOWN',
      total_amount: 100,
      duration_minutes: 30,
      num_slices: 5,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No snapshot');
  });
});

// ── simulate_market_impact ───────���───────────────────────

describe('simulate_market_impact', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerAnalysisTools(server as any, client as any);
  });

  it('returns impact estimate with volatility', async () => {
    const handler = server.getHandler('simulate_market_impact')!;
    const result = await handler({
      symbol: 'AAPL',
      amount: 500,
      lookback: 60,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('AAPL');
    expect(data.amount).toBe(500);
    expect(data.temporaryImpactBps).toBeGreaterThanOrEqual(0);
    expect(data.permanentImpactBps).toBeGreaterThanOrEqual(0);
    expect(typeof data.realizedVolatility).toBe('number');
  });

  it('errors when no snapshot available', async () => {
    client.getSnapshots.mockResolvedValue({});

    const handler = server.getHandler('simulate_market_impact')!;
    const result = await handler({
      symbol: 'UNKNOWN',
      amount: 100,
      lookback: 60,
    });

    expect(result.isError).toBe(true);
  });
});

// ── calculate_position_size ──────────────────────────────

describe('calculate_position_size', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerAnalysisTools(server as any, client as any);
  });

  it('returns Kelly and fixed-fractional sizing', async () => {
    const handler = server.getHandler('calculate_position_size')!;
    const result = await handler({
      symbol: 'AAPL',
      entry_price: 150,
      stop_loss_price: 140,
      win_rate: 0.55,
      avg_win_loss_ratio: 1.5,
      risk_per_trade: 0.02,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('AAPL');
    expect(data.portfolioValue).toBe(100000);
    expect(data.kelly).toBeDefined();
    expect(data.kelly.suggestedShares).toBeGreaterThan(0);
    expect(data.fixedFractional).toBeDefined();
    expect(data.fixedFractional.suggestedShares).toBeGreaterThan(0);
    expect(data.fixedFractional.maxLoss).toBe(2000); // 100k * 0.02
    expect(data.recommendation).toBeTruthy();
  });

  it('handles account fetch errors', async () => {
    client.getAccount.mockRejectedValue(new Error('Auth expired'));

    const handler = server.getHandler('calculate_position_size')!;
    const result = await handler({
      symbol: 'AAPL',
      entry_price: 150,
      stop_loss_price: 140,
      win_rate: 0.55,
      avg_win_loss_ratio: 1.5,
      risk_per_trade: 0.02,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Auth expired');
  });
});

// ── calculate_dca_schedule ───────────��───────────────────

describe('calculate_dca_schedule', () => {
  let server: ReturnType<typeof createMockServer>;
  let client: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    server = createMockServer();
    client = createMockClient();
    registerAnalysisTools(server as any, client as any);
  });

  it('returns a DCA schedule with vol adjustment', async () => {
    const handler = server.getHandler('calculate_dca_schedule')!;
    const result = await handler({
      symbol: 'AAPL',
      total_amount: 10000,
      num_orders: 5,
      vol_adjust: true,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('AAPL');
    expect(data.totalAmount).toBe(10000);
    expect(data.numOrders).toBe(5);
    expect(data.volAdjusted).toBe(true);
    expect(data.schedule).toHaveLength(5);
    expect(data.estimatedTotalShares).toBeGreaterThan(0);
  });

  it('returns schedule without vol adjustment', async () => {
    const handler = server.getHandler('calculate_dca_schedule')!;
    const result = await handler({
      symbol: 'AAPL',
      total_amount: 5000,
      num_orders: 10,
      vol_adjust: false,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.volAdjusted).toBe(false);
    expect(data.schedule).toHaveLength(10);
  });

  it('errors when no snapshot available', async () => {
    client.getSnapshots.mockResolvedValue({});

    const handler = server.getHandler('calculate_dca_schedule')!;
    const result = await handler({
      symbol: 'UNKNOWN',
      total_amount: 1000,
      num_orders: 5,
      vol_adjust: true,
    });

    expect(result.isError).toBe(true);
  });
});

// ── Tool registration ──────��─────────────────────────────

describe('tool registration', () => {
  it('registers all 7 analysis tools', () => {
    const server = createMockServer();
    const client = createMockClient();
    registerAnalysisTools(server as any, client as any);

    const expectedTools = [
      'get_technical_analysis',
      'detect_confluence',
      'assess_portfolio_risk',
      'plan_twap',
      'simulate_market_impact',
      'calculate_position_size',
      'calculate_dca_schedule',
    ];

    expect(server.tool).toHaveBeenCalledTimes(7);
    for (const name of expectedTools) {
      expect(server.getHandler(name)).toBeDefined();
    }
  });
});
