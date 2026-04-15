/**
 * Multi-strategy backtesting engine.
 *
 * Runs historical simulations on OHLCV bar data with realistic commission
 * and slippage modelling. Supports nine built-in strategies and computes
 * a comprehensive metrics suite using lib/math.ts where possible.
 */

import type { Bar } from './connector-interface.js';
import {
  sharpeRatio, sortinoRatio, maxDrawdown, calmarRatio,
  winRate as calcWinRate, profitFactor as calcProfitFactor,
  returns as calcReturns, mean,
} from './math.js';
import { STRATEGIES, DEFAULT_PARAMS, type Signal, type StrategyFn } from './backtest-strategies.js';

// ── Public Interfaces ───────────────────────────────────────

export interface BacktestConfig {
  strategy: string;
  params: Record<string, number>;
  initialCapital: number;
  commissionPct: number;   // e.g. 0.001 for 0.1%
  slippagePct: number;     // e.g. 0.0005 for 0.05%
}

export interface BacktestTrade {
  timestamp: number;
  side: 'buy' | 'sell';
  price: number;
  amount: number;
  cost: number;
  commission: number;
  slippage: number;
  pnl: number;
  equity: number;
}

export interface BacktestMetrics {
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  avgWin: number;
  avgLoss: number;
  largestWin: number;
  largestLoss: number;
  avgHoldingPeriod: number;
  calmarRatio: number;
  expectancy: number;
  finalEquity: number;
}

export interface BacktestResult {
  strategy: string;
  params: Record<string, number>;
  trades: BacktestTrade[];
  equityCurve: { timestamp: number; equity: number }[];
  metrics: BacktestMetrics;
}

// Re-export for backward compatibility
export { STRATEGIES, DEFAULT_PARAMS, type Signal, type StrategyFn } from './backtest-strategies.js';

// ── Backtester Class ────────────────────────────────────────

export interface RunOptions {
  strategy: string;
  bars: Bar[];
  params: Record<string, number>;
  initialCapital: number;
  commissionRate?: number;
  slippageRate?: number;
  slippageBps?: number;
}

export interface WalkForwardOptions extends RunOptions {
  inSampleRatio: number;
}

export interface OptimizeOptions {
  strategy: string;
  bars: Bar[];
  paramGrid: Record<string, number[]>;
  initialCapital: number;
  commissionRate?: number;
  slippageRate?: number;
  metric: string;
}

export class Backtester {
  private bars: Bar[] = [];
  private config: BacktestConfig = {
    strategy: '', params: {}, initialCapital: 10000,
    commissionPct: 0.001, slippagePct: 0.0005,
  };

  constructor(bars?: Bar[], config?: BacktestConfig) {
    if (bars && config) {
      if (bars.length < 2) {
        throw new Error('Need at least 2 bars to backtest.');
      }
      this.bars = bars;
      this.config = config;
    }
  }

  /** Run a strategy with the given options (test-friendly API). */
  run(opts: RunOptions): BacktestResult;
  /** Run the pre-configured strategy (classic API). */
  run(): BacktestResult;
  run(opts?: RunOptions): BacktestResult {
    if (opts) {
      // Test-friendly API: all options in one call
      const bars = opts.bars;
      const slippagePct = opts.slippageBps != null
        ? opts.slippageBps / 10000
        : opts.slippageRate ?? 0;
      const config: BacktestConfig = {
        strategy: opts.strategy,
        params: opts.params,
        initialCapital: opts.initialCapital,
        commissionPct: opts.commissionRate ?? 0,
        slippagePct,
      };
      if (bars.length === 0) {
        return {
          strategy: opts.strategy, params: opts.params,
          trades: [], equityCurve: [],
          metrics: emptyMetrics(),
        };
      }
      this.bars = bars;
      this.config = config;
    }

    const strategyFn = STRATEGIES[this.config.strategy];
    if (!strategyFn) {
      throw new Error(
        `Unknown strategy "${this.config.strategy}". Available: ${Object.keys(STRATEGIES).join(', ')}`,
      );
    }

    const signals = strategyFn(this.bars, this.config.params);
    return this.simulate(signals);
  }

