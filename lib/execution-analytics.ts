/**
 * Execution analytics: pure functions for order book and trade flow analysis.
 * Extracted from CCXT connector tools for reuse across connectors and skills.
 */

import { mean, standardDeviation } from './math.js';

// ── Interfaces ───────────────────────────────────────────────

export interface FillSimulation {
  filled: number;
  avgFillPrice: number;
  slippagePct: number;
  slippagePerUnit: number;
}

export interface DepthBand {
  bidDepth: number;
  askDepth: number;
  total: number;
}

export interface OrderBookImbalance {
  bidVolume: number;
  askVolume: number;
  imbalance: number;
}

export interface BookLevel {
  price: number;
  size: number;
  ratioVsTop: number;
}

export interface TradeEntry {
  side: 'buy' | 'sell';
  amount: number;
  price?: number;
  timestamp?: number;
}

export interface TradeFlowAnalysis {
  buyVolume: number;
  sellVolume: number;
  buyCount: number;
  sellCount: number;
  buySellRatio: number | null;
  imbalancePct: number;
  signal: string;
  largeTrades: {
    count: number;
    threshold: number;
    trades: TradeEntry[];
  };
}

export interface MomentumScore {
  change1Bar: number | null;
  change5Bar: number | null;
  change10Bar: number | null;
  change20Bar: number | null;
  volumeSurge: number;
  momentumScore: number;
}

export interface ExecutionQuality {
  vwap: number;
  avgFillPrice: number;
  slippageBps: number | undefined;
  makerCount: number;
  takerCount: number;
}

export interface FillEntry {
  price: number;
  amount: number;
  cost?: number;
  takerOrMaker?: string;
}

export interface EntryRecommendation {
  orderType: 'limit' | 'market';
  price: number | null;
  rationale: string;
}

// ── Order Book Fill Simulation ───────────────────────────────

/**
 * Simulate walking an order book to fill a given amount.
 * Pass asks for a buy, bids for a sell.
 *
 * @param book  - price levels: [price, size][]
 * @param amount - desired fill quantity in base currency
 * @param mid   - current mid price for slippage calculation
 */
export function simulateOrderBookFill(
  book: [number, number][],
  amount: number,
  mid: number,
): FillSimulation {
  let filled = 0;
  let totalCost = 0;

  for (const [price, size] of book) {
    const fill = Math.min(size, amount - filled);
    totalCost += fill * price;
    filled += fill;
    if (filled >= amount) break;
  }

  const avgFillPrice = filled > 0
    ? Math.round((totalCost / filled) * 100) / 100
    : Math.round(mid * 100) / 100;
  const slippagePct = mid > 0
    ? Math.round((Math.abs(avgFillPrice - mid) / mid) * 100000000) / 100000000
    : 0;
  const slippagePerUnit = Math.round(Math.abs(avgFillPrice - mid) * 100) / 100;

  return {
    filled: Math.round(filled * 100000000) / 100000000,
    avgFillPrice,
    slippagePct,
    slippagePerUnit,
  };
}

// ── Depth Analysis at Bands ──────────────────────────────────

/**
 * Compute total bid and ask depth within percentage bands of the mid price.
 *
 * @param bids  - bid levels sorted best-first: [price, size][]
 * @param asks  - ask levels sorted best-first: [price, size][]
 * @param mid   - current mid price
 * @param bands - percentage bands as decimals, e.g. [0.001, 0.005, 0.01]
 */
export function analyzeDepthAtBands(
  bids: [number, number][],
  asks: [number, number][],
  mid: number,
  bands: number[],
): Record<string, DepthBand> {
  const result: Record<string, DepthBand> = {};

  for (const pctBand of bands) {
    const threshold = mid * pctBand;
    let bidDepth = 0;
    let askDepth = 0;

    for (const [price, size] of bids) {
      if (price >= mid - threshold) bidDepth += size;
      else break;
    }
    for (const [price, size] of asks) {
      if (price <= mid + threshold) askDepth += size;
      else break;
    }

    const label = `${(pctBand * 100).toFixed(1)}%`;
    result[label] = {
      bidDepth: Math.round(bidDepth * 100000000) / 100000000,
      askDepth: Math.round(askDepth * 100000000) / 100000000,
      total: Math.round((bidDepth + askDepth) * 100000000) / 100000000,
    };
  }

  return result;
}

// ── Order Book Imbalance ─────────────────────────────────────

