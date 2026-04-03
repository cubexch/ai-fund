import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import {
  simulateOrderBookFill,
  analyzeDepthAtBands,
  computeOrderBookImbalance,
  analyzeOrderBookShape,
  computeWeightedMid,
  computeMomentumScore,
} from '@ai-fund/lib/execution-analytics';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerExecutionMicrostructureTools(server: McpServer, client: ExchangeClient) {

  // ── get_market_microstructure ─────────────────────────────

  server.tool(
    'get_market_microstructure',
    `Analyze order book depth microstructure for a symbol on ${client.name}. Returns bid-ask imbalance, depth at multiple price levels, price impact estimates, order book shape, and weighted mid price — the analytics a Citadel market maker uses.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      depth: z.number().default(20).describe('Order book depth (number of levels per side, default 20)'),
    } as any,
    handler(async (params: any) => {
      const symbol: string = params.symbol;
      const depth: number = params.depth ?? 20;

      const orderBook = await client.getOrderBook(symbol, depth);

      const mid = orderBook.mid;
      if (mid == null || mid === 0) {
        throw new Error(`Cannot determine mid price for ${symbol} — order book may be empty`);
      }

      const bestBid = orderBook.bestBid ?? mid;
      const bestAsk = orderBook.bestAsk ?? mid;
      const bids = orderBook.bids;
      const asks = orderBook.asks;

      // Bid-ask imbalance
      const { bidVolume, askVolume, imbalance } = computeOrderBookImbalance(bids, asks);

      // Depth within percentage bands of mid
      const depthBands = analyzeDepthAtBands(bids, asks, mid, [0.001, 0.005, 0.01]);

      // Price impact: walk the book for 1x average depth
      const totalVolume = bidVolume + askVolume;
      const avgDepthPerSide = totalVolume > 0 ? totalVolume / 2 : 1;
      const buyFill = simulateOrderBookFill(asks, avgDepthPerSide, mid);
      const sellFill = simulateOrderBookFill(bids, avgDepthPerSide, mid);

      const priceImpact = {
        marketBuy: {
          filledSize: buyFill.filled,
          avgPrice: buyFill.avgFillPrice,
          impactPct: Math.round(buyFill.slippagePct * 10000 * 100) / 10000,
        },
        marketSell: {
          filledSize: sellFill.filled,
          avgPrice: sellFill.avgFillPrice,
          impactPct: Math.round(sellFill.slippagePct * 10000 * 100) / 10000,
        },
      };

      // Order book shape: ratio of cumulative depth at each level vs top level
      const shape = {
        bids: analyzeOrderBookShape(bids),
        asks: analyzeOrderBookShape(asks),
      };

      // Weighted mid price
      const bidTopSize = bids.length > 0 ? bids[0][1] : 0;
      const askTopSize = asks.length > 0 ? asks[0][1] : 0;
      const weightedMid = computeWeightedMid(bestBid, bestAsk, bidTopSize, askTopSize);

      return {
        symbol,
        mid: Math.round(mid * 100) / 100,
        bestBid,
        bestAsk,
        spread: orderBook.spread,
        spreadBps: orderBook.spreadBps,
        weightedMid,
        imbalance,
        bidVolume,
        askVolume,
        depthBands,
        priceImpact,
        shape,
      };
    }),
  );

  // ── get_momentum_scanner ──────────────────────────────────

  server.tool(
    'get_momentum_scanner',
    `Scan multiple symbols on ${client.name} for momentum signals. Computes price change over 1/5/10/20 bars, volume surge ratio, and a composite momentum score. Returns symbols sorted by momentum strength (strongest first).`,
    {
      symbols: z.string().describe('Comma-separated list of symbols (e.g., "BTC/USDT,ETH/USDT,SOL/USDT")'),
      timeframe: z.string().default('1h').describe('Candle timeframe (default 1h)'),
    } as any,
    handler(async (params: any) => {
      const symbolList: string[] = params.symbols.split(',').map((s: string) => s.trim());
      const timeframe: string = params.timeframe ?? '1h';

      const results: any[] = [];

      await Promise.all(
        symbolList.map(async (symbol) => {
          try {
            const bars = await client.getBars(symbol, timeframe, undefined, 50);

            if (bars.length < 21) {
              results.push({ symbol, error: `Insufficient data: ${bars.length} bars (need 21+)` });
              return;
            }

            const closes = bars.map(b => b.close);
            const volumes = bars.map(b => b.volume);
            const latest = closes[closes.length - 1];

            const momentum = computeMomentumScore(closes, volumes);

            results.push({
              symbol,
              price: latest,
              change1Bar: momentum.change1Bar,
              change5Bar: momentum.change5Bar,
              change10Bar: momentum.change10Bar,
              change20Bar: momentum.change20Bar,
              volumeSurge: momentum.volumeSurge,
              momentumScore: momentum.momentumScore,
            });
          } catch (err: any) {
            results.push({ symbol, error: err.message });
          }
        }),
      );

      // Sort by momentum score descending (strongest first), errors at end
      results.sort((a, b) => {
        const aScore = a.momentumScore ?? -Number.MAX_SAFE_INTEGER;
        const bScore = b.momentumScore ?? -Number.MAX_SAFE_INTEGER;
        return bScore - aScore;
      });

      return {
        exchange: client.name,
        timeframe,
        timestamp: Date.now(),
        symbols: results,
      };
    }),
  );
}
