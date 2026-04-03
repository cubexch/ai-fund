/**
 * Cross-venue analytics and smart order routing.
 * Triangular arb, spread analysis, venue scoring, fragmentation,
 * latency cost modeling, and order book aggregation.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import { mean, standardDeviation, correlation } from './math.js';

// ── Types ────────────────────────────────────────────────

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

export interface VenueSpreadEntry {
  venue: string;
  midPrice: number;
  spread: number;
  spreadBps: number;
  effectiveSpread: number;
}

export interface CrossVenueSpreadResult {
  bestBid: { venue: string; price: number };
  bestAsk: { venue: string; price: number };
  crossSpread: number;
  crossSpreadPct: number;
  arbOpportunity: boolean;
  netArbProfit: number;
  venues: VenueSpreadEntry[];
}

export interface RouteFill {
  venue: string;
  quantity: number;
  price: number;
  fee: number;
  cost: number;
}

export interface SmartOrderRouteResult {
  fills: RouteFill[];
  totalCost: number;
  avgPrice: number;
  totalFees: number;
  venueCount: number;
  savings: number;
}

export interface VenueScore {
  venue: string;
  score: number;
  rank: number;
  strengths: string[];
  weaknesses: string[];
}

export interface FragmentationResult {
  hhi: number;
  effectiveVenues: number;
  topVenueShare: number;
  fragmentationLevel: 'consolidated' | 'moderate' | 'fragmented';
  shares: Array<{ venue: string; sharePct: number }>;
}

export interface LatencyCostResult {
  latencyCostBps: number;
  annualizedCost: number;
  optimalLatency: number;
  costCurve: Array<{ latencyMs: number; costBps: number }>;
}

export interface LeadLagEntry {
  leader: string;
  follower: string;
  lagMs: number;
  correlation: number;
}

export interface VenueCorrelationResult {
  correlations: Record<string, Record<string, number>>;
  leadLag: LeadLagEntry[];
  priceDiscoveryLeader: string;
}

export interface VenueSelectionResult {
  primary: string;
  secondary: string | null;
  reasoning: string;
  expectedCost: number;
  expectedSlippage: number;
  splitRecommendation: boolean;
}

export interface MakerTakerResult {
  optimalVenue: string;
  monthlySavings: number;
  effectiveFee: number;
  venueAnalysis: Array<{ venue: string; effectiveFee: number; monthlyCost: number }>;
}

export interface VenueImbalance {
  venue: string;
  imbalance: number;
  bidDepth: number;
  askDepth: number;
}

export interface CrossVenueOBResult {
  aggregateImbalance: number;
  venueImbalances: VenueImbalance[];
  pressure: 'buy' | 'sell' | 'neutral';
  divergence: boolean;
}

// ── Public Functions ─────────────────────────────────────

/**
 * Detect triangular arbitrage opportunities across currency pairs.
 */
export function triangularArb(
  prices: Array<{ pair: string; bid: number; ask: number; venue: string; fee: number }>
): TriangularArbResult {
  if (prices.length < 3) return { opportunities: [], scanned: 0 };

  // Extract unique currencies
  const currencies = new Set<string>();
  for (const p of prices) {
    const [base, quote] = p.pair.split('/');
    if (base) currencies.add(base);
    if (quote) currencies.add(quote);
  }

  // Build price lookup
  const lookup = new Map<string, typeof prices[0]>();
  for (const p of prices) {
    lookup.set(p.pair, p);
  }

  const currList = [...currencies];
  const opportunities: TriangularArbOpportunity[] = [];
  let scanned = 0;

  // Try all 3-currency paths
  for (let i = 0; i < currList.length; i++) {
    for (let j = 0; j < currList.length; j++) {
      if (j === i) continue;
      for (let k = 0; k < currList.length; k++) {
        if (k === i || k === j) continue;
        scanned++;

        const a = currList[i], b = currList[j], c = currList[k];

        // Path: A → B → C → A
        const ab = lookup.get(`${a}/${b}`) ?? lookup.get(`${b}/${a}`);
        const bc = lookup.get(`${b}/${c}`) ?? lookup.get(`${c}/${b}`);
        const ca = lookup.get(`${c}/${a}`) ?? lookup.get(`${a}/${c}`);

        if (!ab || !bc || !ca) continue;

        // Calculate round-trip return
        const capital = 10000;
        let amount = capital;
        const legs: ArbLeg[] = [];

        // Leg 1: buy B with A
        if (ab.pair === `${a}/${b}`) {
          amount = amount / ab.ask;
          legs.push({ pair: ab.pair, side: 'buy', price: ab.ask, venue: ab.venue });
        } else {
          amount = amount * ab.bid;
          legs.push({ pair: ab.pair, side: 'sell', price: ab.bid, venue: ab.venue });
        }
        amount *= (1 - ab.fee);

        // Leg 2: buy C with B
        if (bc.pair === `${b}/${c}`) {
          amount = amount / bc.ask;
          legs.push({ pair: bc.pair, side: 'buy', price: bc.ask, venue: bc.venue });
        } else {
          amount = amount * bc.bid;
          legs.push({ pair: bc.pair, side: 'sell', price: bc.bid, venue: bc.venue });
        }
        amount *= (1 - bc.fee);

        // Leg 3: sell C for A
        if (ca.pair === `${c}/${a}`) {
          amount = amount * ca.bid;
          legs.push({ pair: ca.pair, side: 'sell', price: ca.bid, venue: ca.venue });
        } else {
          amount = amount / ca.ask;
          legs.push({ pair: ca.pair, side: 'buy', price: ca.ask, venue: ca.venue });
        }
        amount *= (1 - ca.fee);

        const grossProfit = amount - capital;
        const netProfit = grossProfit; // fees already deducted
        const profitPct = (netProfit / capital) * 100;

        if (netProfit > 0) {
          opportunities.push({
            path: [a, b, c, a],
            grossProfit: amount - capital + capital * (ab.fee + bc.fee + ca.fee),
            netProfit,
            profitPct,
            requiredCapital: capital,
            legs,
          });
        }
      }
    }
  }

  opportunities.sort((a, b) => b.netProfit - a.netProfit);
  return { opportunities, scanned };
}

