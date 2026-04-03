/**
 * Backtest MCP tools — multi-strategy backtesting, comparison,
 * parameter optimization, and walk-forward validation.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { handler } from './handler.js';
import {
  Backtester,
  type BacktestConfig,
  type BacktestResult,
  type BacktestMetrics,
} from '../client/backtester.js';
import type { BarResult } from '../client/exchange.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Helpers ─────────────────────────────────────────────────

async function fetchBars(
  client: ExchangeClient,
  symbol: string,
  timeframe: string,
  since?: string,
  until?: string,
): Promise<BarResult[]> {
  const store = client.store;
  if (!store) {
    throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');
  }

  const sinceTs = since ? new Date(since).getTime() : undefined;
  const untilTs = until ? new Date(until).getTime() : undefined;

  let bars: BarResult[];

  if (sinceTs || untilTs) {
    // Query with date range via SQL
    const conditions: string[] = [
      `symbol = '${symbol.replace(/'/g, "''")}'`,
      `interval = '${timeframe.replace(/'/g, "''")}'`,
      `exchange = '${client.exchangeId.replace(/'/g, "''")}'`,
    ];
    if (sinceTs) conditions.push(`ts >= '${new Date(sinceTs).toISOString()}'`);
    if (untilTs) conditions.push(`ts <= '${new Date(untilTs).toISOString()}'`);

    const rows = await store.sql(
      `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS timestamp, open, high, low, close, volume
       FROM ohlcv WHERE ${conditions.join(' AND ')} ORDER BY ts ASC LIMIT 50000`,
    );

    bars = rows.map((r: any) => ({
      timestamp: Number(r.timestamp),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));
  } else {
    // Fetch all cached data
    const cached = await store.query({
      symbol,
      interval: timeframe,
      exchange: client.exchangeId,
      limit: 50000,
    });
    bars = cached.map((c: any) => ({
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));
  }

  if (bars.length < 30) {
    throw new Error(
      `Insufficient cached data for ${symbol} (${bars.length} bars). Run ingest_history first.`,
    );
  }

  return bars;
}

/** Summarize a BacktestResult into a compact object for tool output. */
function summarize(r: BacktestResult): Record<string, unknown> {
  return {
    strategy: r.strategy,
    params: r.params,
    totalTrades: r.metrics.totalTrades,
    totalReturn: pct(r.metrics.totalReturn),
    annualizedReturn: pct(r.metrics.annualizedReturn),
    sharpeRatio: r.metrics.sharpeRatio,
    sortinoRatio: r.metrics.sortinoRatio,
    maxDrawdown: pct(r.metrics.maxDrawdown),
    winRate: pct(r.metrics.winRate),
    profitFactor: r.metrics.profitFactor,
    calmarRatio: r.metrics.calmarRatio,
    expectancy: r.metrics.expectancy,
    avgWin: r.metrics.avgWin,
    avgLoss: r.metrics.avgLoss,
    largestWin: r.metrics.largestWin,
    largestLoss: r.metrics.largestLoss,
    avgHoldingPeriodHrs: Math.round(r.metrics.avgHoldingPeriod / 3600000 * 100) / 100,
    maxDrawdownDurationHrs: Math.round(r.metrics.maxDrawdownDuration / 3600000 * 100) / 100,
  };
}

function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

// ── Registration ────────────────────────────────────────────

