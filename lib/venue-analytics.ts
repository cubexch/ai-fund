/**
 * Cross-venue analytics and smart order routing.
 * Pure functions for multi-exchange comparison, arbitrage detection,
 * and execution venue selection.
 */

import { mean, standardDeviation, correlation } from './math.js';

// ── Types ────────────────────────────────────────────────

export interface TriangularArbInput {
  pair: string;
  bid: number;
  ask: number;
  venue: string;
  fee: number;
}

export interface ArbLeg {
  pair: string;
  side: 'buy' | 'sell';
  price: number;
  venue: string;
}

export interface TriangularArbOpportunity {
  path: string[];
  grossProfit: number;
  netProfit: number;
  profitPct: number;
  requiredCapital: number;
  legs: ArbLeg[];
}

export interface TriangularArbResult {
  opportunities: TriangularArbOpportunity[];
  scanned: number;
}

export interface VenueQuote {
  venue: string;
  bid: number;
  ask: number;
  volume24h: number;
  fee: number;
}

export interface CrossVenueSpreadResult {
  bestBid: { venue: string; price: number };
  bestAsk: { venue: string; price: number };
  crossSpread: number;
  crossSpreadPct: number;
  arbOpportunity: boolean;
  netArbProfit: number;
  venues: Array<{
    venue: string;
    midPrice: number;
    spread: number;
    spreadBps: number;
    effectiveSpread: number;
  }>;
}

export interface SmartOrderRouteParams {
  side: 'buy' | 'sell';
  totalQuantity: number;
  venues: Array<{
    venue: string;
    price: number;
    availableQty: number;
    fee: number;
    latencyMs: number;
  }>;
}

export interface SmartOrderRouteFill {
  venue: string;
  quantity: number;
  price: number;
  fee: number;
  cost: number;
}

export interface SmartOrderRouteResult {
  fills: SmartOrderRouteFill[];
  totalCost: number;
  avgPrice: number;
  totalFees: number;
  venueCount: number;
  savings: number;
}

export interface VenueQualityMetrics {
  venue: string;
  uptime: number;
  latencyMs: number;
  spreadBps: number;
  fillRate: number;
  slippageBps: number;
  volume24h: number;
}

export interface VenueQualityResult {
  venue: string;
  score: number;
  rank: number;
  strengths: string[];
  weaknesses: string[];
}

export interface FragmentationInput {
  venue: string;
  volume24h: number;
  openInterest?: number;
}

export interface FragmentationResult {
  hhi: number;
  effectiveVenues: number;
  topVenueShare: number;
  fragmentationLevel: 'consolidated' | 'moderate' | 'fragmented';
  shares: Array<{ venue: string; sharePct: number }>;
}

export interface LatencyCostParams {
  latencyMs: number;
  volatility: number;
  orderSize: number;
  avgVolume: number;
}

export interface LatencyCostResult {
  latencyCostBps: number;
  annualizedCost: number;
  optimalLatency: number;
  costCurve: Array<{ latencyMs: number; costBps: number }>;
}

export interface VenueCorrelationResult {
  correlations: Record<string, Record<string, number>>;
  leadLag: Array<{
    leader: string;
    follower: string;
    lagMs: number;
    correlation: number;
  }>;
  priceDiscoveryLeader: string;
}

export interface ExecutionVenueSelectionParams {
  side: 'buy' | 'sell';
  size: number;
  urgency: 'low' | 'medium' | 'high';
  venues: Array<{
    venue: string;
    spread: number;
    depth: number;
    fee: number;
    latencyMs: number;
    fillRate: number;
  }>;
}

export interface ExecutionVenueSelectionResult {
  primary: string;
  secondary: string | null;
  reasoning: string;
  expectedCost: number;
  expectedSlippage: number;
  splitRecommendation: boolean;
}

export interface MakerTakerParams {
  venues: Array<{
    venue: string;
    makerFee: number;
    takerFee: number;
    makerRebate?: number;
    volumeTier?: number;
  }>;
  monthlyVolume: number;
  makerRatio: number;
}

export interface MakerTakerResult {
  optimalVenue: string;
  monthlySavings: number;
  effectiveFee: number;
  venueAnalysis: Array<{
    venue: string;
    effectiveFee: number;
    monthlyCost: number;
  }>;
}

export interface OrderbookLevel {
  price: number;
  qty: number;
}