  /** Walk-forward test: optimize on in-sample, validate on out-of-sample. */
  walkForward(opts: WalkForwardOptions): {
    inSample: BacktestResult & { barCount: number; startTimestamp: number; endTimestamp: number };
    outOfSample: BacktestResult & { barCount: number; startTimestamp: number; endTimestamp: number };
  } {
    const splitIdx = Math.round(opts.bars.length * opts.inSampleRatio);
    const inBars = opts.bars.slice(0, splitIdx);
    const outBars = opts.bars.slice(splitIdx);

    const inResult = this.run({ ...opts, bars: inBars });
    const outResult = this.run({ ...opts, bars: outBars });

    return {
      inSample: {
        ...inResult, barCount: inBars.length,
        startTimestamp: inBars.length > 0 ? inBars[0].timestamp : 0,
        endTimestamp: inBars.length > 0 ? inBars[inBars.length - 1].timestamp : 0,
      },
      outOfSample: {
        ...outResult, barCount: outBars.length,
        startTimestamp: outBars.length > 0 ? outBars[0].timestamp : 0,
        endTimestamp: outBars.length > 0 ? outBars[outBars.length - 1].timestamp : 0,
      },
    };
  }

  /** Grid-search parameter optimization. */
  optimize(opts: OptimizeOptions): { bestParams: Record<string, number>; bestMetric: number; allResults: (BacktestResult & { metric: number })[] } {
    const paramNames = Object.keys(opts.paramGrid);
    const paramArrays = paramNames.map(k => opts.paramGrid[k]);
    const combos = cartesianProduct(paramArrays);

    const metricKey = opts.metric as keyof BacktestMetrics;
    const results: (BacktestResult & { metric: number })[] = [];
    for (const combo of combos) {
      const params: Record<string, number> = {};
      paramNames.forEach((name, i) => { params[name] = combo[i]; });
      const result = this.run({
        strategy: opts.strategy,
        bars: opts.bars,
        params,
        initialCapital: opts.initialCapital,
        commissionRate: opts.commissionRate,
        slippageRate: opts.slippageRate,
      });
      results.push({ ...result, metric: result.metrics[metricKey] as number });
    }

    results.sort((a, b) => b.metric - a.metric);
    const best = results[0];

    return {
      bestParams: best?.params ?? {},
      bestMetric: best ? best.metric : 0,
      allResults: results,
    };
  }

  /** Run every registered strategy with default params and return ranked results. */
  runAll(): BacktestResult[] {
    const results: BacktestResult[] = [];

    for (const [name, fn] of Object.entries(STRATEGIES)) {
      try {
        const params = DEFAULT_PARAMS[name] ?? {};
        const signals = fn(this.bars, params);
        const cfg = { ...this.config, strategy: name, params };
        const bt = new Backtester(this.bars, cfg);
        results.push(bt.simulate(signals));
      } catch {
        // Skip strategies that fail (e.g. insufficient data)
      }
    }

    // Sort by Sharpe ratio descending
    results.sort((a, b) => b.metrics.sharpeRatio - a.metrics.sharpeRatio);
    return results;
  }

  /** List available strategy names. */
  static strategyNames(): string[] {
    return Object.keys(STRATEGIES);
  }

  /** Get default params for a strategy. */
  static defaultParams(strategy: string): Record<string, number> {
    return { ...(DEFAULT_PARAMS[strategy] ?? {}) };
  }

  // ── Core simulation engine ────────────────────────────────

