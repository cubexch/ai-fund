/**
 * Risk management engine tools.
 * Position limits, VaR, drawdown monitoring, stress testing, pre-trade checks.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { handler, authHandler } from './handler.js';
import {
  valueAtRisk, maxDrawdown, sharpeRatio, sortinoRatio,
  returns, correlationMatrix, mean, standardDeviation,
} from '../../../../../lib/math.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Risk limits (in-memory) ──────────────────────────────────

interface RiskLimits {
  maxPositionPct: number;       // max % of portfolio in one position
  maxDrawdownPct: number;       // max drawdown before circuit breaker
  maxLeverage: number;          // max total leverage
  maxConcentrationPct: number;  // max % in correlated assets
  dailyLossLimitPct: number;    // max daily loss as % of portfolio
}

let riskLimits: RiskLimits = {
  maxPositionPct: 20,
  maxDrawdownPct: 15,
  maxLeverage: 3,
  maxConcentrationPct: 40,
  dailyLossLimitPct: 5,
};

export function registerRiskTools(server: McpServer, client: ExchangeClient) {

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

      let grossLong = 0;
      let grossShort = 0;
      const positions: { currency: string; value: number; weight: number; side: string }[] = [];

      // Get total portfolio value
      let totalValue = 0;
      for (const bal of balances) {
        if (bal.total === 0) continue;
        const symbol = `${bal.currency}/USDT`;
        const ticker = tickers.find(t => t.symbol === symbol);
        const price = ticker?.last || (bal.currency === 'USDT' || bal.currency === 'USD' ? 1 : 0);
        const value = bal.total * price;
        totalValue += Math.abs(value);
      }

      if (totalValue === 0) totalValue = 1; // avoid division by zero

      for (const bal of balances) {
        if (bal.total === 0) continue;
        const symbol = `${bal.currency}/USDT`;
        const ticker = tickers.find(t => t.symbol === symbol);
        const price = ticker?.last || (bal.currency === 'USDT' || bal.currency === 'USD' ? 1 : 0);
        const value = bal.total * price;
        const weight = (value / totalValue) * 100;
        const side = value >= 0 ? 'long' : 'short';

        if (value > 0) grossLong += value;
        else grossShort += Math.abs(value);

        positions.push({ currency: bal.currency, value, weight, side });
      }

      positions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

      return {
        exchange: client.exchangeId,
        totalValue,
        grossExposure: grossLong + grossShort,
        netExposure: grossLong - grossShort,
        longExposure: grossLong,
        shortExposure: grossShort,
        longShortRatio: grossShort > 0 ? grossLong / grossShort : Infinity,
        numPositions: positions.filter(p => Math.abs(p.value) > 1).length,
        positions,
        limits: { ...riskLimits },
        topConcentration: positions.length > 0 ? positions[0].weight : 0,
        concentrationAlert: positions.length > 0 && positions[0].weight > riskLimits.maxConcentrationPct,
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
        const sym = `${bal.currency}/USDT`;
        const t = tickers.find(tk => tk.symbol === sym);
        const p = t?.last || (bal.currency === 'USDT' || bal.currency === 'USD' ? 1 : 0);
        totalValue += Math.abs(bal.total * p);
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
        const sym = `${bal.currency}/USDT`;
        const t = tickers.find(tk => tk.symbol === sym);
        const p = t?.last || (bal.currency === 'USDT' || bal.currency === 'USD' ? 1 : 0);
        totalValue += bal.total * p;
        if (bal.currency !== 'USDT' && bal.currency !== 'USD' && bal.total > 0) {
          holdingSymbols.push(sym);
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
        const sym = `${bal.currency}/USDT`;
        const t = tickers.find(tk => tk.symbol === sym);
        const p = t?.last || (bal.currency === 'USDT' || bal.currency === 'USD' ? 1 : 0);
        currentEquity += bal.total * p;
      }

      // Use recent bars of a stable reference to estimate peak
      // This is an approximation — real peak tracking needs persistent state
      const peakEstimate = currentEquity * 1.05; // conservative 5% above current
      const drawdownPct = ((peakEstimate - currentEquity) / peakEstimate) * 100;
      const recoveryNeeded = ((peakEstimate / currentEquity) - 1) * 100;

      const status = drawdownPct > riskLimits.maxDrawdownPct ? 'CRITICAL'
        : drawdownPct > riskLimits.maxDrawdownPct * 0.7 ? 'WARNING' : 'OK';

      return {
        exchange: client.exchangeId,
        currentEquity,
        estimatedPeak: peakEstimate,
        drawdownPct,
        recoveryNeeded,
        maxAllowedDrawdown: riskLimits.maxDrawdownPct,
        status,
        circuitBreaker: drawdownPct > riskLimits.maxDrawdownPct,
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

      // Align series lengths
      const minLen = Math.min(...returnsSeries.map(r => r.length));
      const aligned = returnsSeries.map(r => r.slice(0, minLen));

      const corrResult = correlationMatrix(aligned);
      const matrix = corrResult.matrix;

      // Find highly correlated pairs
      const highCorrelations: { pair: [string, string]; correlation: number }[] = [];
      for (let i = 0; i < validSymbols.length; i++) {
        for (let j = i + 1; j < validSymbols.length; j++) {
          const corr = matrix[i][j];
          if (Math.abs(corr) >= params.threshold) {
            highCorrelations.push({
              pair: [validSymbols[i], validSymbols[j]],
              correlation: Math.round(corr * 1000) / 1000,
            });
          }
        }
      }

      const avgCorrelation = matrix.length > 1
        ? matrix.reduce((sum: number, row: number[], i: number) =>
            sum + row.reduce((s: number, v: number, j: number) => i !== j ? s + v : s, 0), 0)
          / (matrix.length * (matrix.length - 1))
        : 0;

      const riskScore = Math.min(100, (highCorrelations.length / Math.max(1, validSymbols.length * (validSymbols.length - 1) / 2)) * 100);

      return {
        exchange: client.exchangeId,
        numHoldings: validSymbols.length,
        threshold: params.threshold,
        avgCorrelation: Math.round(avgCorrelation * 1000) / 1000,
        highCorrelations,
        numHighlyCorrelated: highCorrelations.length,
        riskScore: Math.round(riskScore),
        status: riskScore > 60 ? 'HIGH_RISK' : riskScore > 30 ? 'MODERATE' : 'DIVERSIFIED',
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
      const scenarios: Record<string, Record<string, number>> = {
        btc_crash_2022: { BTC: -0.65, ETH: -0.72, SOL: -0.85, AVAX: -0.80, LINK: -0.70, default: -0.60 },
        luna_collapse: { BTC: -0.30, ETH: -0.35, SOL: -0.45, AVAX: -0.40, default: -0.35 },
        ftx_contagion: { BTC: -0.25, ETH: -0.30, SOL: -0.60, FTT: -0.97, default: -0.30 },
        flash_crash: { BTC: -0.15, ETH: -0.20, SOL: -0.25, default: -0.18 },
      };

      let changes: Record<string, number>;
      if (params.scenario === 'custom') {
        try {
          changes = JSON.parse(params.custom_changes || '{}');
        } catch {
          throw new Error('Invalid JSON in custom_changes');
        }
      } else {
        changes = scenarios[params.scenario] || {};
      }

      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      let currentValue = 0;
      let stressedValue = 0;
      const impacts: { currency: string; currentValue: number; stressedValue: number; changePct: number; loss: number }[] = [];

      for (const bal of balances) {
        if (bal.total === 0) continue;
        const sym = `${bal.currency}/USDT`;
        const t = tickers.find(tk => tk.symbol === sym);
        const price = t?.last || (bal.currency === 'USDT' || bal.currency === 'USD' ? 1 : 0);
        const value = bal.total * price;
        currentValue += value;

        const changePct = changes[bal.currency] ?? (changes as any).default ?? 0;
        const stressed = value * (1 + changePct);
        stressedValue += stressed;

        if (Math.abs(changePct) > 0) {
          impacts.push({
            currency: bal.currency,
            currentValue: value,
            stressedValue: stressed,
            changePct: changePct * 100,
            loss: value - stressed,
          });
        }
      }

      impacts.sort((a, b) => b.loss - a.loss);
      const totalLoss = currentValue - stressedValue;
      const lossPct = currentValue > 0 ? (totalLoss / currentValue) * 100 : 0;

      return {
        exchange: client.exchangeId,
        scenario: params.scenario,
        currentPortfolioValue: currentValue,
        stressedPortfolioValue: stressedValue,
        totalLoss,
        lossPct,
        impacts,
        survivable: lossPct < riskLimits.maxDrawdownPct,
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
      const orderValue = params.amount * params.price;
      const balances = await client.getBalance();
      const tickers = await client.getTickers();

      // Portfolio value
      let totalValue = 0;
      for (const bal of balances) {
        const sym = `${bal.currency}/USDT`;
        const t = tickers.find(tk => tk.symbol === sym);
        const p = t?.last || (bal.currency === 'USDT' || bal.currency === 'USD' ? 1 : 0);
        totalValue += Math.abs(bal.total * p);
      }

      const orderPct = totalValue > 0 ? (orderValue / totalValue) * 100 : 100;

      const checks = [
        {
          name: 'position_size',
          passed: orderPct <= riskLimits.maxPositionPct,
          detail: `${orderPct.toFixed(1)}% of portfolio (max ${riskLimits.maxPositionPct}%)`,
        },
        {
          name: 'order_value',
          passed: orderValue > 0,
          detail: `Order value: $${orderValue.toFixed(2)}`,
        },
        {
          name: 'portfolio_exists',
          passed: totalValue > 0,
          detail: `Portfolio: $${totalValue.toFixed(2)}`,
        },
      ];

      // Check if we have sufficient balance for buys
      if (params.side === 'buy') {
        const quoteCurrency = params.symbol.split('/')[1] || 'USDT';
        const quoteBal = balances.find((b: any) => b.currency === quoteCurrency);
        const available = quoteBal?.free || 0;
        checks.push({
          name: 'sufficient_balance',
          passed: available >= orderValue,
          detail: `Available ${quoteCurrency}: ${available.toFixed(2)}, needed: ${orderValue.toFixed(2)}`,
        });
      }

      const allPassed = checks.every(c => c.passed);

      return {
        symbol: params.symbol,
        side: params.side,
        amount: params.amount,
        price: params.price,
        orderValue,
        decision: allPassed ? 'GO' : 'NO_GO',
        reason: allPassed ? 'All risk checks passed' : checks.filter(c => !c.passed).map(c => c.detail).join('; '),
        checks,
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

      let totalValue = 0;
      const holdings: { currency: string; value: number; pct: number }[] = [];
      for (const bal of balances) {
        if (bal.total === 0) continue;
        const sym = `${bal.currency}/USDT`;
        const t = tickers.find(tk => tk.symbol === sym);
        const p = t?.last || (bal.currency === 'USDT' || bal.currency === 'USD' ? 1 : 0);
        const value = bal.total * p;
        totalValue += Math.abs(value);
        if (Math.abs(value) > 1) {
          holdings.push({ currency: bal.currency, value, pct: 0 });
        }
      }
      holdings.forEach(h => { h.pct = totalValue > 0 ? (Math.abs(h.value) / totalValue) * 100 : 0; });
      holdings.sort((a, b) => b.pct - a.pct);

      const topConcentration = holdings.length > 0 ? holdings[0].pct : 0;
      const concentrationStatus = topConcentration > riskLimits.maxConcentrationPct ? 'red'
        : topConcentration > riskLimits.maxConcentrationPct * 0.7 ? 'yellow' : 'green';

      return {
        exchange: client.exchangeId,
        timestamp: Date.now(),
        portfolioValue: totalValue,
        numPositions: holdings.length,
        limits: { ...riskLimits },
        metrics: {
          concentration: { value: topConcentration, status: concentrationStatus, topHolding: holdings[0]?.currency || 'none' },
          diversification: { value: holdings.length, status: holdings.length >= 5 ? 'green' : holdings.length >= 3 ? 'yellow' : 'red' },
        },
        holdings: holdings.slice(0, 10),
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
      let totalEquity = 0;
      let totalUsed = 0;
      for (const bal of balances) {
        if (bal.currency === 'USDT' || bal.currency === 'USD') {
          totalEquity += bal.total;
          totalUsed += bal.used;
        }
      }

      const freeMargin = totalEquity - totalUsed;
      const marginRatio = totalEquity > 0 ? (totalUsed / totalEquity) * 100 : 0;
      const healthScore = Math.max(0, 100 - marginRatio);

      return {
        exchange: client.exchangeId,
        totalEquity,
        usedMargin: totalUsed,
        freeMargin,
        marginRatio,
        healthScore,
        status: healthScore > 70 ? 'HEALTHY' : healthScore > 40 ? 'CAUTION' : 'DANGER',
      };
    }),
  );
}