/**
 * Analyze spread differences across venues for the same asset.
 */
export function crossVenueSpread(
  venues: Array<{ venue: string; bid: number; ask: number; volume24h: number; fee: number }>
): CrossVenueSpreadResult {
  if (venues.length === 0) {
    return {
      bestBid: { venue: '', price: 0 }, bestAsk: { venue: '', price: 0 },
      crossSpread: 0, crossSpreadPct: 0, arbOpportunity: false, netArbProfit: 0, venues: [],
    };
  }

  let bestBid = { venue: venues[0].venue, price: venues[0].bid };
  let bestAsk = { venue: venues[0].venue, price: venues[0].ask };

  const venueEntries: VenueSpreadEntry[] = [];

  for (const v of venues) {
    if (v.bid > bestBid.price) bestBid = { venue: v.venue, price: v.bid };
    if (v.ask < bestAsk.price) bestAsk = { venue: v.venue, price: v.ask };

    const mid = (v.bid + v.ask) / 2;
    const spread = v.ask - v.bid;
    venueEntries.push({
      venue: v.venue,
      midPrice: mid,
      spread,
      spreadBps: mid === 0 ? 0 : (spread / mid) * 10000,
      effectiveSpread: spread + mid * v.fee * 2,
    });
  }

  const crossSpread = bestBid.price - bestAsk.price;
  const mid = (bestBid.price + bestAsk.price) / 2;
  const crossSpreadPct = mid === 0 ? 0 : (crossSpread / mid) * 100;

  // Check if arb exists after fees
  const bidVenue = venues.find(v => v.venue === bestBid.venue)!;
  const askVenue = venues.find(v => v.venue === bestAsk.venue)!;
  const fees = bestBid.price * bidVenue.fee + bestAsk.price * askVenue.fee;
  const netArbProfit = crossSpread - fees;
  const arbOpportunity = netArbProfit > 0;

  return { bestBid, bestAsk, crossSpread, crossSpreadPct, arbOpportunity, netArbProfit, venues: venueEntries };
}

/**
 * Optimal order split across venues minimizing total execution cost.
 */
