import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';

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
      const bidVolume = bids.reduce((sum, [, size]) => sum + size, 0);
      const askVolume = asks.reduce((sum, [, size]) => sum + size, 0);
      const totalVolume = bidVolume + askVolume;
      const imbalance = totalVolume > 0
        ? Math.round(((bidVolume - askVolume) / totalVolume) * 10000) / 10000
        : 0;

      // Depth within percentage bands of mid
      const depthAtBand = (pctBand: number) => {
        const threshold = mid * pctBand;
        let bidDepth = 0;
        let askDepth = 0;
        for (const [price, size] of bids) {
          if (price >= mid - threshold) bidDepth += size;
          else break;
        }
        for (const [price, size] of asks) {
          if (price <= mid + threshold) askDepth += size;
          else break;
        }
        return {
          bidDepth: Math.round(bidDepth * 100000000) / 100000000,
          askDepth: Math.round(askDepth * 100000000) / 100000000,
          total: Math.round((bidDepth + askDepth) * 100000000) / 100000000,
        };
      };

      const depthBands = {
        '0.1%': depthAtBand(0.001),
        '0.5%': depthAtBand(0.005),
        '1.0%': depthAtBand(0.01),
      };

      // Price impact: walk the book for 1x average depth
      const avgDepthPerSide = totalVolume > 0 ? totalVolume / 2 : 1;
      const walkBook = (book: [number, number][], size: number) => {
        let filled = 0;
        let totalCost = 0;
        for (const [price, qty] of book) {
          const fill = Math.min(qty, size - filled);
          totalCost += fill * price;
          filled += fill;
          if (filled >= size) break;
        }
        const avgPrice = filled > 0 ? totalCost / filled : mid;
        return {
          filledSize: Math.round(filled * 100000000) / 100000000,
          avgPrice: Math.round(avgPrice * 100) / 100,
          impactPct: Math.round((Math.abs(avgPrice - mid) / mid) * 1000000) / 10000,
        };
      };

      const priceImpact = {
        marketBuy: walkBook(asks, avgDepthPerSide),
        marketSell: walkBook(bids, avgDepthPerSide),
      };

      // Order book shape: ratio of cumulative depth at each level vs top level
      const bookShape = (book: [number, number][]) => {
        if (book.length === 0) return [];
        const topSize = book[0][1];
        if (topSize === 0) return [];
        return book.map(([price, size]) => ({
          price,
          size: Math.round(size * 100000000) / 100000000,
          ratioVsTop: Math.round((size / topSize) * 10000) / 10000,
        }));
      };

      const shape = {
        bids: bookShape(bids),
        asks: bookShape(asks),
      };

      // Weighted mid price: (bestBid * askTopSize + bestAsk * bidTopSize) / (bidTopSize + askTopSize)
      const bidTopSize = bids.length > 0 ? bids[0][1] : 0;
      const askTopSize = asks.length > 0 ? asks[0][1] : 0;
      const weightedMid = (bidTopSize + askTopSize) > 0
        ? Math.round(((bestBid * askTopSize + bestAsk * bidTopSize) / (bidTopSize + askTopSize)) * 100) / 100
        : mid;

      return {
        symbol,
        mid: Math.round(mid * 100) / 100,
        bestBid,
        bestAsk,
        spread: orderBook.spread,
        spreadBps: orderBook.spreadBps,
        weightedMid,
        imbalance,
        bidVolume: Math.round(bidVolume * 100000000) / 100000000,
        askVolume: Math.round(askVolume * 100000000) / 100000000,
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

            // Price changes over N bars
            const pctChange = (n: number) => {
              if (closes.length <= n) return null;
              const prev = closes[closes.length - 1 - n];
              return prev > 0 ? Math.round(((latest - prev) / prev) * 10000) / 100 : null;
            };

            const change1 = pctChange(1);
            const change5 = pctChange(5);
            const change10 = pctChange(10);
            const change20 = pctChange(20);

            // Volume surge: avg of last 5 bars vs avg of previous 20 bars
            const recentVols = volumes.slice(-5);
            const priorVols = volumes.slice(-25, -5);

            const avgRecent = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
            const avgPrior = priorVols.length > 0
              ? priorVols.reduce((a, b) => a + b, 0) / priorVols.length
              : avgRecent;

            const volumeSurge = avgPrior > 0
              ? Math.round((avgRecent / avgPrior) * 100) / 100
              : 1;

            // Momentum score: weighted combination of price change and volume surge
            // Weights: change1 (0.1), change5 (0.2), change10 (0.3), change20 (0.2), volumeSurge (0.2)
            const c1 = change1 ?? 0;
            const c5 = change5 ?? 0;
            const c10 = change10 ?? 0;
            const c20 = change20 ?? 0;
            const volScore = (volumeSurge - 1) * 100; // normalize to percentage scale

            const momentumScore = Math.round(
              (c1 * 0.1 + c5 * 0.2 + c10 * 0.3 + c20 * 0.2 + volScore * 0.2) * 100,
            ) / 100;

            results.push({
              symbol,
              price: latest,
              change1Bar: change1,
              change5Bar: change5,
              change10Bar: change10,
              change20Bar: change20,
              volumeSurge,
              momentumScore,
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
