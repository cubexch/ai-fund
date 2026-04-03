/**
 * Grid trading, DCA scheduling, and basis trade analysis utilities.
 * All pure functions — no async, no exchange clients, no MCP.
 */

import { returns, standardDeviation } from './math.js';
import { bollingerBands, atr } from './indicators.js';

// ── Types ─────────────────────────────────────────────────

export interface DcaScheduleInput {
  totalAmount: number;
  numOrders: number;
  currentPrice: number;
  closes: number[];
  volAdjust: boolean;
}

export interface DcaOrder {
  orderNumber: number;
  amountQuote: number;
  estimatedAmountBase: number;
  sizeReason: string;
}

export interface GridParams {
  gridTop: number;
  gridBottom: number;
  spacing: number;
  numGrids: number;
  levels: { price: number; side: 'buy' | 'sell'; amount: number }[];
  expectedDailyTrades: number;
  volRegime: 'high' | 'normal' | 'low';
  atr: { current: number; average: number; ratio: number };
  priceRange: { high: number; low: number; current: number; bbUpper: number; bbLower: number };
}

export interface BasisTradeInput {
  spotPrice: number;
  perpPrice: number;
  fundingRate: number | null;
  estimatedFeePct?: number;
}

export interface BasisTradeResult {
  basis: number;
  basisAnnualized: number;
  fundingRateAnnualized: number | null;
  totalCarryAnnualized: number;
  estimatedFees: number;
  netCarryAnnualized: number;
  signal: string;
  actionable: boolean;
}

// ── Volatility Regime Classification ──────────────────────

/**
 * Classify volatility regime based on current vs average ATR.
 */
export function classifyVolRegime(currentAtr: number, avgAtr: number): 'high' | 'normal' | 'low' {
  if (avgAtr === 0) return 'normal';
  const ratio = currentAtr / avgAtr;
  if (ratio > 1.5) return 'high';
  if (ratio < 0.7) return 'low';
  return 'normal';
}

// ── DCA Schedule ──────────────────────────────────────────

/**
 * Compute a DCA schedule, optionally adjusted by rolling volatility.
 *
 * When volAdjust is true, each order's size is inversely proportional
 * to its rolling volatility (window=10), so more capital is deployed
 * during calmer periods.
 */
export function computeDcaSchedule(input: DcaScheduleInput): DcaOrder[] {
  const { totalAmount, numOrders, currentPrice, closes, volAdjust } = input;

  if (numOrders <= 0) return [];

  if (!volAdjust || closes.length < 12) {
    const amountPerOrder = totalAmount / numOrders;
    const orders: DcaOrder[] = [];
    for (let i = 0; i < numOrders; i++) {
      orders.push({
        orderNumber: i + 1,
        amountQuote: amountPerOrder,
        estimatedAmountBase: amountPerOrder / currentPrice,
        sizeReason: 'equal split',
      });
    }
    return orders;
  }

  // Compute rolling volatilities using window=10
  const rets = returns(closes);
  const window = 10;
  const vols: number[] = [];

  for (let i = 0; i < numOrders; i++) {
    const startIdx = Math.max(0, rets.length - numOrders + i - window + 1);
    const endIdx = Math.max(startIdx + window, rets.length - numOrders + i + 1);
    const slice = rets.slice(startIdx, endIdx);
    const vol = standardDeviation(slice);
    vols.push(vol > 0 ? vol : 1e-8);
  }

  // Inverse vol weighting: lower vol => larger allocation
  const inverseVols = vols.map(v => 1 / v);
  const totalInverseVol = inverseVols.reduce((a, b) => a + b, 0);
  const weights = inverseVols.map(iv => iv / totalInverseVol);

  const orders: DcaOrder[] = [];
  for (let i = 0; i < numOrders; i++) {
    const amountQuote = totalAmount * weights[i];
    orders.push({
      orderNumber: i + 1,
      amountQuote,
      estimatedAmountBase: amountQuote / currentPrice,
      sizeReason: `vol-adjusted (vol=${vols[i].toFixed(4)}, weight=${(weights[i] * 100).toFixed(1)}%)`,
    });
  }

  return orders;
}

// ── Grid Parameter Optimization ───────────────────────────

