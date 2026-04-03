/**
 * Tests for risk management tools (src/tools/risk.ts).
 */

import { describe, it, expect } from 'vitest';
import { registerRiskTools } from '../src/tools/risk';
import { createMockClient, MockMcpServer, TICKERS, BALANCES } from './helpers';
import { generateBars } from '@ai-fund/lib/test-fixtures/market-data';

// ── Setup ────────────────────────────────────────────────────

function setup(overrides: Record<string, unknown> = {}) {
  const client = createMockClient({
    getBalance: async () => BALANCES,
    getTickers: async () => Object.values(TICKERS),
    getBars: async (_sym: string, _tf: string, _since?: number, limit?: number) =>
      generateBars({ count: limit ?? 30, startPrice: 65000 }),
    ...overrides,
  } as any);
  const server = new MockMcpServer();
  registerRiskTools(server as any, client);
  return { server, client };
}

function parseResult(result: any) {
  return JSON.parse(result.content[0].text);
}

// ── set_risk_limits ──────────────────────────────────────────

describe('set_risk_limits', () => {
  it('returns default limits when called with no params', async () => {
    const { server } = setup();
    const result = await server.callTool('set_risk_limits', {});
    const data = parseResult(result);

    expect(data.limits.maxPositionPct).toBe(20);
    expect(data.limits.maxDrawdownPct).toBe(15);
    expect(data.limits.maxLeverage).toBe(3);
    expect(data.limits.maxConcentrationPct).toBe(40);
    expect(data.limits.dailyLossLimitPct).toBe(5);
  });

  it('updates limits when params provided', async () => {
    const { server } = setup();
    const result = await server.callTool('set_risk_limits', {
      max_position_pct: 10,
      max_drawdown_pct: 8,
    });
    const data = parseResult(result);

    expect(data.limits.maxPositionPct).toBe(10);
    expect(data.limits.maxDrawdownPct).toBe(8);
    // Others unchanged
    expect(data.limits.maxLeverage).toBe(3);
  });

  it('limits are scoped per registration (not shared)', async () => {
    const { server: server1 } = setup();
    const { server: server2 } = setup();

    await server1.callTool('set_risk_limits', { max_position_pct: 5 });
    const data2 = parseResult(await server2.callTool('set_risk_limits', {}));

    // server2 should still have defaults
    expect(data2.limits.maxPositionPct).toBe(20);
  });
});

// ── get_portfolio_exposure ───────────────────────────────────

describe('get_portfolio_exposure', () => {
  it('computes exposure breakdown', async () => {
    const { server } = setup();
    const result = await server.callTool('get_portfolio_exposure', {});
    const data = parseResult(result);

    // USDT=50000 + BTC(0.5*65000)=32500 + ETH(5*3400)=17000 + SOL(100*175)=17500 = 117000
    expect(data.totalValue).toBe(117000);
    expect(data.grossExposure).toBe(117000);
    expect(data.positions).toHaveLength(4);
    expect(data.numPositions).toBe(4);
    expect(data.limits.maxPositionPct).toBe(20);
  });

  it('returns null for longShortRatio when no shorts', async () => {
    const { server } = setup();
    const result = await server.callTool('get_portfolio_exposure', {});
    const data = parseResult(result);

    // All balances are positive (long), so longShortRatio should be null (was Infinity)
    expect(data.longShortRatio).toBeNull();
  });

  it('sorts positions by absolute value descending', async () => {
    const { server } = setup();
    const result = await server.callTool('get_portfolio_exposure', {});
    const data = parseResult(result);

    for (let i = 1; i < data.positions.length; i++) {
      expect(Math.abs(data.positions[i - 1].value)).toBeGreaterThanOrEqual(
        Math.abs(data.positions[i].value)
      );
    }
  });

  it('returns auth error when no credentials', async () => {
    const { server } = setup({ hasCredentials: false } as any);
    // Reconstruct with no-cred client
    const client = createMockClient({ hasCredentials: false } as any);
    const s2 = new MockMcpServer();
    registerRiskTools(s2 as any, client);

    const result = await s2.callTool('get_portfolio_exposure', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('credentials');
  });
});

// ── check_position_limits ────────────────────────────────────

describe('check_position_limits', () => {
  it('approves small order within limits', async () => {
    const { server } = setup();
    const result = await server.callTool('check_position_limits', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.01,
      price: 65000,
    });
    const data = parseResult(result);

    expect(data.decision).toBe('APPROVED');
    expect(data.checks.every((c: any) => c.passed)).toBe(true);
  });

  it('rejects oversized order', async () => {
    const { server } = setup();
    // Order for 100 BTC at $65000 = $6.5M, portfolio ~ $100k → way over 20%
    const result = await server.callTool('check_position_limits', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 100,
      price: 65000,
    });
    const data = parseResult(result);

    expect(data.decision).toBe('REJECTED');
    expect(data.checks.some((c: any) => !c.passed)).toBe(true);
  });
});

