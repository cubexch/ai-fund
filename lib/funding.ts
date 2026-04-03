/**
 * Funding rate and carry trade analytics for crypto perpetuals and futures.
 * Pure functions — no async, no exchange clients, no MCP.
 */

import { mean, standardDeviation, zScore } from './math.js';

// ── Types ─────────────────────────────────────────────────

export interface FundingPrediction {
  predicted: number;
  confidence: number;
  method: string;
  upperBound: number;
  lowerBound: number;
}

export interface AnnualizedFunding {
  annualizedRate: number;
  dailyRate: number;
  monthlyRate: number;
}

export interface BasisPoint {
  symbol: string;
  expiry: number;
  basis: number;
  basisPct: number;
  annualizedBasis: number;
  daysToExpiry: number;
}

export interface BasisCurveResult {
  curve: BasisPoint[];
  contango: boolean;
  backwardation: boolean;
  maxBasis: number;
}

export interface CarryTradeResult {
  expectedPnl: number;
  annualizedReturn: number;
  breakeven: number;
  maxLoss: number;
  fundingComponent: number;
  basisComponent: number;
  costOfCarry: number;
}

export interface FundingArbOpportunity {
  longVenue: string;
  shortVenue: string;
  spread: number;
  annualizedSpread: number;
  netAfterFees: number;
}

export interface FundingArbResult {
  opportunities: FundingArbOpportunity[];
  bestOpportunity: FundingArbOpportunity | null;
}

export interface FundingSentimentResult {
  sentiment: 'crowded_long' | 'crowded_short' | 'neutral';
  extremeLevel: number;
  percentile: number;
  zScore: number;
  meanRevertSignal: boolean;
}

export interface CashAndCarryResult {
  grossProfit: number;
  netProfit: number;
  annualizedReturn: number;
  margin: number;
  riskFreeSpread: number;
}

export interface FundingStreaks {
  longestPositive: number;
  longestNegative: number;
  current: { direction: 'positive' | 'negative'; length: number };
}

export interface FundingRateStatsResult {
  mean: number;
  median: number;
  std: number;
  min: number;
  max: number;
  positiveRatio: number;
  streaks: FundingStreaks;
  annualizedMean: number;
}

export interface RollYieldResult {
  rollYield: number;
  annualizedRollYield: number;
  spread: number;
  spreadPct: number;
  direction: 'contango' | 'backwardation';
}

export interface FundingHedgeCostResult {
  totalCost: number;
  dailyCost: number;
  annualizedCostPct: number;
  breakevenMove: number;
}

// ── Constants ─────────────────────────────────────────────

const DAYS_PER_YEAR = 365;
const MS_PER_DAY = 86_400_000;

// ── Helpers ───────────────────────────────────────────────

function median(data: number[]): number {
  if (data.length === 0) return 0;
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function ewma(data: number[], halfLife: number): number {
  if (data.length === 0) return 0;
  const lambda = Math.log(2) / halfLife;
  let weightedSum = 0;
  let weightSum = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    const age = data.length - 1 - i;
    const w = Math.exp(-lambda * age);
    weightedSum += data[i] * w;
    weightSum += w;
  }
  return weightSum === 0 ? 0 : weightedSum / weightSum;
}

function percentileRank(value: number, data: number[]): number {
  if (data.length === 0) return 0.5;
  const below = data.filter(d => d < value).length;
  return below / data.length;
}

// ── Funding Prediction ────────────────────────────────────

/**
 * Predict next funding rate using historical rates.
 * Supports EWMA, simple mean, and median methods.
 */
export function predictFunding(
  rates: number[],
  params?: { method?: 'ewma' | 'mean' | 'median'; lookback?: number; halfLife?: number }
): FundingPrediction {
  const method = params?.method ?? 'ewma';
  const lookback = params?.lookback ?? rates.length;
  const halfLife = params?.halfLife ?? 12;

  const window = rates.slice(-lookback);
  if (window.length === 0) {
    return { predicted: 0, confidence: 0, method, upperBound: 0, lowerBound: 0 };
  }

  let predicted: number;
  if (method === 'ewma') {
    predicted = ewma(window, halfLife);
  } else if (method === 'median') {
    predicted = median(window);
  } else {
    predicted = mean(window);
  }

  const std = standardDeviation(window);
  // Confidence decreases with volatility relative to mean magnitude
  const meanAbs = Math.abs(mean(window));
  const confidence = meanAbs === 0
    ? (std === 0 ? 1 : 0)
    : Math.max(0, Math.min(1, 1 - std / (meanAbs + std)));

  return {
    predicted,
    confidence,
    method,
    upperBound: predicted + 2 * std,
    lowerBound: predicted - 2 * std,
  };
}

