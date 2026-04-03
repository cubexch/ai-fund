import { describe, it, expect } from 'vitest';
import { registerStrategyTools } from '../src/tools/strategy';
import { createMockClient, MockMcpServer } from './helpers';

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
    getOrderBook: async () => ({
      symbol: 'BTC/USDT',
      bids: [
        [65000, 1.5], [64990, 2.0], [64980, 3.0], [64970, 1.0], [64960, 2.5],
      ] as [number, number][],
      asks: [
        [65010, 1.0], [65020, 2.0], [65030, 2.5], [65040, 1.5], [65050, 3.0],
      ] as [number, number][],
      bestBid: 65000,
      bestAsk: 65010,
      mid: 65005,
      spread: 10,
      spreadBps: 1.54,
      timestamp: 1700000000000,
    }),
    getQuote: async () => ({
      symbol: 'BTC/USDT',
      bid: 65000,
      bidSize: 1.5,
      ask: 65010,
      askSize: 1.0,
      mid: 65005,
      spread: 10,
      spreadBps: 1.54,
      last: 65005,
      timestamp: 1700000000000,
    }),
    getTrades: async () => {
      const trades = [];
      for (let i = 0; i < 100; i++) {
        trades.push({
          id: String(i),
          timestamp: 1700000000000 + i * 1000,
          symbol: 'BTC/USDT',
          side: i % 3 === 0 ? 'sell' : 'buy',  // ~67% buy, ~33% sell
          price: 65005 + (Math.random() - 0.5) * 10,
          amount: 0.1 + Math.random() * 0.5,
          cost: undefined,
        });
      }
      return trades;
    },
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
    expect(data.latest.price).toBeGreaterThan(0);
    expect(data.latest.rsi).toBeGreaterThanOrEqual(0);
    expect(data.latest.rsi).toBeLessThanOrEqual(100);
    expect(data.latest.macd.histogram).toBeTypeOf('number');
    expect(data.latest.macd.signal).toBeTypeOf('number');
    expect(data.latest.macd.macd).toBeTypeOf('number');
    expect(data.latest.bollingerBands.upper).toBeGreaterThan(data.latest.bollingerBands.middle);
    expect(data.latest.bollingerBands.middle).toBeGreaterThan(data.latest.bollingerBands.lower);
    expect(data.latest.atr).toBeGreaterThan(0);
    if (data.latest.stochastic !== null) {
      expect(data.latest.stochastic.k).toBeGreaterThanOrEqual(0);
      expect(data.latest.stochastic.k).toBeLessThanOrEqual(100);
      expect(data.latest.stochastic.d).toBeGreaterThanOrEqual(0);
      expect(data.latest.stochastic.d).toBeLessThanOrEqual(100);
    }
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
    // Kelly = winRate - (1-winRate)/avgWinLossRatio = 0.55 - 0.45/1.5 = 0.25
    // Half Kelly = 0.125
    expect(data.kellyFraction).toBeCloseTo(0.125, 3);
    expect(data.capitalToRisk).toBeCloseTo(12500, 0); // 100000 * 0.125
    expect(data.positionSize).toBeCloseTo(12500 / 65000, 4); // capitalToRisk / entryPrice
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

// ── get_optimal_entry ───────────────────────────────────

