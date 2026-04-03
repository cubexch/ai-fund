/**
 * Cross-tool integration tests — verifies multi-step workflows
 * that span multiple MCP tools and share state.
 *
 * These test what would actually happen in production when
 * an agent chains tool calls together.
 */

import { describe, it, expect } from 'vitest';
import { registerRiskTools } from '../src/tools/risk';
import { registerExecutionTools } from '../src/tools/execution';
import { registerAccountTools } from '../src/tools/account';
import { registerOrderTools } from '../src/tools/orders';
import { createMockClient, MockMcpServer } from './helpers';
import { generateBars } from '@ai-fund/lib/test-fixtures/market-data';

// ── Setup: multi-tool server ─────────────────────────────────

function setupFullDesk(overrides: Record<string, any> = {}) {
  const balances = [
    { currency: 'USDT', free: 50000, used: 0, total: 50000 },
    { currency: 'BTC', free: 0.5, used: 0, total: 0.5 },
    { currency: 'ETH', free: 5, used: 0, total: 5 },
  ];
  const tickers = [
    { symbol: 'BTC/USDT', last: 65000, bid: 64990, ask: 65010, high: 66000, low: 64000, volume: 1234, timestamp: Date.now() },
    { symbol: 'ETH/USDT', last: 3400, bid: 3399, ask: 3401, high: 3480, low: 3320, volume: 15000, timestamp: Date.now() },
  ];

  const client = createMockClient({
    getBalance: async () => overrides.balances ?? balances,
    getTickers: async () => overrides.tickers ?? tickers,
    getTicker: async (symbol: string) => tickers.find(t => t.symbol === symbol) ?? tickers[0],
    getQuote: async (symbol: string) => {
      const t = tickers.find(tk => tk.symbol === symbol) ?? tickers[0];
      return {
        symbol: t.symbol, bid: t.bid, ask: t.ask,
        mid: ((t.bid ?? 0) + (t.ask ?? 0)) / 2,
        spread: (t.ask ?? 0) - (t.bid ?? 0),
        spreadBps: 3.08, last: t.last, timestamp: t.timestamp,
      };
    },
    getBars: async (_s: string, _tf: string, _since?: number, limit?: number) =>
      generateBars({ count: limit ?? 100, startPrice: 65000 }),
    getMyTrades: async () => overrides.myTrades ?? [],
    getOpenOrders: async () => overrides.openOrders ?? [],
    placeOrder: async (symbol: string, type: string, side: string, amount: number, price?: number) => ({
      id: 'flow-ord-1', symbol, side, type, amount,
      filled: type === 'market' ? amount : 0,
      remaining: type === 'market' ? 0 : amount,
      price, average: type === 'market' ? 65000 : undefined,
      status: type === 'market' ? 'closed' : 'open',
      timestamp: Date.now(),
    }),
    ...overrides,
  } as any);

  const server = new MockMcpServer();
  registerRiskTools(server as any, client);
  registerExecutionTools(server as any, client);
  registerAccountTools(server as any, client);
  registerOrderTools(server as any, client);
  return { server, client };
}

function parse(result: any) {
  return JSON.parse(result.content[0].text);
}

// ── Flow 1: Risk limits → Pre-trade check → Order ───────────

describe('Flow: set_risk_limits → check_pre_trade → place_order', () => {
  it('tightened limits correctly reject oversized orders', async () => {
    const { server } = setupFullDesk();

    // Step 1: Set tight risk limits (5% max position)
    const limitsResult = parse(await server.callTool('set_risk_limits', {
      max_position_pct: 5,
    }));
    expect(limitsResult.limits.maxPositionPct).toBe(5);

    // Step 2: Pre-trade check with a large order
    // Portfolio ≈ $50k USDT + 0.5 BTC ($32.5k) + 5 ETH ($17k) = ~$99.5k
    // Order: 0.5 BTC @ $65k = $32.5k = ~32.7% of portfolio → should fail
    const preTradeResult = parse(await server.callTool('check_pre_trade', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.5,
      price: 65000,
    }));
    expect(preTradeResult.decision).toBe('NO_GO');
    expect(preTradeResult.checks.find((c: any) => c.name === 'position_size').passed).toBe(false);
  });

  it('loose limits approve reasonable orders', async () => {
    const { server } = setupFullDesk();

    // Step 1: Set permissive limits
    await server.callTool('set_risk_limits', { max_position_pct: 50 });

    // Step 2: Small order should pass
    const preTradeResult = parse(await server.callTool('check_pre_trade', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.01,
      price: 65000,
    }));
    expect(preTradeResult.decision).toBe('GO');
    expect(preTradeResult.checks.every((c: any) => c.passed)).toBe(true);
  });

  it('pre-trade check balance validation catches insufficient funds', async () => {
    const { server } = setupFullDesk({
      balances: [
        { currency: 'USDT', free: 100, used: 0, total: 100 }, // only $100 available
        { currency: 'BTC', free: 0, used: 0, total: 0 },
      ],
    });

    const result = parse(await server.callTool('check_pre_trade', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 1,
      price: 65000, // $65k order with $100 available
    }));

    expect(result.decision).toBe('NO_GO');
    const balCheck = result.checks.find((c: any) => c.name === 'sufficient_balance');
    expect(balCheck).toBeDefined();
    expect(balCheck.passed).toBe(false);
  });
});