export interface OrderbookInput {
  venue: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

export interface CrossVenueOBImbalanceResult {
  aggregateImbalance: number;
  venueImbalances: Array<{
    venue: string;
    imbalance: number;
    bidDepth: number;
    askDepth: number;
  }>;
  pressure: 'buy' | 'sell' | 'neutral';
  divergence: boolean;
}

// ── Triangular Arbitrage ─────────────────────────────────

/**
 * Detect triangular arbitrage opportunities across venue price quotes.
 * Scans all 3-pair cycles (A/B -> B/C -> C/A) for profitable round-trips.
 */
export function triangularArb(prices: TriangularArbInput[]): TriangularArbResult {
  const pairMap = new Map<string, TriangularArbInput[]>();
  for (const p of prices) {
    const existing = pairMap.get(p.pair) ?? [];
    existing.push(p);
    pairMap.set(p.pair, existing);
  }

  const pairs = [...pairMap.keys()];
  const opportunities: TriangularArbOpportunity[] = [];
  let scanned = 0;

  // Extract base/quote from pair string (e.g. "BTC/USDT" -> ["BTC", "USDT"])
  const splitPair = (pair: string): [string, string] | null => {
    const parts = pair.split('/');
    if (parts.length !== 2) return null;
    return [parts[0], parts[1]];
  };

  // Build adjacency: currency -> list of pairs containing that currency
  const currencyPairs = new Map<string, string[]>();
  for (const pair of pairs) {
    const parts = splitPair(pair);
    if (!parts) continue;
    for (const c of parts) {
      const list = currencyPairs.get(c) ?? [];
      list.push(pair);
      currencyPairs.set(c, list);
    }
  }

  // Find all 3-leg cycles
  for (const startCurrency of currencyPairs.keys()) {
    const firstPairs = currencyPairs.get(startCurrency) ?? [];
    for (const p1 of firstPairs) {
      const [b1, q1] = splitPair(p1)!;
      const midCurrency = b1 === startCurrency ? q1 : b1;

      const secondPairs = (currencyPairs.get(midCurrency) ?? []).filter(p => p !== p1);
      for (const p2 of secondPairs) {
        const [b2, q2] = splitPair(p2)!;
        const endCurrency = b2 === midCurrency ? q2 : b2;
        if (endCurrency === startCurrency || endCurrency === midCurrency) continue;

        // Find closing pair
        const closingPair = pairs.find(p => {
          const parts = splitPair(p);
          if (!parts) return false;
          return (parts[0] === endCurrency && parts[1] === startCurrency) ||
                 (parts[0] === startCurrency && parts[1] === endCurrency);
        });
        if (!closingPair) continue;

        scanned++;

        // Get best prices for each leg
        const quotes1 = pairMap.get(p1) ?? [];
        const quotes2 = pairMap.get(p2) ?? [];
        const quotes3 = pairMap.get(closingPair) ?? [];

        // Determine sides: we start with startCurrency and want to end with startCurrency
        // Leg 1: startCurrency -> midCurrency
        const leg1Side: 'buy' | 'sell' = b1 === midCurrency ? 'buy' : 'sell';
        // Leg 2: midCurrency -> endCurrency
        const leg2Side: 'buy' | 'sell' = b2 === endCurrency ? 'buy' : 'sell';
        // Leg 3: endCurrency -> startCurrency
        const [b3] = splitPair(closingPair)!;
        const leg3Side: 'buy' | 'sell' = b3 === startCurrency ? 'buy' : 'sell';

        // Best execution price for each leg
        const bestLeg1 = leg1Side === 'buy'
          ? quotes1.reduce((best, q) => q.ask < best.ask ? q : best, quotes1[0])
          : quotes1.reduce((best, q) => q.bid > best.bid ? q : best, quotes1[0]);
        const bestLeg2 = leg2Side === 'buy'
          ? quotes2.reduce((best, q) => q.ask < best.ask ? q : best, quotes2[0])
          : quotes2.reduce((best, q) => q.bid > best.bid ? q : best, quotes2[0]);
        const bestLeg3 = leg3Side === 'buy'
          ? quotes3.reduce((best, q) => q.ask < best.ask ? q : best, quotes3[0])
          : quotes3.reduce((best, q) => q.bid > best.bid ? q : best, quotes3[0]);

        // Calculate round-trip P&L starting with 1 unit of startCurrency
        const capital = 1;
        let amount = capital;

        // Leg 1
        const price1 = leg1Side === 'buy' ? bestLeg1.ask : bestLeg1.bid;
        amount = leg1Side === 'buy' ? amount / price1 : amount * price1;
        amount *= (1 - bestLeg1.fee);

        // Leg 2
        const price2 = leg2Side === 'buy' ? bestLeg2.ask : bestLeg2.bid;
        amount = leg2Side === 'buy' ? amount / price2 : amount * price2;
        amount *= (1 - bestLeg2.fee);

        // Leg 3
        const price3 = leg3Side === 'buy' ? bestLeg3.ask : bestLeg3.bid;
        amount = leg3Side === 'buy' ? amount / price3 : amount * price3;
        amount *= (1 - bestLeg3.fee);

        const grossAmount = capital;
        const grossProfit = amount - grossAmount;
        // Fees already deducted in the amount calculation
        const netProfit = grossProfit;

        if (netProfit > 0) {
          opportunities.push({
            path: [startCurrency, midCurrency, endCurrency, startCurrency],
            grossProfit: amount - capital, // before fees would be higher, but we computed net inline
            netProfit,
            profitPct: (netProfit / capital) * 100,
            requiredCapital: capital,
            legs: [
              { pair: p1, side: leg1Side, price: price1, venue: bestLeg1.venue },
              { pair: p2, side: leg2Side, price: price2, venue: bestLeg2.venue },
              { pair: closingPair, side: leg3Side, price: price3, venue: bestLeg3.venue },
            ],
          });
        }
      }
    }
  }

  // Sort by profit descending
  opportunities.sort((a, b) => b.netProfit - a.netProfit);

  return { opportunities, scanned };
}

// ── Cross-Venue Spread ───────────────────────────────────

/**
 * Analyze bid/ask spreads across venues to find the best execution
 * and detect cross-venue arbitrage.
 */
export function crossVenueSpread(venues: VenueQuote[]): CrossVenueSpreadResult {
  if (venues.length === 0) {
    return {
      bestBid: { venue: '', price: 0 },
      bestAsk: { venue: '', price: 0 },
      crossSpread: 0,
      crossSpreadPct: 0,
      arbOpportunity: false,
      netArbProfit: 0,
      venues: [],
    };
  }

  // Find best bid (highest) and best ask (lowest)
  let bestBid = venues[0];
  let bestAsk = venues[0];
  for (const v of venues) {
    if (v.bid > bestBid.bid) bestBid = v;
    if (v.ask < bestAsk.ask) bestAsk = v;
  }

  const crossSpread = bestBid.bid - bestAsk.ask;
  const midRef = (bestBid.bid + bestAsk.ask) / 2;
  const crossSpreadPct = midRef === 0 ? 0 : (crossSpread / midRef) * 100;

  // Net arb profit accounts for fees on both sides
  const netArbProfit = crossSpread > 0
    ? crossSpread - (bestAsk.ask * bestAsk.fee) - (bestBid.bid * bestBid.fee)
    : 0;
  const arbOpportunity = netArbProfit > 0;

  const venueDetails = venues.map(v => {
    const mid = (v.bid + v.ask) / 2;
    const spread = v.ask - v.bid;
    const spreadBps = mid === 0 ? 0 : (spread / mid) * 10000;
    const effectiveSpread = spread + mid * v.fee * 2;
    return {
      venue: v.venue,
      midPrice: mid,
      spread,
      spreadBps,
      effectiveSpread,
    };
  });

  return {
    bestBid: { venue: bestBid.venue, price: bestBid.bid },
    bestAsk: { venue: bestAsk.venue, price: bestAsk.ask },
    crossSpread,
    crossSpreadPct,
    arbOpportunity,
    netArbProfit: Math.max(0, netArbProfit),
    venues: venueDetails,
  };
}

// ── Smart Order Routing ──────────────────────────────────

/**
 * Route an order across multiple venues to minimize execution cost.
 * Greedily fills at the best available price, accounting for fees and latency.
 */
export function smartOrderRoute(params: SmartOrderRouteParams): SmartOrderRouteResult {
  const { side, totalQuantity, venues } = params;

  if (venues.length === 0 || totalQuantity <= 0) {
    return { fills: [], totalCost: 0, avgPrice: 0, totalFees: 0, venueCount: 0, savings: 0 };
  }

  // Sort venues by effective price (price + fee adjustment)
  // For buys: lowest effective price first; for sells: highest effective price first
  const sorted = [...venues].map(v => ({
    ...v,
    effectivePrice: side === 'buy'
      ? v.price * (1 + v.fee)
      : v.price * (1 - v.fee),
  })).sort((a, b) =>
    side === 'buy'
      ? a.effectivePrice - b.effectivePrice
      : b.effectivePrice - a.effectivePrice
  );

  const fills: SmartOrderRouteFill[] = [];
  let remaining = totalQuantity;

  for (const v of sorted) {
    if (remaining <= 0) break;
    const fillQty = Math.min(remaining, v.availableQty);
    if (fillQty <= 0) continue;

    const fee = fillQty * v.price * v.fee;
    const cost = fillQty * v.price + (side === 'buy' ? fee : -fee);

    fills.push({
      venue: v.venue,
      quantity: fillQty,
      price: v.price,
      fee,
      cost,
    });

    remaining -= fillQty;
  }

  const totalCost = fills.reduce((s, f) => s + f.cost, 0);
  const totalQtyFilled = fills.reduce((s, f) => s + f.quantity, 0);
  const avgPrice = totalQtyFilled === 0 ? 0 : totalCost / totalQtyFilled;
  const totalFees = fills.reduce((s, f) => s + f.fee, 0);

  // Savings vs worst single venue
  const worstVenue = side === 'buy'
    ? sorted[sorted.length - 1]
    : sorted[sorted.length - 1];
  const worstCost = worstVenue
    ? totalQtyFilled * worstVenue.effectivePrice
    : totalCost;
  const savings = Math.abs(worstCost - totalCost);

  return {
    fills,
    totalCost,
    avgPrice,
    totalFees,
    venueCount: fills.length,
    savings,
  };
}

// ── Venue Quality Score ──────────────────────────────────

/**
 * Score and rank venues based on multiple quality dimensions.
 * Weights: uptime 20%, latency 20%, spread 20%, fill rate 20%, slippage 10%, volume 10%.
 */
export function venueQualityScore(
  metrics: VenueQualityMetrics[]
): VenueQualityResult[] {
  if (metrics.length === 0) return [];

  // Normalize each dimension to 0-1 (higher is better)
  const maxLatency = Math.max(...metrics.map(m => m.latencyMs), 1);
  const maxSpread = Math.max(...metrics.map(m => m.spreadBps), 1);
  const maxSlippage = Math.max(...metrics.map(m => m.slippageBps), 1);
  const maxVolume = Math.max(...metrics.map(m => m.volume24h), 1);

  const scored = metrics.map(m => {
    const uptimeScore = m.uptime; // already 0-1
    const latencyScore = 1 - m.latencyMs / maxLatency;
    const spreadScore = 1 - m.spreadBps / maxSpread;
    const fillScore = m.fillRate; // already 0-1
    const slippageScore = 1 - m.slippageBps / maxSlippage;
    const volumeScore = m.volume24h / maxVolume;

    const score =
      uptimeScore * 0.20 +
      latencyScore * 0.20 +
      spreadScore * 0.20 +
      fillScore * 0.20 +
      slippageScore * 0.10 +
      volumeScore * 0.10;

    const strengths: string[] = [];
    const weaknesses: string[] = [];

    if (uptimeScore >= 0.99) strengths.push('high uptime');
    else if (uptimeScore < 0.95) weaknesses.push('low uptime');

    if (latencyScore >= 0.8) strengths.push('low latency');
    else if (latencyScore < 0.3) weaknesses.push('high latency');

    if (spreadScore >= 0.8) strengths.push('tight spreads');
    else if (spreadScore < 0.3) weaknesses.push('wide spreads');

    if (fillScore >= 0.95) strengths.push('high fill rate');
    else if (fillScore < 0.8) weaknesses.push('low fill rate');

    if (slippageScore >= 0.8) strengths.push('low slippage');
    else if (slippageScore < 0.3) weaknesses.push('high slippage');

    if (volumeScore >= 0.5) strengths.push('deep liquidity');
    else if (volumeScore < 0.1) weaknesses.push('thin liquidity');

    return { venue: m.venue, score, strengths, weaknesses, rank: 0 };
  });

  // Sort by score descending and assign ranks
  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => { s.rank = i + 1; });

