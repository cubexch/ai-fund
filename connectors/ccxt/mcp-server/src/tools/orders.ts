import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerOrderTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'place_order',
    `Place an order on ${client.name}. Supports market and limit order types.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT, ETH/USD)'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      type: z.enum(['market', 'limit']).describe('Order type'),
      amount: z.number().describe('Quantity to buy or sell in base currency'),
      price: z.number().optional().describe('Limit price (required for limit orders)'),
    } as any,
    async (params: any) => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured. Set API key and secret to trade.' }],
            isError: true,
          };
        }
        const order = await client.placeOrder(
          params.symbol,
          params.type,
          params.side,
          params.amount,
          params.price,
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(order, null, 2),
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
    'cancel_order',
    `Cancel an open order on ${client.name} by order ID.`,
    {
      order_id: z.string().describe('The order ID to cancel'),
      symbol: z.string().optional().describe('Trading pair (required by some exchanges)'),
    } as any,
    async (params: any) => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured.' }],
            isError: true,
          };
        }
        await client.cancelOrder(params.order_id, params.symbol);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: 'cancelled', orderId: params.order_id }, null, 2),
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
    'cancel_all_orders',
    `Cancel all open orders on ${client.name}. Optionally filter by symbol.`,
    {
      symbol: z.string().optional().describe('Trading pair to cancel orders for (omit for all)'),
    } as any,
    async (params: any) => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured.' }],
            isError: true,
          };
        }
        await client.cancelAllOrders(params.symbol);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: 'all_cancelled', symbol: params.symbol ?? 'all' }, null, 2),
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
    'get_orders',
    `Get orders on ${client.name}. Filter by status: open or closed.`,
    {
      status: z.enum(['open', 'closed', 'all']).default('open').describe('Order status filter'),
      symbol: z.string().optional().describe('Filter by trading pair'),
      limit: z.number().default(50).describe('Maximum number of orders to return'),
    } as any,
    async (params: any) => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured.' }],
            isError: true,
          };
        }
        let orders;
        if (params.status === 'open') {
          orders = await client.getOpenOrders(params.symbol);
        } else if (params.status === 'closed') {
          orders = await client.getClosedOrders(params.symbol, undefined, params.limit);
        } else {
          const [open, closed] = await Promise.all([
            client.getOpenOrders(params.symbol),
            client.getClosedOrders(params.symbol, undefined, params.limit),
          ]);
          orders = [...open, ...closed];
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(orders, null, 2),
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
    'get_order_history',
    `Get historical closed/filled orders on ${client.name}.`,
    {
      symbol: z.string().optional().describe('Filter by trading pair'),
      limit: z.number().default(50).describe('Maximum number of orders to return'),
    } as any,
    async (params: any) => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured.' }],
            isError: true,
          };
        }
        const orders = await client.getClosedOrders(params.symbol, undefined, params.limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(orders, null, 2),
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
    'get_fills',
    `Get trade fills (executed trades) from your ${client.name} account.`,
    {
      symbol: z.string().optional().describe('Filter by trading pair'),
      limit: z.number().default(50).describe('Maximum number of fills to return'),
    } as any,
    async (params: any) => {
      try {
        if (!client.hasCredentials) {
          return {
            content: [{ type: 'text' as const, text: 'Failed: No API credentials configured.' }],
            isError: true,
          };
        }
        const trades = await client.getMyTrades(params.symbol, undefined, params.limit);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(trades, null, 2),
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