export function smartOrderRoute(params: {
  side: 'buy' | 'sell';
  totalQuantity: number;
  venues: Array<{ venue: string; price: number; availableQty: number; fee: number; latencyMs: number }>;
}): SmartOrderRouteResult {
  const { side, totalQuantity } = params;
  if (totalQuantity <= 0 || params.venues.length === 0) {
    return { fills: [], totalCost: 0, avgPrice: 0, totalFees: 0, venueCount: 0, savings: 0 };
  }

  // Sort venues by effective price (price + fee for buy, price - fee for sell)
  const sorted = [...params.venues].sort((a, b) => {
    const effA = side === 'buy' ? a.price * (1 + a.fee) : a.price * (1 - a.fee);
    const effB = side === 'buy' ? b.price * (1 + b.fee) : b.price * (1 - b.fee);
    return side === 'buy' ? effA - effB : effB - effA;
  });

  const fills: RouteFill[] = [];
  let remaining = totalQuantity;
  let totalCost = 0;
  let totalFees = 0;

  for (const v of sorted) {
    if (remaining <= 0) break;
    const qty = Math.min(remaining, v.availableQty);
    if (qty <= 0) continue;

    const fee = qty * v.price * v.fee;
    const cost = qty * v.price + (side === 'buy' ? fee : -fee);

    fills.push({ venue: v.venue, quantity: qty, price: v.price, fee, cost });
    totalCost += cost;
    totalFees += fee;
    remaining -= qty;
  }

  const filledQty = totalQuantity - remaining;
  const avgPrice = filledQty === 0 ? 0 : totalCost / filledQty;

  // Savings vs worst venue
  const worstPrice = side === 'buy'
    ? Math.max(...params.venues.map(v => v.price * (1 + v.fee)))
    : Math.min(...params.venues.map(v => v.price * (1 - v.fee)));
  const worstCost = filledQty * worstPrice;
  const savings = Math.abs(worstCost - totalCost);

  return { fills, totalCost, avgPrice, totalFees, venueCount: fills.length, savings };
}

/**
 * Composite quality score per venue.
 */
export function venueQualityScore(
  metrics: Array<{ venue: string; uptime: number; latencyMs: number; spreadBps: number; fillRate: number; slippageBps: number; volume24h: number }>
): VenueScore[] {
  if (metrics.length === 0) return [];

  const maxVol = Math.max(...metrics.map(m => m.volume24h));
  const maxLatency = Math.max(...metrics.map(m => m.latencyMs));
  const maxSpread = Math.max(...metrics.map(m => m.spreadBps));
  const maxSlippage = Math.max(...metrics.map(m => m.slippageBps));

  const scored = metrics.map(m => {
    let score = 0;
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    // Uptime (0-1, weight 20)
    score += m.uptime * 20;
    if (m.uptime > 0.999) strengths.push('excellent uptime');
    if (m.uptime < 0.99) weaknesses.push('reliability concerns');

    // Latency (lower better, weight 20)
    const latScore = maxLatency === 0 ? 20 : 20 * (1 - m.latencyMs / maxLatency);
    score += latScore;
    if (m.latencyMs < 10) strengths.push('low latency');
    if (m.latencyMs > 200) weaknesses.push('high latency');

    // Spread (lower better, weight 20)
    const spScore = maxSpread === 0 ? 20 : 20 * (1 - m.spreadBps / maxSpread);
    score += spScore;
    if (m.spreadBps < 5) strengths.push('tight spreads');
    if (m.spreadBps > 20) weaknesses.push('wide spreads');

    // Fill rate (higher better, weight 20)
    score += m.fillRate * 20;
    if (m.fillRate > 0.95) strengths.push('high fill rate');
    if (m.fillRate < 0.8) weaknesses.push('low fill rate');

    // Slippage (lower better, weight 10)
    const slScore = maxSlippage === 0 ? 10 : 10 * (1 - m.slippageBps / maxSlippage);
    score += slScore;

    // Volume (higher better, weight 10)
    const volScore = maxVol === 0 ? 10 : 10 * (m.volume24h / maxVol);
    score += volScore;
    if (m.volume24h === maxVol) strengths.push('highest volume');

    return { venue: m.venue, score, rank: 0, strengths, weaknesses };
  });

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => { s.rank = i + 1; });

  return scored;
}

/**
 * Market fragmentation metrics.
 */
export function fragmentationIndex(
  venues: Array<{ venue: string; volume24h: number; openInterest?: number }>
): FragmentationResult {
  if (venues.length === 0) {
    return { hhi: 0, effectiveVenues: 0, topVenueShare: 0, fragmentationLevel: 'consolidated', shares: [] };
  }

  const totalVol = venues.reduce((s, v) => s + v.volume24h, 0);
  if (totalVol === 0) {
    return {
      hhi: 10000,
      effectiveVenues: venues.length,
      topVenueShare: 0,
      fragmentationLevel: 'consolidated',
      shares: venues.map(v => ({ venue: v.venue, sharePct: 0 })),
    };
  }

  const shares = venues
    .map(v => ({ venue: v.venue, sharePct: (v.volume24h / totalVol) * 100 }))
    .sort((a, b) => b.sharePct - a.sharePct);

  const hhi = shares.reduce((s, sh) => s + sh.sharePct ** 2, 0);
  const effectiveVenues = hhi === 0 ? 0 : 10000 / hhi;
  const topVenueShare = shares[0].sharePct;

  let fragmentationLevel: FragmentationResult['fragmentationLevel'];
  if (hhi > 5000) fragmentationLevel = 'consolidated';
  else if (hhi > 2500) fragmentationLevel = 'moderate';
  else fragmentationLevel = 'fragmented';

  return { hhi, effectiveVenues, topVenueShare, fragmentationLevel, shares };
}