// ── Flow 2: Risk dashboard → Stress test → Correlation ──────

describe('Flow: risk_dashboard → stress_test → correlation_risk', () => {
  it('dashboard identifies concentration, stress test validates survivability', async () => {
    const { server } = setupFullDesk();

    // Step 1: Check dashboard
    const dashboard = parse(await server.callTool('get_risk_dashboard', {}));
    expect(dashboard.portfolioValue).toBeGreaterThan(0);
    expect(dashboard.metrics.concentration).toBeDefined();

    // Step 2: Stress test with the same portfolio
    const stress = parse(await server.callTool('simulate_stress_test', {
      scenario: 'btc_crash_2022',
    }));
    expect(stress.totalLoss).toBeGreaterThan(0);
    expect(stress.lossPct).toBeGreaterThan(0);

    // Step 3: Correlation risk
    const corr = parse(await server.callTool('check_correlation_risk', {
      threshold: 0.8,
      lookback: 30,
    }));
    expect(corr.numHoldings).toBeGreaterThanOrEqual(2);
    expect(typeof corr.riskScore).toBe('number');
  });
});

// ── Flow 3: Execution quality → Spread monitor ──────────────

describe('Flow: execution_quality → spread_monitor → order_flow_imbalance', () => {
  it('no fills returns appropriate message, spread monitor still works', async () => {
    const { server } = setupFullDesk({ myTrades: [] });

    // Step 1: No fills
    const eq = parse(await server.callTool('get_execution_quality', { symbol: 'BTC/USDT' }));
    expect(eq.totalFills).toBe(0);
    expect(eq.message).toContain('No recent fills');

    // Step 2: Spread monitor still works regardless of fills
    const spread = parse(await server.callTool('get_spread_monitor', {
      symbols: 'BTC/USDT,ETH/USDT',
    }));
    expect(spread.symbols.length).toBe(2);
  });

  it('execution quality with fills computes correct VWAP math', async () => {
    const { server } = setupFullDesk({
      myTrades: [
        { id: 't1', symbol: 'BTC/USDT', side: 'buy', price: 64900, amount: 1.0, cost: 64900, timestamp: Date.now(), takerOrMaker: 'taker' },
        { id: 't2', symbol: 'BTC/USDT', side: 'buy', price: 65100, amount: 1.0, cost: 65100, timestamp: Date.now(), takerOrMaker: 'maker' },
      ],
    });

    const eq = parse(await server.callTool('get_execution_quality', { symbol: 'BTC/USDT' }));

    // VWAP = (64900*1 + 65100*1) / (1+1) = 65000
    expect(eq.vwap).toBe(65000);
    // Avg fill = (64900 + 65100) / 2 = 65000
    expect(eq.avgFillPrice).toBe(65000);
    // Slippage: (65000 - 65000) / 65000 * 10000 = 0 bps
    expect(eq.slippageBps).toBeCloseTo(0, 0);
    // Maker/taker: 1 taker, 1 maker
    expect(eq.makerTaker.maker).toBe(1);
    expect(eq.makerTaker.taker).toBe(1);
    expect(eq.makerTaker.makerPct).toBe(50);
  });
});

// ── Flow 4: Account → Position close ─────────────────────────

describe('Flow: get_account → close_position', () => {
  it('account shows balances, close_position sells correct amount', async () => {
    const { server, client } = setupFullDesk();

    // Step 1: Check account
    const account = parse(await server.callTool('get_account', {}));
    expect(account.balances.length).toBe(3);
    const btc = account.balances.find((b: any) => b.currency === 'BTC');
    expect(btc.free).toBe(0.5);

    // Step 2: Close 50% of BTC position
    const close = parse(await server.callTool('close_position', {
      symbol: 'BTC/USDT',
      percentage: 50,
    }));
    expect(close.closeSide).toBe('sell');
    expect(close.closedPercentage).toBe(50);
    // Should place order for 0.25 BTC (50% of 0.5)
    expect(client.calls.find(c => c.method === 'placeOrder')).toBeDefined();
    const placeCall = client.calls.find(c => c.method === 'placeOrder')!;
    expect(placeCall.args[3]).toBeCloseTo(0.25, 4); // amount
  });
});

// ── Flow 5: Limits persistence across multiple checks ────────