  return scored;
}

// ── Fragmentation Index ──────────────────────────────────

/**
 * Herfindahl-Hirschman Index and effective venue count for market fragmentation.
 */
export function fragmentationIndex(venues: FragmentationInput[]): FragmentationResult {
  if (venues.length === 0) {
    return {
      hhi: 0,
      effectiveVenues: 0,
      topVenueShare: 0,
      fragmentationLevel: 'consolidated',
      shares: [],
    };
  }

  const totalVolume = venues.reduce((s, v) => s + v.volume24h, 0);
  if (totalVolume === 0) {
    return {
      hhi: 0,
      effectiveVenues: 0,
      topVenueShare: 0,
      fragmentationLevel: 'consolidated',
      shares: venues.map(v => ({ venue: v.venue, sharePct: 0 })),
    };
  }

  const shares = venues
    .map(v => ({
      venue: v.venue,
      sharePct: (v.volume24h / totalVolume) * 100,
    }))
    .sort((a, b) => b.sharePct - a.sharePct);

  // HHI = sum of squared market shares (using percentages, so max is 10000)
  const hhi = shares.reduce((s, v) => s + (v.sharePct) ** 2, 0);

  // Effective number of venues (inverse HHI with decimal shares)
  const decimalShares = shares.map(s => s.sharePct / 100);
  const hhiDecimal = decimalShares.reduce((s, d) => s + d ** 2, 0);
  const effectiveVenues = hhiDecimal === 0 ? 0 : 1 / hhiDecimal;

  const topVenueShare = shares[0].sharePct;

  let fragmentationLevel: 'consolidated' | 'moderate' | 'fragmented';
  if (hhi > 2500) {
    fragmentationLevel = 'consolidated';
  } else if (hhi > 1500) {
    fragmentationLevel = 'moderate';
  } else {
    fragmentationLevel = 'fragmented';
  }

  return { hhi, effectiveVenues, topVenueShare, fragmentationLevel, shares };
}