/**
 * Optimize grid trading parameters using Bollinger Bands and ATR.
 *
 * - Bollinger Bands (20, 2) define the price range
 * - ATR(14) determines grid spacing
 * - Vol regime classifies market conditions
 * - Grid levels are placed with buys below and sells above current price
 */
export function optimizeGridParams(
  candles: { open: number; high: number; low: number; close: number; volume: number }[],
  numGrids: number,
  notionalTotal: number = 10000,
): GridParams {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const currentPrice = closes[closes.length - 1];

  // Bollinger Bands for price range
  const bb = bollingerBands(closes, 20, 2);
  const bbUpper = bb.upper[bb.upper.length - 1];
  const bbLower = bb.lower[bb.lower.length - 1];

  // ATR for grid spacing
  const ohlcvCandles = candles.map(c => ({
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    timestamp: 0,
  }));
  const atrValues = atr(ohlcvCandles, 14);
  const currentAtr = atrValues[atrValues.length - 1];
  const avgAtr = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
  const atrRatio = avgAtr > 0 ? currentAtr / avgAtr : 1;

  // Vol regime
  const volRegime = classifyVolRegime(currentAtr, avgAtr);

  // Grid boundaries from Bollinger Bands
  const gridTop = bbUpper;
  const gridBottom = bbLower;
  const spacing = (gridTop - gridBottom) / numGrids;

  // Build grid levels
  const amountPerGrid = notionalTotal / numGrids;
  const levels: { price: number; side: 'buy' | 'sell'; amount: number }[] = [];

  for (let i = 0; i <= numGrids; i++) {
    const price = gridBottom + i * spacing;
    const side: 'buy' | 'sell' = price < currentPrice ? 'buy' : 'sell';
    levels.push({
      price: parseFloat(price.toFixed(8)),
      side,
      amount: amountPerGrid / price,
    });
  }

  // Expected daily trades: higher vol => more grid touches
  const dailyRange = currentAtr;
  const expectedDailyTrades = spacing > 0 ? Math.round(dailyRange / spacing) : 0;

  // Price range stats
  const high = Math.max(...highs);
  const low = Math.min(...lows);

  return {
    gridTop,
    gridBottom,
    spacing,
    numGrids,
    levels,
    expectedDailyTrades,
    volRegime,
    atr: { current: currentAtr, average: avgAtr, ratio: atrRatio },
    priceRange: { high, low, current: currentPrice, bbUpper, bbLower },
  };
}

// ── Basis Trade Analysis ──────────────────────────────────

/**
 * Analyze a spot-perpetual basis trade opportunity.
 *
 * Computes annualized basis, funding carry, fees, and net carry,
 * then classifies the signal and actionability.
 */
export function analyzeBasisTrade(input: BasisTradeInput): BasisTradeResult {
  const { spotPrice, perpPrice, fundingRate, estimatedFeePct = 0.2 } = input;

  const basis = ((perpPrice - spotPrice) / spotPrice) * 100;
  const basisAnnualized = basis * 365;

  const fundingRateAnnualized = fundingRate !== null
    ? fundingRate * 365 * 3 * 100
    : null;

  const totalCarryAnnualized = basisAnnualized + (fundingRateAnnualized ?? 0);
  const estimatedFees = estimatedFeePct;
  const netCarryAnnualized = totalCarryAnnualized - estimatedFees;

  // Signal classification
  let signal: string;
  let actionable: boolean;

  if (netCarryAnnualized > 5) {
    signal = 'strong positive carry — short perp, long spot';
    actionable = true;
  } else if (netCarryAnnualized > 1) {
    signal = 'moderate positive carry — consider basis trade';
    actionable = true;
  } else if (netCarryAnnualized > -1) {
    signal = 'neutral carry — no clear opportunity';
    actionable = false;
  } else if (netCarryAnnualized > -5) {
    signal = 'moderate negative carry — reverse basis possible';
    actionable = true;
  } else {
    signal = 'strong negative carry — long perp, short spot';
    actionable = true;
  }

  return {
    basis,
    basisAnnualized,
    fundingRateAnnualized,
    totalCarryAnnualized,
    estimatedFees,
    netCarryAnnualized,
    signal,
    actionable,
  };
}