describe('get_optimal_entry tool', () => {
  it('returns valid recommendation for buy with medium urgency', async () => {
    const { server } = setup();
    const result = await server.callTool('get_optimal_entry', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.5,
      urgency: 'medium',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.side).toBe('buy');
    expect(data.amount).toBe(0.5);
    // Mock orderBook: bid=65000, ask=65010, mid=65005, spread=10
    expect(data.currentMid).toBe(65005);
    expect(data.currentSpread).toBe(10);
    expect(data.spreadBps).toBeCloseTo(1.54, 1);
    expect(data.recommendedOrderType).toBe('limit');
    expect(data.recommendedPrice).toBe(65005); // mid for medium urgency
    expect(data.estimatedSlippage.pct).toBeGreaterThanOrEqual(0);
    expect(data.estimatedSlippage.absolutePerUnit).toBeGreaterThanOrEqual(0);
    expect(data.depthAnalysis.bidDepth01Pct).toBeGreaterThanOrEqual(0);
    expect(data.depthAnalysis.askDepth01Pct).toBeGreaterThanOrEqual(0);
    expect(data.tradeFlowSignal).toMatch(/^(bullish|bearish|neutral)$/);
    expect(data.tradeFlowImbalance).toBeTypeOf('number');
    expect(data.rationale).toBeTypeOf('string');
    expect(data.rationale.length).toBeGreaterThan(0);
  });

  it('returns market order recommendation for high urgency', async () => {
    const { server } = setup();
    const result = await server.callTool('get_optimal_entry', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.5,
      urgency: 'high',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.recommendedOrderType).toBe('market');
    expect(data.recommendedPrice).toBeNull();
    expect(data.rationale).toContain('High urgency');
    expect(data.rationale).toContain('market order');
  });

  it('returns limit order for low urgency', async () => {
    const { server } = setup();
    const result = await server.callTool('get_optimal_entry', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.5,
      urgency: 'low',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.recommendedOrderType).toBe('limit');
    expect(data.recommendedPrice).toBeTypeOf('number');
    // For buy low urgency, price should be near bid (below mid)
    expect(data.recommendedPrice).toBeLessThan(data.currentMid);
    expect(data.rationale).toContain('Low urgency');
  });

  it('computes slippage correctly from order book', async () => {
    // Custom order book: asks at 100, 101, 102 with size 1 each
    // Buying 2.5 should fill 1@100 + 1@101 + 0.5@102 = avg 100.6
    // Mid = 99.5, slippage = (100.6 - 99.5) / 99.5
    const { server } = setup({
      getOrderBook: async () => ({
        symbol: 'TEST/USDT',
        bids: [[99, 2.0], [98, 3.0]] as [number, number][],
        asks: [[100, 1.0], [101, 1.0], [102, 1.0]] as [number, number][],
        bestBid: 99,
        bestAsk: 100,
        mid: 99.5,
        spread: 1,
        spreadBps: 100.5,
        timestamp: 1700000000000,
      }),
      getQuote: async () => ({
        symbol: 'TEST/USDT',
        bid: 99, bidSize: 2.0,
        ask: 100, askSize: 1.0,
        mid: 99.5, spread: 1, spreadBps: 100.5,
        last: 99.5, timestamp: 1700000000000,
      }),
      getTrades: async () => [
        { id: '1', timestamp: 1700000000000, symbol: 'TEST/USDT', side: 'buy', price: 99.5, amount: 1, cost: undefined },
        { id: '2', timestamp: 1700000001000, symbol: 'TEST/USDT', side: 'sell', price: 99.5, amount: 1, cost: undefined },
      ],
    });

    const result = await server.callTool('get_optimal_entry', {
      symbol: 'TEST/USDT',
      side: 'buy',
      amount: 2.5,
      urgency: 'high',
    });

    const data = JSON.parse(result.content[0].text);
    // avg fill = (1*100 + 1*101 + 0.5*102) / 2.5 = 252/2.5 = 100.8
    const expectedAvg = (1 * 100 + 1 * 101 + 0.5 * 102) / 2.5;
    const expectedSlippagePct = Math.abs(expectedAvg - 99.5) / 99.5;
    expect(data.estimatedSlippage.pct).toBeCloseTo(expectedSlippagePct, 4);
    expect(data.estimatedSlippage.absolutePerUnit).toBeCloseTo(expectedAvg - 99.5, 1);

    // Trade flow: 1 buy, 1 sell = neutral (50/50)
    expect(data.tradeFlowSignal).toBe('neutral');
    expect(data.tradeFlowImbalance).toBe(0.5);
  });
});

// ── get_funding_rates ──────────────────────────────────