// ── Annualized Funding ────────────────────────────────────

/**
 * Annualize a single funding rate.
 * @param rate - single-period funding rate (decimal, e.g. 0.0001)
 * @param periodsPerDay - funding periods per day (default 3 for 8h)
 */
export function fundingAnnualized(rate: number, periodsPerDay: number = 3): AnnualizedFunding {
  const dailyRate = rate * periodsPerDay;
  return {
    annualizedRate: dailyRate * DAYS_PER_YEAR,
    dailyRate,
    monthlyRate: dailyRate * 30,
  };
}

// ── Basis Curve ───────────────────────────────────────────

/**
 * Term structure of basis for a set of futures contracts.
 * Expiry is a Unix timestamp in milliseconds.
 */
export function basisCurve(
  futures: Array<{ expiry: number; price: number; symbol: string }>,
  spotPrice: number
): BasisCurveResult {
  const now = Date.now();

  const curve: BasisPoint[] = futures
    .map(f => {
      const daysToExpiry = Math.max((f.expiry - now) / MS_PER_DAY, 1);
      const basis = f.price - spotPrice;
      const basisPct = spotPrice === 0 ? 0 : basis / spotPrice;
      const annualizedBasis = basisPct * (DAYS_PER_YEAR / daysToExpiry);
      return {
        symbol: f.symbol,
        expiry: f.expiry,
        basis,
        basisPct,
        annualizedBasis,
        daysToExpiry,
      };
    })
    .sort((a, b) => a.expiry - b.expiry);

  const basisValues = curve.map(c => c.basis);
  const maxBasis = basisValues.length > 0 ? Math.max(...basisValues.map(Math.abs)) : 0;

  // Contango: longer-dated futures trade above spot (positive basis trend)
  // Backwardation: longer-dated futures trade below spot
  const contango = curve.length > 0 && curve[curve.length - 1].basis > 0;
  const backwardation = curve.length > 0 && curve[curve.length - 1].basis < 0;

  return { curve, contango, backwardation, maxBasis };
}

// ── Carry Trade ───────────────────────────────────────────

/**
 * Carry trade P&L estimation combining funding and basis components.
 */
export function carryTrade(params: {
  spotPrice: number;
  futuresPrice: number;
  fundingRate: number;
  daysToExpiry?: number;
  borrowRate?: number;
  positionSize: number;
}): CarryTradeResult {
  const {
    spotPrice,
    futuresPrice,
    fundingRate,
    daysToExpiry = 30,
    borrowRate = 0,
    positionSize,
  } = params;

  // Basis component: profit from futures-spot convergence
  const basisComponent = (futuresPrice - spotPrice) * positionSize;

  // Funding component: expected funding payments over holding period
  // Positive funding = longs pay shorts; if we're short perp, we receive funding
  const fundingPerDay = fundingRate * 3; // 3 periods per day
  const fundingComponent = fundingPerDay * daysToExpiry * positionSize * spotPrice;

  // Cost of carry: borrow cost for holding spot
  const costOfCarry = borrowRate * (daysToExpiry / DAYS_PER_YEAR) * positionSize * spotPrice;

  const expectedPnl = basisComponent + fundingComponent - costOfCarry;
  const notional = positionSize * spotPrice;
  const annualizedReturn = notional === 0
    ? 0
    : (expectedPnl / notional) * (DAYS_PER_YEAR / daysToExpiry);

  // Breakeven: price move that would wipe out carry profit
  const breakeven = positionSize === 0 ? 0 : Math.abs(expectedPnl) / positionSize;

  // Max loss: if basis moves against us entirely (simplified)
  const maxLoss = Math.abs(basisComponent) + costOfCarry;

  return {
    expectedPnl,
    annualizedReturn,
    breakeven,
    maxLoss,
    fundingComponent,
    basisComponent,
    costOfCarry,
  };
}

// ── Funding Arbitrage ─────────────────────────────────────

/**
 * Find best funding rate arbitrage across venues.
 * Strategy: long where funding is most negative (receive payment), short where most positive.
 */