/**
 * Compute bid-ask volume imbalance across the full visible book.
 * Imbalance is (bid - ask) / (bid + ask), range [-1, 1].
 */
export function computeOrderBookImbalance(
  bids: [number, number][],
  asks: [number, number][],
): OrderBookImbalance {
  const bidVolume = bids.reduce((sum, [, size]) => sum + size, 0);
  const askVolume = asks.reduce((sum, [, size]) => sum + size, 0);
  const totalVolume = bidVolume + askVolume;
  const imbalance = totalVolume > 0
    ? Math.round(((bidVolume - askVolume) / totalVolume) * 10000) / 10000
    : 0;

  return {
    bidVolume: Math.round(bidVolume * 100000000) / 100000000,
    askVolume: Math.round(askVolume * 100000000) / 100000000,
    imbalance,
  };
}

// ── Order Book Shape ─────────────────────────────────────────

/**
 * Analyze the shape of one side of an order book.
 * Each level's size is compared as a ratio to the top-of-book size.
 */
export function analyzeOrderBookShape(
  book: [number, number][],
): BookLevel[] {
  if (book.length === 0) return [];
  const topSize = book[0][1];
  if (topSize === 0) return [];

  return book.map(([price, size]) => ({
    price: Math.round(price * 100) / 100,
    size: Math.round(size * 100000000) / 100000000,
    ratioVsTop: Math.round((size / topSize) * 10000) / 10000,
  }));
}

// ── Weighted Mid Price ───────────────────────────────────────

/**
 * Size-weighted mid price: weights the best bid and ask by opposing top-of-book sizes.
 * Formula: (bestBid * askTopSize + bestAsk * bidTopSize) / (bidTopSize + askTopSize)
 */
export function computeWeightedMid(
  bestBid: number,
  bestAsk: number,
  bidTopSize: number,
  askTopSize: number,
): number {
  const totalSize = bidTopSize + askTopSize;
  if (totalSize === 0) {
    return Math.round(((bestBid + bestAsk) / 2) * 100) / 100;
  }
  return Math.round(
    ((bestBid * askTopSize + bestAsk * bidTopSize) / totalSize) * 100,
  ) / 100;
}

// ── Trade Flow Analysis ──────────────────────────────────────

/**
 * Analyze a batch of recent trades for buy/sell imbalance, large-trade detection,
 * and a directional signal.
 */
export function analyzeTradeFlow(
  trades: TradeEntry[],
): TradeFlowAnalysis {
  let buyVolume = 0;
  let sellVolume = 0;
  let buyCount = 0;
  let sellCount = 0;
  let totalSize = 0;

  for (const t of trades) {
    totalSize += t.amount;
    if (t.side === 'buy') {
      buyVolume += t.amount;
      buyCount++;
    } else {
      sellVolume += t.amount;
      sellCount++;
    }
  }

  const totalVolume = buyVolume + sellVolume;
  const avgSize = trades.length > 0 ? totalSize / trades.length : 0;

  const buySellRatio = sellVolume > 0
    ? Math.round((buyVolume / sellVolume) * 100) / 100
    : buyVolume > 0 ? null : 0;

  const imbalancePct = totalVolume > 0
    ? Math.round(((buyVolume - sellVolume) / totalVolume) * 10000) / 100
    : 0;

  let signal: string;
  if (imbalancePct > 20) signal = 'strong_buy_pressure';
  else if (imbalancePct > 5) signal = 'moderate_buy_pressure';
  else if (imbalancePct < -20) signal = 'strong_sell_pressure';
  else if (imbalancePct < -5) signal = 'moderate_sell_pressure';
  else signal = 'neutral';

  const largeThreshold = avgSize * 2;
  const largeTrades = trades.filter(t => t.amount > largeThreshold);

  return {
    buyVolume: Math.round(buyVolume * 10000) / 10000,
    sellVolume: Math.round(sellVolume * 10000) / 10000,
    buyCount,
    sellCount,
    buySellRatio,
    imbalancePct,
    signal,
    largeTrades: {
      count: largeTrades.length,
      threshold: Math.round(largeThreshold * 10000) / 10000,
      trades: largeTrades,
    },
  };
}

// ── Momentum Scoring ─────────────────────────────────────────

/**
 * Compute a composite momentum score from price closes and volumes.
 * Combines multi-bar price changes with a volume surge ratio.
 */