describe('get_funding_rates tool', () => {
  it('returns funding rates for multiple symbols', async () => {
    const { server } = setup({
      exchange: {
        fetchFundingRate: async (symbol: string) => ({
          symbol,
          fundingRate: 0.0001,
          fundingTimestamp: 1700000000000,
          markPrice: symbol.includes('BTC') ? 65100 : 3100,
          indexPrice: symbol.includes('BTC') ? 65000 : 3050,
          interestRate: 0.0001,
        }),
      },
    });
    const result = await server.callTool('get_funding_rates', {
      symbols: 'BTC/USDT:USDT,ETH/USDT:USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(2);
    expect(data[0].symbol).toBe('BTC/USDT:USDT');
    expect(data[0].fundingRate).toBe(0.0001);
    expect(data[0].fundingRateAnnualized).toBeTypeOf('number');
    expect(data[0].fundingRateAnnualized).toBeGreaterThan(0);
    // 0.0001 * 365 * 3 * 10000 / 100 = 10.95
    expect(data[0].fundingRateAnnualized).toBe(10.95);
    expect(data[0].nextFundingTime).toBe(1700000000000);
    expect(data[0].markPrice).toBe(65100);
    expect(data[0].indexPrice).toBe(65000);
    expect(data[0].interestRate).toBe(0.0001);
    expect(data[1].symbol).toBe('ETH/USDT:USDT');
  });

  it('returns error for unsupported symbols', async () => {
    const { server } = setup({
      exchange: {
        fetchFundingRate: async (symbol: string) => {
          throw new Error(`No funding rate for ${symbol}`);
        },
      },
    });
    const result = await server.callTool('get_funding_rates', {
      symbols: 'FAKECOIN/USDT:USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].symbol).toBe('FAKECOIN/USDT:USDT');
    expect(data[0].error).toContain('No funding rate');
  });

  it('returns error when exchange lacks fetchFundingRate', async () => {
    const { server } = setup({
      exchange: {},
    });
    const result = await server.callTool('get_funding_rates', {
      symbols: 'BTC/USDT:USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].error).toContain('does not support');
  });
});

// ── detect_basis_trade ─────────────────────────────────

describe('detect_basis_trade tool', () => {
  it('detects positive carry opportunity', async () => {
    const { server } = setup({
      getTicker: async (symbol: string) => {
        if (symbol === 'BTC/USDT') {
          return { symbol, last: 65000, mid: 65000, bid: 64990, ask: 65010 };
        }
        // Perp at premium
        return { symbol, last: 65100, mid: 65100, bid: 65090, ask: 65110 };
      },
      exchange: {
        fetchFundingRate: async () => ({
          fundingRate: 0.0001,
          fundingTimestamp: 1700000000000,
          markPrice: 65100,
          indexPrice: 65000,
          interestRate: 0.0001,
        }),
      },
    });

    const result = await server.callTool('detect_basis_trade', {
      base: 'BTC',
      quote: 'USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.base).toBe('BTC');
    expect(data.quote).toBe('USDT');
    expect(data.spotSymbol).toBe('BTC/USDT');
    expect(data.perpSymbol).toBe('BTC/USDT:USDT');
    expect(data.spotPrice).toBe(65000);
    expect(data.perpPrice).toBe(65100);
    expect(data.basis).toBeGreaterThan(0);
    // basis = (65100 - 65000) / 65000 * 100 ≈ 0.154%
    expect(data.basis).toBeCloseTo(0.154, 2);
    expect(data.basisAnnualized).toBeTypeOf('number');
    expect(data.basisAnnualized).toBeGreaterThan(0);
    expect(data.fundingRate).toBe(0.0001);
    expect(data.fundingRateAnnualized).toBeTypeOf('number');
    expect(data.fundingRateAnnualized).toBeGreaterThan(0);
    expect(data.totalCarryAnnualized).toBeGreaterThan(0);
    expect(data.estimatedFees).toBe(0.2);
    expect(data.netCarryAnnualized).toBeTypeOf('number');
    expect(data.signal).toContain('positive carry');
    expect(data.actionable).toBe(true);
  });

  it('handles missing funding rate gracefully', async () => {
    const { server } = setup({
      getTicker: async (symbol: string) => {
        if (symbol === 'ETH/USDT') {
          return { symbol, last: 3000, mid: 3000, bid: 2999, ask: 3001 };
        }
        return { symbol, last: 3010, mid: 3010, bid: 3009, ask: 3011 };
      },
      exchange: {
        fetchFundingRate: async () => {
          throw new Error('Not supported');
        },
      },
    });

    const result = await server.callTool('detect_basis_trade', {
      base: 'ETH',
      quote: 'USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.fundingRate).toBeNull();
    expect(data.fundingRateAnnualized).toBeNull();
    // Should still compute basis
    expect(data.basis).toBeGreaterThan(0);
    expect(data.totalCarryAnnualized).toBeTypeOf('number');
  });

  it('errors when spot ticker is unavailable', async () => {
    const { server } = setup({
      getTicker: async (symbol: string) => {
        if (symbol === 'FAKE/USDT') {
          throw new Error('Market not found');
        }
        return { symbol, last: 100, mid: 100, bid: 99, ask: 101 };
      },
      exchange: {},
    });

    const result = await server.callTool('detect_basis_trade', {
      base: 'FAKE',
      quote: 'USDT',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('spot price');
  });

  it('errors when perp ticker is unavailable', async () => {
    const { server } = setup({
      getTicker: async (symbol: string) => {
        if (symbol === 'SOL/USDT') {
          return { symbol, last: 100, mid: 100, bid: 99, ask: 101 };
        }
        throw new Error('Perp market not found');
      },
      exchange: {},
    });

    const result = await server.callTool('detect_basis_trade', {
      base: 'SOL',
      quote: 'USDT',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('perp price');
  });

  it('reports negligible carry when basis is near zero', async () => {
    const { server } = setup({
      getTicker: async (symbol: string) => {
        // Spot and perp at nearly same price
        return { symbol, last: 50000, mid: 50000, bid: 49999, ask: 50001 };
      },
      exchange: {
        fetchFundingRate: async () => ({
          fundingRate: 0.000001,
          fundingTimestamp: 1700000000000,
          markPrice: 50000,
          indexPrice: 50000,
          interestRate: 0.0001,
        }),
      },
    });

    const result = await server.callTool('detect_basis_trade', {
      base: 'BTC',
      quote: 'USDT',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.basis).toBeCloseTo(0, 1);
    expect(data.signal).toContain('Negligible');
    expect(data.actionable).toBe(false);
  });
});

// ── rebalance_portfolio ──────────────────────────────────

describe('rebalance_portfolio tool', () => {
  it('generates correct trades for rebalancing', async () => {
    const { server } = setup({
      getTicker: async (symbol: string) => {
        if (symbol === 'SOL/USDT') {
          return { symbol, last: 150, mid: 150, bid: 149, ask: 151 };
        }
        return { symbol, last: 100, mid: 100, bid: 99, ask: 101 };
      },
    });

    const holdings = JSON.stringify([
      { symbol: 'BTC/USDT', amount: 0.5, price: 65000 },
      { symbol: 'ETH/USDT', amount: 10, price: 3500 },
    ]);
    const targets = JSON.stringify({
      'BTC/USDT': 0.6,
      'ETH/USDT': 0.3,
      'SOL/USDT': 0.1,
    });

    const result = await server.callTool('rebalance_portfolio', { holdings, targets });
    const data = JSON.parse(result.content[0].text);

    // Portfolio value = 0.5*65000 + 10*3500 = 32500 + 35000 = 67500
    expect(data.portfolioValue).toBe(67500);

    // Current weights
    expect(data.currentWeights['BTC/USDT']).toBeCloseTo(32500 / 67500, 3);
    expect(data.currentWeights['ETH/USDT']).toBeCloseTo(35000 / 67500, 3);

    // Target weights preserved
    expect(data.targetWeights['BTC/USDT']).toBe(0.6);
    expect(data.targetWeights['ETH/USDT']).toBe(0.3);
    expect(data.targetWeights['SOL/USDT']).toBe(0.1);

    // Trades should exist for all three symbols
    expect(data.trades.length).toBe(3);

    // BTC: target = 40500, current = 32500 => buy 8000 worth
    const btcTrade = data.trades.find((t: any) => t.symbol === 'BTC/USDT');
    expect(btcTrade).toBeDefined();
    expect(btcTrade.side).toBe('buy');
    expect(btcTrade.notional).toBeCloseTo(8000, 0);

    // ETH: target = 20250, current = 35000 => sell 14750 worth
    const ethTrade = data.trades.find((t: any) => t.symbol === 'ETH/USDT');
    expect(ethTrade).toBeDefined();
    expect(ethTrade.side).toBe('sell');
    expect(ethTrade.notional).toBeCloseTo(14750, 0);

    // SOL: target = 6750, current = 0 => buy 6750 worth
    const solTrade = data.trades.find((t: any) => t.symbol === 'SOL/USDT');
    expect(solTrade).toBeDefined();
    expect(solTrade.side).toBe('buy');
    expect(solTrade.notional).toBeCloseTo(6750, 0);
    expect(solTrade.reason).toContain('New position');

    // Trades sorted by absolute notional descending
    for (let i = 0; i < data.trades.length - 1; i++) {
      expect(data.trades[i].notional).toBeGreaterThanOrEqual(data.trades[i + 1].notional);
    }

    // Total turnover and turnover pct
    expect(data.totalTurnover).toBeCloseTo(8000 + 14750 + 6750, 0);
    expect(data.turnoverPct).toBeGreaterThan(0);
  });

  it('uses provided total_value instead of computing from holdings', async () => {
    const { server } = setup();

    const holdings = JSON.stringify([
      { symbol: 'BTC/USDT', amount: 1, price: 65000 },
    ]);
    const targets = JSON.stringify({ 'BTC/USDT': 1.0 });

    const result = await server.callTool('rebalance_portfolio', {
      holdings,
      targets,
      total_value: 100000,
    });
    const data = JSON.parse(result.content[0].text);

    // Should use 100000, not 65000
    expect(data.portfolioValue).toBe(100000);
    // BTC target = 100000, current = 65000 => buy 35000 worth
    const btcTrade = data.trades.find((t: any) => t.symbol === 'BTC/USDT');
    expect(btcTrade).toBeDefined();
    expect(btcTrade.side).toBe('buy');
    expect(btcTrade.notional).toBeCloseTo(35000, 0);
  });

  it('calls ensureMarkets and roundAmount for precision', async () => {
    const { server, client } = setup();

    const holdings = JSON.stringify([
      { symbol: 'BTC/USDT', amount: 1, price: 65000 },
    ]);
    const targets = JSON.stringify({ 'BTC/USDT': 0.5 });

    await server.callTool('rebalance_portfolio', {
      holdings,
      targets,
      total_value: 100000,
    });

    expect(client.calls).toContainEqual(
      expect.objectContaining({ method: 'ensureMarkets' })
    );
    expect(client.calls).toContainEqual(
      expect.objectContaining({ method: 'roundAmount' })
    );
  });

  it('rejects zero portfolio value', async () => {
    const { server } = setup();

    const holdings = JSON.stringify([]);
    const targets = JSON.stringify({ 'BTC/USDT': 1.0 });

    const result = await server.callTool('rebalance_portfolio', {
      holdings,
      targets,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('positive');
  });

  it('skips negligible trades (< $1)', async () => {
    const { server } = setup();

    const holdings = JSON.stringify([
      { symbol: 'BTC/USDT', amount: 1, price: 65000 },
    ]);
    // Target weight matches current exactly
    const targets = JSON.stringify({ 'BTC/USDT': 1.0 });

    const result = await server.callTool('rebalance_portfolio', {
      holdings,
      targets,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.trades.length).toBe(0);
    expect(data.totalTurnover).toBe(0);
  });
});

// ── scan_mean_reversion ──────────────────────────────────

describe('scan_mean_reversion tool', () => {
  function makeStoreCandles(finalPrice: number, lookback: number) {
    // Generate candles with a stable mean then spike the last one
    const candles = [];
    const stablePrice = 100;
    for (let i = 0; i < lookback; i++) {
      candles.push({
        timestamp: 1700000000000 + i * 86400000,
        open: stablePrice,
        high: stablePrice + 1,
        low: stablePrice - 1,
        close: stablePrice,
        volume: 1000,
      });
    }
    // Final candle at the extreme price
    candles.push({
      timestamp: 1700000000000 + lookback * 86400000,
      open: stablePrice,
      high: Math.max(stablePrice, finalPrice),
      low: Math.min(stablePrice, finalPrice),
      close: finalPrice,
      volume: 1500,
    });
    return candles;
  }

  it('detects overbought signal when z-score exceeds threshold', async () => {
    const mockStore = {
      query: async (opts: any) => {
        // Return candles where the last close is far above the mean
        // All closes at 100 except last at 200 => high positive z-score
        return makeStoreCandles(200, opts.limit - 1);
      },
    };

    const { server } = setup({
      store: mockStore,
    });

    const result = await server.callTool('scan_mean_reversion', {
      symbols: 'BTC/USDT',
      timeframe: '1d',
      lookback: 50,
      zscore_threshold: 2.0,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.scanned).toBe(1);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].signal).toBe('overbought');
    expect(data.results[0].zscore).toBeGreaterThan(2.0);
    expect(data.results[0].currentPrice).toBe(200);
    expect(data.results[0].mean).toBeTypeOf('number');
    expect(data.results[0].std).toBeTypeOf('number');
    expect(data.results[0].std).toBeGreaterThan(0);
    expect(data.results[0].deviationPct).toBeGreaterThan(0);
    expect(data.opportunities).toBe(1);
  });

  it('detects oversold signal for negative z-score', async () => {
    const mockStore = {
      query: async (opts: any) => {
        // Last close far below the mean (all 100 except last at 10)
        return makeStoreCandles(10, opts.limit - 1);
      },
    };

    const { server } = setup({
      store: mockStore,
    });

    const result = await server.callTool('scan_mean_reversion', {
      symbols: 'ETH/USDT',
      timeframe: '1d',
      lookback: 50,
      zscore_threshold: 2.0,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].signal).toBe('oversold');
    expect(data.results[0].zscore).toBeLessThan(-2.0);
    expect(data.results[0].deviationPct).toBeLessThan(0);
    expect(data.opportunities).toBe(1);
  });

  it('reports neutral when z-score is within threshold', async () => {
    const mockStore = {
      query: async (opts: any) => {
        // Last close near the mean
        return makeStoreCandles(100, opts.limit - 1);
      },
    };

    const { server } = setup({
      store: mockStore,
    });

    const result = await server.callTool('scan_mean_reversion', {
      symbols: 'SOL/USDT',
      timeframe: '1d',
      lookback: 50,
      zscore_threshold: 2.0,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].signal).toBe('neutral');
    expect(Math.abs(data.results[0].zscore)).toBeLessThan(2.0);
    expect(data.opportunities).toBe(0);
  });

  it('sorts results by absolute z-score descending', async () => {
    const mockStore = {
      query: async (opts: any) => {
        if (opts.symbol === 'BTC/USDT') return makeStoreCandles(120, opts.limit - 1); // moderate
        if (opts.symbol === 'ETH/USDT') return makeStoreCandles(200, opts.limit - 1); // extreme
        return makeStoreCandles(100, opts.limit - 1); // neutral
      },
    };

    const { server } = setup({
      store: mockStore,
    });

    const result = await server.callTool('scan_mean_reversion', {
      symbols: 'BTC/USDT,ETH/USDT,SOL/USDT',
      timeframe: '1d',
      lookback: 50,
      zscore_threshold: 2.0,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.scanned).toBe(3);
    expect(data.results).toHaveLength(3);
    // ETH should be first (highest abs z-score), then BTC, then SOL
    expect(Math.abs(data.results[0].zscore)).toBeGreaterThanOrEqual(Math.abs(data.results[1].zscore));
    expect(Math.abs(data.results[1].zscore)).toBeGreaterThanOrEqual(Math.abs(data.results[2].zscore));
  });

  it('reports error for insufficient data', async () => {
    const mockStore = {
      query: async () => {
        // Return only 5 candles when 50 are needed
        return makeStoreCandles(100, 4);
      },
    };

    const { server } = setup({
      store: mockStore,
    });

    const result = await server.callTool('scan_mean_reversion', {
      symbols: 'BTC/USDT',
      timeframe: '1d',
      lookback: 50,
      zscore_threshold: 2.0,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].error).toContain('Insufficient data');
    expect(data.opportunities).toBe(0);
  });

  it('errors when store is not configured', async () => {
    const { server } = setup({
      store: null,
    });

    const result = await server.callTool('scan_mean_reversion', {
      symbols: 'BTC/USDT',
      timeframe: '1d',
      lookback: 50,
      zscore_threshold: 2.0,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('DuckDB store not configured');
  });
});

// ── detect_confluence ────────────────────────────────────

describe('detect_confluence tool', () => {
  it('returns signals for each timeframe and a confluence score', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_confluence', {
      symbol: 'BTC/USDT',
      timeframes: '5m,15m,1h,4h,1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.timeframes).toEqual(['5m', '15m', '1h', '4h', '1d']);

    // Check that signals exist for each timeframe
    for (const tf of ['5m', '15m', '1h', '4h', '1d']) {
      expect(data.signals[tf]).toBeDefined();
      expect(data.signals[tf].rsi).toBeTypeOf('number');
      expect(data.signals[tf].rsi).toBeGreaterThanOrEqual(0);
      expect(data.signals[tf].rsi).toBeLessThanOrEqual(100);
      expect(data.signals[tf].rsiSignal).toMatch(/^(overbought|oversold|neutral)$/);
      expect(data.signals[tf].macd).toMatch(/^(bullish|bearish)$/);
      expect(data.signals[tf].trend).toMatch(/^(bullish|bearish)$/);
      expect(data.signals[tf].bbPosition).toMatch(/^(inside|above_upper|below_lower)$/);
      expect(data.signals[tf].priceVsEma).toMatch(/^(above|below)$/);
    }

    // Confluence score
    expect(data.confluence).toBeDefined();
    expect(data.confluence.bullish).toBeTypeOf('number');
    expect(data.confluence.bearish).toBeTypeOf('number');
    expect(data.confluence.bullish + data.confluence.bearish).toBeLessThanOrEqual(5);
    expect(data.confluence.score).toBeGreaterThanOrEqual(0);
    expect(data.confluence.score).toBeLessThanOrEqual(100);
    expect(data.confluence.direction).toMatch(/^(bullish|bearish)$/);
    expect(data.confluence.strength).toMatch(/^(strong|moderate|weak)$/);
    expect(data.recommendation).toBeTypeOf('string');
    expect(data.recommendation.length).toBeGreaterThan(0);
  });

  it('works with a single timeframe', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_confluence', {
      symbol: 'BTC/USDT',
      timeframes: '1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.timeframes).toEqual(['1d']);
    expect(data.signals['1d']).toBeDefined();
    expect(data.confluence.score).toBe(100);
  });

  it('rejects insufficient data', async () => {
    const { server } = setup({
      getBars: async () => {
        const bars = [];
        for (let i = 0; i < 20; i++) {
          bars.push({
            timestamp: 1700000000000 + i * 86400000,
            open: 100, high: 105, low: 95, close: 100, volume: 1000,
          });
        }
        return bars;
      },
    });
    const result = await server.callTool('detect_confluence', {
      symbol: 'BTC/USDT',
      timeframes: '1d',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Insufficient');
  });
});

// ── detect_bb_squeeze ────────────────────────────────────

describe('detect_bb_squeeze tool', () => {
  it('returns results with bandwidth and squeeze detection', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_bb_squeeze', {
      symbols: 'BTC/USDT',
      timeframe: '4h',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.timeframe).toBe('4h');
    expect(data.results).toBeInstanceOf(Array);
    expect(data.results).toHaveLength(1);
    const r = data.results[0];
    expect(r.symbol).toBe('BTC/USDT');
    expect(r.bandwidth).toBeTypeOf('number');
    expect(r.bandwidth).toBeGreaterThan(0);
    expect(r.avgBandwidth).toBeTypeOf('number');
    expect(r.avgBandwidth).toBeGreaterThan(0);
    expect(r.squeezeRatio).toBeTypeOf('number');
    expect(r.squeezeRatio).toBeGreaterThan(0);
    expect(r.inSqueeze).toBeTypeOf('boolean');
    expect(r.squeezeDuration).toBeTypeOf('number');
    expect(r.squeezeDuration).toBeGreaterThanOrEqual(0);
    expect(r.pricePosition).toMatch(/^(above_middle|below_middle)$/);
    expect(r.signal).toBeTypeOf('string');
  });

  it('detects a squeeze when bandwidth is very low', async () => {
    // Generate bars with very tight range (low volatility)
    const { server } = setup({
      getBars: async () => {
        const bars = [];
        const basePrice = 65000;
        for (let i = 0; i < 120; i++) {
          // First 80 bars: high volatility; last 40 bars: very tight
          const vol = i < 80 ? 500 : 5;
          const price = basePrice + (Math.random() - 0.5) * vol;
          bars.push({
            timestamp: 1700000000000 + i * 14400000,
            open: price - vol * 0.1,
            high: price + vol * 0.2,
            low: price - vol * 0.3,
            close: price,
            volume: 1000,
          });
        }
        return bars;
      },
    });

    const result = await server.callTool('detect_bb_squeeze', {
      symbols: 'BTC/USDT',
      timeframe: '4h',
      squeeze_threshold: 0.5,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.results[0].inSqueeze).toBe(true);
    expect(data.results[0].squeezeDuration).toBeGreaterThan(0);
    expect(data.results[0].signal).toContain('squeeze');
  });

  it('scans multiple symbols and sorts by squeeze intensity', async () => {
    const { server } = setup();
    const result = await server.callTool('detect_bb_squeeze', {
      symbols: 'BTC/USDT,ETH/USDT,SOL/USDT',
      timeframe: '4h',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.results).toHaveLength(3);
    // Results should be sorted by squeezeRatio ascending
    for (let i = 1; i < data.results.length; i++) {
      expect(data.results[i].squeezeRatio).toBeGreaterThanOrEqual(data.results[i - 1].squeezeRatio);
    }
  });

  it('rejects insufficient data', async () => {
    const { server } = setup({
      getBars: async () => {
        return [
          { timestamp: 1, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
        ];
      },
    });
    const result = await server.callTool('detect_bb_squeeze', {
      symbols: 'BTC/USDT',
      timeframe: '4h',
    });
    expect(result.isError).toBe(true);
    // With only 1 bar, tool should error (insufficient data or cannot compute BB)
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });
});

// ── get_liquidation_heatmap ─────────────────────────────

describe('get_liquidation_heatmap tool', () => {
  it('returns levels and cluster zones with valid structure', async () => {
    const { server } = setup();
    const result = await server.callTool('get_liquidation_heatmap', {
      symbol: 'BTC/USDT',
      leverage_levels: '2,5,10,25',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.currentMid).toBeTypeOf('number');
    expect(data.currentMid).toBeGreaterThan(0);
    expect(data.levels).toBeInstanceOf(Array);
    expect(data.levels).toHaveLength(4);

    for (const level of data.levels) {
      expect(level.leverage).toBeTypeOf('number');
      expect(level.longLiquidation).toBeTypeOf('number');
      expect(level.shortLiquidation).toBeTypeOf('number');
      expect(level.longLiquidation).toBeLessThan(data.currentMid);
      expect(level.shortLiquidation).toBeGreaterThan(data.currentMid);
      expect(level.nearbyBidVolume).toBeTypeOf('number');
      expect(level.nearbyAskVolume).toBeTypeOf('number');
    }

    // 10x leverage: long liq = mid * (1 - 1/10) = mid * 0.9
    const level10 = data.levels.find((l: any) => l.leverage === 10);
    expect(level10).toBeDefined();
    expect(level10.longLiquidation).toBeCloseTo(data.currentMid * 0.9, 0);
    expect(level10.shortLiquidation).toBeCloseTo(data.currentMid * 1.1, 0);

    expect(data.clusterZones).toBeInstanceOf(Array);
    for (const zone of data.clusterZones) {
      expect(zone.priceRange).toBeInstanceOf(Array);
      expect(zone.priceRange).toHaveLength(2);
      expect(zone.estimatedLiquidationVolume).toBeTypeOf('number');
      expect(zone.type).toMatch(/^(long_liquidation|short_liquidation)$/);
    }
  });
});

// ── get_volatility_term_structure ───────────────────────

describe('get_volatility_term_structure tool', () => {
  it('returns term structure with classification', async () => {
    const { server } = setup();
    const result = await server.callTool('get_volatility_term_structure', {
      symbol: 'BTC/USDT',
      timeframes: '1h,4h,1d',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.structure).toBeInstanceOf(Array);
    expect(data.structure).toHaveLength(3);

    for (const entry of data.structure) {
      expect(entry.timeframe).toBeTypeOf('string');
      expect(entry.annualizedVolatility).toBeTypeOf('number');
      expect(entry.annualizedVolatility).toBeGreaterThan(0);
      expect(entry.sampleSize).toBeTypeOf('number');
      expect(entry.sampleSize).toBeGreaterThan(0);
      expect(entry.periodsPerYear).toBeTypeOf('number');
    }

    expect(data.ratios).toBeInstanceOf(Array);
    expect(data.ratios).toHaveLength(2);
    for (const ratio of data.ratios) {
      expect(ratio.from).toBeTypeOf('string');
      expect(ratio.to).toBeTypeOf('string');
      expect(ratio.ratio).toBeTypeOf('number');
    }

    expect(data.classification).toMatch(/^(normal|inverted|mixed)$/);
  });
});

// ── calculate_dca_schedule ──────────────────────────────

describe('calculate_dca_schedule tool', () => {
  it('returns vol-adjusted DCA schedule with correct structure', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_dca_schedule', {
      symbol: 'BTC/USDT',
      total_amount: 10000,
      num_orders: 5,
      timeframe: '1d',
      vol_adjust: true,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.totalAmount).toBe(10000);
    expect(data.numOrders).toBe(5);
    expect(data.currentPrice).toBeTypeOf('number');
    expect(data.currentPrice).toBeGreaterThan(0);
    expect(data.volAdjust).toBe(true);
    expect(data.schedule).toBeInstanceOf(Array);
    expect(data.schedule).toHaveLength(5);

    // Total quote amounts should sum approximately to totalAmount
    const totalQuote = data.schedule.reduce((sum: number, o: any) => sum + o.amount_quote, 0);
    expect(totalQuote).toBeCloseTo(10000, -1);

    for (const order of data.schedule) {
      expect(order.order_number).toBeTypeOf('number');
      expect(order.amount_quote).toBeTypeOf('number');
      expect(order.amount_quote).toBeGreaterThan(0);
      expect(order.estimated_amount_base).toBeTypeOf('number');
      expect(order.estimated_amount_base).toBeGreaterThan(0);
      expect(order.size_reason).toBeTypeOf('string');
      expect(order.size_reason).toContain('Vol-adjusted');
    }
  });

  it('returns equal splits when vol_adjust is false', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_dca_schedule', {
      symbol: 'BTC/USDT',
      total_amount: 10000,
      num_orders: 4,
      timeframe: '1d',
      vol_adjust: false,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.volAdjust).toBe(false);
    expect(data.schedule).toHaveLength(4);

    for (const order of data.schedule) {
      expect(order.amount_quote).toBe(2500);
      expect(order.size_reason).toBe('Equal split');
    }
  });
});

// ── optimize_grid_params ────────────────────────────────

describe('optimize_grid_params tool', () => {
  it('returns grid levels with correct structure', async () => {
    const { server } = setup();
    const result = await server.callTool('optimize_grid_params', {
      symbol: 'BTC/USDT',
      timeframe: '4h',
      period: 100,
      num_grids: 10,
    });

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);

    expect(data.symbol).toBe('BTC/USDT');
    expect(data.priceRange).toBeDefined();
    expect(data.priceRange.high).toBeTypeOf('number');
    expect(data.priceRange.low).toBeTypeOf('number');
    expect(data.priceRange.current).toBeTypeOf('number');
    expect(data.priceRange.bbUpper).toBeTypeOf('number');
    expect(data.priceRange.bbLower).toBeTypeOf('number');
    expect(data.priceRange.bbUpper).toBeGreaterThan(data.priceRange.bbLower);

    expect(data.gridLevels).toHaveLength(10);
    for (const level of data.gridLevels) {
      expect(level.price).toBeTypeOf('number');
      expect(level.price).toBeGreaterThan(0);
      expect(['buy', 'sell']).toContain(level.side);
      expect(level.amount).toBeTypeOf('number');
      expect(level.amount).toBeGreaterThan(0);
    }

    expect(data.spacing).toBeTypeOf('number');
    expect(data.spacing).toBeGreaterThan(0);

    expect(data.atrBased).toBeDefined();
    expect(data.atrBased.currentAtr).toBeTypeOf('number');
    expect(data.atrBased.avgAtr).toBeTypeOf('number');
    expect(data.atrBased.atrRatio).toBeTypeOf('number');

    expect(data.expectedDailyTrades).toBeTypeOf('number');
    expect(['low', 'normal', 'high']).toContain(data.volRegime);
  });

  it('rejects insufficient candle data', async () => {
    const { server } = setup({
      getBars: async () => [
        { timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      ],
    });
    const result = await server.callTool('optimize_grid_params', {
      symbol: 'BTC/USDT',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('at least 26 candles');
  });

  it('respects num_grids parameter', async () => {
    const { server } = setup();
    const result = await server.callTool('optimize_grid_params', {
      symbol: 'BTC/USDT',
      num_grids: 5,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.gridLevels).toHaveLength(5);
  });

  it('places returned grid levels at cell midpoints, not band boundaries', async () => {
    const { server } = setup();
    const result = await server.callTool('optimize_grid_params', {
      symbol: 'BTC/USDT',
      num_grids: 5,
    });

    const data = JSON.parse(result.content[0].text);
    const firstExpected = data.priceRange.bbLower + data.spacing / 2;
    const lastExpected = data.priceRange.bbUpper - data.spacing / 2;

    expect(Math.abs(data.gridLevels[0].price - firstExpected)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(data.gridLevels[data.gridLevels.length - 1].price - lastExpected)).toBeLessThanOrEqual(0.02);
    expect(data.gridLevels[0].price).toBeGreaterThan(data.priceRange.bbLower);
    expect(data.gridLevels[data.gridLevels.length - 1].price).toBeLessThan(data.priceRange.bbUpper);
  });

  it('grid levels are sorted by price ascending', async () => {
    const { server } = setup();
    const result = await server.callTool('optimize_grid_params', {
      symbol: 'BTC/USDT',
      num_grids: 10,
    });

    const data = JSON.parse(result.content[0].text);
    for (let i = 1; i < data.gridLevels.length; i++) {
      expect(data.gridLevels[i].price).toBeGreaterThan(data.gridLevels[i - 1].price);
    }
  });

  it('defaults timeframe and period when not provided', async () => {
    const { server, client } = setup();
    await server.callTool('optimize_grid_params', {
      symbol: 'BTC/USDT',
    });

    const call = client.calls.find(c => c.method === 'getBars');
    expect(call).toBeDefined();
    expect(call!.args[0]).toBe('BTC/USDT');
    expect(call!.args[1]).toBe('4h');
    expect(call!.args[3]).toBe(100);
  });
});
