import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { authHandler } from './handler';

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
    authHandler(client, async (params: any) => {
      return client.placeOrder(params.symbol, params.type, params.side, params.amount, params.price);
    }),
  );

  server.tool(
    'modify_order',
    `Modify an existing order on ${client.name}. Changes price, amount, or both. Falls back to cancel+replace if exchange doesn't support native edit.`,
    {
      order_id: z.string().describe('The order ID to modify'),
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      type: z.enum(['market', 'limit']).describe('Order type'),
      amount: z.number().optional().describe('New quantity (omit to keep current)'),
      price: z.number().optional().describe('New limit price (omit to keep current)'),
    } as any,
    authHandler(client, async (params: any) => {
      return client.modifyOrder(
        params.order_id, params.symbol, params.type, params.side,
        params.amount, params.price,
      );
    }),
  );

  server.tool(
    'cancel_order',
    `Cancel an open order on ${client.name} by order ID.`,
    {
      order_id: z.string().describe('The order ID to cancel'),
      symbol: z.string().optional().describe('Trading pair (required by some exchanges)'),
    } as any,
    authHandler(client, async (params: any) => {
      await client.cancelOrder(params.order_id, params.symbol);
      return { status: 'cancelled', orderId: params.order_id };
    }),
  );

  server.tool(
    'cancel_all_orders',
    `Cancel all open orders on ${client.name}. Optionally filter by symbol.`,
    {
      symbol: z.string().optional().describe('Trading pair to cancel orders for (omit for all)'),
    } as any,
    authHandler(client, async (params: any) => {
      await client.cancelAllOrders(params.symbol);
      return { status: 'all_cancelled', symbol: params.symbol ?? 'all' };
    }),
  );

  server.tool(
    'get_orders',
    `Get orders on ${client.name}. Filter by status: open or closed.`,
    {
      status: z.enum(['open', 'closed', 'all']).default('open').describe('Order status filter'),
      symbol: z.string().optional().describe('Filter by trading pair'),
      limit: z.number().default(50).describe('Maximum number of orders to return'),
    } as any,
    authHandler(client, async (params: any) => {
      if (params.status === 'open') {
        return client.getOpenOrders(params.symbol);
      }
      if (params.status === 'closed') {
        return client.getClosedOrders(params.symbol, undefined, params.limit);
      }
      const [open, closed] = await Promise.all([
        client.getOpenOrders(params.symbol),
        client.getClosedOrders(params.symbol, undefined, params.limit),
      ]);
      return [...open, ...closed];
    }),
  );

  server.tool(
    'get_order_history',
    `Get historical closed/filled orders on ${client.name}.`,
    {
      symbol: z.string().optional().describe('Filter by trading pair'),
      limit: z.number().default(50).describe('Maximum number of orders to return'),
    } as any,
    authHandler(client, async (params: any) => {
      return client.getClosedOrders(params.symbol, undefined, params.limit);
    }),
  );

  server.tool(
    'get_fills',
    `Get trade fills (executed trades) from your ${client.name} account.`,
    {
      symbol: z.string().optional().describe('Filter by trading pair'),
      limit: z.number().default(50).describe('Maximum number of fills to return'),
    } as any,
    authHandler(client, async (params: any) => {
      return client.getMyTrades(params.symbol, undefined, params.limit);
    }),
  );
}