// ── Latency Cost Model ───────────────────────────────────

/**
 * Model the cost of latency in basis points using a square-root market impact model.
 * Cost ~ volatility * sqrt(latency) * sqrt(orderSize / avgVolume).
 */
export function latencyCostModel(params: LatencyCostParams): LatencyCostResult {
  const { latencyMs, volatility, orderSize, avgVolume } = params;

  const participationRate = avgVolume === 0 ? 0 : orderSize / avgVolume;
  const costFn = (lat: number): number => {
    // Almgren-Chriss inspired: cost = sigma * sqrt(lat/1000) * sqrt(participation)
    return volatility * Math.sqrt(lat / 1000) * Math.sqrt(participationRate) * 10000;
  };

  const latencyCostBps = costFn(latencyMs);

  // Annualized cost assuming continuous trading (252 trading days, 6.5h each)
  const tradesPerDay = avgVolume === 0 ? 0 : avgVolume / orderSize;
  const annualizedCost = latencyCostBps * tradesPerDay * 252 / 10000;

  // Optimal latency: where marginal cost of faster infra exceeds marginal savings
  // Simple heuristic: latency where cost drops below 0.1 bps
  let optimalLatency = 1;
  for (let l = 1; l <= 1000; l++) {
    if (costFn(l) <= 0.1) {
      optimalLatency = l;
      break;
    }
    optimalLatency = l;
  }

  // Cost curve at various latency points
  const costCurve: Array<{ latencyMs: number; costBps: number }> = [];
  const points = [1, 5, 10, 25, 50, 100, 250, 500, 1000];
  for (const l of points) {
    costCurve.push({ latencyMs: l, costBps: costFn(l) });
  }

  return { latencyCostBps, annualizedCost, optimalLatency, costCurve };
}

