import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AlpacaClient } from '../client/api.js';

export function registerMarketDataTools(server: McpServer, client: AlpacaClient) {
  server.tool(
    'get_bars',
    'Get OHLCV candlestick bars for a symbol. Timeframes: 1Min, 5Min, 15Min, 1Hour, 1Day, 1Week, 1Month.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL, TSLA)'),
      timeframe: z.string().default('1Day').describe('Bar timeframe (1Min, 5Min, 15Min, 1Hour, 1Day, 1Week, 1Month)'),
      start: z.string().optional().describe('Start date/time (ISO 8601 or YYYY-MM-DD)'),
      end: z.string().optional().describe('End date/time (ISO 8601 or YYYY-MM-DD)'),
      limit: z.number().default(100).describe('Number of bars to return (max 10000)'),
    },
    async (params) => {
      try {
        const bars = await client.getBars(params.symbol, {
          timeframe: params.timeframe,
          start: params.start,
          end: params.end,
          limit: params.limit,
        });
        const formatted = bars.map(b => ({
          timestamp: b.t,
          open: b.o,
          high: b.h,
          low: b.l,
          close: b.c,
          volume: b.v,
          vwap: b.vw,
          tradeCount: b.n,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ symbol: params.symbol, bars: formatted }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_quote',
    'Get the latest quote (bid/ask) for a symbol.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL)'),
    },
    async (params) => {
      try {
        const quote = await client.getLatestQuote(params.symbol);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              symbol: params.symbol,
              bidPrice: quote.bp,
              bidSize: quote.bs,
              askPrice: quote.ap,
              askSize: quote.as,
              timestamp: quote.t,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_tickers',
    'Get current snapshots (price, quote, daily bar) for one or more symbols.',
    {
      symbols: z.string().describe('Comma-separated list of symbols (e.g., "AAPL,TSLA,MSFT")'),
    },
    async (params) => {
      try {
        const symbolList = params.symbols.split(',').map(s => s.trim());
        const snapshots = await client.getSnapshots(symbolList);
        const formatted = Object.entries(snapshots).map(([symbol, snap]) => ({
          symbol,
          lastPrice: snap.latestTrade.p,
          bidPrice: snap.latestQuote.bp,
          askPrice: snap.latestQuote.ap,
          dailyOpen: snap.dailyBar.o,
          dailyHigh: snap.dailyBar.h,
          dailyLow: snap.dailyBar.l,
          dailyClose: snap.dailyBar.c,
          dailyVolume: snap.dailyBar.v,
          prevClose: snap.prevDailyBar.c,
          changeFromPrevClose: snap.latestTrade.p - snap.prevDailyBar.c,
          changePct: `${(((snap.latestTrade.p - snap.prevDailyBar.c) / snap.prevDailyBar.c) * 100).toFixed(2)}%`,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatted, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'search_assets',
    'Search for tradable assets on Alpaca by symbol or name.',
    {
      query: z.string().describe('Search query (symbol or partial name)'),
      asset_class: z.enum(['us_equity', 'crypto']).optional().describe('Filter by asset class'),
    },
    async (params) => {
      try {
        const assets = await client.getAssets({
          status: 'active',
          asset_class: params.asset_class,
        });
        const query = params.query.toLowerCase();
        const matches = assets
          .filter(a =>
            a.tradable &&
            (a.symbol.toLowerCase().includes(query) ||
             a.name.toLowerCase().includes(query))
          )
          .slice(0, 20)
          .map(a => ({
            symbol: a.symbol,
            name: a.name,
            exchange: a.exchange,
            class: a.class,
            tradable: a.tradable,
            fractionable: a.fractionable,
            shortable: a.shortable,
          }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(matches, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_trades',
    'Get recent trades for a symbol from the market data feed.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL)'),
      start: z.string().optional().describe('Start date/time (ISO 8601)'),
      end: z.string().optional().describe('End date/time (ISO 8601)'),
      limit: z.number().default(100).describe('Number of trades to return'),
    },
    async (params) => {
      try {
        const trades = await client.getTrades(params.symbol, {
          start: params.start,
          end: params.end,
          limit: params.limit,
        });
        const formatted = trades.map(t => ({
          timestamp: t.t,
          price: t.p,
          size: t.s,
          exchange: t.x,
          conditions: t.c,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ symbol: params.symbol, trades: formatted }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    },
  );
}
