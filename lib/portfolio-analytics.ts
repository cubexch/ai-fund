/**
 * Exchange-agnostic portfolio analytics.
 * Pure functions that take typed data (balances, prices, bars) and return structured results.
 * No exchange clients, no MCP, no zod.
 */

import { valueAtRisk, maxDrawdown, sharpeRatio, sortinoRatio, annualizedVolatility, returns, correlationMatrix, mean } from './math.js';

// ── Types ────────────────────────────────────────────────

export interface BalanceEntry {
  currency: string;
  total: number;
  free: number;
  used: number;
}

export interface TickerEntry {
  symbol: string;
  last: number | undefined;
}

export interface PortfolioPosition {
  currency: string;
  value: number;
  weight: number;
  side: 'long' | 'short';
}

export interface PortfolioExposure {
  totalValue: number;
  grossExposure: number;
  netExposure: number;
  longExposure: number;
  shortExposure: number;
  longShortRatio: number | null;
  numPositions: number;
  positions: PortfolioPosition[];
  topConcentration: number;
}

export interface PreTradeCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PreTradeResult {
  orderValue: number;
  orderPct: number;
  portfolioValue: number;
  decision: 'GO' | 'NO_GO';
  reason: string;
  checks: PreTradeCheck[];
}

export interface StressImpact {
  currency: string;
  currentValue: number;
  stressedValue: number;
  changePct: number;
  loss: number;
}

export interface StressTestResult {
  currentPortfolioValue: number;
  stressedPortfolioValue: number;
  totalLoss: number;
  lossPct: number;
  impacts: StressImpact[];
  survivable: boolean;
}

export interface RebalanceTrade {
  symbol: string;
  side: 'buy' | 'sell';
  amount: number;
  notional: number;
  reason: string;
}

export interface RebalanceResult {
  portfolioValue: number;
  currentWeights: Record<string, number>;
  targetWeights: Record<string, number>;
  trades: RebalanceTrade[];
  totalTurnover: number;
  turnoverPct: number;
}

export interface PortfolioRiskSymbol {
  symbol: string;
  weight: number;
  annualizedVolatility: number;
  maxDrawdown: number;
  sharpeRatio: number;
  sortinoRatio: number | null;
  dataPoints: number;
}

export interface PortfolioRiskResult {
  portfolio: {
    value: number;
    confidence: number;
    valueAtRisk: number;
    annualizedVolatility: number;
    maxDrawdown: number;
    sharpeRatio: number;
    meanDailyReturn: number;
    dataPoints: number;
  };
  perSymbol: PortfolioRiskSymbol[];
  correlations: { labels: string[]; matrix: number[][] };
}

// ── Stress test scenarios ────────────────────────────────

export const STRESS_SCENARIOS: Record<string, Record<string, number>> = {
  btc_crash_2022: { BTC: -0.65, ETH: -0.72, SOL: -0.85, AVAX: -0.80, LINK: -0.70, default: -0.60 },
  luna_collapse: { BTC: -0.30, ETH: -0.35, SOL: -0.45, AVAX: -0.40, default: -0.35 },
  ftx_contagion: { BTC: -0.25, ETH: -0.30, SOL: -0.60, FTT: -0.97, default: -0.30 },
  flash_crash: { BTC: -0.15, ETH: -0.20, SOL: -0.25, default: -0.18 },
};

// ── Price resolution ─────────────────────────────────────

/**
 * Resolve a USD-equivalent price for a currency using ticker data.
 * Returns 1 for stablecoins, 0 if not found.
 */
export function resolvePrice(
  currency: string,
  tickers: TickerEntry[],
): number {
  if (currency === 'USDT' || currency === 'USD' || currency === 'USDC') return 1;
  const symbol = `${currency}/USDT`;
  const ticker = tickers.find(t => t.symbol === symbol);
  return ticker?.last || 0;
}

// ── Portfolio exposure ───────────────────────────────────

/**
 * Compute portfolio exposure breakdown from balances and ticker data.
 */
export function computePortfolioExposure(
  balances: BalanceEntry[],
  tickers: TickerEntry[],
): PortfolioExposure {
  let grossLong = 0;
  let grossShort = 0;
  const positions: PortfolioPosition[] = [];

  let totalValue = 0;
  for (const bal of balances) {
    if (bal.total === 0) continue;
    const price = resolvePrice(bal.currency, tickers);
    totalValue += Math.abs(bal.total * price);
  }

  for (const bal of balances) {
    if (bal.total === 0) continue;
    const price = resolvePrice(bal.currency, tickers);
    const value = bal.total * price;
    const weight = totalValue > 0 ? (value / totalValue) * 100 : 0;
    const side: 'long' | 'short' = value >= 0 ? 'long' : 'short';

    if (value > 0) grossLong += value;
    else grossShort += Math.abs(value);

    positions.push({ currency: bal.currency, value, weight, side });
  }

  positions.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  return {
    totalValue,
    grossExposure: grossLong + grossShort,
    netExposure: grossLong - grossShort,
    longExposure: grossLong,
    shortExposure: grossShort,
    longShortRatio: grossShort > 0 ? grossLong / grossShort : null,
    numPositions: positions.filter(p => Math.abs(p.value) > 1).length,
    positions,
    topConcentration: positions.length > 0 ? positions[0].weight : 0,
  };
}