// ── calculate_var ────────────────────────────────────────────

describe('calculate_var', () => {
  it('computes VaR with explicit params', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_var', {
      confidence: 0.95,
      horizon: 1,
      lookback: 30,
    });
    const data = parseResult(result);

    expect(data.var).toBeGreaterThan(0);
    expect(data.var).toBeLessThan(117000); // VaR can't exceed portfolio
    expect(data.varPct).toBeGreaterThan(0);
    expect(data.varPct).toBeLessThan(100);
    expect(data.portfolioValue).toBe(117000);
    expect(data.confidence).toBe(0.95);
    expect(data.horizon).toBe(1);
  });

  it('accepts custom confidence and horizon', async () => {
    const { server } = setup();
    const result = await server.callTool('calculate_var', {
      confidence: 0.99,
      horizon: 5,
      lookback: 60,
    });
    const data = parseResult(result);

    expect(data.confidence).toBe(0.99);
    expect(data.horizon).toBe(5);
  });
});

// ── get_drawdown_monitor ─────────────────────────────────────

describe('get_drawdown_monitor', () => {
  it('returns drawdown metrics', async () => {
    const { server } = setup();
    const result = await server.callTool('get_drawdown_monitor', {});
    const data = parseResult(result);

    expect(data.currentEquity).toBe(117000);
    expect(data.drawdownPct).toBeGreaterThanOrEqual(0);
    expect(data.drawdownPct).toBeLessThan(100);
    expect(data.recoveryNeeded).toBeGreaterThanOrEqual(0);
    expect(['OK', 'WARNING', 'CRITICAL']).toContain(data.status);
    expect(data.circuitBreaker).toBe(false); // no drawdown in fresh portfolio
  });
});

// ── check_correlation_risk ───────────────────────────────────

describe('check_correlation_risk', () => {
  it('analyzes correlation between holdings', async () => {
    const { server } = setup();
    const result = await server.callTool('check_correlation_risk', {});
    const data = parseResult(result);

    expect(data.avgCorrelation).toBeGreaterThanOrEqual(-1);
    expect(data.avgCorrelation).toBeLessThanOrEqual(1);
    expect(data.riskScore).toBeGreaterThanOrEqual(0);
    expect(data.riskScore).toBeLessThanOrEqual(100);
    expect(data.numHoldings).toBe(3); // BTC, ETH, SOL (USDT excluded as stablecoin)
    expect(['HIGH_RISK', 'MODERATE', 'DIVERSIFIED']).toContain(data.status);
  });

  it('returns early with < 2 holdings', async () => {
    const client = createMockClient({
      getBalance: async () => [
        { currency: 'USDT', free: 50000, used: 0, total: 50000 },
        { currency: 'BTC', free: 1, used: 0, total: 1 },
      ],
      getTickers: async () => Object.values(TICKERS),
      getBars: async () => generateBars({ count: 30, startPrice: 65000 }),
    } as any);
    const server = new MockMcpServer();
    registerRiskTools(server as any, client);

    const result = await server.callTool('check_correlation_risk', {});
    const data = parseResult(result);
    expect(data.message).toContain('at least 2');
  });
});

// ── simulate_stress_test ─────────────────────────────────────

