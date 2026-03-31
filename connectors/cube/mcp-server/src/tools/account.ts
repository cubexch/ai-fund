import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getCredentials } from '../client/auth.js';
import type { IridiumClient } from '../client/iridium.js';

export function registerAccountTools(server: McpServer, iridium: IridiumClient) {
  const defaultSubaccountId = () => getCredentials().subaccountId;

  server.tool(
    'get_positions',
    'Get all current positions (asset holdings) for the trading subaccount. Shows total and available balances for each asset.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
    },
    async params => {
      try {
        const positions = await iridium.getPositions(params.subaccountId ?? defaultSubaccountId());
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(positions, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_balances',
    'Get asset balances for the trading subaccount. Shows total balance and available (not locked in orders) for each asset.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
    },
    async params => {
      try {
        const balances = await iridium.getBalances(params.subaccountId ?? defaultSubaccountId());
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(balances, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_order_history',
    'Get historical orders for the subaccount. Shows past orders with their status, fills, and execution details.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
      marketId: z.number().optional().describe('Filter by market ID (omit for all markets)'),
      limit: z.number().default(50).describe('Number of orders to return'),
    },
    async params => {
      try {
        const orders = await iridium.getOrderHistory(params.subaccountId ?? defaultSubaccountId(), {
          marketId: params.marketId,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(orders, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_fills',
    'Get trade fills (executed trades) for the subaccount. Shows price, quantity, fees, and timestamps for each fill.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
      marketId: z.number().optional().describe('Filter by market ID (omit for all markets)'),
      limit: z.number().default(50).describe('Number of fills to return'),
    },
    async params => {
      try {
        const fills = await iridium.getFills(params.subaccountId ?? defaultSubaccountId(), {
          marketId: params.marketId,
          limit: params.limit,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(fills, null, 2),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool('get_subaccounts', 'List all subaccounts available to this API key.', {}, async () => {
    try {
      const subaccounts = await iridium.getSubaccounts();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(subaccounts, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
        isError: true,
      };
    }
  });
}