/**
 * Estimate cost of latency in basis points.
 */
export function latencyCostModel(params: {
  latencyMs: number;
  volatility: number;
  orderSize: number;
  avgVolume: number;
}): LatencyCostResult {
  const { latencyMs, volatility, orderSize, avgVolume } = params;

  // Cost = volatility * sqrt(latency in trading days) * participation rate
  const tradingDayMs = 24 * 60 * 60 * 1000; // crypto = 24h
  const latencyFraction = latencyMs / tradingDayMs;
  const participation = avgVolume === 0 ? 0 : orderSize / avgVolume;

  const latencyCostBps = volatility * Math.sqrt(latencyFraction) * 10000 * (1 + participation);
  const annualizedCost = latencyCostBps * 252; // ~252 trading days

  // Optimal latency: where marginal cost reduction = marginal infrastructure cost
  // Simplified: 1ms is the floor
  const optimalLatency = Math.max(1, latencyMs * 0.1);

  // Cost curve
  const costCurve: Array<{ latencyMs: number; costBps: number }> = [];
  for (const ms of [1, 5, 10, 25, 50, 100, 250, 500, 1000]) {
    const frac = ms / tradingDayMs;
    const cost = volatility * Math.sqrt(frac) * 10000 * (1 + participation);
    costCurve.push({ latencyMs: ms, costBps: cost });
  }

  return { latencyCostBps, annualizedCost, optimalLatency, costCurve };
}

/**
 * Price correlation and lead-lag between venues.
 */
export function venueCorrelation(
  priceSeries: Record<string, number[]>
): VenueCorrelationResult {
  const venues = Object.keys(priceSeries);
  if (venues.length < 2) {
    return { correlations: {}, leadLag: [], priceDiscoveryLeader: venues[0] ?? '' };
  }

  const correlations: Record<string, Record<string, number>> = {};
  const leadLag: LeadLagEntry[] = [];

  for (const a of venues) {
    correlations[a] = {};
    for (const b of venues) {
      const corr = correlation(priceSeries[a], priceSeries[b]);
      correlations[a][b] = corr;
    }
  }

  // Lead-lag: compute cross-correlation at lag 1
  let bestLeader = venues[0];
  let bestLeadScore = 0;

  for (let i = 0; i < venues.length; i++) {
    for (let j = i + 1; j < venues.length; j++) {
      const a = priceSeries[venues[i]];
      const b = priceSeries[venues[j]];
      const n = Math.min(a.length, b.length);
      if (n < 3) continue;

      // Cross-corr: a leads b (a[t] vs b[t+1])
      const aLead = correlation(a.slice(0, n - 1), b.slice(1, n));
      // Cross-corr: b leads a (b[t] vs a[t+1])
      const bLead = correlation(b.slice(0, n - 1), a.slice(1, n));

      if (Math.abs(aLead) > Math.abs(bLead)) {
        leadLag.push({ leader: venues[i], follower: venues[j], lagMs: 1, correlation: aLead });
        if (Math.abs(aLead) > bestLeadScore) {
          bestLeadScore = Math.abs(aLead);
          bestLeader = venues[i];
        }
      } else {
        leadLag.push({ leader: venues[j], follower: venues[i], lagMs: 1, correlation: bLead });
        if (Math.abs(bLead) > bestLeadScore) {
          bestLeadScore = Math.abs(bLead);
          bestLeader = venues[j];
        }
      }
    }
  }

  return { correlations, leadLag, priceDiscoveryLeader: bestLeader };
}

/**
 * Recommend best venue(s) given order characteristics.
 */