// ── Pre-trade risk check ─────────────────────────────────

/**
 * Run pre-trade risk checks against portfolio state and limits.
 */
export function checkPreTrade(
  balances: BalanceEntry[],
  tickers: TickerEntry[],
  order: { symbol: string; side: 'buy' | 'sell'; amount: number; price: number },
  limits: { maxPositionPct: number },
): PreTradeResult {
  const orderValue = order.amount * order.price;

  let totalValue = 0;
  for (const bal of balances) {
    totalValue += Math.abs(bal.total * resolvePrice(bal.currency, tickers));
  }

  const orderPct = totalValue > 0 ? (orderValue / totalValue) * 100 : 100;

  const checks: PreTradeCheck[] = [
    {
      name: 'position_size',
      passed: orderPct <= limits.maxPositionPct,
      detail: `${orderPct.toFixed(1)}% of portfolio (max ${limits.maxPositionPct}%)`,
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

  if (order.side === 'buy') {
    const quoteCurrency = order.symbol.split('/')[1] || 'USDT';
    const quoteBal = balances.find(b => b.currency === quoteCurrency);
    const available = quoteBal?.free || 0;
    checks.push({
      name: 'sufficient_balance',
      passed: available >= orderValue,
      detail: `Available ${quoteCurrency}: ${available.toFixed(2)}, needed: ${orderValue.toFixed(2)}`,
    });
  }

  const allPassed = checks.every(c => c.passed);

  return {
    orderValue,
    orderPct,
    portfolioValue: totalValue,
    decision: allPassed ? 'GO' : 'NO_GO',
    reason: allPassed ? 'All risk checks passed' : checks.filter(c => !c.passed).map(c => c.detail).join('; '),
    checks,
  };
}

// ── Stress test ──────────────────────────────────────────

/**
 * Simulate portfolio impact under a stress scenario.
 */
export function simulateStressTest(
  balances: BalanceEntry[],
  tickers: TickerEntry[],
  changes: Record<string, number>,
  maxDrawdownPct: number,
): StressTestResult {
  let currentValue = 0;
  let stressedValue = 0;
  const impacts: StressImpact[] = [];

  for (const bal of balances) {
    if (bal.total === 0) continue;
    const price = resolvePrice(bal.currency, tickers);
    const value = bal.total * price;
    currentValue += value;

    const changePct = changes[bal.currency] ?? (changes as Record<string, number>).default ?? 0;
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
    currentPortfolioValue: currentValue,
    stressedPortfolioValue: stressedValue,
    totalLoss,
    lossPct,
    impacts,
    survivable: lossPct < maxDrawdownPct,
  };
}

// ── Portfolio risk assessment ────────────────────────────

/**
 * Compute per-symbol and portfolio-level risk metrics from daily close data.
 * @param symbolData - map of symbol → array of daily closes
 * @param weights - array of portfolio weights (same order as symbolData keys)
 * @param portfolioValue - total portfolio value in quote currency
 * @param confidence - VaR confidence level (e.g. 0.95)
 */
export function assessPortfolioRisk(
  symbolData: Record<string, number[]>,
  weights: number[],
  portfolioValue: number,
  confidence: number,
): PortfolioRiskResult {
  const symbols = Object.keys(symbolData);
  const allReturns: number[][] = [];
  const perSymbol: PortfolioRiskSymbol[] = [];

  for (let i = 0; i < symbols.length; i++) {
    const closes = symbolData[symbols[i]];
    const symReturns = returns(closes);
    allReturns.push(symReturns);

    const cumValues = [1.0];
    for (const r of symReturns) {
      cumValues.push(cumValues[cumValues.length - 1] * (1 + r));
    }

    const vol = annualizedVolatility(symReturns);
    const mdd = maxDrawdown(cumValues);
    const sharpe = sharpeRatio(symReturns);
    const sortino = sortinoRatio(symReturns);

    perSymbol.push({
      symbol: symbols[i],
      weight: weights[i],
      annualizedVolatility: Math.round(vol * 10000) / 10000,
      maxDrawdown: Math.round(mdd.maxDrawdown * 10000) / 10000,
      sharpeRatio: Math.round(sharpe * 100) / 100,
      sortinoRatio: Number.isFinite(sortino) ? Math.round(sortino * 100) / 100 : null,
      dataPoints: symReturns.length,
    });
  }

  const minLen = Math.min(...allReturns.map(r => r.length));
  const portfolioReturns: number[] = [];
  for (let t = 0; t < minLen; t++) {
    let wr = 0;
    for (let i = 0; i < allReturns.length; i++) {
      wr += weights[i] * allReturns[i][t];
    }
    portfolioReturns.push(wr);
  }

  const portfValues = [1.0];
  for (const r of portfolioReturns) {
    portfValues.push(portfValues[portfValues.length - 1] * (1 + r));
  }

  const portfVol = annualizedVolatility(portfolioReturns);
  const portfMdd = maxDrawdown(portfValues);
  const portfSharpe = sharpeRatio(portfolioReturns);
  const var_ = portfolioReturns.length > 1 ? valueAtRisk(portfolioValue, portfolioReturns, confidence) : 0;

  const corrMatrix = correlationMatrix(
    allReturns.map(r => r.slice(0, minLen)),
    symbols,
  );
  corrMatrix.matrix = corrMatrix.matrix.map(row =>
    row.map(v => Math.round(v * 10000) / 10000),
  );

  return {
    portfolio: {
      value: portfolioValue,
      confidence,
      valueAtRisk: Math.round(var_ * 100) / 100,
      annualizedVolatility: Math.round(portfVol * 10000) / 10000,
      maxDrawdown: Math.round(portfMdd.maxDrawdown * 10000) / 10000,
      sharpeRatio: Math.round(portfSharpe * 100) / 100,
      meanDailyReturn: Math.round(mean(portfolioReturns) * 1000000) / 1000000,
      dataPoints: portfolioReturns.length,
    },
    perSymbol,
    correlations: corrMatrix,
  };
}

// ── Rebalance calculation ────────────────────────────────

/**
 * Calculate trades needed to rebalance from current holdings to target weights.
 * @param holdings - current holdings with symbol, amount, and price
 * @param targetWeights - target allocation weights by symbol (sum to ~1.0)
 * @param prices - price lookup for all symbols involved
 * @param totalValue - optional override for total portfolio value
 */
export function calculateRebalanceTrades(
  holdings: { symbol: string; amount: number; price: number }[],
  targetWeights: Record<string, number>,
  prices: Record<string, number>,
  totalValue?: number,
): RebalanceResult {
  const portfolioValue = totalValue ??
    holdings.reduce((sum, h) => sum + h.amount * h.price, 0);

  if (portfolioValue <= 0) {
    return {
      portfolioValue: 0,
      currentWeights: {},
      targetWeights,
      trades: [],
      totalTurnover: 0,
      turnoverPct: 0,
    };
  }

  const currentValues: Record<string, number> = {};
  for (const h of holdings) {
    currentValues[h.symbol] = h.amount * h.price;
  }

  const currentWeights: Record<string, number> = {};
  for (const [sym, val] of Object.entries(currentValues)) {
    currentWeights[sym] = Math.round((val / portfolioValue) * 10000) / 10000;
  }

  const allSymbols = new Set([...Object.keys(currentValues), ...Object.keys(targetWeights)]);
  const trades: RebalanceTrade[] = [];
  let totalTurnover = 0;

  for (const sym of allSymbols) {
    const currentVal = currentValues[sym] ?? 0;
    const targetWeight = targetWeights[sym] ?? 0;
    const targetVal = portfolioValue * targetWeight;
    const delta = targetVal - currentVal;

    if (Math.abs(delta) < 1) continue;

    const curWeightPct = ((currentVal / portfolioValue) * 100).toFixed(1);
    const tgtWeightPct = (targetWeight * 100).toFixed(1);

    const side: 'buy' | 'sell' = delta > 0 ? 'buy' : 'sell';
    const absDelta = Math.abs(delta);
    const price = prices[sym];
    if (!price || price <= 0) continue;

    const amount = absDelta / price;
    const reason = currentVal === 0
      ? `New position at ${tgtWeightPct}%`
      : side === 'buy'
        ? `Increase from ${curWeightPct}% to ${tgtWeightPct}%`
        : `Decrease from ${curWeightPct}% to ${tgtWeightPct}%`;

    trades.push({
      symbol: sym,
      side,
      amount,
      notional: Math.round(absDelta * 100) / 100,
      reason,
    });
    totalTurnover += absDelta;
  }

  trades.sort((a, b) => b.notional - a.notional);

  return {
    portfolioValue: Math.round(portfolioValue * 100) / 100,
    currentWeights,
    targetWeights,
    trades,
    totalTurnover: Math.round(totalTurnover * 100) / 100,
    turnoverPct: Math.round((totalTurnover / portfolioValue) * 1000) / 10,
  };
}