describe('Flow: limits persist across tool calls within same registration', () => {
  it('limits set once apply to subsequent pre-trade checks', async () => {
    const { server } = setupFullDesk();

    // Set strict limits
    await server.callTool('set_risk_limits', { max_position_pct: 1 });

    // First check: should reject
    const check1 = parse(await server.callTool('check_pre_trade', {
      symbol: 'BTC/USDT', side: 'buy', amount: 0.1, price: 65000,
    }));
    expect(check1.decision).toBe('NO_GO');

    // Second check without re-setting limits: should still reject
    const check2 = parse(await server.callTool('check_position_limits', {
      symbol: 'BTC/USDT', side: 'buy', amount: 0.1, price: 65000,
    }));
    expect(check2.decision).toBe('REJECTED');

    // Relax limits
    await server.callTool('set_risk_limits', { max_position_pct: 50 });

    // Now should approve
    const check3 = parse(await server.callTool('check_pre_trade', {
      symbol: 'BTC/USDT', side: 'buy', amount: 0.1, price: 65000,
    }));
    expect(check3.decision).toBe('GO');
  });
});

// ── Flow 6: Order flow imbalance → momentum scanner ──────────

describe('Flow: order_flow_imbalance signals', () => {
  it('strong buy pressure detected from skewed trades', async () => {
    const trades = Array.from({ length: 100 }, (_, i) => ({
      id: `t-${i}`, timestamp: Date.now() - i * 1000,
      symbol: 'BTC/USDT',
      // 80% buys, 20% sells
      side: i % 5 === 0 ? 'sell' : 'buy',
      price: 65000 + (Math.sin(i) * 10),
      amount: 0.1, cost: 6500,
    }));

    const { server } = setupFullDesk({
      getTrades: async () => trades,
    });

    const result = parse(await server.callTool('get_order_flow_imbalance', {
      symbol: 'BTC/USDT',
      limit: 100,
    }));

    expect(result.buyCount).toBeGreaterThan(result.sellCount);
    expect(result.imbalancePct).toBeGreaterThan(0);
    expect(['strong_buy_pressure', 'moderate_buy_pressure']).toContain(result.signal);
    expect(result.buySellRatio).toBeGreaterThan(1);
  });

  it('neutral signal from balanced trades', async () => {
    const trades = Array.from({ length: 100 }, (_, i) => ({
      id: `t-${i}`, timestamp: Date.now() - i * 1000,
      symbol: 'BTC/USDT',
      side: i % 2 === 0 ? 'buy' : 'sell',
      price: 65000, amount: 0.1, cost: 6500,
    }));

    const { server } = setupFullDesk({
      getTrades: async () => trades,
    });

    const result = parse(await server.callTool('get_order_flow_imbalance', {
      symbol: 'BTC/USDT',
      limit: 100,
    }));

    expect(Math.abs(result.imbalancePct)).toBeLessThan(5);
    expect(result.signal).toBe('neutral');
  });

  it('buySellRatio returns null (not Infinity) when no sells', async () => {
    const trades = Array.from({ length: 10 }, (_, i) => ({
      id: `t-${i}`, timestamp: Date.now(),
      symbol: 'BTC/USDT', side: 'buy',
      price: 65000, amount: 0.1, cost: 6500,
    }));

    const { server } = setupFullDesk({
      getTrades: async () => trades,
    });

    const result = parse(await server.callTool('get_order_flow_imbalance', {
      symbol: 'BTC/USDT', limit: 10,
    }));

    // This was Infinity before our fix — verify it's null now
    expect(result.buySellRatio).toBeNull();
    expect(result.signal).toBe('strong_buy_pressure');
  });
});

// ── Flow 7: Empty portfolio edge cases ───────────────────────

describe('Flow: empty portfolio handling', () => {
  it('dashboard handles zero-value portfolio', async () => {
    const { server } = setupFullDesk({
      balances: [],
      tickers: [],
    });

    const dashboard = parse(await server.callTool('get_risk_dashboard', {}));
    expect(dashboard.numPositions).toBe(0);
    expect(dashboard.holdings).toEqual([]);
  });

  it('stress test on empty portfolio shows zero loss', async () => {
    const { server } = setupFullDesk({
      balances: [],
      tickers: [],
    });

    const stress = parse(await server.callTool('simulate_stress_test', {
      scenario: 'flash_crash',
    }));
    expect(stress.totalLoss).toBe(0);
    expect(stress.lossPct).toBe(0);
  });

  it('VaR on empty portfolio returns zero', async () => {
    const { server } = setupFullDesk({
      balances: [],
      tickers: [],
    });

    const result = parse(await server.callTool('calculate_var', {
      confidence: 0.95, horizon: 1, lookback: 30,
    }));
    expect(result.var).toBe(0);
  });

  it('exposure with unpriced assets uses 0 weight instead of 1/N', async () => {
    // Balances with assets that have no matching ticker → resolvePrice returns 0
    // totalValue = 0, so weights should all be 0 (not divided by fallback 1)
    const { server } = setupFullDesk({
      balances: [
        { currency: 'OBSCURE', free: 1000, used: 0, total: 1000 },
      ],
      tickers: [], // no tickers to resolve price
    });

    const exposure = parse(await server.callTool('get_portfolio_exposure', {}));
    expect(exposure.totalValue).toBe(0);
    // Weight should be 0, not artificially inflated
    if (exposure.positions.length > 0) {
      expect(exposure.positions[0].weight).toBe(0);
    }
  });
});
