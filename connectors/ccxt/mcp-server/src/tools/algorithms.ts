/**
 * Algorithmic execution planning tools.
 * TWAP, VWAP, iceberg, sniper, smart routing, market impact simulation.
 *
 * Core logic lives in @ai-fund/lib/execution-planner.
 * These handlers fetch exchange data and delegate to pure functions.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import {
  planTwap,
  planVwap,
  planIceberg,
  analyzeSniper,
  compareExecutionPlans,
  estimateMarketImpact,
  realizedVolatility,
  calculateImplementationShortfall,
} from '@ai-fund/lib/execution-planner';

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

      const [ticker, recentBars] = await Promise.all([
        client.getTicker(params.symbol),
        client.getBars(params.symbol, '1d', undefined, 2),
      ]);
      const currentPrice = ticker.last ?? recentBars[recentBars.length - 1]?.close ?? 0;
      const dailyVolume = ticker.volume ?? recentBars[recentBars.length - 1]?.volume ?? 0;
      if (dailyVolume <= 0) throw new Error(`No volume data available for ${params.symbol} — cannot estimate market participation`);

      const plan = planTwap({
        totalAmount: params.total_amount,
        durationMinutes: params.duration_minutes,
        numSlices: params.num_slices,
        currentPrice,
        dailyVolume,
        nowMs: Date.now(),
      });

      return {
        symbol: params.symbol,
        side: params.side,
        ...plan,
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

      const bars = await client.getBars(params.symbol, '1h', undefined, Math.max(params.num_slices * 2, 48));

      const plan = planVwap({
        totalAmount: params.total_amount,
        durationMinutes: params.duration_minutes,
        numSlices: params.num_slices,
        bars,
        nowMs: Date.now(),
      });

      return {
        symbol: params.symbol,
        side: params.side,
        ...plan,
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

      const ticker = await client.getTicker(params.symbol);

      const plan = planIceberg({
        totalAmount: params.total_amount,
        clipSize: params.clip_size,
      });

      return {
        symbol: params.symbol,
        side: params.side,
        currentPrice: ticker.last,
        ...plan,
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
      const bestPrice = params.side === 'buy' ? (book.bestAsk || 0) : (book.bestBid || 0);

      const result = analyzeSniper({
        amount: params.amount,
        side: params.side,
        levels,
        bestPrice,
      });

      return {
        symbol: params.symbol,
        side: params.side,
        amount: params.amount,
        ...result,
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
      const [ticker, book, recentBars] = await Promise.all([
        client.getTicker(params.symbol),
        client.getOrderBook(params.symbol, 20),
        client.getBars(params.symbol, '1d', undefined, 2),
      ]);
      const price = ticker.last ?? recentBars[recentBars.length - 1]?.close ?? 0;
      const dailyVol = ticker.volume ?? recentBars[recentBars.length - 1]?.volume ?? 0;
      if (dailyVol <= 0) throw new Error(`No volume data available for ${params.symbol}`);
      const spreadBps = book.spreadBps || 5;

      const comparison = compareExecutionPlans({
        totalAmount: params.total_amount,
        durationMinutes: params.duration_minutes,
        price,
        dailyVolume: dailyVol,
        spreadBps,
      });

      return {
        symbol: params.symbol,
        side: params.side,
        totalAmount: params.total_amount,
        ...comparison,
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

      const [ticker, bars] = await Promise.all([
        client.getTicker(params.symbol),
        client.getBars(params.symbol, '1d', undefined, 30),
      ]);

      const dailyVolume = ticker.volume ?? bars[bars.length - 1]?.volume ?? 0;
      if (dailyVolume <= 0) throw new Error(`No volume data available for ${params.symbol}`);
      const price = ticker.last ?? bars[bars.length - 1]?.close ?? 0;
      if (price <= 0) throw new Error(`No price data available for ${params.symbol}`);

      const closes = bars.map(b => b.close);
      const volatility = realizedVolatility(closes);

      const impact = estimateMarketImpact({
        amount: params.amount,
        dailyVolume,
        volatility,
        price,
      });

      return {
        symbol: params.symbol,
        side: params.side,
        amount: params.amount,
        currentPrice: price,
        dailyVolume,
        volatility,
        ...impact,
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

      const perVenueLiq = totalLiquidity / venueList.length;
      const allocations = venueList.map((venue: string) => {
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
      const result = calculateImplementationShortfall({
        side: params.side,
        decisionPrice: params.decision_price,
        executionPrice: params.execution_price,
        amount: params.amount,
      });

      return {
        symbol: params.symbol,
        side: params.side,
        ...result,
      };
    }),
  );
}
