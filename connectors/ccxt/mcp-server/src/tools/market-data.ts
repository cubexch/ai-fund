import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { handler } from './handler.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerMarketDataTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'get_tickers',
    `Get current prices for one or more symbols on ${client.name}. Returns last price, bid/ask, 24h high/low, volume, and change.`,
    {
      symbols: z.string().optional().describe('Comma-separated list of symbols (e.g., "BTC/USDT,ETH/USDT"). Omit for all available tickers.'),
    } as any,
    handler(async (params: any) => {
      const symbolList = params.symbols
        ? params.symbols.split(',').map((s: string) => s.trim())
        : undefined;
      return client.getTickers(symbolList);
    }),
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
    handler(async (params: any) => {
      let since: number | undefined;
      if (params.since) {
        const num = Number(params.since);
        since = isNaN(num) ? new Date(params.since).getTime() : num;
        if (isNaN(since)) {
          throw new Error(`Invalid since value: "${params.since}". Use ISO 8601 (e.g., "2024-01-01T00:00:00Z") or Unix timestamp in ms.`);
        }
      }
      const bars = await client.getBars(params.symbol, params.timeframe, since, params.limit);
      return { symbol: params.symbol, timeframe: params.timeframe, bars };
    }),
  );

  server.tool(
    'get_order_book',
    `Get order book depth (bids and asks) for a symbol on ${client.name}.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      limit: z.number().default(20).describe('Number of price levels per side'),
    } as any,
    handler(async (params: any) => {
      return client.getOrderBook(params.symbol, params.limit);
    }),
  );

  server.tool(
    'get_trades',
    `Get recent public trades for a symbol on ${client.name}.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      limit: z.number().default(50).describe('Number of trades to return'),
    } as any,
    handler(async (params: any) => {
      const trades = await client.getTrades(params.symbol, undefined, params.limit);
      return { symbol: params.symbol, trades };
    }),
  );

  server.tool(
    'search_assets',
    `Search for tradable markets on ${client.name} by symbol, base, or quote currency.`,
    {
      query: z.string().describe('Search query (e.g., "BTC", "ETH/USDT", "SOL")'),
    } as any,
    handler(async (params: any) => {
      return client.searchMarkets(params.query);
    }),
  );
}
