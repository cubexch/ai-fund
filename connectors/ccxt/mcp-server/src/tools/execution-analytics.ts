import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler, authHandler } from './handler';
import { analyzeTradeFlow, computeExecutionQuality } from '@ai-fund/lib/execution-analytics';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerExecutionAnalyticsTools(server: McpServer, client: ExchangeClient) {

  // ── get_execution_quality ─────────────────────────────────

  server.tool(
    'get_execution_quality',
    `Analyze execution quality of recent fills for a symbol on ${client.name}. Returns VWAP, average fill price, slippage vs current mid, fill rate, and maker/taker breakdown.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
    } as any,
    authHandler(client, async (params: any) => {
      const symbol: string = params.symbol;

      // Fetch recent fills and current quote in parallel
      const [trades, quote] = await Promise.all([
        client.getMyTrades(symbol),
        client.getQuote(symbol),
      ]);

      if (trades.length === 0) {
        return { symbol, totalFills: 0, message: 'No recent fills found for this symbol.' };
      }

      // Map trades to FillEntry for the lib function
      const fills = trades.map(t => ({
        price: t.price,
        amount: t.amount,
        cost: t.cost,
        takerOrMaker: (t as any).takerOrMaker as string | undefined,
      }));

      const mid = quote.mid;
      const eq = computeExecutionQuality(fills, mid ?? undefined);

      // Compute total volume/cost for fill rate calculation
      const totalVolume = trades.reduce((sum, t) => sum + t.amount, 0);
      const totalCost = trades.reduce((sum, t) => sum + (t.cost ?? t.price * t.amount), 0);

      // Fill rate from open orders
      const openOrders = await client.getOpenOrders(symbol);
      const totalRequested = openOrders.reduce((sum, o) => sum + (o.amount ?? 0), 0) + totalVolume;
      const fillRate = totalRequested > 0
        ? Math.round((totalVolume / totalRequested) * 10000) / 100
        : 100;

      const hasMakerTaker = eq.makerCount + eq.takerCount > 0;

      return {
        symbol,
        totalFills: trades.length,
        totalVolume,
        totalCost: Math.round(totalCost * 100) / 100,
        vwap: eq.vwap,
        avgFillPrice: eq.avgFillPrice,
        currentMid: mid,
        slippageBps: eq.slippageBps,
        fillRatePct: fillRate,
        makerTaker: hasMakerTaker
          ? { maker: eq.makerCount, taker: eq.takerCount, makerPct: Math.round((eq.makerCount / trades.length) * 10000) / 100 }
          : undefined,
      };
    }),
  );

  // ── get_spread_monitor ────────────────────────────────────

  server.tool(
    'get_spread_monitor',
    `Real-time spread monitoring across multiple symbols on ${client.name}. Returns spreads sorted by spreadBps — essential for market-making venue selection. Shows which pairs have tightest/widest spreads.`,
    {
      symbols: z.string().describe('Comma-separated list of symbols (e.g., "BTC/USDT,ETH/USDT,SOL/USDT")'),
    } as any,
    handler(async (params: any) => {
      const symbolList: string[] = params.symbols.split(',').map((s: string) => s.trim());

      const quotes = await Promise.all(
        symbolList.map(async (symbol) => {
          try {
            return await client.getQuote(symbol);
          } catch (err: any) {
            return { symbol, error: err.message, bid: undefined, ask: undefined, mid: undefined, spread: undefined, spreadBps: undefined };
          }
        }),
      );

      // Sort by spreadBps ascending (tightest first), errors at the end
      const sorted = quotes.sort((a, b) => {
        const aSpread = (a as any).spreadBps ?? Number.MAX_SAFE_INTEGER;
        const bSpread = (b as any).spreadBps ?? Number.MAX_SAFE_INTEGER;
        return aSpread - bSpread;
      });

      return {
        exchange: client.name,
        timestamp: Date.now(),
        symbols: sorted,
        tightest: sorted.length > 0 && (sorted[0] as any).spreadBps != null ? sorted[0].symbol : undefined,
        widest: sorted.length > 0 && (sorted[sorted.length - 1] as any).spreadBps != null ? sorted[sorted.length - 1].symbol : undefined,
      };
    }),
  );

  // ── get_order_flow_imbalance ──────────────────────────────

  server.tool(
    'get_order_flow_imbalance',
    `Analyze recent public trades for buy/sell imbalance on ${client.name}. Computes buy vs sell volume, imbalance percentage, large trade detection, and net flow direction signal.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      limit: z.number().default(100).describe('Number of recent trades to analyze (default 100)'),
    } as any,
    handler(async (params: any) => {
      const symbol: string = params.symbol;
      const limit: number = params.limit ?? 100;

      const trades = await client.getTrades(symbol, undefined, limit);

      if (trades.length === 0) {
        return { symbol, totalTrades: 0, message: 'No recent trades found.' };
      }

      // Map exchange trades to TradeEntry for the lib function
      const tradeEntries = trades.map(t => ({
        side: t.side as 'buy' | 'sell',
        amount: t.amount,
        price: t.price,
        timestamp: t.timestamp,
      }));

      const flow = analyzeTradeFlow(tradeEntries);

      return {
        symbol,
        totalTrades: trades.length,
        buyVolume: flow.buyVolume,
        sellVolume: flow.sellVolume,
        buyCount: flow.buyCount,
        sellCount: flow.sellCount,
        buySellRatio: flow.buySellRatio,
        imbalancePct: flow.imbalancePct,
        largeTrades: {
          count: flow.largeTrades.count,
          threshold: flow.largeTrades.threshold,
          trades: flow.largeTrades.trades.map(t => ({
            side: t.side,
            price: t.price,
            amount: t.amount,
            timestamp: t.timestamp,
          })),
        },
        signal: flow.signal,
      };
    }),
  );

  // ── get_latency_stats ─────────────────────────────────────

  server.tool(
    'get_latency_stats',
    `Get API request latency statistics for ${client.name}. Shows per-method timing (avg, p50, p95, p99, min, max), error rates, and request counts. Essential for monitoring execution infrastructure health.`,
    {} as any,
    handler(async () => {
      return {
        exchange: client.exchangeId,
        stats: client.latency.allStats(),
      };
    }),
  );
}