export function computeMomentumScore(
  closes: number[],
  volumes: number[],
): MomentumScore {
  if (closes.length < 2) {
    return {
      change1Bar: null,
      change5Bar: null,
      change10Bar: null,
      change20Bar: null,
      volumeSurge: 1,
      momentumScore: 0,
    };
  }

  const latest = closes[closes.length - 1];

  const pctChange = (n: number): number | null => {
    if (closes.length <= n) return null;
    const prev = closes[closes.length - 1 - n];
    return prev > 0 ? Math.round(((latest - prev) / prev) * 10000) / 100 : null;
  };

  const change1Bar = pctChange(1);
  const change5Bar = pctChange(5);
  const change10Bar = pctChange(10);
  const change20Bar = pctChange(20);

  // Volume surge: avg of last 5 bars vs avg of previous 20 bars
  const recentVols = volumes.slice(-5);
  const priorVols = volumes.slice(-25, -5);

  const avgRecent = recentVols.length > 0
    ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length
    : 0;
  const avgPrior = priorVols.length > 0
    ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length
    : avgRecent;

  const volumeSurge = avgPrior > 0
    ? Math.round((avgRecent / avgPrior) * 100) / 100
    : 1;

  // Weighted momentum score
  const c1 = change1Bar ?? 0;
  const c5 = change5Bar ?? 0;
  const c10 = change10Bar ?? 0;
  const c20 = change20Bar ?? 0;
  const volScore = (volumeSurge - 1) * 100;

  const momentumScore = Math.round(
    (c1 * 0.1 + c5 * 0.2 + c10 * 0.3 + c20 * 0.2 + volScore * 0.2) * 100,
  ) / 100;

  return {
    change1Bar,
    change5Bar,
    change10Bar,
    change20Bar,
    volumeSurge,
    momentumScore,
  };
}

// ── Execution Quality Metrics ────────────────────────────────

/**
 * Compute execution quality from a set of fills.
 * Returns VWAP, average fill price, slippage in bps vs mid, and maker/taker breakdown.
 */
export function computeExecutionQuality(
  fills: FillEntry[],
  midPrice: number | undefined,
): ExecutionQuality {
  if (fills.length === 0) {
    return {
      vwap: 0,
      avgFillPrice: 0,
      slippageBps: undefined,
      makerCount: 0,
      takerCount: 0,
    };
  }

  let totalVolume = 0;
  let totalCost = 0;
  let makerCount = 0;
  let takerCount = 0;

  for (const f of fills) {
    totalVolume += f.amount;
    totalCost += f.cost ?? f.price * f.amount;
    if (f.takerOrMaker === 'maker') makerCount++;
    else if (f.takerOrMaker === 'taker') takerCount++;
  }

  const vwap = totalVolume > 0
    ? Math.round((totalCost / totalVolume) * 100) / 100
    : 0;
  const avgFillPrice = Math.round(
    (fills.reduce((sum, f) => sum + f.price, 0) / fills.length) * 100,
  ) / 100;

  const slippageBps = midPrice != null && midPrice > 0
    ? Math.round(((vwap - midPrice) / midPrice) * 10000 * 100) / 100
    : undefined;

  return {
    vwap,
    avgFillPrice,
    slippageBps,
    makerCount,
    takerCount,
  };
}

// ── Entry Recommendation ─────────────────────────────────────

/**
 * Recommend an order type and price based on spread conditions and urgency.
 */
export function recommendEntry(
  side: 'buy' | 'sell',
  mid: number,
  bestBid: number,
  bestAsk: number,
  spread: number,
  spreadBps: number,
  slippagePct: number,
  urgency: 'low' | 'medium' | 'high',
): EntryRecommendation {
  const tickSize = spread > 0 ? spread * 0.1 : mid * 0.0001;

  if (urgency === 'low') {
    const price = side === 'buy'
      ? Math.round((bestBid + tickSize) * 100) / 100
      : Math.round((bestAsk - tickSize) * 100) / 100;
    return {
      orderType: 'limit',
      price,
      rationale: `Low urgency: limit order near ${side === 'buy' ? 'bid' : 'ask'} to minimize cost; spread is ${spreadBps.toFixed(1)} bps`,
    };
  }

  if (urgency === 'medium') {
    const price = Math.round(mid * 100) / 100;
    return {
      orderType: 'limit',
      price,
      rationale: `Medium urgency: limit at mid price (${price}) balances fill probability and cost`,
    };
  }

  // high urgency
  return {
    orderType: 'market',
    price: null,
    rationale: `High urgency: market order for immediate fill; expected slippage ${(slippagePct * 100).toFixed(3)}%`,
  };
}