  private simulate(signals: Signal[]): BacktestResult {
    const { initialCapital, commissionPct, slippagePct, strategy, params } = this.config;
    const bars = this.bars;
    const trades: BacktestTrade[] = [];
    const equityCurve: { timestamp: number; equity: number }[] = [];

    let cash = initialCapital;
    let position = 0;       // amount of asset held
    let entryPrice = 0;
    let entryTimestamp = 0;
    let entryCost = 0;      // total cost basis including commission + slippage

    // Record initial equity (1ms before first bar to ensure strictly increasing timestamps)
    equityCurve.push({ timestamp: bars[0].timestamp - 1, equity: cash });

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      const signal = i < signals.length ? signals[i] : 'hold';

      if (signal === 'buy' && position === 0) {
        // Open long position — use all available cash
        const rawPrice = bar.close;
        const slippage = rawPrice * slippagePct;
        const execPrice = rawPrice + slippage;     // slippage works against us
        const grossCost = cash;
        const commission = grossCost * commissionPct;
        const netCost = grossCost - commission;
        const amount = netCost / execPrice;

        position = amount;
        entryPrice = execPrice;
        entryTimestamp = bar.timestamp;
        entryCost = grossCost;
        cash = 0;

        trades.push({
          timestamp: bar.timestamp,
          side: 'buy',
          price: execPrice,
          amount,
          cost: grossCost,
          commission,
          slippage: slippage * amount,
          pnl: 0,
          equity: position * bar.close,
        });
      } else if (signal === 'sell' && position > 0) {
        // Close long position
        const rawPrice = bar.close;
        const slippage = rawPrice * slippagePct;
        const execPrice = rawPrice - slippage;     // slippage works against us
        const sellAmount = position; // capture before zeroing
        const grossProceeds = sellAmount * execPrice;
        const commission = grossProceeds * commissionPct;
        const netProceeds = grossProceeds - commission;
        const pnl = netProceeds - entryCost;

        cash = netProceeds;
        position = 0;

        trades.push({
          timestamp: bar.timestamp,
          side: 'sell',
          price: execPrice,
          amount: sellAmount,
          cost: grossProceeds,
          commission,
          slippage: slippage * sellAmount,
          pnl,
          equity: cash,
        });
      }

      // Record equity at every bar
      const equity = position > 0 ? position * bar.close : cash;
      equityCurve.push({ timestamp: bar.timestamp, equity });
    }

    // Force-close any open position at last bar
    if (position > 0) {
      const lastBar = bars[bars.length - 1];
      const rawPrice = lastBar.close;
      const slippage = rawPrice * slippagePct;
      const execPrice = rawPrice - slippage;
      const grossProceeds = position * execPrice;
      const commission = grossProceeds * commissionPct;
      const netProceeds = grossProceeds - commission;
      const pnl = netProceeds - entryCost;

      cash = netProceeds;

      trades.push({
        timestamp: lastBar.timestamp,
        side: 'sell',
        price: execPrice,
        amount: position,
        cost: grossProceeds,
        commission,
        slippage: slippage * position,
        pnl,
        equity: cash,
      });

      position = 0;
      // Update last equity point
      equityCurve[equityCurve.length - 1] = { timestamp: lastBar.timestamp, equity: cash };
    }

    const metrics = this.computeMetrics(trades, equityCurve, initialCapital);

