import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IridiumClient } from '../client/iridium';
import type { OHLCV } from '@ai-fund/lib/indicators';
import { detectConfluence, detectBbSqueeze } from '@ai-fund/lib/confluence-detector';
import {
  assessPortfolioRisk,
  simulateStressTest,
  STRESS_SCENARIOS,
  type BalanceEntry,
  type TickerEntry,
} from '@ai-fund/lib/portfolio-analytics';
import {
  planTwap,
  estimateMarketImpact,
  realizedVolatility,
} from '@ai-fund/lib/execution-planner';
import {
  simulateOrderBookFill,
  analyzeDepthAtBands,
  computeOrderBookImbalance,
  analyzeOrderBookShape,
  computeWeightedMid,
} from '@ai-fund/lib/execution-analytics';
import { returns } from '@ai-fund/lib/math';

export function registerAnalysisTools(server: McpServer, iridium: IridiumClient) {
  const defaultSubaccountId = () => iridium.getDefaultSubaccountId();

  // ── Helper: fetch candles and convert to OHLCV ────────────

  async function fetchOhlcv(
    marketId: number,
    interval: string,
    limit: number,
  ): Promise<OHLCV[]> {
    const candles = await iridium.getPriceHistory(marketId, interval, limit);
    // Cube returns newest-first; reverse to chronological order
    const sorted = [...candles].reverse();
    return sorted.map(k => ({
      open: parseFloat(k.open),
      high: parseFloat(k.high),
      low: parseFloat(k.low),
      close: parseFloat(k.close),
      volume: parseFloat(k.volume),
      timestamp: k.startTime,
    }));
  }

  // ── 1. detect_confluence ──────────────────────────────────

  server.tool(
    'detect_confluence',
    'Multi-timeframe confluence detection. Analyzes RSI, MACD, SMA trend, Bollinger Bands, and EMA across multiple timeframes to produce a directional score.',
    {
      marketId: z.number().describe('Market ID to analyze'),
      timeframes: z
        .array(z.enum(['1m', '15m', '1h', '4h', '1d']))
        .default(['15m', '1h', '4h'])
        .describe('Timeframes to analyze (each fetches 200 bars)'),
    },
    async params => {
      try {
        const barsPerTimeframe: Record<string, OHLCV[]> = {};

        // Fetch bars for each timeframe in parallel
        const fetches = params.timeframes.map(async tf => {
          const ohlcv = await fetchOhlcv(params.marketId, tf, 200);
          if (ohlcv.length < 51) {
            throw new Error(`Insufficient data for ${tf}: only ${ohlcv.length} bars (need 51+)`);
          }
          barsPerTimeframe[tf] = ohlcv;
        });
        await Promise.all(fetches);

        const result = detectConfluence(barsPerTimeframe);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ marketId: params.marketId, ...result }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── 2. detect_bb_squeeze ──────────────────────────────────

  server.tool(
    'detect_bb_squeeze',
    'Detect Bollinger Band squeeze (low volatility compression that precedes breakouts). Returns squeeze status, duration, and directional bias.',
    {
      marketId: z.number().describe('Market ID to analyze'),
      interval: z.enum(['1m', '15m', '1h', '4h', '1d']).default('1h').describe('Candlestick interval'),
      limit: z.number().default(200).describe('Number of candles to fetch'),
      period: z.number().default(20).describe('Bollinger Band period'),
      squeezeThreshold: z.number().default(0.5).describe('Squeeze if bandwidth < threshold * avg bandwidth'),
    },
    async params => {
      try {
        const ohlcv = await fetchOhlcv(params.marketId, params.interval, params.limit);
        const closes = ohlcv.map(c => c.close);

        if (closes.length < params.period + 1) {
          return {
            content: [{
              type: 'text' as const,
              text: `Insufficient data: only ${closes.length} candles (need at least ${params.period + 1}).`,
            }],
            isError: true,
          };
        }

        const result = detectBbSqueeze(closes, params.period, params.squeezeThreshold);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              { marketId: params.marketId, interval: params.interval, ...result },
              null,
              2
            ),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── 3. assess_portfolio_risk ──────────────────────────────

  server.tool(
    'assess_portfolio_risk',
    'Assess portfolio risk: VaR, volatility, Sharpe, Sortino, max drawdown, and cross-asset correlations for all holdings.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
      interval: z.enum(['1h', '4h', '1d']).default('1d').describe('Candle interval for return calculation'),
      limit: z.number().default(100).describe('Number of candles per asset'),
      confidence: z.number().default(0.95).describe('VaR confidence level (e.g. 0.95 = 95%)'),
    },
    async params => {
      try {
        const subId = params.subaccountId ?? await defaultSubaccountId();
        const [positionGroups, tickers, registry, markets] = await Promise.all([
          iridium.getPositions(subId),
          iridium.getTickers(),
          iridium.getAssetRegistry(),
          iridium.getMarkets(),
        ]);

        const tickerMap = new Map(tickers.map(t => [t.symbol, t]));
        const marketMap = new Map(markets.map(m => [m.symbol, m]));

        // Build portfolio: resolve positions to symbols with USD values
        const holdings: { symbol: string; value: number; marketId: number }[] = [];
        for (const [, group] of Object.entries(positionGroups)) {
          for (const entry of group.inner) {
            const amt = parseFloat(entry.amount);
            if (amt <= 0) continue;
            const asset = registry.getById(entry.assetId);
            const symbol = asset?.symbol ?? `ASSET-${entry.assetId}`;
            if (['USDC', 'USDT'].includes(symbol)) continue; // skip stablecoins
            const ticker = tickerMap.get(`${symbol}USDC`);
            const price = ticker?.lastPrice ?? 0;
            if (price === 0) continue;
            const market = marketMap.get(`${symbol}USDC`);
            if (!market) continue;
            holdings.push({ symbol, value: amt * price, marketId: market.marketId });
          }
        }

        if (holdings.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No non-stablecoin holdings with price data found.',
            }],
            isError: true,
          };
        }

        const totalValue = holdings.reduce((sum, h) => sum + h.value, 0);
        const weights = holdings.map(h => h.value / totalValue);

        // Fetch historical data for each holding in parallel
        const symbolData: Record<string, number[]> = {};
        const fetches = holdings.map(async h => {
          const ohlcv = await fetchOhlcv(h.marketId, params.interval, params.limit);
          symbolData[h.symbol] = ohlcv.map(c => c.close);
        });
        await Promise.all(fetches);

        const result = assessPortfolioRisk(symbolData, weights, totalValue, params.confidence);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── 4. simulate_stress_test ───────────────────────────────

  server.tool(
    'simulate_stress_test',
    'Stress test the portfolio under historical crash scenarios (BTC crash 2022, Luna collapse, FTX contagion, flash crash) or custom shocks.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
      scenario: z
        .enum(['btc_crash_2022', 'luna_collapse', 'ftx_contagion', 'flash_crash', 'custom'])
        .default('btc_crash_2022')
        .describe('Stress scenario to simulate'),
      customChanges: z
        .record(z.string(), z.number())
        .optional()
        .describe('Custom scenario: map of asset symbol → percentage change (e.g. {"BTC": -0.3, "ETH": -0.4, "default": -0.2})'),
      maxDrawdownPct: z.number().default(30).describe('Max drawdown threshold for survivability check (%)'),
    },
    async params => {
      try {
        const subId = params.subaccountId ?? await defaultSubaccountId();
        const [positionGroups, tickers, registry] = await Promise.all([
          iridium.getPositions(subId),
          iridium.getTickers(),
          iridium.getAssetRegistry(),
        ]);

        const tickerMap = new Map(tickers.map(t => [t.symbol, t]));

        // Build balances and tickers in the format expected by the shared lib
        const balances: BalanceEntry[] = [];
        for (const [, group] of Object.entries(positionGroups)) {
          for (const entry of group.inner) {
            const amt = parseFloat(entry.amount);
            if (amt <= 0) continue;
            const asset = registry.getById(entry.assetId);
            const symbol = asset?.symbol ?? `ASSET-${entry.assetId}`;
            balances.push({ currency: symbol, total: amt, free: amt, used: 0 });
          }
        }

        // Convert Cube tickers to generic TickerEntry format
        // The shared lib expects {symbol: "BTC/USDT", last: number}
        const genericTickers: TickerEntry[] = tickers.map(t => ({
          symbol: `${t.baseAsset}/USDT`,
          last: t.lastPrice ?? undefined,
        }));

        const changes = params.scenario === 'custom'
          ? (params.customChanges ?? { default: -0.2 })
          : STRESS_SCENARIOS[params.scenario];

        const result = simulateStressTest(balances, genericTickers, changes, params.maxDrawdownPct);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ scenario: params.scenario, ...result }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── 5. plan_twap ──────────────────────────────────────────

  server.tool(
    'plan_twap',
    'Plan a TWAP (Time-Weighted Average Price) execution. Splits a large order into equal slices over a time window to minimize market impact.',
    {
      marketId: z.number().describe('Market ID for the asset'),
      totalAmount: z.number().describe('Total quantity to execute (in base asset)'),
      durationMinutes: z.number().default(60).describe('Execution window in minutes'),
      numSlices: z.number().default(10).describe('Number of order slices'),
    },
    async params => {
      try {
        const [tickers, ohlcv] = await Promise.all([
          iridium.getTickers(),
          fetchOhlcv(params.marketId, '1d', 30),
        ]);

        // Find ticker for this market
        const markets = await iridium.getMarkets();
        const market = markets.find(m => m.marketId === params.marketId);
        if (!market) {
          return {
            content: [{ type: 'text' as const, text: `Unknown marketId: ${params.marketId}` }],
            isError: true,
          };
        }

        const ticker = tickers.find(t => t.symbol === market.symbol);
        const currentPrice = ticker?.lastPrice ?? 0;
        if (currentPrice === 0) {
          return {
            content: [{ type: 'text' as const, text: `No price data for ${market.symbol}` }],
            isError: true,
          };
        }

        const dailyVolume = ohlcv.length > 0
          ? ohlcv.reduce((sum, c) => sum + c.volume, 0) / ohlcv.length
          : 0;

        const result = planTwap({
          totalAmount: params.totalAmount,
          durationMinutes: params.durationMinutes,
          numSlices: params.numSlices,
          currentPrice,
          dailyVolume: dailyVolume || 1, // avoid division by zero
          nowMs: Date.now(),
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              {
                market: market.symbol,
                dailyVolume: dailyVolume.toFixed(2),
                participationRate: dailyVolume > 0
                  ? `${((params.totalAmount / dailyVolume) * 100).toFixed(2)}%`
                  : 'N/A',
                ...result,
              },
              null,
              2
            ),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── 6. simulate_market_impact ─────────────────────────────

  server.tool(
    'simulate_market_impact',
    'Estimate market impact of a large order using the Almgren-Chriss model. Returns temporary/permanent impact in bps and estimated cost. Accepts a symbol (e.g. "SOL", "BTC") — resolves the market automatically.',
    {
      symbol: z.string().describe('Base asset symbol (e.g. "SOL", "BTC", "ETH")'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      amount: z.number().describe('Order quantity in base asset units'),
      interval: z.enum(['1h', '4h', '1d']).default('1d').describe('Interval for volatility estimation'),
    },
    async params => {
      try {
        const markets = await iridium.getMarkets();
        const upper = params.symbol.toUpperCase();
        const market = markets.find(m => m.symbol.toUpperCase().startsWith(upper));
        if (!market) {
          return {
            content: [{ type: 'text' as const, text: `No market found for "${params.symbol}". Use get_assets to list available markets.` }],
            isError: true,
          };
        }

        const [tickers, ohlcv] = await Promise.all([
          iridium.getTickers(),
          fetchOhlcv(market.marketId, params.interval, 60),
        ]);

        const ticker = tickers.find(t => t.symbol === market.symbol);
        const price = ticker?.lastPrice ?? 0;
        if (price === 0) {
          return {
            content: [{ type: 'text' as const, text: `No price data for ${market.symbol}` }],
            isError: true,
          };
        }

        const closes = ohlcv.map(c => c.close);
        const volatility = realizedVolatility(closes);
        const dailyVolume = ohlcv.length > 0
          ? ohlcv.reduce((sum, c) => sum + c.volume, 0) / ohlcv.length
          : 1;

        const result = estimateMarketImpact({
          amount: params.amount,
          dailyVolume,
          volatility,
          price,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              {
                market: market.symbol,
                side: params.side,
                amount: params.amount,
                price,
                dailyVolume: dailyVolume.toFixed(2),
                realizedVolatility: (volatility * 100).toFixed(2) + '%',
                ...result,
              },
              null,
              2
            ),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── 7. get_market_microstructure ──────────────────────────

  server.tool(
    'get_market_microstructure',
    'Analyze order book microstructure: depth at multiple bands, bid-ask imbalance, weighted mid price, book shape, and fill simulation.',
    {
      symbol: z.string().describe('Market symbol, e.g. "BTCUSDC", "ETHUSDC", "SOLUSDC"'),
      simulateAmount: z.number().optional().describe('Optional: simulate filling this amount against the book (in base asset)'),
      simulateSide: z.enum(['buy', 'sell']).default('buy').describe('Side for fill simulation'),
    },
    async params => {
      try {
        const book = await iridium.getOrderBook(params.symbol);

        if (book.bids.length === 0 && book.asks.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `Empty order book for ${params.symbol}` }],
            isError: true,
          };
        }

        const bestBid = book.bids.length > 0 ? book.bids[0][0] : 0;
        const bestAsk = book.asks.length > 0 ? book.asks[0][0] : 0;
        const mid = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;
        const spreadBps = mid > 0 ? (spread / mid) * 10000 : 0;

        // Weighted mid price
        const bidTopSize = book.bids.length > 0 ? book.bids[0][1] : 0;
        const askTopSize = book.asks.length > 0 ? book.asks[0][1] : 0;
        const weightedMid = computeWeightedMid(bestBid, bestAsk, bidTopSize, askTopSize);

        // Depth at bands
        const depthBands = analyzeDepthAtBands(
          book.bids, book.asks, mid,
          [0.001, 0.005, 0.01, 0.02, 0.05]
        );

        // Order book imbalance
        const imbalance = computeOrderBookImbalance(book.bids, book.asks);

        // Book shape (top 10 levels each side)
        const bidShape = analyzeOrderBookShape(book.bids.slice(0, 10));
        const askShape = analyzeOrderBookShape(book.asks.slice(0, 10));

        const result: Record<string, unknown> = {
          symbol: params.symbol,
          bestBid,
          bestAsk,
          mid: Math.round(mid * 100) / 100,
          spread: Math.round(spread * 100) / 100,
          spreadBps: Math.round(spreadBps * 100) / 100,
          weightedMid,
          depthBands,
          imbalance,
          bidLevels: book.bids.length,
          askLevels: book.asks.length,
          bidShape,
          askShape,
        };

        // Fill simulation
        if (params.simulateAmount) {
          const levels = params.simulateSide === 'buy' ? book.asks : book.bids;
          const sim = simulateOrderBookFill(levels, params.simulateAmount, mid);
          result.fillSimulation = {
            side: params.simulateSide,
            amount: params.simulateAmount,
            ...sim,
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
