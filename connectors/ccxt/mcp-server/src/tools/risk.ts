/**
 * Risk management engine tools.
 * Position limits, VaR, drawdown monitoring, stress testing, pre-trade checks.
 *
 * Thin wrappers around @ai-fund/lib/portfolio-analytics — all pure computation
 * is delegated to the shared library. This file handles MCP registration,
 * auth gating, exchange data fetching, and response shaping.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler, authHandler } from './handler';
import {
  valueAtRisk, returns,
} from '@ai-fund/lib/math';
import {
  resolvePrice,
  computePortfolioExposure,
  checkPreTrade,
  simulateStressTest,
  monitorDrawdown,
  computeMarginHealth,
  computeRiskDashboard,
  detectCorrelationClusters,
  STRESS_SCENARIOS,
} from '@ai-fund/lib/portfolio-analytics';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Risk limits (in-memory) ──────────────────────────────────

interface RiskLimits {
  maxPositionPct: number;       // max % of portfolio in one position
  maxDrawdownPct: number;       // max drawdown before circuit breaker
  maxLeverage: number;          // max total leverage
  maxConcentrationPct: number;  // max % in correlated assets
  dailyLossLimitPct: number;    // max daily loss as % of portfolio
}

const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxPositionPct: 20,
  maxDrawdownPct: 15,
  maxLeverage: 3,
  maxConcentrationPct: 40,
  dailyLossLimitPct: 5,
};

export function registerRiskTools(server: McpServer, client: ExchangeClient) {
  // Scoped per-registration — each exchange gets its own limits, not shared globally
  const riskLimits: RiskLimits = { ...DEFAULT_RISK_LIMITS };

  // ── Set / Get risk limits ───────────────────────────────────

  server.tool(
    'set_risk_limits',
    'View or update risk management limits. Pass parameters to update, or call with no params to view current limits.',
    {
      max_position_pct: z.number().optional().describe('Max % of portfolio in one position (default 20)'),
      max_drawdown_pct: z.number().optional().describe('Max drawdown % before circuit breaker (default 15)'),
      max_leverage: z.number().optional().describe('Max total leverage (default 3)'),
      max_concentration_pct: z.number().optional().describe('Max % in correlated cluster (default 40)'),
      daily_loss_limit_pct: z.number().optional().describe('Max daily loss % (default 5)'),
    } as any,
    handler(async (params: any) => {
      if (params.max_position_pct != null) riskLimits.maxPositionPct = params.max_position_pct;
      if (params.max_drawdown_pct != null) riskLimits.maxDrawdownPct = params.max_drawdown_pct;
      if (params.max_leverage != null) riskLimits.maxLeverage = params.max_leverage;
      if (params.max_concentration_pct != null) riskLimits.maxConcentrationPct = params.max_concentration_pct;
      if (params.daily_loss_limit_pct != null) riskLimits.dailyLossLimitPct = params.daily_loss_limit_pct;
      return { limits: { ...riskLimits }, updated: true };
    }),
  );

  // ── Portfolio exposure ──────────────────────────────────────

  server.tool(
    'get_portfolio_exposure',
    `Full portfolio exposure breakdown on ${client.name}. Shows gross/net exposure, concentration, and per-asset weights.`,
    {} as any,
    authHandler(client, async () => {
      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      const exposure = computePortfolioExposure(balances, tickers);

      return {
        exchange: client.exchangeId,
        ...exposure,
        limits: { ...riskLimits },
        concentrationAlert: exposure.topConcentration > riskLimits.maxConcentrationPct,
      };
    }),
  );

  // ── Check position limits ───────────────────────────────────

  server.tool(
    'check_position_limits',
    'Validate a proposed trade against risk limits. Returns pass/fail with details.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      amount: z.number().describe('Order amount'),
      price: z.number().describe('Expected execution price'),
    } as any,
    authHandler(client, async (params: any) => {
      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      // Estimate portfolio value
      let totalValue = 0;
      for (const bal of balances) {
        totalValue += Math.abs(bal.total * resolvePrice(bal.currency, tickers));
      }

      const orderValue = params.amount * params.price;
      const orderPct = totalValue > 0 ? (orderValue / totalValue) * 100 : 100;

      const checks = [
        {
          name: 'position_size',
          passed: orderPct <= riskLimits.maxPositionPct,
          message: `Order is ${orderPct.toFixed(1)}% of portfolio (limit: ${riskLimits.maxPositionPct}%)`,
        },
        {
          name: 'portfolio_value',
          passed: totalValue > 0,
          message: totalValue > 0 ? `Portfolio value: $${totalValue.toFixed(2)}` : 'No portfolio value detected',
        },
      ];

      const allPassed = checks.every(c => c.passed);

      return {
        symbol: params.symbol,
        side: params.side,
        orderValue,
        orderPct,
        portfolioValue: totalValue,
        decision: allPassed ? 'APPROVED' : 'REJECTED',
        checks,
        limits: { ...riskLimits },
      };
    }),
  );

  // ── Value at Risk ───────────────────────────────────────────

  server.tool(
    'calculate_var',
    'Calculate portfolio Value at Risk using parametric method.',
    {
      confidence: z.number().default(0.95).describe('Confidence level (0.95 or 0.99)'),
      horizon: z.number().default(1).describe('Time horizon in days'),
      lookback: z.number().default(30).describe('Historical lookback period in days'),
    } as any,
    authHandler(client, async (params: any) => {
      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      // Calculate portfolio value
      let totalValue = 0;
      const holdingSymbols: string[] = [];
      for (const bal of balances) {
        if (bal.total === 0) continue;
        totalValue += bal.total * resolvePrice(bal.currency, tickers);
        if (bal.currency !== 'USDT' && bal.currency !== 'USD' && bal.total > 0) {
          holdingSymbols.push(`${bal.currency}/USDT`);
        }
      }

      // Fetch historical data for holdings and compute returns
      const allReturns: number[][] = [];
      for (const sym of holdingSymbols.slice(0, 10)) {
        try {
          const bars = await client.getBars(sym, '1d', undefined, params.lookback);
          const closes = bars.map(b => b.close);
          allReturns.push(returns(closes));
        } catch {
          // skip symbols without data
        }
      }

      // Simple portfolio return approximation (equal-weighted)
      let portfolioReturns: number[] = [];
      if (allReturns.length > 0) {
        const minLen = Math.min(...allReturns.map(r => r.length));
        for (let i = 0; i < minLen; i++) {
          let sum = 0;
          for (const ret of allReturns) {
            sum += ret[i];
          }
          portfolioReturns.push(sum / allReturns.length);
        }
      }

      const var95 = portfolioReturns.length > 1 ? valueAtRisk(totalValue, portfolioReturns, params.confidence, params.horizon) : 0;

      return {
        exchange: client.exchangeId,
        portfolioValue: totalValue,
        confidence: params.confidence,
        horizon: params.horizon,
        var: var95,
        varPct: totalValue > 0 ? (var95 / totalValue) * 100 : 0,
        numHoldings: holdingSymbols.length,
        dataPoints: portfolioReturns.length,
        status: var95 / totalValue * 100 > riskLimits.dailyLossLimitPct ? 'WARNING' : 'OK',
      };
    }),
  );

  // ── Drawdown monitor ────────────────────────────────────────

  server.tool(
    'get_drawdown_monitor',
    'Monitor current portfolio drawdown from peak equity.',
    {} as any,
    authHandler(client, async () => {
      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      let currentEquity = 0;
      for (const bal of balances) {
        currentEquity += bal.total * resolvePrice(bal.currency, tickers);
      }

      const result = monitorDrawdown(currentEquity, riskLimits.maxDrawdownPct);

      return {
        exchange: client.exchangeId,
        ...result,
        maxAllowedDrawdown: riskLimits.maxDrawdownPct,
      };
    }),
  );

  // ── Correlation risk ────────────────────────────────────────

  server.tool(
    'check_correlation_risk',
    'Check portfolio for dangerous correlations between holdings. Identifies highly correlated clusters.',
    {
      threshold: z.number().default(0.8).describe('Correlation threshold (default 0.8)'),
      lookback: z.number().default(30).describe('Lookback period in days'),
    } as any,
    authHandler(client, async (params: any) => {
      const balances = await client.getBalance();
      const holdingSymbols: string[] = [];
      for (const bal of balances) {
        if (bal.total > 0 && bal.currency !== 'USDT' && bal.currency !== 'USD') {
          holdingSymbols.push(`${bal.currency}/USDT`);
        }
      }

      if (holdingSymbols.length < 2) {
        return { exchange: client.exchangeId, message: 'Need at least 2 holdings for correlation analysis', riskScore: 0 };
      }

      // Fetch returns for each holding
      const returnsSeries: number[][] = [];
      const validSymbols: string[] = [];
      for (const sym of holdingSymbols.slice(0, 10)) {
        try {
          const bars = await client.getBars(sym, '1d', undefined, params.lookback);
          if (bars.length > 5) {
            returnsSeries.push(returns(bars.map(b => b.close)));
            validSymbols.push(sym);
          }
        } catch {
          // skip
        }
      }

      if (validSymbols.length < 2) {
        return { exchange: client.exchangeId, message: 'Insufficient price data for correlation analysis', riskScore: 0 };
      }

      const result = detectCorrelationClusters(returnsSeries, validSymbols, params.threshold);

      return {
        exchange: client.exchangeId,
        ...result,
        symbols: validSymbols,
      };
    }),
  );

  // ── Stress test ─────────────────────────────────────────────

  server.tool(
    'simulate_stress_test',
    'Stress test portfolio against historical crash scenarios or custom price changes.',
    {
      scenario: z.enum(['btc_crash_2022', 'luna_collapse', 'ftx_contagion', 'flash_crash', 'custom']).describe('Stress scenario'),
      custom_changes: z.string().optional().describe('For custom: JSON like {"BTC":-0.3,"ETH":-0.4} (decimal pct changes)'),
    } as any,
    authHandler(client, async (params: any) => {
      let changes: Record<string, number>;
      if (params.scenario === 'custom') {
        try {
          changes = JSON.parse(params.custom_changes || '{}');
        } catch {
          throw new Error('Invalid JSON in custom_changes');
        }
      } else {
        changes = STRESS_SCENARIOS[params.scenario] || {};
      }

      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      const result = simulateStressTest(balances, tickers, changes, riskLimits.maxDrawdownPct);

      return {
        exchange: client.exchangeId,
        scenario: params.scenario,
        ...result,
        maxAllowedDrawdown: riskLimits.maxDrawdownPct,
      };
    }),
  );

  // ── Pre-trade risk check ────────────────────────────────────

  server.tool(
    'check_pre_trade',
    'Comprehensive pre-trade risk check. Run this before executing any trade to get a go/no-go decision.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      amount: z.number().describe('Order amount'),
      price: z.number().describe('Expected price'),
    } as any,
    authHandler(client, async (params: any) => {
      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      const result = checkPreTrade(
        balances,
        tickers,
        { symbol: params.symbol, side: params.side, amount: params.amount, price: params.price },
        { maxPositionPct: riskLimits.maxPositionPct },
      );

      return {
        symbol: params.symbol,
        side: params.side,
        amount: params.amount,
        price: params.price,
        ...result,
        limits: { ...riskLimits },
      };
    }),
  );

  // ── Risk dashboard ──────────────────────────────────────────

  server.tool(
    'get_risk_dashboard',
    'Comprehensive risk dashboard with traffic-light status for all risk metrics.',
    {} as any,
    authHandler(client, async () => {
      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      const dashboard = computeRiskDashboard(balances, tickers, riskLimits.maxConcentrationPct);

      return {
        exchange: client.exchangeId,
        timestamp: Date.now(),
        portfolioValue: dashboard.portfolioValue,
        numPositions: dashboard.numPositions,
        limits: { ...riskLimits },
        metrics: {
          concentration: {
            value: dashboard.topConcentration,
            status: dashboard.concentrationStatus,
            topHolding: dashboard.holdings[0]?.currency || 'none',
          },
          diversification: {
            value: dashboard.numPositions,
            status: dashboard.diversificationStatus,
          },
        },
        holdings: dashboard.holdings,
      };
    }),
  );

  // ── Margin health ───────────────────────────────────────────

  server.tool(
    'get_margin_health',
    'Check margin account health, liquidation distance, and available margin.',
    { symbol: z.string().optional().describe('Optional symbol to check specific position') } as any,
    authHandler(client, async (params: any) => {
      const balances = await client.getBalance();

      const result = computeMarginHealth(balances, ['USDT', 'USD']);

      return {
        exchange: client.exchangeId,
        ...result,
      };
    }),
  );
}
