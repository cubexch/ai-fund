import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { sanitizeError } from '../client/sanitize.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerMarketDataTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'get_tickers',
    `Get current prices for one or more symbols on ${client.name}. Returns last price, bid/ask, 24h high/low, volume, and change.`,
    {
      symbols: z.string().optional().describe('Comma-separated list of symbols (e.g., "BTC/USDT,ETH/USDT"). Omit for all available tickers.'),
    } as any,
    async (params: any) => {
      try {
        const symbolList = params.symbols
          ? params.symbols.split(',').map((s: string) => s.trim())
          : undefined;
        const tickers = await client.getTickers(symbolList);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(tickers, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_bars',
    `Get OHLCV candlestick bars for a symbol on ${client.name}. Timeframes: 1m, 5m, 15m, 1h, 4h, 1d, 1w.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT, ETH/USD)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d, 1w)'),
      since: z.string().optional().describe('Start time as ISO 8601 string or Unix timestamp in ms'),
      limit: z.number().default(100).describe('Number of candles to return (max varies by exchange)'),
    } as any,
    async (params: any) => {
      try {
        const since = params.since
          ? (isNaN(Number(params.since)) ? new Date(params.since).getTime() : Number(params.since))
          : undefined;
        const bars = await client.getBars(params.symbol, params.timeframe, since, params.limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ symbol: params.symbol, timeframe: params.timeframe, bars }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_order_book',
    `Get order book depth (bids and asks) for a symbol on ${client.name}.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      limit: z.number().default(20).describe('Number of price levels per side'),
    } as any,
    async (params: any) => {
      try {
        const ob = await client.getOrderBook(params.symbol, params.limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(ob, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_trades',
    `Get recent public trades for a symbol on ${client.name}.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      limit: z.number().default(50).describe('Number of trades to return'),
    } as any,
    async (params: any) => {
      try {
        const trades = await client.getTrades(params.symbol, undefined, params.limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ symbol: params.symbol, trades }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'search_assets',
    `Search for tradable markets on ${client.name} by symbol, base, or quote currency.`,
    {
      query: z.string().describe('Search query (e.g., "BTC", "ETH/USDT", "SOL")'),
    } as any,
    async (params: any) => {
      try {
        const markets = await client.searchMarkets(params.query);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(markets, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${sanitizeError(error)}` }],
          isError: true,
        };
      }
    },
  );
}