describe('simulate_stress_test', () => {
  it('runs btc_crash_2022 scenario', async () => {
    const { server } = setup();
    const result = await server.callTool('simulate_stress_test', {
      scenario: 'btc_crash_2022',
    });
    const data = parseResult(result);

    expect(data.scenario).toBe('btc_crash_2022');
    expect(data.currentPortfolioValue).toBe(117000);
    expect(data.stressedPortfolioValue).toBeLessThan(117000);
    expect(data.totalLoss).toBeGreaterThan(0);
    expect(data.totalLoss).toBeLessThan(117000);
    expect(data.lossPct).toBeGreaterThan(0);
    expect(data.lossPct).toBeLessThan(100);
    expect(typeof data.survivable).toBe('boolean');
  });

  it('runs custom scenario', async () => {
    const { server } = setup();
    const result = await server.callTool('simulate_stress_test', {
      scenario: 'custom',
      custom_changes: '{"BTC":-0.5,"ETH":-0.6}',
    });
    const data = parseResult(result);

    expect(data.scenario).toBe('custom');
    expect(data.impacts.length).toBeGreaterThan(0);
  });

  it('rejects invalid custom JSON', async () => {
    const { server } = setup();
    const result = await server.callTool('simulate_stress_test', {
      scenario: 'custom',
      custom_changes: 'not json',
    });
    expect(result.isError).toBe(true);
  });

  it('runs all named scenarios', async () => {
    const { server } = setup();
    for (const scenario of ['btc_crash_2022', 'luna_collapse', 'ftx_contagion', 'flash_crash']) {
      const result = await server.callTool('simulate_stress_test', { scenario });
      const data = parseResult(result);
      expect(data.scenario).toBe(scenario);
      expect(data.lossPct).toBeGreaterThan(0);
    }
  });
});

// ── check_pre_trade ──────────────────────────────────────────

describe('check_pre_trade', () => {
  it('approves a reasonable buy', async () => {
    const { server } = setup();
    const result = await server.callTool('check_pre_trade', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 0.1,
      price: 65000,
    });
    const data = parseResult(result);

    expect(data.decision).toBe('GO');
    expect(data.checks.every((c: any) => c.passed)).toBe(true);
  });

  it('rejects insufficient balance buy', async () => {
    const { server } = setup();
    // Buy 1000 BTC @ $65000 = $65M, way more than $50k available USDT
    const result = await server.callTool('check_pre_trade', {
      symbol: 'BTC/USDT',
      side: 'buy',
      amount: 1000,
      price: 65000,
    });
    const data = parseResult(result);

    expect(data.decision).toBe('NO_GO');
    expect(data.checks.some((c: any) => !c.passed)).toBe(true);
  });

  it('sell orders skip balance check', async () => {
    const { server } = setup();
    const result = await server.callTool('check_pre_trade', {
      symbol: 'BTC/USDT',
      side: 'sell',
      amount: 0.01,
      price: 65000,
    });
    const data = parseResult(result);

    // No 'sufficient_balance' check for sells
    const checkNames = data.checks.map((c: any) => c.name);
    expect(checkNames).not.toContain('sufficient_balance');
  });
});

// ── get_risk_dashboard ───────────────────────────────────────

describe('get_risk_dashboard', () => {
  it('returns comprehensive dashboard', async () => {
    const { server } = setup();
    const result = await server.callTool('get_risk_dashboard', {});
    const data = parseResult(result);

    expect(data.portfolioValue).toBe(117000);
    expect(data.numPositions).toBe(4); // USDT, BTC, ETH, SOL
    expect(data.limits.maxPositionPct).toBe(20);
    // USDT is largest at 50000/117000 = ~42.7%
    expect(data.metrics.concentration.value).toBeCloseTo(42.7, 0);
    expect(['red', 'yellow', 'green']).toContain(data.metrics.concentration.status);
    // 4 holdings → yellow (3-4 = yellow, ≥5 = green)
    expect(data.metrics.diversification.value).toBe(4);
    expect(data.metrics.diversification.status).toBe('yellow');
    expect(data.holdings).toHaveLength(4);
  });
});

// ── get_margin_health ────────────────────────────────────────

describe('get_margin_health', () => {
  it('returns margin health metrics', async () => {
    const { server } = setup();
    const result = await server.callTool('get_margin_health', {});
    const data = parseResult(result);

    // Margin health only counts USDT/USD balances
    expect(data.totalEquity).toBe(50000);
    expect(data.freeMargin).toBe(50000); // no used margin
    expect(data.marginRatio).toBe(0); // no used margin
    expect(data.healthScore).toBe(100); // 100 - 0% margin ratio
    expect(data.status).toBe('HEALTHY');
  });
});