export function executionVenueSelection(params: {
  side: 'buy' | 'sell';
  size: number;
  urgency: 'low' | 'medium' | 'high';
  venues: Array<{ venue: string; spread: number; depth: number; fee: number; latencyMs: number; fillRate: number }>;
}): VenueSelectionResult {
  const { side, size, urgency, venues } = params;
  if (venues.length === 0) {
    return { primary: '', secondary: null, reasoning: 'No venues available', expectedCost: 0, expectedSlippage: 0, splitRecommendation: false };
  }

  // Score each venue based on urgency-weighted criteria
  const weights = urgency === 'high'
    ? { latency: 0.35, fillRate: 0.30, spread: 0.20, depth: 0.10, fee: 0.05 }
    : urgency === 'medium'
    ? { latency: 0.15, fillRate: 0.20, spread: 0.30, depth: 0.20, fee: 0.15 }
    : { latency: 0.05, fillRate: 0.10, spread: 0.25, depth: 0.25, fee: 0.35 };

  const maxLat = Math.max(...venues.map(v => v.latencyMs), 1);
  const maxSpread = Math.max(...venues.map(v => v.spread), 1);
  const maxDepth = Math.max(...venues.map(v => v.depth), 1);
  const maxFee = Math.max(...venues.map(v => v.fee), 0.001);

  const scored = venues.map(v => {
    const score =
      weights.latency * (1 - v.latencyMs / maxLat) +
      weights.fillRate * v.fillRate +
      weights.spread * (1 - v.spread / maxSpread) +
      weights.depth * (v.depth / maxDepth) +
      weights.fee * (1 - v.fee / maxFee);
    return { ...v, score };
  }).sort((a, b) => b.score - a.score);

  const primary = scored[0];
  const splitRecommendation = size > primary.depth * 0.5 && scored.length > 1;
  const secondary = splitRecommendation ? scored[1].venue : null;

  const expectedSlippage = primary.depth === 0 ? 0 : (size / primary.depth) * primary.spread;
  const expectedCost = size * primary.spread + size * primary.fee + expectedSlippage;

  const reasoning = splitRecommendation
    ? `Split recommended: order size (${size}) exceeds 50% of ${primary.venue} depth (${primary.depth})`
    : `${primary.venue} best for ${urgency} urgency: ${urgency === 'high' ? 'lowest latency' : urgency === 'low' ? 'lowest cost' : 'balanced execution'}`;

  return { primary: primary.venue, secondary, reasoning, expectedCost, expectedSlippage, splitRecommendation };
}

/**
 * Optimize venue selection by fee structure.
 */
export function makerTakerOptimization(params: {
  venues: Array<{ venue: string; makerFee: number; takerFee: number; makerRebate?: number; volumeTier?: number }>;
  monthlyVolume: number;
  makerRatio: number;
}): MakerTakerResult {
  const { venues, monthlyVolume, makerRatio } = params;
  if (venues.length === 0) {
    return { optimalVenue: '', monthlySavings: 0, effectiveFee: 0, venueAnalysis: [] };
  }

  const takerRatio = 1 - makerRatio;

  const analysis = venues.map(v => {
    const makerCost = (v.makerFee - (v.makerRebate ?? 0)) * makerRatio;
    const takerCost = v.takerFee * takerRatio;
    const effectiveFee = makerCost + takerCost;
    const monthlyCost = effectiveFee * monthlyVolume;
    return { venue: v.venue, effectiveFee, monthlyCost };
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

/**
 * Aggregate order book imbalance across venues.
 */
export function crossVenueOBImbalance(
  orderbooks: Array<{ venue: string; bids: Array<{ price: number; qty: number }>; asks: Array<{ price: number; qty: number }> }>,
  depth?: number
): CrossVenueOBResult {
  if (orderbooks.length === 0) {
    return { aggregateImbalance: 0, venueImbalances: [], pressure: 'neutral', divergence: false };
  }

  const d = depth ?? 10;
  let totalBid = 0;
  let totalAsk = 0;
  const venueImbalances: VenueImbalance[] = [];

  for (const ob of orderbooks) {
    const bidDepth = ob.bids.slice(0, d).reduce((s, b) => s + b.qty, 0);
    const askDepth = ob.asks.slice(0, d).reduce((s, a) => s + a.qty, 0);
    const total = bidDepth + askDepth;
    const imbalance = total === 0 ? 0 : (bidDepth - askDepth) / total;

    venueImbalances.push({ venue: ob.venue, imbalance, bidDepth, askDepth });
    totalBid += bidDepth;
    totalAsk += askDepth;
  }

  const totalDepth = totalBid + totalAsk;
  const aggregateImbalance = totalDepth === 0 ? 0 : (totalBid - totalAsk) / totalDepth;

  const pressure: 'buy' | 'sell' | 'neutral' =
    aggregateImbalance > 0.1 ? 'buy' :
    aggregateImbalance < -0.1 ? 'sell' : 'neutral';

  // Divergence: venues disagree on direction
  const signs = venueImbalances.map(v => Math.sign(v.imbalance));
  const divergence = signs.some(s => s > 0) && signs.some(s => s < 0);

  return { aggregateImbalance, venueImbalances, pressure, divergence };
}
