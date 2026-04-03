import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import ccxt from 'ccxt';
import type { ExchangeClient } from '../client/exchange';
import type { StreamManager } from '../client/stream';
import { handler, authHandler } from './handler';

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
        const aScore = a.momentumScore ?? -Infinity;
        const bScore = b.momentumScore ?? -Infinity;
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

  // ── get_live_snapshot ─────────────────────────────────────

  server.tool(
    'get_live_snapshot',
    `Get real-time market data snapshot for a symbol on ${client.name}. Returns WebSocket-streamed order book, ticker, and trades if a stream is active, otherwise falls back to REST API (order book + quote).`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
    } as any,
    handler(async (params: any) => {
      const symbol: string = params.symbol;
      const stream = (client as any).stream as StreamManager | undefined;

      if (stream) {
        const snap = stream.getSnapshot(symbol);
        if (snap && snap.lastUpdate > 0) {
          return {
            symbol,
            source: 'websocket',
            exchange: client.name,
            staleness_ms: Date.now() - snap.lastUpdate,
            ...snap,
          };
        }
      }

      // Fallback to REST
      const [orderBook, quote] = await Promise.all([
        client.getOrderBook(symbol, 20),
        client.getQuote(symbol),
      ]);

      return {
        symbol,
        source: 'rest',
        exchange: client.name,
        orderBook: {
          bids: orderBook.bids.slice(0, 10),
          asks: orderBook.asks.slice(0, 10),
          bestBid: orderBook.bestBid,
          bestAsk: orderBook.bestAsk,
          mid: orderBook.mid,
          spread: orderBook.spread,
          spreadBps: orderBook.spreadBps,
          timestamp: orderBook.timestamp,
        },
        ticker: {
          last: quote.last,
          bid: quote.bid,
          ask: quote.ask,
          volume: undefined,
          timestamp: quote.timestamp,
        },
        trades: undefined,
        lastUpdate: Date.now(),
      };
    }),
  );

  // ── get_stream_status ─────────────────────────────────────

  server.tool(
    'get_stream_status',
    `Show active WebSocket streaming subscriptions and data freshness on ${client.name}. Lists all symbols with active streams, their channels (orderBook, ticker, trades), and how recently each was updated.`,
    {} as any,
    handler(async () => {
      const stream = (client as any).stream as StreamManager | undefined;

      if (!stream) {
        return {
          exchange: client.name,
          streaming: false,
          message: 'No WebSocket stream manager is active. Market data is served via REST API.',
          subscriptions: [],
        };
      }

      const subs = stream.getSubscriptions();
      const details = subs.map(({ symbol, channels }) => {
        const snap = stream.getSnapshot(symbol);
        return {
          symbol,
          channels,
          lastUpdate: snap?.lastUpdate ?? null,
          staleness_ms: snap?.lastUpdate ? Date.now() - snap.lastUpdate : null,
          hasOrderBook: !!snap?.orderBook,
          hasTicker: !!snap?.ticker,
          hasTrades: !!snap?.trades && snap.trades.length > 0,
          tradeCount: snap?.trades?.length ?? 0,
        };
      });

      return {
        exchange: client.name,
        exchangeId: stream.exchangeId,
        streaming: true,
        totalSubscriptions: subs.length,
        subscriptions: details,
      };
    }),
  );

  // ── get_exchange_health ──────────────────────────────────

  server.tool(
    'get_exchange_health',
    `Comprehensive health check for ${client.name}. Returns connectivity status, auth state, rate limiter capacity, datastore status, journal status, latency stats, and any detected issues.`,
    {} as any,
    handler(async () => {
      const issues: string[] = [];
      let status: 'healthy' | 'degraded' = 'healthy';

      // Latency stats
      let latencyStats: unknown[] = [];
      try {
        latencyStats = client.latency.allStats();
      } catch {
        issues.push('Failed to retrieve latency stats');
        status = 'degraded';
      }

      // Rate limiter status
      let rateLimiter: { availableTokens: number | null; pendingRequests: number | null } = {
        availableTokens: null,
        pendingRequests: null,
      };
      try {
        const limiter = (client as any).limiter;
        if (limiter) {
          rateLimiter = {
            availableTokens: limiter.available ?? null,
            pendingRequests: limiter.pending ?? null,
          };
        }
      } catch {
        // ignore
      }

      // Connectivity test: fetch a single ticker
      let connectivity: { latencyMs: number | null; status: string } = { latencyMs: null, status: 'unknown' };
      try {
        const start = performance.now();
        await client.getTicker('BTC/USDT');
        const elapsed = Math.round(performance.now() - start);
        connectivity = { latencyMs: elapsed, status: 'ok' };
      } catch (err: any) {
        connectivity = { latencyMs: null, status: 'error' };
        issues.push(`Connectivity test failed: ${err.message}`);
        status = 'degraded';
      }

      // Auth status
      const auth = {
        hasCredentials: client.hasCredentials,
        sandbox: client.isSandbox,
      };

      // Markets loaded
      const marketsLoaded = (client as any)._marketsLoaded ?? false;
      if (!marketsLoaded) {
        issues.push('Markets not yet loaded');
      }

      // Datastore status
      let datastore: { configured: boolean; totalRows: number | null } = { configured: false, totalRows: null };
      if (client.store) {
        datastore.configured = true;
        try {
          datastore.totalRows = await client.store.count();
        } catch {
          issues.push('Datastore count query failed');
          status = 'degraded';
        }
      }

      // Journal status
      const journal = {
        configured: !!(client as any).journal,
      };

      return {
        exchange: client.exchangeId,
        status,
        connectivity,
        auth,
        rateLimiter,
        datastore,
        journal,
        latencyStats,
        marketsLoaded,
        issues,
      };
    }),
  );

  // ── aggregate_order_books ─────────────────────────────────

  server.tool(
    'aggregate_order_books',
    'Aggregate order books from multiple exchanges for a symbol. Merges bids and asks, shows per-level exchange contributions, computes aggregate spread, and identifies best execution venue for buy/sell.',
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      exchanges: z.string().describe('Comma-separated exchange IDs (e.g., "coinbase,binance,kraken")'),
      depth: z.number().default(10).describe('Number of levels per side per exchange (default 10)'),
    } as any,
    handler(async (params: any) => {
      const symbol: string = params.symbol;
      const exchangeIds = params.exchanges.split(',').map((e: string) => e.trim());
      const depth: number = params.depth ?? 10;

      // Collect order books from each exchange
      const allBids: { price: number; amount: number; exchange: string }[] = [];
      const allAsks: { price: number; amount: number; exchange: string }[] = [];
      const exchangeErrors: { exchange: string; error: string }[] = [];

      for (const exId of exchangeIds) {
        try {
          const ExClass = (ccxt as any)[exId];
          if (!ExClass) {
            exchangeErrors.push({ exchange: exId, error: 'Unknown exchange' });
            continue;
          }
          const ex = new ExClass() as any;
          const book = await ex.fetchOrderBook(symbol, depth);

          for (const [price, amount] of book.bids ?? []) {
            allBids.push({ price, amount, exchange: exId });
          }
          for (const [price, amount] of book.asks ?? []) {
            allAsks.push({ price, amount, exchange: exId });
          }
        } catch (err: any) {
          exchangeErrors.push({ exchange: exId, error: err.message });
        }
      }

      // Sort bids descending by price, asks ascending by price
      allBids.sort((a, b) => b.price - a.price);
      allAsks.sort((a, b) => a.price - b.price);

      // Aggregate: merge levels at same price, track contributing exchanges
      const aggregateBook = (
        entries: { price: number; amount: number; exchange: string }[],
        limit: number,
      ) => {
        const merged: { price: number; totalAmount: number; exchanges: Record<string, number> }[] = [];
        for (const entry of entries) {
          const existing = merged.find(m => m.price === entry.price);
          if (existing) {
            existing.totalAmount += entry.amount;
            existing.exchanges[entry.exchange] = (existing.exchanges[entry.exchange] ?? 0) + entry.amount;
          } else {
            merged.push({
              price: entry.price,
              totalAmount: entry.amount,
              exchanges: { [entry.exchange]: entry.amount },
            });
          }
          if (merged.length >= limit && !merged.find(m => m.price === entry.price)) break;
        }
        return merged.slice(0, limit).map(m => ({
          price: m.price,
          totalAmount: Math.round(m.totalAmount * 100000000) / 100000000,
          exchanges: m.exchanges,
        }));
      };

      const aggregatedBids = aggregateBook(allBids, depth);
      const aggregatedAsks = aggregateBook(allAsks, depth);

      // Compute aggregate spread
      const bestBid = aggregatedBids.length > 0 ? aggregatedBids[0].price : null;
      const bestAsk = aggregatedAsks.length > 0 ? aggregatedAsks[0].price : null;
      const aggregateSpread = bestBid != null && bestAsk != null
        ? Math.round((bestAsk - bestBid) * 100) / 100
        : null;
      const aggregateMid = bestBid != null && bestAsk != null
        ? Math.round(((bestBid + bestAsk) / 2) * 100) / 100
        : null;

      // Best execution venues
      const bestBuyVenue = aggregatedAsks.length > 0
        ? Object.keys(aggregatedAsks[0].exchanges)[0]
        : null;
      const bestSellVenue = aggregatedBids.length > 0
        ? Object.keys(aggregatedBids[0].exchanges)[0]
        : null;

      // Total depth
      const totalBidDepth = Math.round(allBids.reduce((sum, b) => sum + b.amount, 0) * 100000000) / 100000000;
      const totalAskDepth = Math.round(allAsks.reduce((sum, a) => sum + a.amount, 0) * 100000000) / 100000000;

      return {
        symbol,
        exchanges: exchangeIds,
        errors: exchangeErrors.length > 0 ? exchangeErrors : undefined,
        aggregatedBids,
        aggregatedAsks,
        aggregateSpread,
        aggregateMid,
        bestBuyVenue,
        bestSellVenue,
        totalBidDepth,
        totalAskDepth,
      };
    }),
  );
}
