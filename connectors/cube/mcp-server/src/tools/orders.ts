import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IridiumClient, Market } from '../client/iridium.js';

/**
 * Convert a human-readable price/quantity to lot units using market tick sizes.
 * e.g. price 83.69 with priceTickSize 0.01 → 8369
 */
function toLots(humanValue: string, tickSize: string): number {
  const hv = parseFloat(humanValue);
  const ts = parseFloat(tickSize);
  if (ts === 0) throw new Error(`Invalid tick size: ${tickSize}`);
  return Math.round(hv / ts);
}

/**
 * Convert lot units back to human-readable value.
 */
function fromLots(lots: number, tickSize: string): string {
  const ts = parseFloat(tickSize);
  return (lots * ts).toString();
}

const SIDE_MAP: Record<string, number> = { BID: 0, ASK: 1 };
const TIF_MAP: Record<string, number> = { IOC: 0, GFS: 1, FOK: 2 };
const ORDER_TYPE_MAP: Record<string, number> = {
  LIMIT: 0,
  MARKET_LIMIT: 1,
  MARKET_WITH_PROTECTION: 2,
  STOP_LOSS: 3,
  STOP_LIMIT: 4,
};

export function registerOrderTools(server: McpServer, _osmium: unknown, iridium: IridiumClient) {
  // Cache markets for lot size lookups
  let marketsCache: Market[] | null = null;
  let marketsCacheTime = 0;
  const CACHE_TTL = 300_000; // 5 minutes

  async function getMarket(marketId: number): Promise<Market> {
    const now = Date.now();
    if (!marketsCache || now - marketsCacheTime > CACHE_TTL) {
      marketsCache = await iridium.getMarkets();
      marketsCacheTime = now;
    }
    const market = marketsCache.find(m => m.marketId === marketId);
    if (!market) throw new Error(`Market ${marketId} not found`);
    return market;
  }

  server.tool(
    'place_order',
    'Place a new order on Cube Exchange. Prices and quantities are in human-readable units (e.g. price=83.69, quantity=0.0119). Supports LIMIT, MARKET, STOP_LOSS, and STOP_LIMIT order types. Always confirm with the user before placing live orders.',
    {
      marketId: z.number().describe('Market ID to trade on'),
      side: z.enum(['BID', 'ASK']).describe('BID (buy) or ASK (sell)'),
      price: z.string().optional().describe('Limit price in human-readable units (e.g. "83.69")'),
      quantity: z.string().describe('Base asset quantity in human-readable units (e.g. "0.0119")'),
      orderType: z
        .enum(['LIMIT', 'MARKET_LIMIT', 'MARKET_WITH_PROTECTION', 'STOP_LOSS', 'STOP_LIMIT'])
        .default('LIMIT')
        .describe('Order type'),
      timeInForce: z
        .enum(['IOC', 'GFS', 'FOK'])
        .default('GFS')
        .describe('IOC = Immediate or Cancel, GFS = Good for Session, FOK = Fill or Kill'),
      postOnly: z.boolean().default(false).describe('If true, order will only be placed as maker'),
      stopPrice: z.string().optional().describe('Stop trigger price in human-readable units (for STOP_LOSS/STOP_LIMIT)'),
    },
    async params => {
      try {
        const market = await getMarket(params.marketId);

        // Convert human-readable values to lot units
        const priceLots = params.price !== undefined
          ? toLots(params.price, market.priceTickSize)
          : undefined;
        const quantityLots = toLots(params.quantity, market.quantityTickSize);
        const stopPriceLots = params.stopPrice !== undefined
          ? toLots(params.stopPrice, market.priceTickSize)
          : undefined;

        const result = await iridium.placeOrderRest({
          marketId: params.marketId,
          side: SIDE_MAP[params.side],
          price: priceLots,
          quantity: quantityLots,
          orderType: ORDER_TYPE_MAP[params.orderType],
          timeInForce: TIF_MAP[params.timeInForce],
          postOnly: params.postOnly ? 1 : 0,
          cancelOnDisconnect: false,
          stopPrice: stopPriceLots,
        });

        // Convert lot values back to human-readable for the response
        const humanPrice = result.price ? fromLots(result.price, market.priceTickSize) : params.price;
        const humanQty = fromLots(result.quantity, market.quantityTickSize);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'placed',
                  clientOrderId: result.clientOrderId,
                  exchangeOrderId: result.exchangeOrderId,
                  market: market.symbol,
                  marketId: result.marketId,
                  side: params.side,
                  price: humanPrice,
                  quantity: humanQty,
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
      clientOrderId: z.number().describe('Client-assigned order ID to cancel'),
    },
    async params => {
      try {
        const result = await iridium.cancelOrderRest({
          marketId: params.marketId,
          clientOrderId: params.clientOrderId,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'cancelled', ...result as object }, null, 2),
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
    "Modify an existing resting order's price and/or quantity. Values in human-readable units.",
    {
      marketId: z.number().describe('Market ID the order is on'),
      clientOrderId: z.number().describe('Client-assigned order ID to modify'),
      newPrice: z.string().optional().describe('New price in human-readable units'),
      newQuantity: z.string().describe('New quantity in human-readable units'),
      postOnly: z.boolean().default(false).describe('If true, modified order will only rest as maker'),
    },
    async params => {
      try {
        const market = await getMarket(params.marketId);

        const result = await iridium.modifyOrderRest({
          marketId: params.marketId,
          clientOrderId: params.clientOrderId,
          newPrice: params.newPrice !== undefined
            ? toLots(params.newPrice, market.priceTickSize)
            : undefined,
          newQuantity: toLots(params.newQuantity, market.quantityTickSize),
          postOnly: params.postOnly ? 1 : 0,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'modified', ...result as object }, null, 2),
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
        const result = await iridium.massCancelRest({
          marketId: params.marketId,
          side: params.side !== undefined ? SIDE_MAP[params.side] : undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'mass_cancelled',
                  marketId: params.marketId ?? 'all',
                  side: params.side ?? 'both',
                  ...result as object,
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