    return { strategy, params, trades, equityCurve, metrics };
  }

  // ── Metrics computation ───────────────────────────────────

  private computeMetrics(
    trades: BacktestTrade[],
    equityCurve: { timestamp: number; equity: number }[],
    initialCapital: number,
  ): BacktestMetrics {
    const sellTrades = trades.filter(t => t.side === 'sell');
    const pnls = sellTrades.map(t => t.pnl);
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p <= 0);

    const totalTrades = sellTrades.length;
    const finalEquity = equityCurve.length > 0
      ? equityCurve[equityCurve.length - 1].equity
      : initialCapital;
    const totalReturn = (finalEquity - initialCapital) / initialCapital;

    // Time span for annualization
    const firstTs = equityCurve.length > 0 ? equityCurve[0].timestamp : 0;
    const lastTs = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].timestamp : 0;
    const durationMs = lastTs - firstTs;
    const durationYears = durationMs / (365.25 * 24 * 60 * 60 * 1000);
    const annualizedReturn = durationYears > 0
      ? Math.pow(1 + totalReturn, 1 / durationYears) - 1
      : totalReturn;

    // Equity values for drawdown and ratio computation
    const equityValues = equityCurve.map(e => e.equity);
    const equityReturns = calcReturns(equityValues);

    // Sharpe & Sortino — use per-bar returns
    // Estimate periodsPerYear from bar frequency
    const periodsPerYear = this.estimatePeriodsPerYear(equityCurve);
    const sharpe = equityReturns.length > 1
      ? sharpeRatio(equityReturns, 0.05, periodsPerYear)
      : 0;
    const sortino = equityReturns.length > 1
      ? sortinoRatio(equityReturns, 0.05, periodsPerYear)
      : 0;

    // Max drawdown + duration
    const dd = maxDrawdown(equityValues);
    const ddDuration = this.computeDrawdownDuration(equityCurve);

    // Calmar
    const calmar = equityReturns.length > 1 && dd.maxDrawdown > 0
      ? calmarRatio(equityReturns, equityValues, periodsPerYear)
      : 0;

    // Win/loss stats
    const wr = totalTrades > 0 ? calcWinRate(pnls) : 0;
    const pf = totalTrades > 0 ? calcProfitFactor(pnls) : 0;
    const avgWin = wins.length > 0 ? mean(wins) : 0;
    const avgLoss = losses.length > 0 ? mean(losses) : 0;
    const largestWin = wins.length > 0 ? Math.max(...wins) : 0;
    const largestLoss = losses.length > 0 ? Math.min(...losses) : 0;

    // Average holding period
    const holdingPeriods = this.computeHoldingPeriods(trades);
    const avgHoldingPeriod = holdingPeriods.length > 0 ? mean(holdingPeriods) : 0;

    // Expectancy
    const expectancy = totalTrades > 0 ? mean(pnls) : 0;

    return {
      totalReturn: round4(totalReturn),
      annualizedReturn: round4(annualizedReturn),
      sharpeRatio: round2(sharpe),
      sortinoRatio: round2(sortino),
      maxDrawdown: round4(dd.maxDrawdown),
      maxDrawdownDuration: Math.round(ddDuration),
      winRate: round4(wr),
      profitFactor: round2(pf),
      totalTrades,
      avgWin: round2(avgWin),
      avgLoss: round2(avgLoss),
      largestWin: round2(largestWin),
      largestLoss: round2(largestLoss),
      avgHoldingPeriod: Math.round(avgHoldingPeriod),
      calmarRatio: round2(calmar),
      expectancy: round2(expectancy),
      finalEquity: round2(finalEquity),
    };
  }

  /** Estimate how many bars make up a year based on average bar spacing. */
  private estimatePeriodsPerYear(curve: { timestamp: number }[]): number {
    if (curve.length < 2) return 365;
    const totalMs = curve[curve.length - 1].timestamp - curve[0].timestamp;
    const avgBarMs = totalMs / (curve.length - 1);
    if (avgBarMs <= 0) return 365;
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    return Math.round(msPerYear / avgBarMs);
  }

  /** Compute the longest drawdown duration in milliseconds. */
  private computeDrawdownDuration(curve: { timestamp: number; equity: number }[]): number {
    if (curve.length < 2) return 0;
    let peak = curve[0].equity;
    let peakTs = curve[0].timestamp;
    let maxDuration = 0;

    for (const point of curve) {
      if (point.equity >= peak) {
        peak = point.equity;
        peakTs = point.timestamp;
      } else {
        const duration = point.timestamp - peakTs;
        if (duration > maxDuration) maxDuration = duration;
      }
    }
    return maxDuration;
  }

  /** Extract holding periods (ms) from paired buy/sell trades. */
  private computeHoldingPeriods(trades: BacktestTrade[]): number[] {
    const periods: number[] = [];
    let lastBuyTs = 0;
    for (const t of trades) {
      if (t.side === 'buy') {
        lastBuyTs = t.timestamp;
      } else if (t.side === 'sell' && lastBuyTs > 0) {
        periods.push(t.timestamp - lastBuyTs);
        lastBuyTs = 0;
      }
    }
    return periods;
  }
}

// ── Helpers ─────────────────────────────────────────────────

function round2(n: number): number {
  if (!isFinite(n)) return n;
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  if (!isFinite(n)) return n;
  return Math.round(n * 10000) / 10000;
}

function emptyMetrics(): BacktestMetrics {
  return {
    totalReturn: 0, annualizedReturn: 0, sharpeRatio: 0, sortinoRatio: 0,
    maxDrawdown: 0, maxDrawdownDuration: 0, winRate: 0, profitFactor: 0,
    totalTrades: 0, avgWin: 0, avgLoss: 0, largestWin: 0, largestLoss: 0,
    avgHoldingPeriod: 0, calmarRatio: 0, expectancy: 0, finalEquity: 0,
  };
}

function cartesianProduct(arrays: number[][]): number[][] {
  if (arrays.length === 0) return [[]];
  const [first, ...rest] = arrays;
  const restProduct = cartesianProduct(rest);
  const result: number[][] = [];
  for (const val of first) {
    for (const combo of restProduct) {
      result.push([val, ...combo]);
    }
  }
  return result;
}