// ── Venue Correlation ────────────────────────────────────

/**
 * Compute price correlation between venues and detect lead-lag relationships.
 * Uses cross-correlation at various lags to find price discovery leader.
 */
export function venueCorrelation(priceSeries: Record<string, number[]>): VenueCorrelationResult {
  const venues = Object.keys(priceSeries);
  const correlations: Record<string, Record<string, number>> = {};
  const leadLag: Array<{
    leader: string;
    follower: string;
    lagMs: number;
    correlation: number;
  }> = [];

  // Pairwise correlation
  for (const v1 of venues) {
    correlations[v1] = {};
    for (const v2 of venues) {
      if (v1 === v2) {
        correlations[v1][v2] = 1;
      } else {
        correlations[v1][v2] = correlation(priceSeries[v1], priceSeries[v2]);
      }
    }
  }

  // Lead-lag detection via cross-correlation at shifted lags
  for (let i = 0; i < venues.length; i++) {
    for (let j = i + 1; j < venues.length; j++) {
      const v1 = venues[i];
      const v2 = venues[j];
      const s1 = priceSeries[v1];
      const s2 = priceSeries[v2];
      const maxLag = Math.min(10, Math.floor(s1.length / 4));

      let bestCorr = -Infinity;
      let bestLag = 0;
      let leader = v1;
      let follower = v2;

      for (let lag = -maxLag; lag <= maxLag; lag++) {
        let corr: number;
        if (lag >= 0) {
          corr = correlation(s1.slice(lag), s2.slice(0, s2.length - lag));
        } else {
          corr = correlation(s1.slice(0, s1.length + lag), s2.slice(-lag));
        }
        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
          if (lag > 0) {
            leader = v1;
            follower = v2;
          } else if (lag < 0) {
            leader = v2;
            follower = v1;
          } else {
            leader = v1;
            follower = v2;
          }
        }
      }

      leadLag.push({
        leader,
        follower,
        lagMs: Math.abs(bestLag),
        correlation: bestCorr,
      });
    }
  }

  // Price discovery leader: venue that leads most often
  const leadCount = new Map<string, number>();
  for (const ll of leadLag) {
    if (ll.lagMs > 0) {
      leadCount.set(ll.leader, (leadCount.get(ll.leader) ?? 0) + 1);
    }
  }

  let priceDiscoveryLeader = venues[0] ?? '';
  let maxLeads = 0;
  for (const [venue, count] of leadCount) {
    if (count > maxLeads) {
      maxLeads = count;
      priceDiscoveryLeader = venue;
    }
  }

  return { correlations, leadLag, priceDiscoveryLeader };
}