export function fundingArbitrage(
  venues: Array<{
    venue: string;
    fundingRate: number;
    nextFundingTime: number;
    price: number;
    fees: { maker: number; taker: number };
  }>
): FundingArbResult {
  if (venues.length < 2) {
    return { opportunities: [], bestOpportunity: null };
  }

  const opportunities: FundingArbOpportunity[] = [];

  for (let i = 0; i < venues.length; i++) {
    for (let j = 0; j < venues.length; j++) {
      if (i === j) continue;
      const longVenue = venues[i];  // go long here (pay funding if positive)
      const shortVenue = venues[j]; // go short here (receive funding if positive)

      // Spread: shortVenue funding - longVenue funding
      // Positive spread means we earn more from the short side than we pay on the long side
      const spread = shortVenue.fundingRate - longVenue.fundingRate;
      if (spread <= 0) continue;

      const annualizedSpread = spread * 3 * DAYS_PER_YEAR; // 3 periods/day * 365
      const totalFees = longVenue.fees.taker + shortVenue.fees.taker; // entry fees
      const netAfterFees = spread - totalFees;

      opportunities.push({
        longVenue: longVenue.venue,
        shortVenue: shortVenue.venue,
        spread,
        annualizedSpread,
        netAfterFees,
      });
    }
  }

  // Sort by net after fees descending
  opportunities.sort((a, b) => b.netAfterFees - a.netAfterFees);

  return {
    opportunities,
    bestOpportunity: opportunities.length > 0 ? opportunities[0] : null,
  };
}

// ── Funding Sentiment ─────────────────────────────────────

/**
 * Crowding analysis derived from funding rate history.
 * Extreme positive funding → crowded long, extreme negative → crowded short.
 */
export function fundingSentiment(
  rates: number[],
  params?: { lookback?: number }
): FundingSentimentResult {
  const lookback = params?.lookback ?? rates.length;
  const window = rates.slice(-lookback);

  if (window.length === 0) {
    return {
      sentiment: 'neutral',
      extremeLevel: 0,
      percentile: 0.5,
      zScore: 0,
      meanRevertSignal: false,
    };
  }

  const latest = window[window.length - 1];
  const z = zScore(latest, window);
  const pct = percentileRank(latest, window);

  // Extreme level: 0-1 scale based on z-score (capped at |3|)
  const extremeLevel = Math.min(1, Math.abs(z) / 3);

  let sentiment: 'crowded_long' | 'crowded_short' | 'neutral';
  if (z > 1.5) {
    sentiment = 'crowded_long';
  } else if (z < -1.5) {
    sentiment = 'crowded_short';
  } else {
    sentiment = 'neutral';
  }

  // Mean reversion signal: extreme positioning tends to revert
  const meanRevertSignal = Math.abs(z) > 2;

  return {
    sentiment,
    extremeLevel,
    percentile: pct,
    zScore: z,
    meanRevertSignal,
  };
}

// ── Cash and Carry ────────────────────────────────────────

/**
 * Classic cash-and-carry arbitrage P&L.
 * Buy spot + short futures, profit from basis convergence.
 * @param params.expiry - futures expiry as Unix timestamp (ms)
 */
export function cashAndCarry(params: {
  spotPrice: number;
  futuresPrice: number;
  expiry: number;
  borrowRate: number;
  positionSize: number;
  spotFee: number;
  futuresFee: number;
}): CashAndCarryResult {
  const {
    spotPrice,
    futuresPrice,
    expiry,
    borrowRate,
    positionSize,
    spotFee,
    futuresFee,
  } = params;

  const now = Date.now();
  const daysToExpiry = Math.max((expiry - now) / MS_PER_DAY, 1);
  const yearFraction = daysToExpiry / DAYS_PER_YEAR;

  const grossProfit = (futuresPrice - spotPrice) * positionSize;

  const spotFeesCost = spotPrice * positionSize * spotFee;
  const futuresFeesCost = futuresPrice * positionSize * futuresFee;
  const borrowCost = spotPrice * positionSize * borrowRate * yearFraction;

  const netProfit = grossProfit - spotFeesCost - futuresFeesCost - borrowCost;
  const notional = spotPrice * positionSize;
  const annualizedReturn = notional === 0
    ? 0
    : (netProfit / notional) / yearFraction;

  const margin = notional === 0 ? 0 : netProfit / notional;
  const riskFreeSpread = spotPrice === 0
    ? 0
    : (futuresPrice - spotPrice) / spotPrice - borrowRate * yearFraction;

  return {
    grossProfit,
    netProfit,
    annualizedReturn,
    margin,
    riskFreeSpread,
  };
}

