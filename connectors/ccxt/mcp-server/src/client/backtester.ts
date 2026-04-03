/**
 * Multi-strategy backtesting engine.
 *
 * Runs historical simulations on OHLCV bar data with realistic commission
 * and slippage modelling. Supports nine built-in strategies and computes
 * a comprehensive metrics suite using lib/math.ts where possible.
 */

import type { BarResult } from './exchange.js';
import {
  sma, ema, rsi, macd, bollingerBands, stochastic,
  type OHLCV,
} from '../../../../../lib/indicators.js';
import {
  sharpeRatio, sortinoRatio, maxDrawdown, calmarRatio,
  winRate as calcWinRate, profitFactor as calcProfitFactor,
  returns as calcReturns, mean,
} from '../../../../../lib/math.js';

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

// ── Signal type used internally ─────────────────────────────

type Signal = 'buy' | 'sell' | 'hold';

// ── Strategy registry ───────────────────────────────────────

type StrategyFn = (bars: BarResult[], params: Record<string, number>) => Signal[];

const STRATEGIES: Record<string, StrategyFn> = {
  sma_crossover: smaCrossoverStrategy,
  rsi_mean_reversion: rsiMeanReversionStrategy,
  macd_momentum: macdMomentumStrategy,
  bollinger_breakout: bollingerBreakoutStrategy,
  bollinger_mean_reversion: bollingerMeanReversionStrategy,
  ema_trend_following: emaTrendFollowingStrategy,
  stochastic_oscillator: stochasticOscillatorStrategy,
  adx_trend_strength: adxTrendStrengthStrategy,
  multi_indicator_confluence: multiIndicatorConfluenceStrategy,
};

/** Default parameters for each strategy — used by runAll(). */
const DEFAULT_PARAMS: Record<string, Record<string, number>> = {
  sma_crossover: { fastPeriod: 10, slowPeriod: 30 },
  rsi_mean_reversion: { period: 14, oversold: 30, overbought: 70 },
  macd_momentum: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
  bollinger_breakout: { period: 20, stdDev: 2 },
  bollinger_mean_reversion: { period: 20, stdDev: 2 },
  ema_trend_following: { period: 20 },
  stochastic_oscillator: { kPeriod: 14, dPeriod: 3, oversold: 20, overbought: 80 },
  adx_trend_strength: { period: 14, threshold: 25 },
  multi_indicator_confluence: {
    rsiPeriod: 14, smaPeriod: 20,
    macdFast: 12, macdSlow: 26, macdSignal: 9,
    requiredSignals: 2,
  },
};

// ── Backtester Class ────────────────────────────────────────

export interface RunOptions {
  strategy: string;
  bars: BarResult[];
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
  bars: BarResult[];
  paramGrid: Record<string, number[]>;
  initialCapital: number;
  commissionRate?: number;
  slippageRate?: number;
  metric: string;
}

export class Backtester {
  private bars: BarResult[] = [];
  private config: BacktestConfig = {
    strategy: '', params: {}, initialCapital: 10000,
    commissionPct: 0.001, slippagePct: 0.0005,
  };

