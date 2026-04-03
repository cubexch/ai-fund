import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { authHandler } from './handler.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerAccountTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'get_account',
    `Get account balances on ${client.name}. Shows free, used, and total for each currency.`,
    {} as any,
    authHandler(client, async () => {
      const balances = await client.getBalance();
      return {
        exchange: client.name,
        exchangeId: client.exchangeId,
        sandbox: client.isSandbox,
        balances,
        totalAssets: balances.length,
      };
    }),
  );

  server.tool(
    'get_positions',
    `Get current positions on ${client.name}. For spot exchanges, returns non-zero balances.`,
    {
      symbols: z.string().optional().describe('Comma-separated list of symbols to filter by'),
    } as any,
    authHandler(client, async (params: any) => {
      const symbolList = params.symbols
        ? params.symbols.split(',').map((s: string) => s.trim())
        : undefined;
      return client.getPositions(symbolList);
    }),
  );

  server.tool(
    'close_position',
    `Close a position on ${client.name} by placing a market sell order for the full balance.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      percentage: z.number().default(100).describe('Percentage of position to close (1-100)'),
    } as any,
    authHandler(client, async (params: any) => {
      const balances = await client.getBalance();
      const [base] = params.symbol.split('/');
      const position = balances.find(b => b.currency === base);
      if (!position || position.free <= 0) {
        throw new Error(`No open position found for ${base}`);
      }
      const amount = position.free * (params.percentage / 100);
      const order = await client.placeOrder(params.symbol, 'market', 'sell', amount);
      return { ...order, closedPercentage: params.percentage };
    }),
  );
}