// ── Execution Venue Selection ────────────────────────────

/**
 * Select optimal execution venue(s) based on order characteristics and venue quality.
 * Considers urgency, size relative to depth, fees, and fill probability.
 */
export function executionVenueSelection(
  params: ExecutionVenueSelectionParams
): ExecutionVenueSelectionResult {
  const { side, size, urgency, venues } = params;

  if (venues.length === 0) {
    return {
      primary: '',
      secondary: null,
      reasoning: 'No venues available',
      expectedCost: 0,
      expectedSlippage: 0,
      splitRecommendation: false,
    };
  }

  // Urgency weights: high urgency prioritizes fill rate and latency; low urgency prioritizes cost
  const weights = {
    low: { spread: 0.35, fee: 0.30, depth: 0.15, fillRate: 0.10, latency: 0.10 },
    medium: { spread: 0.25, fee: 0.20, depth: 0.20, fillRate: 0.20, latency: 0.15 },
    high: { spread: 0.15, fee: 0.10, depth: 0.15, fillRate: 0.30, latency: 0.30 },
  }[urgency];

  // Normalize metrics
  const maxSpread = Math.max(...venues.map(v => v.spread), 1e-10);
  const maxFee = Math.max(...venues.map(v => v.fee), 1e-10);
  const maxDepth = Math.max(...venues.map(v => v.depth), 1e-10);
  const maxLatency = Math.max(...venues.map(v => v.latencyMs), 1);

  const scored = venues.map(v => {
    const spreadScore = 1 - v.spread / maxSpread;
    const feeScore = 1 - v.fee / maxFee;
    const depthScore = v.depth / maxDepth;
    const fillScore = v.fillRate;
    const latencyScore = 1 - v.latencyMs / maxLatency;

    const score =
      spreadScore * weights.spread +
      feeScore * weights.fee +
      depthScore * weights.depth +
      fillScore * weights.fillRate +
      latencyScore * weights.latency;

    return { ...v, score };
  }).sort((a, b) => b.score - a.score);

  const primary = scored[0];
  const secondary = scored.length > 1 ? scored[1] : null;

  // Recommend splitting if order size exceeds 30% of primary venue depth
  const splitRecommendation = size > primary.depth * 0.3 && secondary !== null;

  const expectedSlippage = primary.depth === 0
    ? 0
    : (size / primary.depth) * primary.spread;

  const expectedCost = size * primary.spread + size * primary.fee + expectedSlippage;

  const reasons: string[] = [];
  if (urgency === 'high') reasons.push('prioritizing fill speed');
  if (urgency === 'low') reasons.push('prioritizing cost');
  reasons.push(`${primary.venue} scores highest at ${primary.score.toFixed(3)}`);
  if (splitRecommendation) {
    reasons.push(`split recommended: order is ${((size / primary.depth) * 100).toFixed(0)}% of depth`);
  }

  return {
    primary: primary.venue,
    secondary: secondary ? secondary.venue : null,
    reasoning: reasons.join('; '),
    expectedCost,
    expectedSlippage,
    splitRecommendation,
  };
}

