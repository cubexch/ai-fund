import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AlpacaClient } from '../client/api';
import { toolError } from '@ai-fund/lib/tool-errors';

export function registerOrderTools(server: McpServer, client: AlpacaClient) {
  server.tool(
    'place_order',
    'Place an order on Alpaca. Supports market, limit, stop, stop_limit, and trailing_stop order types.',
    {
      symbol: z.string().describe('Stock/crypto symbol (e.g., AAPL, BTC/USD)'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      type: z.enum(['market', 'limit', 'stop', 'stop_limit', 'trailing_stop']).describe('Order type'),
      qty: z.string().optional().describe('Number of shares/units (use qty or notional, not both)'),
      notional: z.string().optional().describe('Dollar amount to trade (fractional shares)'),
      time_in_force: z.enum(['day', 'gtc', 'opg', 'cls', 'ioc', 'fok']).default('day').describe('Time in force'),
      limit_price: z.string().optional().describe('Limit price (required for limit and stop_limit orders)'),
      stop_price: z.string().optional().describe('Stop price (required for stop and stop_limit orders)'),
      trail_price: z.string().optional().describe('Trail price for trailing_stop orders'),
      trail_percent: z.string().optional().describe('Trail percent for trailing_stop orders'),
    },
    async (params) => {
      try {
        const order = await client.placeOrder({
          symbol: params.symbol,
          side: params.side,
          type: params.type,
          qty: params.qty,
          notional: params.notional,
          time_in_force: params.time_in_force,
          limit_price: params.limit_price,
          stop_price: params.stop_price,
          trail_price: params.trail_price,
          trail_percent: params.trail_percent,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              orderId: order.id,
              clientOrderId: order.client_order_id,
              symbol: order.symbol,
              side: order.side,
              type: order.type,
              qty: order.qty,
              timeInForce: order.time_in_force,
              limitPrice: order.limit_price,
              stopPrice: order.stop_price,
              status: order.status,
              submittedAt: order.submitted_at,
            }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    'get_orders',
    'Get orders from Alpaca. Filter by status: open, closed, or all.',
    {
      status: z.enum(['open', 'closed', 'all']).default('open').describe('Order status filter'),
      limit: z.number().default(50).describe('Maximum number of orders to return'),
      symbols: z.string().optional().describe('Comma-separated list of symbols to filter by'),
    },
    async (params) => {
      try {
        const orders = await client.getOrders({
          status: params.status,
          limit: params.limit,
          symbols: params.symbols ? params.symbols.split(',').map(s => s.trim()) : undefined,
        });
        const formatted = orders.map(o => ({
          orderId: o.id,
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          qty: o.qty,
          filledQty: o.filled_qty,
          filledAvgPrice: o.filled_avg_price,
          limitPrice: o.limit_price,
          stopPrice: o.stop_price,
          status: o.status,
          timeInForce: o.time_in_force,
          submittedAt: o.submitted_at,
          filledAt: o.filled_at,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatted, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    'get_order',
    'Get a specific order by ID.',
    {
      order_id: z.string().describe('The order ID'),
    },
    async (params) => {
      try {
        const order = await client.getOrder(params.order_id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(order, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    'cancel_order',
    'Cancel an open order by ID.',
    {
      order_id: z.string().describe('The order ID to cancel'),
    },
    async (params) => {
      try {
        await client.cancelOrder(params.order_id);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ status: 'cancelled', orderId: params.order_id }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    'cancel_all_orders',
    'Cancel all open orders.',
    {},
    async () => {
      try {
        const results = await client.cancelAllOrders();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              cancelled: results.length,
              orders: results,
            }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    'modify_order',
    'Modify an existing open order. Can change qty, limit_price, stop_price, time_in_force, or trail.',
    {
      order_id: z.string().describe('The order ID to modify'),
      qty: z.string().optional().describe('New quantity'),
      limit_price: z.string().optional().describe('New limit price'),
      stop_price: z.string().optional().describe('New stop price'),
      time_in_force: z.string().optional().describe('New time in force'),
      trail: z.string().optional().describe('New trail value'),
    },
    async (params) => {
      try {
        const order = await client.modifyOrder(params.order_id, {
          qty: params.qty,
          limit_price: params.limit_price,
          stop_price: params.stop_price,
          time_in_force: params.time_in_force,
          trail: params.trail,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              orderId: order.id,
              symbol: order.symbol,
              side: order.side,
              type: order.type,
              qty: order.qty,
              limitPrice: order.limit_price,
              stopPrice: order.stop_price,
              status: order.status,
            }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    'get_order_history',
    'Get historical closed/filled orders. Alias for get_orders with status=closed.',
    {
      limit: z.number().default(50).describe('Maximum number of orders to return'),
      symbols: z.string().optional().describe('Comma-separated list of symbols to filter by'),
      after: z.string().optional().describe('Filter orders after this date (ISO 8601)'),
      until: z.string().optional().describe('Filter orders before this date (ISO 8601)'),
    },
    async (params) => {
      try {
        const orders = await client.getOrders({
          status: 'closed',
          limit: params.limit,
          symbols: params.symbols ? params.symbols.split(',').map(s => s.trim()) : undefined,
          after: params.after,
          until: params.until,
          direction: 'desc',
        });
        const formatted = orders.map(o => ({
          orderId: o.id,
          symbol: o.symbol,
          side: o.side,
          type: o.type,
          qty: o.qty,
          filledQty: o.filled_qty,
          filledAvgPrice: o.filled_avg_price,
          status: o.status,
          submittedAt: o.submitted_at,
          filledAt: o.filled_at,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatted, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    'get_fills',
    'Get trade fills (executed trades) from Alpaca account activities.',
    {
      symbols: z.string().optional().describe('Comma-separated list of symbols to filter by'),
      after: z.string().optional().describe('Filter after this date (ISO 8601)'),
      until: z.string().optional().describe('Filter before this date (ISO 8601)'),
      limit: z.number().default(50).describe('Maximum number of fills to return'),
    },
    async (params) => {
      try {
        const activities = await client.getActivities('FILL', {
          symbols: params.symbols ? params.symbols.split(',').map(s => s.trim()) : undefined,
          after: params.after,
          until: params.until,
          pageSize: params.limit,
        });
        const formatted = activities.map(a => ({
          id: a.id,
          orderId: a.order_id,
          symbol: a.symbol,
          side: a.side,
          qty: a.qty,
          price: a.price,
          cumQty: a.cum_qty,
          leavesQty: a.leaves_qty,
          transactionTime: a.transaction_time,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatted, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
