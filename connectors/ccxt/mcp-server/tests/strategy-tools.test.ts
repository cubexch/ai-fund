import { describe, it, expect } from 'vitest';
import { registerStrategyTools } from '../src/tools/strategy.js';
import { createMockClient, MockMcpServer } from './helpers.js';

function setup(overrides: Record<string, unknown> = {}) {
  const client = createMockClient({
    getBars: async () => {
      // Generate 100 bars of mock data with realistic price movement
      const bars = [];
      let price = 65000;
      for (let i = 0; i < 100; i++) {
        const change = (Math.sin(i * 0.3) * 500) + (Math.random() - 0.5) * 200;
        price += change;
        bars.push({
          timestamp: 1700000000000 + i * 86400000,
          open: price - 100,
          high: price + 200,
          low: price - 300,
          close: price,
          volume: 1000 + Math.random() * 500,
        });
      }
      return bars;
    },
    getTradingFees: async () => [
      { symbol: 'BTC/USDT', maker: 0.001, taker: 0.002, percentage: true },
    ],
    getExchangeInfo: async () => ({
      id: 'coinbase',
      name: 'Coinbase',
      countries: ['US'],
      rateLimit: 100,
      has: { fetchTicker: true, createOrder: true, editOrder: true },
      timeframes: ['1m', '5m', '15m', '1h', '4h', '1d'],
      totalMarkets: 500,
      activeMarkets: 480,
    }),
    getMarketInfo: async () => ({
      symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', type: 'spot',
      active: true,
      precision: { amount: 8, price: 2 },
      limits: { amount: { min: 0.0001, max: 100 }, price: { min: 0.01, max: 1000000 } },
      maker: 0.001, taker: 0.002,
    }),
    ensureMarkets: async () => {},
    roundAmount: (sym: string, amount: number) => Math.round(amount * 100000000) / 100000000,
    ...overrides,
  } as any);
  const server = new MockMcpServer();
  registerStrategyTools(server as any, client);
  return { server, client };
}

// ── get_technical_analysis ────────────────────────────────

describe('get_technical_analysis tool', () => {
  it('returns indicators with valid structure', async () => {
    const { server } = setup();
    const result = await server.callTool('get_technical_analysis', {
      symbol: 'BTC/USDT', timeframe: '1d', limit: 100,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframe).toBe('1d');
    expect(data.candles).toBe(100);
    expect(data.latest.price).toBeTypeOf('number');
    expect(data.latest.rsi).toBeTypeOf('number');
    expect(data.latest.rsi).toBeGreaterThanOrEqual(0);
    expect(data.latest.rsi).toBeLessThanOrEqual(100);
    expect(data.latest.macd).toBeDefined();
    expect(data.latest.macd.histogram).toBeTypeOf('number');
    expect(data.latest.bollingerBands).toBeDefined();
    expect(data.latest.bollingerBands.upper).toBeGreaterThan(data.latest.bollingerBands.lower);
    expect(data.latest.atr).toBeTypeOf('number');
    expect(data.latest.atr).toBeGreaterThan(0);
    expect(data.latest.stochastic).toBeDefined();
    expect(data.signals).toBeInstanceOf(Array);
    expect(data.signals.length).toBeGreaterThan(0);
  });

  it('rejects insufficient candle data', async () => {
    const { server } = setup({
      getBars: async () => [
        { timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      ],
    });
    const result = await server.callTool('get_technical_analysis', {
      symbol: 'BTC/USDT', timeframe: '1d', limit: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 26 candles');
  });

  it('generates RSI signals correctly', async () => {
    // Build data that will produce extreme RSI
    const { server } = setup({
      getBars: async () => {
        const bars = [];
        let price = 100;
        // 50 bars of straight up
        for (let i = 0; i < 50; i++) {
          price += 10;
          bars.push({
            timestamp: 1700000000000 + i * 86400000,
            open: price - 5, high: price + 5, low: price - 10, close: price,
            volume: 1000,
          });
        }
        return bars;
      },
    });
    const result = await server.callTool('get_technical_analysis', {
      symbol: 'BTC/USDT', timeframe: '1d', limit: 50,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.latest.rsi).toBeGreaterThan(70);
    expect(data.signals).toContain('RSI overbought (>70)');
  });
});

// ── calculate_position_size ───────────────────────────────

describe('calculate_position_size tool', () => {
  it('calculates Kelly position size', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_position_size', {
      method: 'kelly',
      portfolio_value: 100000,
      win_rate: 0.55,
      avg_win_loss_ratio: 1.5,
      entry_price: 65000,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.method).toBe('kelly');
    expect(data.halfKelly).toBe(true);
    expect(data.kellyFraction).toBeGreaterThan(0);
    expect(data.kellyFraction).toBeLessThan(1);
    expect(data.capitalToRisk).toBeGreaterThan(0);
    expect(data.positionSize).toBeGreaterThan(0);
    expect(data.portfolioValue).toBe(100000);
  });

  it('calculates fixed-fractional position size', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_position_size', {
      method: 'fixed_fractional',
      portfolio_value: 100000,
      risk_per_trade: 0.02,
      entry_price: 65000,
      stop_loss_price: 63000,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.method).toBe('fixed_fractional');
    expect(data.positionSize).toBeGreaterThan(0);
    expect(data.maxLoss).toBe(2000); // 2% of 100k
    expect(data.riskPerUnit).toBe(2000); // 65000 - 63000
    // position size = 2000 / 2000 = 1.0 BTC
    expect(data.positionSize).toBe(1);
  });

  it('rounds to exchange precision when symbol provided', async () => {
    const { server, client } = setup();
    const result = await server.callTool('calculate_position_size', {
      method: 'kelly',
      portfolio_value: 100000,
      win_rate: 0.55,
      avg_win_loss_ratio: 1.5,
      entry_price: 65000,
      symbol: 'BTC/USDT',
    });

    expect(client.calls).toContainEqual(
      expect.objectContaining({ method: 'ensureMarkets' })
    );
    expect(client.calls).toContainEqual(
      expect.objectContaining({ method: 'roundAmount' })
    );
  });

  it('rejects Kelly without required params', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_position_size', {
      method: 'kelly',
      portfolio_value: 100000,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('win_rate');
  });

  it('rejects fixed-fractional without required params', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_position_size', {
      method: 'fixed_fractional',
      portfolio_value: 100000,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('risk_per_trade');
  });
});

