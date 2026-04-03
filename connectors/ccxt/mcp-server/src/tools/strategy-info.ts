/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';

export function registerStrategyInfoTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'get_fees',
    `Get trading fee rates on ${client.name}. Returns maker and taker fee percentages — critical for arbitrage profitability calculations.`,
    {
      symbol: z.string().optional().describe('Trading pair to get fees for (omit for top markets)'),
    } as any,
    handler(async (params: any) => {
      return client.getTradingFees(params.symbol);
    }),
  );

  server.tool(
    'get_exchange_info',
    `Get ${client.name} exchange capabilities — supported order types, timeframes, rate limits, market count. Use to check what features are available.`,
    {} as any,
    handler(async () => {
      return client.getExchangeInfo();
    }),
  );

  server.tool(
    'get_market_info',
    `Get detailed market information for a symbol on ${client.name} — precision rules, min/max order sizes, and fee rates. Essential before placing orders to know valid amounts.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
    } as any,
    handler(async (params: any) => {
      return client.getMarketInfo(params.symbol);
    }),
  );
}
