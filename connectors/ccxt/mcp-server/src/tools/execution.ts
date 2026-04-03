import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import ccxt from 'ccxt';
import type { ExchangeClient } from '../client/exchange.js';
import { handler, authHandler } from './handler.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerExecutionTools(server: McpServer, client: ExchangeClient) {

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

      let totalVolume = 0;
      let totalCost = 0;
      let makerCount = 0;
      let takerCount = 0;

      for (const t of trades) {
        totalVolume += t.amount;
        totalCost += t.cost ?? t.price * t.amount;
        // takerOrMaker may be present on raw trades
        const tom = (t as any).takerOrMaker;
        if (tom === 'maker') makerCount++;
        else if (tom === 'taker') takerCount++;
      }

      const vwap = totalCost / totalVolume;
      const avgFillPrice = trades.reduce((sum, t) => sum + t.price, 0) / trades.length;

      // Slippage vs current mid price
      const mid = quote.mid;
      const slippageBps = mid != null && mid > 0
        ? Math.round(((vwap - mid) / mid) * 10000 * 100) / 100
        : undefined;

      // Fill rate from open orders
      const openOrders = await client.getOpenOrders(symbol);
      const totalRequested = openOrders.reduce((sum, o) => sum + (o.amount ?? 0), 0) + totalVolume;
      const fillRate = totalRequested > 0
        ? Math.round((totalVolume / totalRequested) * 10000) / 100
        : 100;

      const hasMakerTaker = makerCount + takerCount > 0;

      return {
        symbol,
        totalFills: trades.length,
        totalVolume,
        totalCost: Math.round(totalCost * 100) / 100,
        vwap: Math.round(vwap * 100) / 100,
        avgFillPrice: Math.round(avgFillPrice * 100) / 100,
        currentMid: mid,
        slippageBps,
        fillRatePct: fillRate,
        makerTaker: hasMakerTaker
          ? { maker: makerCount, taker: takerCount, makerPct: Math.round((makerCount / trades.length) * 10000) / 100 }
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
        const aSpread = (a as any).spreadBps ?? Infinity;
        const bSpread = (b as any).spreadBps ?? Infinity;
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
      const avgSize = totalSize / trades.length;
      const largeTrades = trades.filter(t => t.amount > avgSize * 2);

      const buySellRatio = sellVolume > 0
        ? Math.round((buyVolume / sellVolume) * 100) / 100
        : buyVolume > 0 ? Infinity : 0;

      const imbalancePct = totalVolume > 0
        ? Math.round(((buyVolume - sellVolume) / totalVolume) * 10000) / 100
        : 0;

      let signal: string;
      if (imbalancePct > 20) signal = 'strong_buy_pressure';
      else if (imbalancePct > 5) signal = 'moderate_buy_pressure';
      else if (imbalancePct < -20) signal = 'strong_sell_pressure';
      else if (imbalancePct < -5) signal = 'moderate_sell_pressure';
      else signal = 'neutral';

      return {
        symbol,
        totalTrades: trades.length,
        buyVolume: Math.round(buyVolume * 10000) / 10000,
        sellVolume: Math.round(sellVolume * 10000) / 10000,
        buyCount,
        sellCount,
        buySellRatio,
        imbalancePct,
        largeTrades: {
          count: largeTrades.length,
          threshold: Math.round(avgSize * 2 * 10000) / 10000,
          trades: largeTrades.map(t => ({
            side: t.side,
            price: t.price,
            amount: t.amount,
            timestamp: t.timestamp,
          })),
        },
        signal,
      };
    }),
  );

  // ── detect_arbitrage_opportunity ──────────────────────────

  server.tool(
    'detect_arbitrage_opportunity',
    'Detect cross-exchange arbitrage opportunities by comparing bid/ask prices for a symbol across multiple exchanges. Returns per-venue quotes, best bid/ask venues, spread, estimated profit after fees, and whether the opportunity is actionable.',
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      exchanges: z.string().describe('Comma-separated exchange IDs (e.g., "coinbase,binance,kraken")'),
    } as any,
    handler(async (params: any) => {
      const symbol: string = params.symbol;
      const exchangeIds = params.exchanges.split(',').map((e: string) => e.trim());
      const quotes: any[] = [];

      for (const exId of exchangeIds) {
        try {
          const ExClass = (ccxt as any)[exId];
          if (!ExClass) {
            quotes.push({ exchange: exId, error: 'Unknown exchange' });
            continue;
          }
          const ex = new ExClass() as any;
          const ticker = await ex.fetchTicker(symbol);
          quotes.push({
            exchange: exId,
            bid: ticker.bid,
            ask: ticker.ask,
            last: ticker.last,
            volume: ticker.baseVolume,
            timestamp: ticker.timestamp,
          });
        } catch (err: any) {
          quotes.push({ exchange: exId, error: err.message });
        }
      }

      // Find best bid (sell venue) and best ask (buy venue)
      const valid = quotes.filter(q => q.bid != null && q.ask != null);

      if (valid.length < 2) {
        return {
          symbol,
          quotes,
          arbitrage: null,
          message: 'Need at least 2 exchanges with valid quotes to detect arbitrage.',
        };
      }

      const bestBidQuote = valid.reduce((best, q) => q.bid > best.bid ? q : best, valid[0]);
      const bestAskQuote = valid.reduce((best, q) => q.ask < best.ask ? q : best, valid[0]);

      const grossSpread = bestBidQuote.bid - bestAskQuote.ask;
      const grossSpreadPct = (grossSpread / bestAskQuote.ask) * 100;

      // Assume 0.1% fee each side (buy + sell)
      const feeRate = 0.001;
      const buyCost = bestAskQuote.ask * (1 + feeRate);
      const sellProceeds = bestBidQuote.bid * (1 - feeRate);
      const netProfit = sellProceeds - buyCost;
      const netProfitPct = (netProfit / buyCost) * 100;

      const actionable = netProfit > 0;

      return {
        symbol,
        quotes,
        arbitrage: {
          bestBidVenue: bestBidQuote.exchange,
          bestBidPrice: bestBidQuote.bid,
          bestAskVenue: bestAskQuote.exchange,
          bestAskPrice: bestAskQuote.ask,
          grossSpread: Math.round(grossSpread * 100) / 100,
          grossSpreadPct: Math.round(grossSpreadPct * 10000) / 10000,
          feeRatePerSide: feeRate,
          netProfitPerUnit: Math.round(netProfit * 100) / 100,
          netProfitPct: Math.round(netProfitPct * 10000) / 10000,
          actionable,
        },
      };
    }),
  );
}