// ── get_fees ──────────────────────────────────────────────

describe('get_fees tool', () => {
  it('returns fee rates', async () => {
    const { server } = setup();
    const result = await server.callTool('get_fees', { symbol: 'BTC/USDT' });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].symbol).toBe('BTC/USDT');
    expect(data[0].maker).toBe(0.001);
    expect(data[0].taker).toBe(0.002);
  });

  it('returns fees without symbol filter', async () => {
    const { server } = setup();
    const result = await server.callTool('get_fees', {});
    const data = JSON.parse(result.content[0].text);
    expect(data.length).toBeGreaterThan(0);
  });
});

// ── get_exchange_info ─────────────────────────────────────

describe('get_exchange_info tool', () => {
  it('returns exchange capabilities', async () => {
    const { server } = setup();
    const result = await server.callTool('get_exchange_info', {});

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe('coinbase');
    expect(data.name).toBe('Coinbase');
    expect(data.has).toBeDefined();
    expect(data.has.fetchTicker).toBe(true);
    expect(data.timeframes).toContain('1h');
    expect(data.totalMarkets).toBe(500);
    expect(data.activeMarkets).toBe(480);
  });
});

// ── get_market_info ───────────────────────────────────────

describe('get_market_info tool', () => {
  it('returns market precision and limits', async () => {
    const { server } = setup();
    const result = await server.callTool('get_market_info', { symbol: 'BTC/USDT' });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.precision.amount).toBe(8);
    expect(data.precision.price).toBe(2);
    expect(data.limits.amount.min).toBe(0.0001);
    expect(data.maker).toBe(0.001);
    expect(data.taker).toBe(0.002);
  });
});

// ── assess_portfolio_risk ────────────────────────────────

describe('assess_portfolio_risk tool', () => {
  it('returns VaR as a positive number', async () => {
    const { server } = setup();
    const result = await server.callTool('assess_portfolio_risk', {
      symbols: 'BTC/USDT,ETH/USDT',
      weights: '0.6,0.4',
      portfolio_value: 100000,
      confidence: 0.95,
      period: 90,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.portfolio.valueAtRisk).toBeGreaterThan(0);
    expect(data.portfolio.value).toBe(100000);
    expect(data.portfolio.confidence).toBe(0.95);
  });

  it('returns per-symbol stats with sharpe, volatility, maxDrawdown', async () => {
    const { server } = setup();
    const result = await server.callTool('assess_portfolio_risk', {
      symbols: 'BTC/USDT,ETH/USDT',
      weights: '0.6,0.4',
      portfolio_value: 100000,
      confidence: 0.95,
      period: 90,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.perSymbol).toHaveLength(2);
    for (const sym of data.perSymbol) {
      expect(sym.annualizedVolatility).toBeTypeOf('number');
      expect(sym.annualizedVolatility).toBeGreaterThan(0);
      expect(sym.maxDrawdown).toBeTypeOf('number');
      expect(sym.maxDrawdown).toBeGreaterThanOrEqual(0);
      expect(sym.sharpeRatio).toBeTypeOf('number');
      expect(sym.weight).toBeTypeOf('number');
    }
    expect(data.perSymbol[0].symbol).toBe('BTC/USDT');
    expect(data.perSymbol[1].symbol).toBe('ETH/USDT');
  });

  it('returns correlations matrix', async () => {
    const { server } = setup();
    const result = await server.callTool('assess_portfolio_risk', {
      symbols: 'BTC/USDT,ETH/USDT',
      weights: '0.6,0.4',
      portfolio_value: 100000,
      confidence: 0.95,
      period: 90,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.correlations).toBeDefined();
    expect(data.correlations.matrix).toHaveLength(2);
    expect(data.correlations.matrix[0]).toHaveLength(2);
    expect(data.correlations.labels).toEqual(['BTC/USDT', 'ETH/USDT']);
    // Diagonal should be 1
    expect(data.correlations.matrix[0][0]).toBe(1);
    expect(data.correlations.matrix[1][1]).toBe(1);
    // Off-diagonal should be between -1 and 1
    expect(data.correlations.matrix[0][1]).toBeGreaterThanOrEqual(-1);
    expect(data.correlations.matrix[0][1]).toBeLessThanOrEqual(1);
  });

  it('rejects mismatched symbols/weights length', async () => {
    const { server } = setup();
    const result = await server.callTool('assess_portfolio_risk', {
      symbols: 'BTC/USDT,ETH/USDT,SOL/USDT',
      weights: '0.6,0.4',
      portfolio_value: 100000,
      confidence: 0.95,
      period: 90,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Mismatched');
  });

  it('rejects weights that do not sum to ~1.0', async () => {
    const { server } = setup();
    const result = await server.callTool('assess_portfolio_risk', {
      symbols: 'BTC/USDT,ETH/USDT',
      weights: '0.5,0.3',
      portfolio_value: 100000,
      confidence: 0.95,
      period: 90,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('sum to');
  });
});
