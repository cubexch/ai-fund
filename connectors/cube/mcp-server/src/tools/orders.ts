import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OsmiumClient } from '../client/osmium.js';

export function registerOrderTools(server: McpServer, osmium: OsmiumClient) {
  server.tool(
    'place_order',
    'Place a new order on Cube Exchange. Supports LIMIT, MARKET, STOP_LOSS, and STOP_LIMIT order types. Always confirm with the user before placing live orders.',
    {
      marketId: z.number().describe('Market ID to trade on'),
      side: z.enum(['BID', 'ASK']).describe('BID (buy) or ASK (sell)'),
      price: z.string().optional().describe('Limit price (required for LIMIT orders)'),
      quantity: z.string().describe('Base asset quantity to trade'),
      orderType: z
        .enum(['LIMIT', 'MARKET_LIMIT', 'MARKET_WITH_PROTECTION', 'STOP_LOSS', 'STOP_LIMIT'])
        .default('LIMIT')
        .describe('Order type'),
      timeInForce: z
        .enum(['IOC', 'GFS', 'FOK'])
        .default('GFS')
        .describe('IOC = Immediate or Cancel, GFS = Good for Session, FOK = Fill or Kill'),
      postOnly: z.boolean().default(false).describe('If true, order will only be placed as maker'),
      stopPrice: z.string().optional().describe('Stop trigger price (for STOP_LOSS/STOP_LIMIT)'),
    },
    async params => {
      try {
        const result = await osmium.placeOrder({
          marketId: params.marketId,
          side: params.side,
          price: params.price,
          quantity: params.quantity,
          orderType: params.orderType,
          timeInForce: params.timeInForce,
          postOnly: params.postOnly,
          stopPrice: params.stopPrice,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'placed',
                  clientOrderId: result.clientOrderId,
                  exchangeOrderId: result.exchangeOrderId,
                  marketId: result.marketId,
                  side: params.side,
                  price: params.price,
                  quantity: params.quantity,
                  orderType: params.orderType,
                  transactTime: result.transactTime,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Order failed: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'cancel_order',
    'Cancel a specific resting order by its client order ID.',
    {
      marketId: z.number().describe('Market ID the order is on'),
      clientOrderId: z.string().describe('Client-assigned order ID to cancel'),
    },
    async params => {
      try {
        const result = await osmium.cancelOrder({
          marketId: params.marketId,
          clientOrderId: params.clientOrderId,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'cancelled',
                  clientOrderId: result.clientOrderId,
                  reason: result.reason,
                  quantityCanceled: result.baseQuantityCanceled,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Cancel failed: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'modify_order',
    "Modify an existing resting order's price and/or quantity.",
    {
      marketId: z.number().describe('Market ID the order is on'),
      clientOrderId: z.string().describe('Client-assigned order ID to modify'),
      newPrice: z.string().optional().describe('New price'),
      newQuantity: z.string().describe('New quantity'),
      postOnly: z.boolean().default(false).describe('If true, modified order will only rest as maker'),
    },
    async params => {
      try {
        const result = await osmium.modifyOrder({
          marketId: params.marketId,
          clientOrderId: params.clientOrderId,
          newPrice: params.newPrice,
          newQuantity: params.newQuantity,
          postOnly: params.postOnly,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'modified',
                  clientOrderId: result.clientOrderId,
                  newPrice: params.newPrice,
                  newQuantity: params.newQuantity,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Modify failed: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mass_cancel',
    'Cancel all resting orders. Optionally filter by market and/or side.',
    {
      marketId: z.number().optional().describe('Market ID to cancel on (omit for all markets)'),
      side: z.enum(['BID', 'ASK']).optional().describe('Side to cancel (omit for both sides)'),
    },
    async params => {
      try {
        const result = await osmium.massCancel({
          marketId: params.marketId,
          side: params.side,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'mass_cancelled',
                  totalAffectedOrders: result.totalAffectedOrders,
                  marketId: params.marketId ?? 'all',
                  side: params.side ?? 'both',
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Mass cancel failed: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