  constructor(bars?: BarResult[], config?: BacktestConfig) {
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
        const grossProceeds = position * execPrice;
        const commission = grossProceeds * commissionPct;
        const netProceeds = grossProceeds - commission;
        const pnl = netProceeds - entryCost;

        cash = netProceeds;
        position = 0;

        trades.push({
          timestamp: bar.timestamp,
          side: 'sell',
          price: execPrice,
          amount: trades.length > 0 ? trades[trades.length - 1].amount : 0,
          cost: grossProceeds,
          commission,
          slippage: slippage * (trades.length > 0 ? trades[trades.length - 1].amount : 0),
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

// ── Strategy Implementations ────────────────────────────────

/**
 * 1. SMA Crossover
 * Buy when fast SMA crosses above slow SMA, sell when it crosses below.
 */
function smaCrossoverStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const fastPeriod = params.fastPeriod ?? 10;
  const slowPeriod = params.slowPeriod ?? 30;

  if (fastPeriod >= slowPeriod) {
    throw new Error(`fastPeriod (${fastPeriod}) must be less than slowPeriod (${slowPeriod})`);
  }

  const closes = bars.map(b => b.close);
  const fastSma = sma(closes, fastPeriod);
  const slowSma = sma(closes, slowPeriod);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  // Both SMAs must exist — slow SMA starts at index (slowPeriod - 1)
  const offset = slowPeriod - 1;

  for (let i = offset + 1; i < bars.length; i++) {
    const fastIdx = i - (fastPeriod - 1);
    const slowIdx = i - (slowPeriod - 1);
    const prevFastIdx = fastIdx - 1;
    const prevSlowIdx = slowIdx - 1;

    if (prevFastIdx < 0 || prevSlowIdx < 0) continue;

    const fastNow = fastSma[fastIdx];
    const slowNow = slowSma[slowIdx];
    const fastPrev = fastSma[prevFastIdx];
    const slowPrev = slowSma[prevSlowIdx];

    if (fastPrev <= slowPrev && fastNow > slowNow) {
      signals[i] = 'buy';
    } else if (fastPrev >= slowPrev && fastNow < slowNow) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 2. RSI Mean Reversion
 * Buy when RSI drops below oversold, sell when RSI rises above overbought.
 */
function rsiMeanReversionStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 14;
  const oversold = params.oversold ?? 30;
  const overbought = params.overbought ?? 70;

  const closes = bars.map(b => b.close);
  const rsiValues = rsi(closes, period);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  // RSI starts producing values at index `period` in the closes array
  const rsiOffset = period;

  for (let i = rsiOffset; i < bars.length; i++) {
    const rsiIdx = i - rsiOffset;
    if (rsiIdx < 0 || rsiIdx >= rsiValues.length) continue;

    const val = rsiValues[rsiIdx];
    if (val < oversold) {
      signals[i] = 'buy';
    } else if (val > overbought) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 3. MACD Momentum
 * Buy when MACD line crosses above signal line, sell when it crosses below.
 */
function macdMomentumStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const fastPeriod = params.fastPeriod ?? 12;
  const slowPeriod = params.slowPeriod ?? 26;
  const signalPeriod = params.signalPeriod ?? 9;

  const closes = bars.map(b => b.close);
  const result = macd(closes, fastPeriod, slowPeriod, signalPeriod);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  // MACD line length = closes.length - slowPeriod + 1
  // Signal line length = macdLine.length - signalPeriod + 1
  // Histogram aligns signal and macd with offset
  const macdLine = result.macd;
  const signalLine = result.signal;
  const signalOffset = signalPeriod - 1;

  // The histogram starts at signalOffset into macdLine
  // macdLine starts at (slowPeriod - 1) into closes
  // signalLine starts at (signalPeriod - 1) into macdLine
  // So the first aligned index in closes is: (slowPeriod - 1) + (signalPeriod - 1)
  const barsOffset = (slowPeriod - 1) + (signalPeriod - 1);

  for (let i = 1; i < signalLine.length; i++) {
    const barIdx = barsOffset + i;
    if (barIdx >= bars.length) break;

    const macdNow = macdLine[i + signalOffset];
    const macdPrev = macdLine[i + signalOffset - 1];
    const sigNow = signalLine[i];
    const sigPrev = signalLine[i - 1];

    if (macdPrev <= sigPrev && macdNow > sigNow) {
      signals[barIdx] = 'buy';
    } else if (macdPrev >= sigPrev && macdNow < sigNow) {
      signals[barIdx] = 'sell';
    }
  }

  return signals;
}

/**
 * 4. Bollinger Band Breakout
 * Buy when price breaks above the upper band, sell when it breaks below the lower band.
 */
function bollingerBreakoutStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 20;
  const stdDev = params.stdDev ?? 2;

  const closes = bars.map(b => b.close);
  const bb = bollingerBands(closes, period, stdDev);

  const signals: Signal[] = new Array(bars.length).fill('hold');
  const bbOffset = period - 1;

  for (let i = bbOffset + 1; i < bars.length; i++) {
    const bbIdx = i - bbOffset;
    const prevBbIdx = bbIdx - 1;
    if (prevBbIdx < 0) continue;

    const priceNow = closes[i];
    const pricePrev = closes[i - 1];

    // Breakout above upper band
    if (pricePrev <= bb.upper[prevBbIdx] && priceNow > bb.upper[bbIdx]) {
      signals[i] = 'buy';
    }
    // Breakdown below lower band
    else if (pricePrev >= bb.lower[prevBbIdx] && priceNow < bb.lower[bbIdx]) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 5. Bollinger Band Mean Reversion
 * Buy when price touches the lower band, sell when it touches the upper band.
 */
function bollingerMeanReversionStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 20;
  const stdDev = params.stdDev ?? 2;

  const closes = bars.map(b => b.close);
  const bb = bollingerBands(closes, period, stdDev);

  const signals: Signal[] = new Array(bars.length).fill('hold');
  const bbOffset = period - 1;

  for (let i = bbOffset; i < bars.length; i++) {
    const bbIdx = i - bbOffset;
    const price = closes[i];

    if (price <= bb.lower[bbIdx]) {
      signals[i] = 'buy';
    } else if (price >= bb.upper[bbIdx]) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 6. EMA Trend Following
 * Buy when price is above EMA and EMA is rising. Sell when price is below EMA and EMA is falling.
 */
function emaTrendFollowingStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 20;

  const closes = bars.map(b => b.close);
  const emaValues = ema(closes, period);

  const signals: Signal[] = new Array(bars.length).fill('hold');
  // EMA starts at index 0 (first value uses SMA of first `period` elements)
  // but is valid from index (period - 1) in closes
  const emaOffset = period - 1;

  for (let i = emaOffset + 1; i < bars.length; i++) {
    const emaIdx = i - emaOffset;
    const emaPrevIdx = emaIdx - 1;
    if (emaPrevIdx < 0) continue;

    const price = closes[i];
    const emaNow = emaValues[emaIdx];
    const emaPrev = emaValues[emaPrevIdx];
    const emaRising = emaNow > emaPrev;
    const emaFalling = emaNow < emaPrev;

    if (price > emaNow && emaRising) {
      signals[i] = 'buy';
    } else if (price < emaNow && emaFalling) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

/**
 * 7. Stochastic Oscillator
 * Buy when %K crosses above %D in the oversold zone.
 * Sell when %K crosses below %D in the overbought zone.
 */
function stochasticOscillatorStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const kPeriod = params.kPeriod ?? 14;
  const dPeriod = params.dPeriod ?? 3;
  const oversold = params.oversold ?? 20;
  const overbought = params.overbought ?? 80;

  const candles: OHLCV[] = bars.map(b => ({
    open: b.open, high: b.high, low: b.low,
    close: b.close, volume: b.volume, timestamp: b.timestamp,
  }));

  const stoch = stochastic(candles, kPeriod, dPeriod);
  const kLine = stoch.k;
  const dLine = stoch.d;

  const signals: Signal[] = new Array(bars.length).fill('hold');

  // %K starts at index (kPeriod - 1) in candles
  // %D starts at index (dPeriod - 1) in %K
  // So %D[j] corresponds to candle index (kPeriod - 1) + (dPeriod - 1) + j
  const kOffset = kPeriod - 1;
  const dOffset = dPeriod - 1;
  const totalOffset = kOffset + dOffset;

  for (let j = 1; j < dLine.length; j++) {
    const barIdx = totalOffset + j;
    if (barIdx >= bars.length) break;

    const kNow = kLine[dOffset + j];
    const kPrev = kLine[dOffset + j - 1];
    const dNow = dLine[j];
    const dPrev = dLine[j - 1];

    // Bullish crossover in oversold zone
    if (kPrev <= dPrev && kNow > dNow && kNow < oversold) {
      signals[barIdx] = 'buy';
    }
    // Bearish crossover in overbought zone
    else if (kPrev >= dPrev && kNow < dNow && kNow > overbought) {
      signals[barIdx] = 'sell';
    }
  }

  return signals;
}

/**
 * 8. ADX Trend Strength
 * Only trade when ADX > threshold. Use +DI/-DI for direction.
 * Buy when +DI crosses above -DI with strong ADX. Sell on the reverse.
 *
 * We compute +DI/-DI inline because lib/indicators.ts only exports ADX values.
 */
function adxTrendStrengthStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const period = params.period ?? 14;
  const threshold = params.threshold ?? 25;

  if (bars.length < period * 2 + 1) {
    throw new Error(`Need at least ${period * 2 + 1} bars for ADX strategy.`);
  }

  // Compute True Range, +DM, -DM
  const trueRanges: number[] = [];
  const plusDMRaw: number[] = [];
  const minusDMRaw: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevHigh = bars[i - 1].high;
    const prevLow = bars[i - 1].low;
    const prevClose = bars[i - 1].close;

    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    plusDMRaw.push(high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0);
    minusDMRaw.push(prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0);
  }

  // Wilders smoothing
  const smoothTR = wildersSmooth(trueRanges, period);
  const smoothPlusDM = wildersSmooth(plusDMRaw, period);
  const smoothMinusDM = wildersSmooth(minusDMRaw, period);

  // Compute +DI, -DI, DX
  const plusDI: number[] = [];
  const minusDI: number[] = [];
  const dx: number[] = [];

  for (let i = 0; i < smoothTR.length; i++) {
    const pdi = smoothTR[i] === 0 ? 0 : (smoothPlusDM[i] / smoothTR[i]) * 100;
    const mdi = smoothTR[i] === 0 ? 0 : (smoothMinusDM[i] / smoothTR[i]) * 100;
    plusDI.push(pdi);
    minusDI.push(mdi);
    const diSum = pdi + mdi;
    dx.push(diSum === 0 ? 0 : (Math.abs(pdi - mdi) / diSum) * 100);
  }

  // ADX = SMA of DX
  const adxValues = sma(dx, period);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  // adxValues starts at index (period - 1) in dx
  // dx starts at index 0 in smoothTR which starts at index (period - 1) in raw arrays
  // raw arrays start at index 1 in bars
  // So adxValues[j] corresponds to bars index: 1 + (period - 1) + (period - 1) + j = 2*period - 1 + j
  const adxBarOffset = 2 * period - 1;
  // +DI/-DI are in the dx/smoothTR arrays which start at (period - 1) in raw
  const diBarOffset = period; // raw starts at bars[1], smooth starts at raw[period-1] => bars[period]

  for (let j = 1; j < adxValues.length; j++) {
    const barIdx = adxBarOffset + j;
    if (barIdx >= bars.length) break;

    const adxVal = adxValues[j];
    if (adxVal < threshold) continue; // No trade in weak trend

    // +DI/-DI index: the adxValues[j] corresponds to dx index (period - 1 + j)
    const diIdx = period - 1 + j;
    const diIdxPrev = diIdx - 1;
    if (diIdxPrev < 0 || diIdx >= plusDI.length) continue;

    const pdiNow = plusDI[diIdx];
    const pdiPrev = plusDI[diIdxPrev];
    const mdiNow = minusDI[diIdx];
    const mdiPrev = minusDI[diIdxPrev];

    // +DI crosses above -DI
    if (pdiPrev <= mdiPrev && pdiNow > mdiNow) {
      signals[barIdx] = 'buy';
    }
    // -DI crosses above +DI
    else if (pdiPrev >= mdiPrev && pdiNow < mdiNow) {
      signals[barIdx] = 'sell';
    }
  }

  return signals;
}

/**
 * 9. Multi-Indicator Confluence
 * Requires N out of M indicators to agree before entering.
 * Indicators: RSI, SMA trend, MACD histogram.
 */
function multiIndicatorConfluenceStrategy(bars: BarResult[], params: Record<string, number>): Signal[] {
  const rsiPeriod = params.rsiPeriod ?? 14;
  const smaPeriod = params.smaPeriod ?? 20;
  const macdFast = params.macdFast ?? 12;
  const macdSlow = params.macdSlow ?? 26;
  const macdSignalPeriod = params.macdSignal ?? 9;
  const requiredSignals = params.requiredSignals ?? 2;

  const closes = bars.map(b => b.close);

  // Compute indicators
  const rsiValues = rsi(closes, rsiPeriod);
  const smaValues = sma(closes, smaPeriod);
  const macdResult = macd(closes, macdFast, macdSlow, macdSignalPeriod);

  const signals: Signal[] = new Array(bars.length).fill('hold');

  // We need all indicators to be valid.
  // The latest-starting indicator determines where we begin scanning.
  const rsiStart = rsiPeriod;          // RSI valid from this closes index
  const smaStart = smaPeriod - 1;      // SMA valid from this closes index
  const macdHistStart = (macdSlow - 1) + (macdSignalPeriod - 1); // histogram valid from this closes index
  const startIdx = Math.max(rsiStart, smaStart, macdHistStart) + 1; // +1 for prev comparison

  for (let i = startIdx; i < bars.length; i++) {
    let bullish = 0;
    let bearish = 0;

    // RSI signal
    const rsiIdx = i - rsiPeriod;
    if (rsiIdx >= 0 && rsiIdx < rsiValues.length) {
      if (rsiValues[rsiIdx] < 40) bullish++;
      else if (rsiValues[rsiIdx] > 60) bearish++;
    }

    // SMA trend signal
    const smaIdx = i - (smaPeriod - 1);
    if (smaIdx >= 0 && smaIdx < smaValues.length) {
      if (closes[i] > smaValues[smaIdx]) bullish++;
      else if (closes[i] < smaValues[smaIdx]) bearish++;
    }

    // MACD histogram signal
    const histIdx = i - macdHistStart;
    if (histIdx >= 0 && histIdx < macdResult.histogram.length) {
      if (macdResult.histogram[histIdx] > 0) bullish++;
      else if (macdResult.histogram[histIdx] < 0) bearish++;
    }

    if (bullish >= requiredSignals) {
      signals[i] = 'buy';
    } else if (bearish >= requiredSignals) {
      signals[i] = 'sell';
    }
  }

  return signals;
}

// ── Helpers ─────────────────────────────────────────────────

/** Wilders smoothing (same as in lib/indicators.ts — reproduced here for +DI/-DI). */
function wildersSmooth(data: number[], period: number): number[] {
  const result: number[] = [];
  result.push(data.slice(0, period).reduce((a, b) => a + b, 0));
  for (let i = period; i < data.length; i++) {
    result.push(result[result.length - 1] - result[result.length - 1] / period + data[i]);
  }
  return result;
}

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