// ── Funding Rate Stats ────────────────────────────────────

/**
 * Comprehensive statistics on historical funding rates.
 */
export function fundingRateStats(rates: number[]): FundingRateStatsResult {
  if (rates.length === 0) {
    return {
      mean: 0,
      median: 0,
      std: 0,
      min: 0,
      max: 0,
      positiveRatio: 0,
      streaks: { longestPositive: 0, longestNegative: 0, current: { direction: 'positive', length: 0 } },
      annualizedMean: 0,
    };
  }

  const avg = mean(rates);
  const std = standardDeviation(rates);
  const med = median(rates);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const positiveCount = rates.filter(r => r > 0).length;

  // Compute streaks
  let longestPositive = 0;
  let longestNegative = 0;
  let currentPositive = 0;
  let currentNegative = 0;

  for (const r of rates) {
    if (r >= 0) {
      currentPositive++;
      currentNegative = 0;
      if (currentPositive > longestPositive) longestPositive = currentPositive;
    } else {
      currentNegative++;
      currentPositive = 0;
      if (currentNegative > longestNegative) longestNegative = currentNegative;
    }
  }

  const lastRate = rates[rates.length - 1];
  const currentDirection: 'positive' | 'negative' = lastRate >= 0 ? 'positive' : 'negative';
  const currentLength = currentDirection === 'positive' ? currentPositive : currentNegative;

  return {
    mean: avg,
    median: med,
    std,
    min,
    max,
    positiveRatio: rates.length === 0 ? 0 : positiveCount / rates.length,
    streaks: {
      longestPositive,
      longestNegative,
      current: { direction: currentDirection, length: currentLength },
    },
    annualizedMean: avg * 3 * DAYS_PER_YEAR, // 3 periods/day * 365 days
  };
}

// ── Roll Yield ────────────────────────────────────────────

/**
 * Calendar spread roll yield between front and back month contracts.
 * @param frontExpiry - Unix timestamp (ms)
 * @param backExpiry - Unix timestamp (ms)
 */
export function rollYield(
  frontPrice: number,
  backPrice: number,
  frontExpiry: number,
  backExpiry: number
): RollYieldResult {
  const spread = backPrice - frontPrice;
  const spreadPct = frontPrice === 0 ? 0 : spread / frontPrice;

  const daysBetween = Math.max((backExpiry - frontExpiry) / MS_PER_DAY, 1);
  const rollYieldValue = spreadPct;
  const annualizedRollYield = rollYieldValue * (DAYS_PER_YEAR / daysBetween);

  const direction: 'contango' | 'backwardation' = spread >= 0 ? 'contango' : 'backwardation';

  return {
    rollYield: rollYieldValue,
    annualizedRollYield,
    spread,
    spreadPct,
    direction,
  };
}

// ── Funding Hedge Cost ────────────────────────────────────

/**
 * Cost of holding a hedged position accounting for funding payments.
 * @param params.duration - holding duration in days
 * @param params.periodsPerDay - funding periods per day (default 3 for 8h)
 */
export function fundingHedgeCost(params: {
  fundingRate: number;
  positionSize: number;
  leverage: number;
  duration: number;
  periodsPerDay?: number;
}): FundingHedgeCostResult {
  const {
    fundingRate,
    positionSize,
    leverage,
    duration,
    periodsPerDay = 3,
  } = params;

  const totalPeriods = duration * periodsPerDay;
  // Funding is paid on notional (position * leverage)
  const notional = positionSize * leverage;
  const costPerPeriod = Math.abs(fundingRate) * notional;
  const totalCost = costPerPeriod * totalPeriods;
  const dailyCost = costPerPeriod * periodsPerDay;

  const annualizedCostPct = positionSize === 0
    ? 0
    : (dailyCost * DAYS_PER_YEAR) / positionSize;

  // Breakeven move: price change needed to offset funding cost
  const breakevenMove = positionSize === 0
    ? 0
    : totalCost / positionSize;

  return {
    totalCost,
    dailyCost,
    annualizedCostPct,
    breakevenMove,
  };
}