// ── Maker/Taker Fee Optimization ─────────────────────────

/**
 * Find the venue with the lowest effective fee given a maker/taker ratio
 * and monthly volume.
 */
export function makerTakerOptimization(params: MakerTakerParams): MakerTakerResult {
  const { venues, monthlyVolume, makerRatio } = params;
  const takerRatio = 1 - makerRatio;

  if (venues.length === 0) {
    return {
      optimalVenue: '',
      monthlySavings: 0,
      effectiveFee: 0,
      venueAnalysis: [],
    };
  }

  const analysis = venues.map(v => {
    const makerCost = v.makerFee - (v.makerRebate ?? 0);
    const effectiveFee = makerCost * makerRatio + v.takerFee * takerRatio;
    const monthlyCost = monthlyVolume * effectiveFee;
    return {
      venue: v.venue,
      effectiveFee,
      monthlyCost,
    };
  }).sort((a, b) => a.effectiveFee - b.effectiveFee);

  const best = analysis[0];
  const worst = analysis[analysis.length - 1];

  return {
    optimalVenue: best.venue,
    monthlySavings: worst.monthlyCost - best.monthlyCost,
    effectiveFee: best.effectiveFee,
    venueAnalysis: analysis,
  };
}

// ── Cross-Venue Order Book Imbalance ─────────────────────

/**
 * Aggregate order book imbalance across venues.
 * Positive imbalance = more bid depth (buy pressure).
 * Detects divergence when venues disagree on direction.
 */
export function crossVenueOBImbalance(
  orderbooks: OrderbookInput[],
  depth: number = 10
): CrossVenueOBImbalanceResult {
  if (orderbooks.length === 0) {
    return {
      aggregateImbalance: 0,
      venueImbalances: [],
      pressure: 'neutral',
      divergence: false,
    };
  }

  const venueImbalances = orderbooks.map(ob => {
    const bids = ob.bids.slice(0, depth);
    const asks = ob.asks.slice(0, depth);
    const bidDepth = bids.reduce((s, l) => s + l.qty, 0);
    const askDepth = asks.reduce((s, l) => s + l.qty, 0);
    const total = bidDepth + askDepth;
    const imbalance = total === 0 ? 0 : (bidDepth - askDepth) / total;
    return {
      venue: ob.venue,
      imbalance,
      bidDepth,
      askDepth,
    };
  });

  // Aggregate: volume-weighted imbalance
  const totalDepth = venueImbalances.reduce((s, v) => s + v.bidDepth + v.askDepth, 0);
  const aggregateImbalance = totalDepth === 0
    ? 0
    : venueImbalances.reduce((s, v) => {
        const weight = (v.bidDepth + v.askDepth) / totalDepth;
        return s + v.imbalance * weight;
      }, 0);

  // Pressure classification
  let pressure: 'buy' | 'sell' | 'neutral';
  if (aggregateImbalance > 0.1) {
    pressure = 'buy';
  } else if (aggregateImbalance < -0.1) {
    pressure = 'sell';
  } else {
    pressure = 'neutral';
  }

  // Divergence: venues disagree on direction
  const signs = venueImbalances.map(v =>
    v.imbalance > 0.1 ? 1 : v.imbalance < -0.1 ? -1 : 0
  );
  const hasPositive = signs.some(s => s > 0);
  const hasNegative = signs.some(s => s < 0);
  const divergence = hasPositive && hasNegative;

  return { aggregateImbalance, venueImbalances, pressure, divergence };
}
