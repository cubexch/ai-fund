/**
 * Algorithmic execution planning tools.
 * TWAP, VWAP, iceberg, sniper, smart routing, market impact simulation.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { handler } from './handler.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerAlgorithmTools(server: McpServer, client: ExchangeClient) {

  // ── TWAP ────────────────────────────────────────────────────

  server.tool(
    'plan_twap',
    'Plan a Time-Weighted Average Price execution. Splits a large order into N equal slices over a time window.',
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      total_amount: z.number().describe('Total amount to execute'),
      duration_minutes: z.number().describe('Execution window in minutes'),
      num_slices: z.number().describe('Number of order slices'),
    } as any,
    handler(async (params: any) => {
      if (params.total_amount <= 0) throw new Error('total_amount must be positive');
      if (params.duration_minutes <= 0) throw new Error('duration must be positive');
      if (params.num_slices <= 0) throw new Error('num_slices must be positive');

      const now = Date.now();
      const intervalMs = (params.duration_minutes * 60 * 1000) / params.num_slices;
      const amountPerSlice = params.total_amount / params.num_slices;

      const ticker = await client.getTicker(params.symbol);
      const currentPrice = ticker.last || 0;
      const dailyVolume = ticker.volume || 1;
      const participation = params.total_amount / (dailyVolume || 1);
      const estimatedImpact = Math.sqrt(participation) * 100; // bps

      const slices = [];
      for (let i = 0; i < params.num_slices; i++) {
        slices.push({
          sequence: i + 1,
          scheduledTime: now + i * intervalMs,
          amount: amountPerSlice,
          estimatedPrice: currentPrice,
        });
      }

      return {
        symbol: params.symbol,
        side: params.side,
        totalAmount: params.total_amount,
        durationMinutes: params.duration_minutes,
        numSlices: params.num_slices,
        intervalMs,
        currentPrice,
        estimatedImpact,
        slices,
      };
    }),
  );

  // ── VWAP ────────────────────────────────────────────────────

  server.tool(
    'plan_vwap',
    'Plan a Volume-Weighted Average Price execution. Distributes order sizes proportional to historical volume.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      total_amount: z.number().describe('Total amount to execute'),
      duration_minutes: z.number().describe('Execution window in minutes'),
      num_slices: z.number().describe('Number of time buckets'),
    } as any,
    handler(async (params: any) => {
      if (params.total_amount <= 0) throw new Error('total_amount must be positive');
      if (params.duration_minutes <= 0) throw new Error('duration must be positive');
      if (params.num_slices <= 0) throw new Error('num_slices must be positive');

      // Fetch historical bars to determine volume profile
      const bars = await client.getBars(params.symbol, '1h', undefined, Math.max(params.num_slices * 2, 48));
      const now = Date.now();
      const intervalMs = (params.duration_minutes * 60 * 1000) / params.num_slices;

      // Bucket volumes
      const bucketSize = Math.max(1, Math.floor(bars.length / params.num_slices));
      const bucketVolumes: number[] = [];
      for (let i = 0; i < params.num_slices; i++) {
        const start = i * bucketSize;
        const end = Math.min(start + bucketSize, bars.length);
        let vol = 0;
        for (let j = start; j < end; j++) {
          vol += bars[j]?.volume || 0;
        }
        bucketVolumes.push(Math.max(vol, 0.001)); // avoid zero
      }

      const totalVolume = bucketVolumes.reduce((a, b) => a + b, 0);
      const slices = bucketVolumes.map((vol, i) => {
        const weight = vol / totalVolume;
        return {
          sequence: i + 1,
          scheduledTime: now + i * intervalMs,
          amount: params.total_amount * weight,
          volumeWeight: weight,
        };
      });

      return {
        symbol: params.symbol,
        side: params.side,
        totalAmount: params.total_amount,
        durationMinutes: params.duration_minutes,
        numSlices: params.num_slices,
        slices,
      };
    }),
  );

  // ── Iceberg ─────────────────────────────────────────────────

  server.tool(
    'plan_iceberg',
    'Plan an iceberg order execution. Splits order into small visible clips to minimize market impact.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      total_amount: z.number().describe('Total amount to execute'),
      clip_size: z.number().describe('Visible clip size per order'),
    } as any,
    handler(async (params: any) => {
      if (params.total_amount <= 0) throw new Error('total_amount must be positive');
      if (params.clip_size <= 0) throw new Error('clip_size must be positive');

      const fullClips = Math.floor(params.total_amount / params.clip_size);
      const remainder = params.total_amount - fullClips * params.clip_size;
      const numClips = fullClips + (remainder > 1e-10 ? 1 : 0);

      const clips = [];
      for (let i = 0; i < fullClips; i++) {
        clips.push({
          sequence: i + 1,
          amount: params.clip_size,
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
        clips.push({ sequence: 1, amount: params.total_amount });
      }

      const ticker = await client.getTicker(params.symbol);

      return {
        symbol: params.symbol,
        side: params.side,
        totalAmount: params.total_amount,
        clipSize: params.clip_size,
        numClips: clips.length,
        currentPrice: ticker.last,
        clips,
      };
    }),
  );

  // ── Sniper ──────────────────────────────────────────────────

  server.tool(
    'analyze_sniper',
    'Analyze order book to estimate fill probability and expected fill price for a market order.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      amount: z.number().describe('Amount to fill'),
    } as any,
    handler(async (params: any) => {
      if (params.amount <= 0) throw new Error('amount must be positive');

      const book = await client.getOrderBook(params.symbol, 50);
      const levels = params.side === 'buy' ? book.asks : book.bids;

      let filled = 0;
      let totalCost = 0;
      let levelsUsed = 0;

      for (const [price, size] of levels) {
        const fillQty = Math.min(params.amount - filled, size);
        totalCost += fillQty * price;
        filled += fillQty;
        levelsUsed++;
        if (filled >= params.amount) break;
      }

      const fillProbability = Math.min(filled / params.amount, 1);
      const expectedFillPrice = filled > 0 ? totalCost / filled : 0;
      const bestPrice = params.side === 'buy' ? (book.bestAsk || 0) : (book.bestBid || 0);
      const priceImpactBps = bestPrice > 0
        ? Math.abs(expectedFillPrice - bestPrice) / bestPrice * 10000
        : 0;

      return {
        symbol: params.symbol,
        side: params.side,
        amount: params.amount,
        fillProbability,
        expectedFillPrice,
        bestPrice,
        priceImpactBps,
        levelsConsumed: levelsUsed,
        totalBookDepth: levels.reduce((s: number, l: [number, number]) => s + l[1], 0),
      };
    }),
  );

  // ── Execution plan comparison ───────────────────────────────

  server.tool(
    'compare_execution_plans',
    'Compare TWAP, VWAP, and iceberg execution strategies for a given order. Returns cost/impact estimates and a recommendation.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      total_amount: z.number().describe('Total amount'),
      duration_minutes: z.number().describe('Available execution window'),
    } as any,
    handler(async (params: any) => {
      const ticker = await client.getTicker(params.symbol);
      const book = await client.getOrderBook(params.symbol, 20);
      const price = ticker.last || 0;
      const dailyVol = ticker.volume || 1;
      const participation = params.total_amount / dailyVol;
      const spreadBps = book.spreadBps || 5;

      // TWAP estimate
      const twapSlices = Math.max(3, Math.ceil(params.duration_minutes / 10));
      const twapImpact = Math.sqrt(participation / twapSlices) * 80;
      const twapCost = params.total_amount * price * (twapImpact / 10000);

      // VWAP estimate (slightly better than TWAP due to volume weighting)
      const vwapImpact = twapImpact * 0.85;
      const vwapCost = params.total_amount * price * (vwapImpact / 10000);

      // Iceberg estimate
      const clipSize = Math.max(params.total_amount / 20, 0.001);
      const icebergImpact = spreadBps + Math.sqrt(participation) * 30;
      const icebergCost = params.total_amount * price * (icebergImpact / 10000);

      const plans = [
        { algorithm: 'twap', estimatedCost: twapCost, estimatedImpact: twapImpact, numSlices: twapSlices },
        { algorithm: 'vwap', estimatedCost: vwapCost, estimatedImpact: vwapImpact, numSlices: twapSlices },
        { algorithm: 'iceberg', estimatedCost: icebergCost, estimatedImpact: icebergImpact, clipSize },
      ];

      // Recommend the lowest cost
      plans.sort((a, b) => a.estimatedCost - b.estimatedCost);
      const recommended = plans[0].algorithm;

      return {
        symbol: params.symbol,
        side: params.side,
        totalAmount: params.total_amount,
        currentPrice: price,
        dailyVolume: dailyVol,
        participationRate: participation,
        plans,
        recommended,
      };
    }),
  );

  // ── Market impact simulation ────────────────────────────────

  server.tool(
    'simulate_market_impact',
    'Estimate market impact using the Almgren-Chriss square-root model. Returns temporary and permanent impact in bps.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      amount: z.number().describe('Order size in base currency'),
    } as any,
    handler(async (params: any) => {
      if (params.amount <= 0) throw new Error('amount must be positive');
      if (params.side !== 'buy' && params.side !== 'sell') throw new Error('side must be buy or sell');

      const ticker = await client.getTicker(params.symbol);
      const bars = await client.getBars(params.symbol, '1d', undefined, 30);

      const dailyVolume = ticker.volume || 1;
      const price = ticker.last || 1;

      // Compute realized volatility from daily bars
      const closes = bars.map(b => b.close);
      let sumSqRet = 0;
      for (let i = 1; i < closes.length; i++) {
        const ret = Math.log(closes[i] / closes[i - 1]);
        sumSqRet += ret * ret;
      }
      const volatility = closes.length > 1 ? Math.sqrt(sumSqRet / (closes.length - 1)) : 0.02;

      // Almgren-Chriss square-root model
      const participation = params.amount / dailyVolume;
      const sigma = volatility;

      // Temporary impact: eta * sigma * sqrt(participation)
      const eta = 0.142; // empirical constant
      const temporaryImpactBps = eta * sigma * Math.sqrt(participation) * 10000;

      // Permanent impact: gamma * sigma * participation
      const gamma = 0.314; // empirical constant
      const permanentImpactBps = gamma * sigma * participation * 10000;

      const totalImpactBps = temporaryImpactBps + permanentImpactBps;
      const estimatedCost = params.amount * price * (totalImpactBps / 10000);

      return {
        symbol: params.symbol,
        side: params.side,
        amount: params.amount,
        currentPrice: price,
        dailyVolume,
        volatility,
        participationRate: participation,
        temporaryImpactBps: Math.round(temporaryImpactBps * 100) / 100,
        permanentImpactBps: Math.round(permanentImpactBps * 100) / 100,
        totalImpactBps: Math.round(totalImpactBps * 100) / 100,
        estimatedCostUsd: Math.round(estimatedCost * 100) / 100,
      };
    }),
  );

  // ── Smart order routing ─────────────────────────────────────

  server.tool(
    'plan_smart_route',
    'Plan optimal order routing across multiple venues based on available liquidity.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      total_amount: z.number().describe('Total amount to route'),
      venues: z.string().describe('Comma-separated venue names'),
    } as any,
    handler(async (params: any) => {
      const venueList = params.venues.split(',').map((v: string) => v.trim()).filter(Boolean);
      if (venueList.length === 0) throw new Error('At least one venue required');

      const book = await client.getOrderBook(params.symbol, 20);
      const levels = params.side === 'buy' ? book.asks : book.bids;
      const totalLiquidity = levels.reduce((s: number, l: [number, number]) => s + l[1], 0);

      // Distribute across venues proportionally (simplified — in production would query each venue)
      const perVenueLiq = totalLiquidity / venueList.length;
      const allocations = venueList.map((venue: string, i: number) => {
        const share = 1 / venueList.length;
        const amount = params.total_amount * share;
        return {
          venue,
          amount,
          share,
          estimatedLiquidity: perVenueLiq,
        };
      });

      return {
        symbol: params.symbol,
        side: params.side,
        totalAmount: params.total_amount,
        numVenues: venueList.length,
        allocations,
      };
    }),
  );

  // ── Implementation shortfall ────────────────────────────────

  server.tool(
    'calculate_implementation_shortfall',
    'Calculate implementation shortfall between decision price and execution price.',
    {
      symbol: z.string().describe('Trading pair'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      decision_price: z.number().describe('Price at time of decision'),
      execution_price: z.number().describe('Actual execution price'),
      amount: z.number().describe('Amount traded'),
    } as any,
    handler(async (params: any) => {
      const { decision_price, execution_price, amount, side } = params;

      // For buys: shortfall = (exec - decision) / decision
      // For sells: shortfall = (decision - exec) / decision
      const priceDiff = side === 'buy'
        ? execution_price - decision_price
        : decision_price - execution_price;

      const shortfallBps = (priceDiff / decision_price) * 10000;
      const shortfallCost = priceDiff * amount;

      return {
        symbol: params.symbol,
        side,
        decisionPrice: decision_price,
        executionPrice: execution_price,
        amount,
        shortfallBps: Math.round(shortfallBps * 100) / 100,
        shortfallCost: Math.round(shortfallCost * 100) / 100,
        shortfallPct: Math.round(shortfallBps / 100 * 10000) / 10000,
      };
    }),
  );
}