export function registerBacktestTools(
  server: McpServer,
  getClient: () => ExchangeClient,
) {
  // 1. backtest_strategy — run any strategy on cached data
  server.tool(
    'backtest_strategy_v2',
    `Run a multi-strategy backtest on cached OHLCV data. Strategies: ${Backtester.strategyNames().join(', ')}. Models commission and slippage. Returns trades, equity curve, and comprehensive metrics (Sharpe, Sortino, Calmar, max drawdown, win rate, profit factor, expectancy).`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      strategy: z.string().describe(`Strategy name: ${Backtester.strategyNames().join(', ')}`),
      params: z.string().default('{}').describe('JSON object of strategy params (e.g., {"fastPeriod":10,"slowPeriod":30})'),
      initial_capital: z.number().default(10000).describe('Starting capital in quote currency'),
      commission_pct: z.number().default(0.001).describe('Commission rate (0.001 = 0.1%)'),
      slippage_pct: z.number().default(0.0005).describe('Slippage rate (0.0005 = 0.05%)'),
      since: z.string().optional().describe('Start date (ISO 8601, e.g., "2024-01-01")'),
      until: z.string().optional().describe('End date (ISO 8601, e.g., "2024-12-31")'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const bars = await fetchBars(client, params.symbol, params.timeframe, params.since, params.until);

      let strategyParams: Record<string, number>;
      try {
        strategyParams = JSON.parse(params.params);
      } catch {
        throw new Error(`Invalid params JSON: ${params.params}`);
      }

      // Merge with defaults so users only need to override what they want
      const defaults = Backtester.defaultParams(params.strategy);
      const mergedParams = { ...defaults, ...strategyParams };

      const config: BacktestConfig = {
        strategy: params.strategy,
        params: mergedParams,
        initialCapital: params.initial_capital,
        commissionPct: params.commission_pct,
        slippagePct: params.slippage_pct,
      };

      const bt = new Backtester(bars, config);
      const result = bt.run();

      // Downsample equity curve to at most 200 points for output
      const curve = downsampleCurve(result.equityCurve, 200);

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        bars: bars.length,
        dateRange: {
          from: new Date(bars[0].timestamp).toISOString(),
          to: new Date(bars[bars.length - 1].timestamp).toISOString(),
        },
        ...summarize(result),
        trades: result.trades.slice(0, 200), // cap for output
        equityCurve: curve,
      };
    }),
  );

  // 2. compare_strategies — run all strategies, return ranked table
  server.tool(
    'compare_strategies',
    `Run ALL built-in strategies (${Backtester.strategyNames().join(', ')}) on the same cached data and return a ranked comparison table sorted by Sharpe ratio. Quick way to find the best strategy for a given symbol.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      initial_capital: z.number().default(10000).describe('Starting capital'),
      commission_pct: z.number().default(0.001).describe('Commission rate'),
      slippage_pct: z.number().default(0.0005).describe('Slippage rate'),
      since: z.string().optional().describe('Start date (ISO 8601)'),
      until: z.string().optional().describe('End date (ISO 8601)'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const bars = await fetchBars(client, params.symbol, params.timeframe, params.since, params.until);

      const config: BacktestConfig = {
        strategy: '',
        params: {},
        initialCapital: params.initial_capital,
        commissionPct: params.commission_pct,
        slippagePct: params.slippage_pct,
      };

      const bt = new Backtester(bars, config);
      const results = bt.runAll();

      const ranked = results.map((r, idx) => ({
        rank: idx + 1,
        ...summarize(r),
      }));

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        bars: bars.length,
        dateRange: {
          from: new Date(bars[0].timestamp).toISOString(),
          to: new Date(bars[bars.length - 1].timestamp).toISOString(),
        },
        strategiesRun: results.length,
        ranking: ranked,
      };
    }),
  );

  // 3. optimize_strategy — grid search over parameter space
  server.tool(
    'optimize_strategy',
    `Grid search over parameter space for a given strategy. Tests all combinations of provided parameter arrays and ranks results by the chosen metric (sharpe, return, or calmar). Use for finding optimal parameters.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      strategy: z.string().describe('Strategy name'),
      param_ranges: z.string().describe('JSON of param arrays (e.g., {"fastPeriod":[5,10,20],"slowPeriod":[20,50,100]})'),
      optimize_for: z.enum(['sharpe', 'return', 'calmar']).default('sharpe').describe('Metric to optimize for'),
      initial_capital: z.number().default(10000).describe('Starting capital'),
      commission_pct: z.number().default(0.001).describe('Commission rate'),
      slippage_pct: z.number().default(0.0005).describe('Slippage rate'),
      since: z.string().optional().describe('Start date (ISO 8601)'),
      until: z.string().optional().describe('End date (ISO 8601)'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const bars = await fetchBars(client, params.symbol, params.timeframe, params.since, params.until);

      let paramRanges: Record<string, number[]>;
      try {
        paramRanges = JSON.parse(params.param_ranges);
      } catch {
        throw new Error(`Invalid param_ranges JSON: ${params.param_ranges}`);
      }

      // Generate all parameter combinations via cartesian product
      const paramNames = Object.keys(paramRanges);
      const paramArrays = paramNames.map(k => paramRanges[k]);
      const combos = cartesianProduct(paramArrays);

      if (combos.length > 5000) {
        throw new Error(
          `Parameter space too large (${combos.length} combinations, max 5000). Reduce parameter ranges.`,
        );
      }

      const defaults = Backtester.defaultParams(params.strategy);
      const results: { params: Record<string, number>; metrics: BacktestMetrics }[] = [];

      for (const combo of combos) {
        const comboParams: Record<string, number> = { ...defaults };
        for (let j = 0; j < paramNames.length; j++) {
          comboParams[paramNames[j]] = combo[j];
        }

        try {
          const config: BacktestConfig = {
            strategy: params.strategy,
            params: comboParams,
            initialCapital: params.initial_capital,
            commissionPct: params.commission_pct,
            slippagePct: params.slippage_pct,
          };
          const bt = new Backtester(bars, config);
          const result = bt.run();

          // Skip results with zero trades
          if (result.metrics.totalTrades === 0) continue;

          results.push({ params: comboParams, metrics: result.metrics });
        } catch {
          // Skip invalid parameter combinations
        }
      }

      // Sort by chosen metric
      const metric = params.optimize_for as string;
      results.sort((a, b) => {
        const va = metricValue(a.metrics, metric);
        const vb = metricValue(b.metrics, metric);
        return vb - va;
      });

      // Return top 20
      const top = results.slice(0, 20).map((r, idx) => ({
        rank: idx + 1,
        params: r.params,
        totalTrades: r.metrics.totalTrades,
        totalReturn: pct(r.metrics.totalReturn),
        annualizedReturn: pct(r.metrics.annualizedReturn),
        sharpeRatio: r.metrics.sharpeRatio,
        sortinoRatio: r.metrics.sortinoRatio,
        maxDrawdown: pct(r.metrics.maxDrawdown),
        winRate: pct(r.metrics.winRate),
        profitFactor: r.metrics.profitFactor,
        calmarRatio: r.metrics.calmarRatio,
      }));

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        strategy: params.strategy,
        optimizeFor: metric,
        bars: bars.length,
        dateRange: {
          from: new Date(bars[0].timestamp).toISOString(),
          to: new Date(bars[bars.length - 1].timestamp).toISOString(),
        },
        combinationsTested: combos.length,
        validResults: results.length,
        bestParams: results.length > 0 ? results[0].params : null,
        top20: top,
      };
    }),
  );

  // 4. walk_forward_test — walk-forward optimization
  server.tool(
    'walk_forward_test',
    `Walk-forward optimization: split data into rolling train/test windows, optimize on training data, validate on test data. Detects overfitting by comparing in-sample vs out-of-sample performance. The gold standard for strategy validation.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      strategy: z.string().describe('Strategy name'),
      param_ranges: z.string().describe('JSON of param arrays (e.g., {"fastPeriod":[5,10,20],"slowPeriod":[20,50,100]})'),
      window_size: z.number().default(200).describe('Training window size in bars'),
      step_size: z.number().default(50).describe('Step size (test window) in bars'),
      optimize_for: z.enum(['sharpe', 'return', 'calmar']).default('sharpe').describe('Metric to optimize for'),
      initial_capital: z.number().default(10000).describe('Starting capital'),
      commission_pct: z.number().default(0.001).describe('Commission rate'),
      slippage_pct: z.number().default(0.0005).describe('Slippage rate'),
      since: z.string().optional().describe('Start date (ISO 8601)'),
      until: z.string().optional().describe('End date (ISO 8601)'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const bars = await fetchBars(client, params.symbol, params.timeframe, params.since, params.until);

      let paramRanges: Record<string, number[]>;
      try {
        paramRanges = JSON.parse(params.param_ranges);
      } catch {
        throw new Error(`Invalid param_ranges JSON: ${params.param_ranges}`);
      }

      const windowSize: number = params.window_size;
      const stepSize: number = params.step_size;
      const metric = params.optimize_for as string;

      if (bars.length < windowSize + stepSize) {
        throw new Error(
          `Insufficient data: ${bars.length} bars, need at least ${windowSize + stepSize} (window + step).`,
        );
      }

      const paramNames = Object.keys(paramRanges);
      const paramArrays = paramNames.map(k => paramRanges[k]);
      const combos = cartesianProduct(paramArrays);

      if (combos.length > 2000) {
        throw new Error(
          `Parameter space too large for walk-forward (${combos.length} combinations, max 2000).`,
        );
      }

      const defaults = Backtester.defaultParams(params.strategy);
      const windows: {
        trainRange: { from: string; to: string };
        testRange: { from: string; to: string };
        bestParams: Record<string, number>;
        inSample: { sharpe: number; return: string; trades: number };
        outOfSample: { sharpe: number; return: string; trades: number };
      }[] = [];

      let outOfSampleReturns: number[] = [];

      // Slide through data
      for (let start = 0; start + windowSize + stepSize <= bars.length; start += stepSize) {
        const trainBars = bars.slice(start, start + windowSize);
        const testBars = bars.slice(start + windowSize, start + windowSize + stepSize);

        if (trainBars.length < 30 || testBars.length < 5) continue;

        // Optimize on training window
        let bestScore = -Infinity;
        let bestParams: Record<string, number> = { ...defaults };
        let bestInSampleMetrics: BacktestMetrics | null = null;

        for (const combo of combos) {
          const comboParams: Record<string, number> = { ...defaults };
          for (let j = 0; j < paramNames.length; j++) {
            comboParams[paramNames[j]] = combo[j];
          }

          try {
            const config: BacktestConfig = {
              strategy: params.strategy,
              params: comboParams,
              initialCapital: params.initial_capital,
              commissionPct: params.commission_pct,
              slippagePct: params.slippage_pct,
            };
            const bt = new Backtester(trainBars, config);
            const result = bt.run();
            if (result.metrics.totalTrades === 0) continue;

            const score = metricValue(result.metrics, metric);
            if (score > bestScore) {
              bestScore = score;
              bestParams = comboParams;
              bestInSampleMetrics = result.metrics;
            }
          } catch {
            // Skip
          }
        }

        if (!bestInSampleMetrics) continue;

        // Validate on test window with best params
        try {
          const testConfig: BacktestConfig = {
            strategy: params.strategy,
            params: bestParams,
            initialCapital: params.initial_capital,
            commissionPct: params.commission_pct,
            slippagePct: params.slippage_pct,
          };
          const testBt = new Backtester(testBars, testConfig);
          const testResult = testBt.run();

          outOfSampleReturns.push(testResult.metrics.totalReturn);

          windows.push({
            trainRange: {
              from: new Date(trainBars[0].timestamp).toISOString(),
              to: new Date(trainBars[trainBars.length - 1].timestamp).toISOString(),
            },
            testRange: {
              from: new Date(testBars[0].timestamp).toISOString(),
              to: new Date(testBars[testBars.length - 1].timestamp).toISOString(),
            },
            bestParams,
            inSample: {
              sharpe: bestInSampleMetrics.sharpeRatio,
              return: pct(bestInSampleMetrics.totalReturn),
              trades: bestInSampleMetrics.totalTrades,
            },
            outOfSample: {
              sharpe: testResult.metrics.sharpeRatio,
              return: pct(testResult.metrics.totalReturn),
              trades: testResult.metrics.totalTrades,
            },
          });
        } catch {
          // Skip test window failures
        }
      }

      if (windows.length === 0) {
        throw new Error('Walk-forward produced no valid windows. Try a smaller window_size or more data.');
      }

      // Aggregate out-of-sample performance
      const avgOosSharpe = windows.reduce((s, w) => s + w.outOfSample.sharpe, 0) / windows.length;
      const avgIsSharpe = windows.reduce((s, w) => s + w.inSample.sharpe, 0) / windows.length;
      const compoundedReturn = outOfSampleReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;

      // Walk-forward efficiency: out-of-sample Sharpe / in-sample Sharpe
      const wfEfficiency = avgIsSharpe !== 0
        ? Math.round((avgOosSharpe / avgIsSharpe) * 100) / 100
        : 0;

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        strategy: params.strategy,
        optimizeFor: metric,
        totalBars: bars.length,
        dateRange: {
          from: new Date(bars[0].timestamp).toISOString(),
          to: new Date(bars[bars.length - 1].timestamp).toISOString(),
        },
        windowSize,
        stepSize,
        totalWindows: windows.length,
        combinationsPerWindow: combos.length,
        aggregate: {
          avgInSampleSharpe: Math.round(avgIsSharpe * 100) / 100,
          avgOutOfSampleSharpe: Math.round(avgOosSharpe * 100) / 100,
          walkForwardEfficiency: wfEfficiency,
          compoundedOutOfSampleReturn: pct(compoundedReturn),
          overfitRisk: wfEfficiency < 0.5 ? 'HIGH' : wfEfficiency < 0.75 ? 'MODERATE' : 'LOW',
        },
        windows,
      };
    }),
  );
}

// ── Utility functions ───────────────────────────────────────

/** Cartesian product of arrays. */
function cartesianProduct(arrays: number[][]): number[][] {
  if (arrays.length === 0) return [[]];
  return arrays.reduce<number[][]>(
    (acc, arr) => acc.flatMap(combo => arr.map(val => [...combo, val])),
    [[]],
  );
}

/** Extract a metric value from BacktestMetrics by name. */
function metricValue(m: BacktestMetrics, name: string): number {
  switch (name) {
    case 'sharpe': return isFinite(m.sharpeRatio) ? m.sharpeRatio : -999;
    case 'return': return isFinite(m.totalReturn) ? m.totalReturn : -999;
    case 'calmar': return isFinite(m.calmarRatio) ? m.calmarRatio : -999;
    default: return isFinite(m.sharpeRatio) ? m.sharpeRatio : -999;
  }
}

/** Downsample an equity curve to at most `maxPoints` entries. */
function downsampleCurve(
  curve: { timestamp: number; equity: number }[],
  maxPoints: number,
): { timestamp: number; equity: number }[] {
  if (curve.length <= maxPoints) return curve;
  const step = Math.ceil(curve.length / maxPoints);
  const result: { timestamp: number; equity: number }[] = [];
  for (let i = 0; i < curve.length; i += step) {
    result.push(curve[i]);
  }
  // Always include the last point
  if (result[result.length - 1] !== curve[curve.length - 1]) {
    result.push(curve[curve.length - 1]);
  }
  return result;
}
