/**
 * Exchange-agnostic execution planning functions.
 * Pure functions that take pre-fetched data and return typed outputs.
 * No exchange clients, no MCP, no async, no API calls.
 */

// ── Interfaces ───────────────────────────────────────────────

export interface TwapInput {
  totalAmount: number;
  durationMinutes: number;
  numSlices: number;
  currentPrice: number;
  dailyVolume: number;
  nowMs: number;
}

export interface TwapSlice {
  sequence: number;
  scheduledTime: number;
  amount: number;
  estimatedPrice: number;
}

export interface TwapPlan {
  totalAmount: number;
  durationMinutes: number;
  numSlices: number;
  intervalMs: number;
  currentPrice: number;
  estimatedImpact: number;
  slices: TwapSlice[];
}

export interface BarVolume {
  volume: number;
}

export interface VwapInput {
  totalAmount: number;
  durationMinutes: number;
  numSlices: number;
  bars: BarVolume[];
  nowMs: number;
}

export interface VwapSlice {
  sequence: number;
  scheduledTime: number;
  amount: number;
  volumeWeight: number;
}

export interface VwapPlan {
  totalAmount: number;
  durationMinutes: number;
  numSlices: number;
  slices: VwapSlice[];
}

export interface IcebergInput {
  totalAmount: number;
  clipSize: number;
}

export interface IcebergClip {
  sequence: number;
  amount: number;
}

export interface IcebergPlan {
  totalAmount: number;
  clipSize: number;
  numClips: number;
  clips: IcebergClip[];
}

export interface MarketImpactInput {
  amount: number;
  dailyVolume: number;
  volatility: number;
  price: number;
}

export interface MarketImpactResult {
  participationRate: number;
  temporaryImpactBps: number;
  permanentImpactBps: number;
  totalImpactBps: number;
  estimatedCostUsd: number;
}

export interface ExecutionComparisonInput {
  totalAmount: number;
  durationMinutes: number;
  price: number;
  dailyVolume: number;
  spreadBps: number;
}

export interface ExecutionPlanEstimate {
  algorithm: string;
  estimatedCost: number;
  estimatedImpact: number;
  numSlices?: number;
  clipSize?: number;
}

