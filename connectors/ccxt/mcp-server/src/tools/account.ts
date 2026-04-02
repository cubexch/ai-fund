import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { sanitizeError } from '../client/sanitize.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerAccountTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'get_account',
    `Get account balances on ${client.name}. Shows free, used, and total for each currency.`,
    {} as any,
    async () => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured. Set API key and secret.' }],
            isError: true,
          };
        }
        const balances = await client.getBalance();
        const totalUsd = balances.reduce((sum, b) => sum + b.total, 0);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              exchange: client.name,
              exchangeId: client.exchangeId,
              sandbox: client.isSandbox,
              balances,
              totalAssets: balances.length,
            }, null, 2),
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
    'get_positions',
    `Get current positions on ${client.name}. For spot exchanges, returns non-zero balances.`,
    {
      symbols: z.string().optional().describe('Comma-separated list of symbols to filter by'),
    } as any,
    async (params: any) => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured.' }],
            isError: true,
          };
        }
        const symbolList = params.symbols
          ? params.symbols.split(',').map((s: string) => s.trim())
          : undefined;
        const positions = await client.getPositions(symbolList);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(positions, null, 2),
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
    'close_position',
    `Close a position on ${client.name} by placing a market sell order for the full balance.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      percentage: z.number().default(100).describe('Percentage of position to close (1-100)'),
    } as any,
    async (params: any) => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured.' }],
            isError: true,
          };
        }
        // Get current balance for the base currency
        const balances = await client.getBalance();
        const [base] = params.symbol.split('/');
        const position = balances.find(b => b.currency === base);
        if (!position || position.free <= 0) {
          return {
            content: [{ type: 'text' as const, text: `No open position found for ${base}` }],
            isError: true,
          };
        }
        const amount = position.free * (params.percentage / 100);
        const order = await client.placeOrder(params.symbol, 'market', 'sell', amount);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ...order,
              closedPercentage: params.percentage,
            }, null, 2),
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