export interface ExecutionComparison {
  currentPrice: number;
  dailyVolume: number;
  participationRate: number;
  plans: ExecutionPlanEstimate[];
  recommended: string;
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface SniperInput {
  amount: number;
  side: 'buy' | 'sell';
  levels: [number, number][];
  bestPrice: number;
}

export interface SniperResult {
  fillProbability: number;
  expectedFillPrice: number;
  bestPrice: number;
  priceImpactBps: number;
  levelsConsumed: number;
  totalBookDepth: number;
}

export interface ImplementationShortfallInput {
  side: 'buy' | 'sell';
  decisionPrice: number;
  executionPrice: number;
  amount: number;
}

export interface ImplementationShortfallResult {
  decisionPrice: number;
  executionPrice: number;
  amount: number;
  shortfallBps: number;
  shortfallCost: number;
  shortfallPct: number;
}

// ── TWAP ─────────────────────────────────────────────────────

/**
 * Plan a Time-Weighted Average Price execution.
 * Splits a large order into N equal slices over a time window.
 */
export function planTwap(input: TwapInput): TwapPlan {
  const { totalAmount, durationMinutes, numSlices, currentPrice, dailyVolume, nowMs } = input;

  const intervalMs = (durationMinutes * 60 * 1000) / numSlices;
  const amountPerSlice = totalAmount / numSlices;
  const participation = totalAmount / dailyVolume;
  const estimatedImpact = Math.sqrt(participation) * 100; // bps

  const slices: TwapSlice[] = [];
  for (let i = 0; i < numSlices; i++) {
    slices.push({
      sequence: i + 1,
      scheduledTime: nowMs + i * intervalMs,
      amount: amountPerSlice,
      estimatedPrice: currentPrice,
    });
  }

  return {
    totalAmount,
    durationMinutes,
    numSlices,
    intervalMs,
    currentPrice,
    estimatedImpact,
    slices,
  };
}

// ── VWAP ─────────────────────────────────────────────────────

/**
 * Plan a Volume-Weighted Average Price execution.
 * Distributes order sizes proportional to historical volume in each bucket.
 */
export function planVwap(input: VwapInput): VwapPlan {
  const { totalAmount, durationMinutes, numSlices, bars, nowMs } = input;

  const intervalMs = (durationMinutes * 60 * 1000) / numSlices;

  // Bucket volumes
  const bucketSize = Math.max(1, Math.floor(bars.length / numSlices));
  const bucketVolumes: number[] = [];
  for (let i = 0; i < numSlices; i++) {
    const start = i * bucketSize;
    const end = Math.min(start + bucketSize, bars.length);
    let vol = 0;
    for (let j = start; j < end; j++) {
      vol += bars[j]?.volume || 0;
    }
    bucketVolumes.push(Math.max(vol, 0.001)); // avoid zero
  }

  const totalVolume = bucketVolumes.reduce((a, b) => a + b, 0);
  const slices: VwapSlice[] = bucketVolumes.map((vol, i) => {
    const weight = vol / totalVolume;
    return {
      sequence: i + 1,
      scheduledTime: nowMs + i * intervalMs,
      amount: totalAmount * weight,
      volumeWeight: weight,
    };
  });

  return {
    totalAmount,
    durationMinutes,
    numSlices,
    slices,
  };
}

// ── Iceberg ──────────────────────────────────────────────────

/**
 * Plan an iceberg order execution.
 * Splits order into small visible clips to minimize market impact.
 */
export function planIceberg(input: IcebergInput): IcebergPlan {
  const { totalAmount, clipSize } = input;

  const fullClips = Math.floor(totalAmount / clipSize);
  const remainder = totalAmount - fullClips * clipSize;
  const clips: IcebergClip[] = [];

  for (let i = 0; i < fullClips; i++) {
    clips.push({
      sequence: i + 1,
      amount: clipSize,
    });
  }
  if (remainder > 1e-10) {
    clips.push({
      sequence: fullClips + 1,
      amount: Math.round(remainder * 1e8) / 1e8,
    });
  }

  // If clip_size >= total_amount, just one clip
  if (clips.length === 0) {
    clips.push({ sequence: 1, amount: totalAmount });
  }

  return {
    totalAmount,
    clipSize,
    numClips: clips.length,
    clips,
  };
}

// ── Market Impact (Almgren-Chriss) ───────────────────────────

/**
 * Estimate market impact using the Almgren-Chriss square-root model.
 * Returns temporary and permanent impact in bps.
 */
export function estimateMarketImpact(input: MarketImpactInput): MarketImpactResult {
  const { amount, dailyVolume, volatility, price } = input;

  if (dailyVolume <= 0 || !isFinite(dailyVolume)) {
    return {
      participationRate: NaN,
      temporaryImpactBps: NaN,
      permanentImpactBps: NaN,
      totalImpactBps: NaN,
      estimatedCostUsd: NaN,
    };
  }

  const participation = amount / dailyVolume;
  const sigma = volatility;

  // Temporary impact: eta * sigma * sqrt(participation)
  const eta = 0.142; // empirical constant
  const temporaryImpactBps = eta * sigma * Math.sqrt(participation) * 10000;

  // Permanent impact: gamma * sigma * participation
  const gamma = 0.314; // empirical constant
  const permanentImpactBps = gamma * sigma * participation * 10000;

  const totalImpactBps = temporaryImpactBps + permanentImpactBps;
  const estimatedCost = amount * price * (totalImpactBps / 10000);

  return {
    participationRate: participation,
    temporaryImpactBps: Math.round(temporaryImpactBps * 100) / 100,
    permanentImpactBps: Math.round(permanentImpactBps * 100) / 100,
    totalImpactBps: Math.round(totalImpactBps * 100) / 100,
    estimatedCostUsd: Math.round(estimatedCost * 100) / 100,
  };
}

/**
 * Compute realized volatility from an array of closing prices.
 */
export function realizedVolatility(closes: number[]): number {
  let sumSqRet = 0;
  for (let i = 1; i < closes.length; i++) {
    const ret = Math.log(closes[i] / closes[i - 1]);
    sumSqRet += ret * ret;
  }
  return closes.length > 1 ? Math.sqrt(sumSqRet / (closes.length - 1)) : 0.02;
}

// ── Execution Plan Comparison ────────────────────────────────

/**
 * Compare TWAP, VWAP, and iceberg execution strategies.
 * Returns cost/impact estimates and a recommendation (lowest cost).
 */
export function compareExecutionPlans(input: ExecutionComparisonInput): ExecutionComparison {
  const { totalAmount, durationMinutes, price, dailyVolume, spreadBps } = input;

  const participation = totalAmount / dailyVolume;

  // TWAP estimate
  const twapSlices = Math.max(3, Math.ceil(durationMinutes / 10));
  const twapImpact = Math.sqrt(participation / twapSlices) * 80;
  const twapCost = totalAmount * price * (twapImpact / 10000);

  // VWAP estimate (slightly better than TWAP due to volume weighting)
  const vwapImpact = twapImpact * 0.85;
  const vwapCost = totalAmount * price * (vwapImpact / 10000);

  // Iceberg estimate
  const clipSize = Math.max(totalAmount / 20, 0.001);
  const icebergImpact = spreadBps + Math.sqrt(participation) * 30;
  const icebergCost = totalAmount * price * (icebergImpact / 10000);

  const plans: ExecutionPlanEstimate[] = [
    { algorithm: 'twap', estimatedCost: twapCost, estimatedImpact: twapImpact, numSlices: twapSlices },
    { algorithm: 'vwap', estimatedCost: vwapCost, estimatedImpact: vwapImpact, numSlices: twapSlices },
    { algorithm: 'iceberg', estimatedCost: icebergCost, estimatedImpact: icebergImpact, clipSize },
  ];

  // Recommend the lowest cost
  plans.sort((a, b) => a.estimatedCost - b.estimatedCost);
  const recommended = plans[0].algorithm;

  return {
    currentPrice: price,
    dailyVolume,
    participationRate: participation,
    plans,
    recommended,
  };
}

// ── Sniper (Order Book Fill Simulation) ──────────────────────

/**
 * Simulate filling a market order against order book depth.
 * Returns fill probability, expected fill price, and price impact.
 */
export function analyzeSniper(input: SniperInput): SniperResult {
  const { amount, levels, bestPrice } = input;

  let filled = 0;
  let totalCost = 0;
  let levelsUsed = 0;

  for (const [price, size] of levels) {
    const fillQty = Math.min(amount - filled, size);
    totalCost += fillQty * price;
    filled += fillQty;
    levelsUsed++;
    if (filled >= amount) break;
  }

  const fillProbability = Math.min(filled / amount, 1);
  const expectedFillPrice = filled > 0 ? totalCost / filled : 0;
  const priceImpactBps = bestPrice > 0
    ? Math.abs(expectedFillPrice - bestPrice) / bestPrice * 10000
    : 0;

  return {
    fillProbability,
    expectedFillPrice,
    bestPrice,
    priceImpactBps,
    levelsConsumed: levelsUsed,
    totalBookDepth: levels.reduce((s, l) => s + l[1], 0),
  };
}

// ── Implementation Shortfall ─────────────────────────────────

/**
 * Calculate implementation shortfall between decision price and execution price.
 */
export function calculateImplementationShortfall(input: ImplementationShortfallInput): ImplementationShortfallResult {
  const { side, decisionPrice, executionPrice, amount } = input;

  // For buys: shortfall = (exec - decision) / decision
  // For sells: shortfall = (decision - exec) / decision
  const priceDiff = side === 'buy'
    ? executionPrice - decisionPrice
    : decisionPrice - executionPrice;

  const shortfallBps = (priceDiff / decisionPrice) * 10000;
  const shortfallCost = priceDiff * amount;

  return {
    decisionPrice,
    executionPrice,
    amount,
    shortfallBps: Math.round(shortfallBps * 100) / 100,
    shortfallCost: Math.round(shortfallCost * 100) / 100,
    shortfallPct: Math.round(shortfallBps / 100 * 10000) / 10000,
  };
}
