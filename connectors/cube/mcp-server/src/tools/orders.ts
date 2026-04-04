import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IridiumClient, Market } from '../client/iridium';
import type { OsmiumClient } from '../client/osmium';
import { toolError } from '@ai-fund/lib/tool-errors';

/**
 * Convert a human-readable price/quantity to lot units using market tick sizes.
 * e.g. price 83.69 with priceTickSize 0.01 → 8369
 */
export function toLots(humanValue: string, tickSize: string): number {
  const hv = parseFloat(humanValue);
  const ts = parseFloat(tickSize);
  if (ts === 0) throw new Error(`Invalid tick size: ${tickSize}`);
  return Math.round(hv / ts);
}

/**
 * Convert lot units back to human-readable value.
 */
export function fromLots(lots: number, tickSize: string): string {
  const ts = parseFloat(tickSize);
  return (lots * ts).toString();
}

export const SIDE_MAP: Record<string, number> = { BID: 0, ASK: 1 };
export const TIF_MAP: Record<string, number> = { IOC: 0, GFS: 1, FOK: 2 };
export const ORDER_TYPE_MAP: Record<string, number> = {
  LIMIT: 0,
  MARKET_LIMIT: 1,
  MARKET_WITH_PROTECTION: 2,
  STOP_LOSS: 3,
  STOP_LIMIT: 4,
};

/** Normalize side input: accept 'buy'/'sell' as aliases for 'BID'/'ASK' */
function normalizeSide(side: string): 'BID' | 'ASK' {
  const upper = side.toUpperCase();
  if (upper === 'BUY' || upper === 'BID') return 'BID';
  if (upper === 'SELL' || upper === 'ASK') return 'ASK';
  throw new Error(`Invalid side: ${side}. Expected buy/sell/BID/ASK`);
}

export function registerOrderTools(server: McpServer, osmium: OsmiumClient | null, iridium: IridiumClient) {
  // Cache markets for lot size lookups and symbol resolution
  let marketsCache: Market[] | null = null;
  let marketsCacheTime = 0;
  const CACHE_TTL = 300_000; // 5 minutes

  async function refreshMarketsCache(): Promise<Market[]> {
    const now = Date.now();
    if (!marketsCache || now - marketsCacheTime > CACHE_TTL) {
      marketsCache = await iridium.getMarkets();
      marketsCacheTime = now;
    }
    return marketsCache;
  }

  async function getMarket(marketId: number): Promise<Market> {
    const markets = await refreshMarketsCache();
    const market = markets.find(m => m.marketId === marketId);
    if (!market) throw new Error(`Market ${marketId} not found`);
    return market;
  }

  /** Resolve a symbol string (e.g. "BTCUSDC") to a marketId */
  async function resolveMarketId(symbol?: string, marketId?: number): Promise<number> {
    if (marketId !== undefined) return marketId;
    if (!symbol) throw new Error('Either symbol or marketId must be provided');
    const markets = await refreshMarketsCache();
    const upper = symbol.toUpperCase();
    const market = markets.find(m => m.symbol.toUpperCase() === upper);
    if (!market) throw new Error(`Market not found for symbol: ${symbol}. Use get_markets to list available markets.`);
    return market.marketId;
  }

  server.tool(
    'place_order',
    'Place a new order. Prices and quantities are in human-readable units (e.g. price=83.69, quantity=0.0119). Supports LIMIT, MARKET, STOP_LOSS, and STOP_LIMIT order types. Uses WebSocket when available for faster execution, falls back to REST. Always confirm with the user before placing live orders.',
    {
      symbol: z.string().optional().describe('Market symbol (e.g. "BTCUSDC", "SOLUSDC"). Resolves to marketId automatically.'),
      marketId: z.number().optional().describe('Market ID to trade on. Alternative to symbol.'),
      side: z.enum(['BID', 'ASK', 'buy', 'sell']).describe('BID/buy or ASK/sell'),
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
        const resolvedMarketId = await resolveMarketId(params.symbol, params.marketId);
        const market = await getMarket(resolvedMarketId);
        const normalizedSide = normalizeSide(params.side);

        // Convert human-readable values to lot units
        const priceLots = params.price !== undefined
          ? toLots(params.price, market.priceTickSize)
          : undefined;
        const quantityLots = toLots(params.quantity, market.quantityTickSize);
        const stopPriceLots = params.stopPrice !== undefined
          ? toLots(params.stopPrice, market.priceTickSize)
          : undefined;

        // Try WebSocket (Osmium) first for faster execution
        if (osmium) {
          try {
            // Auto-discover subaccount if needed
            if (!osmium.isConnected) {
              const subId = await iridium.getDefaultSubaccountId();
              osmium.setSubaccountId(subId);
            }

            const wsResult = await osmium.placeOrder({
              marketId: resolvedMarketId,
              side: normalizedSide,
              price: priceLots !== undefined ? String(priceLots) : undefined,
              quantity: String(quantityLots),
              orderType: params.orderType,
              timeInForce: params.timeInForce,
              postOnly: params.postOnly,
              cancelOnDisconnect: false,
              stopPrice: stopPriceLots !== undefined ? String(stopPriceLots) : undefined,
            });

            const humanPrice = wsResult.price ? fromLots(Number(wsResult.price), market.priceTickSize) : params.price;
            const humanQty = fromLots(Number(wsResult.quantity), market.quantityTickSize);

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'placed',
                  via: 'websocket',
                  clientOrderId: wsResult.clientOrderId,
                  exchangeOrderId: wsResult.exchangeOrderId,
                  market: market.symbol,
                  marketId: wsResult.marketId,
                  side: wsResult.side,
                  price: humanPrice,
                  quantity: humanQty,
                  orderType: params.orderType,
                  transactTime: wsResult.transactTime,
                }, null, 2),
              }],
            };
          } catch {
            // WebSocket failed — fall through to REST
          }
        }

        // REST fallback via Iridium → Osmium REST API
        const result = await iridium.placeOrderRest({
          marketId: resolvedMarketId,
          side: SIDE_MAP[normalizedSide],
          price: priceLots,
          quantity: quantityLots,
          orderType: ORDER_TYPE_MAP[params.orderType],
          timeInForce: TIF_MAP[params.timeInForce],
          postOnly: params.postOnly ? 1 : 0,
          cancelOnDisconnect: false,
          stopPrice: stopPriceLots,
        });

        const humanPrice = result.price ? fromLots(result.price, market.priceTickSize) : params.price;
        const humanQty = fromLots(result.quantity, market.quantityTickSize);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'placed',
                  via: 'rest',
                  clientOrderId: result.clientOrderId,
                  exchangeOrderId: result.exchangeOrderId,
                  market: market.symbol,
                  marketId: result.marketId,
                  side: normalizedSide,
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
      } catch (error) {
        return toolError(error, 'Order failed');
      }
    }
  );

  server.tool(
    'cancel_order',
    'Cancel a specific resting order by its client order ID.',
    {
      symbol: z.string().optional().describe('Market symbol (e.g. "BTCUSDC", "SOLUSDC")'),
      marketId: z.number().optional().describe('Numeric market ID (alternative to symbol)'),
      clientOrderId: z.number().describe('Client-assigned order ID to cancel'),
    },
    async params => {
      try {
        const resolvedMarketId = await resolveMarketId(params.symbol, params.marketId);

        // Try WebSocket first
        if (osmium?.isConnected) {
          try {
            const wsResult = await osmium.cancelOrder({
              marketId: resolvedMarketId,
              clientOrderId: String(params.clientOrderId),
            });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ status: 'cancelled', via: 'websocket', ...wsResult }, null, 2),
              }],
            };
          } catch {
            // Fall through to REST
          }
        }

        const result = await iridium.cancelOrderRest({
          marketId: resolvedMarketId,
          clientOrderId: params.clientOrderId,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ status: 'cancelled', via: 'rest', ...result as object }, null, 2),
            },
          ],
        };
      } catch (error) {
        return toolError(error, 'Cancel failed');
      }
    }
  );

  server.tool(
    'modify_order',
    "Modify an existing resting order's price and/or quantity. Values in human-readable units.",
    {
      symbol: z.string().optional().describe('Market symbol (e.g. "BTCUSDC", "SOLUSDC")'),
      marketId: z.number().optional().describe('Numeric market ID (alternative to symbol)'),
      clientOrderId: z.number().describe('Client-assigned order ID to modify'),
      newPrice: z.string().optional().describe('New price in human-readable units'),
      newQuantity: z.string().describe('New quantity in human-readable units'),
      postOnly: z.boolean().default(false).describe('If true, modified order will only rest as maker'),
    },
    async params => {
      try {
        const resolvedMarketId = await resolveMarketId(params.symbol, params.marketId);
        const market = await getMarket(resolvedMarketId);

        // Try WebSocket first
        if (osmium?.isConnected) {
          try {
            const wsResult = await osmium.modifyOrder({
              marketId: resolvedMarketId,
              clientOrderId: String(params.clientOrderId),
              newPrice: params.newPrice !== undefined
                ? String(toLots(params.newPrice, market.priceTickSize))
                : undefined,
              newQuantity: String(toLots(params.newQuantity, market.quantityTickSize)),
              postOnly: params.postOnly,
            });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({ ...wsResult, status: 'modified', via: 'websocket' }, null, 2),
              }],
            };
          } catch {
            // Fall through to REST
          }
        }

        const result = await iridium.modifyOrderRest({
          marketId: resolvedMarketId,
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
              text: JSON.stringify({ status: 'modified', via: 'rest', ...result as object }, null, 2),
            },
          ],
        };
      } catch (error) {
        return toolError(error, 'Modify failed');
      }
    }
  );

  server.tool(
    'cancel_all_orders',
    'Cancel all resting orders. Optionally filter by market and/or side.',
    {
      symbol: z.string().optional().describe('Market symbol to cancel on (e.g. "BTCUSDC")'),
      marketId: z.number().optional().describe('Numeric market ID to cancel on (alternative to symbol)'),
      side: z.enum(['BID', 'ASK']).optional().describe('Side to cancel (omit for both sides)'),
    },
    async params => {
      try {
        const resolvedMktId = params.symbol || params.marketId !== undefined
          ? await resolveMarketId(params.symbol, params.marketId)
          : undefined;

        // Try WebSocket first
        if (osmium?.isConnected) {
          try {
            const wsResult = await osmium.massCancel({
              marketId: resolvedMktId,
              side: params.side,
            });
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'mass_cancelled',
                  via: 'websocket',
                  marketId: resolvedMktId ?? 'all',
                  side: params.side ?? 'both',
                  ...wsResult,
                }, null, 2),
              }],
            };
          } catch {
            // Fall through to REST
          }
        }

        const result = await iridium.massCancelRest({
          marketId: resolvedMktId,
          side: params.side !== undefined ? SIDE_MAP[params.side] : undefined,
        });

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  status: 'mass_cancelled',
                  via: 'rest',
                  marketId: resolvedMktId ?? 'all',
                  side: params.side ?? 'both',
                  ...result as object,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return toolError(error, 'Mass cancel failed');
      }
    }
  );

  server.tool(
    'get_orders',
    'Get open/resting orders, optionally filtered by market. Returns orders that are still live on the book.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (auto-detected if omitted)'),
      symbol: z.string().optional().describe('Filter by market symbol (e.g. "BTCUSDC")'),
      marketId: z.number().optional().describe('Filter by numeric market ID (alternative to symbol)'),
      status: z.enum(['open', 'all']).default('open').describe("'open' returns only resting/live orders, 'all' returns full history"),
    },
    async params => {
      try {
        const filterMarketId = params.symbol || params.marketId !== undefined
          ? await resolveMarketId(params.symbol, params.marketId)
          : undefined;
        const subId = params.subaccountId ?? await iridium.getDefaultSubaccountId();
        const orders = await iridium.getOrderHistory(subId, {
          marketId: filterMarketId,
        });

        // Open order statuses — orders still resting on the book
        const OPEN_STATUSES = new Set([
          'open', 'Open',
          'new', 'New',
          'partially_filled', 'PartiallyFilled',
          'pending', 'Pending',
          'resting', 'Resting',
          'accepted', 'Accepted',
        ]);

        const filtered = params.status === 'open'
          ? orders.filter(o => OPEN_STATUSES.has(o.status))
          : orders;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              subaccountId: subId,
              status: params.status,
              count: filtered.length,
              orders: filtered,
            }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error, 'Get orders failed');
      }
    }
  );

  server.tool(
    'close_position',
    'Close a position by symbol. Places a market sell order to flatten the position (or a percentage of it).',
    {
      symbol: z.string().describe('Asset symbol to close (e.g. "SOL", "BTC")'),
      percentage: z.number().min(1).max(100).default(100).describe('Percentage of position to close (1-100, default 100)'),
    },
    async params => {
      try {
        const symbol = params.symbol.toUpperCase();

        // Get positions and asset registry in parallel
        const subId = await iridium.getDefaultSubaccountId();
        const [positions, registry, markets] = await Promise.all([
          iridium.getPositions(subId),
          iridium.getAssetRegistry(),
          refreshMarketsCache(),
        ]);

        // Resolve symbol to assetId
        const assetInfo = registry.getBySymbol(symbol);
        if (!assetInfo) {
          throw new Error(`Unknown asset: ${symbol}. Use search_tokens to find the correct symbol.`);
        }

        // Find the position for this asset across all position groups
        let positionAmount = 0;
        for (const group of Object.values(positions)) {
          for (const entry of group.inner) {
            if (entry.assetId === assetInfo.assetId) {
              positionAmount += parseFloat(entry.amount);
            }
          }
        }

        if (positionAmount <= 0) {
          throw new Error(`No open position found for ${symbol}. Current balance: ${positionAmount}`);
        }

        // Calculate amount to close
        const closeAmount = positionAmount * (params.percentage / 100);

        // Find the market for this symbol (symbol + USDC pair)
        const marketSymbol = `${symbol}USDC`;
        const market = markets.find(m => m.symbol.toUpperCase() === marketSymbol);
        if (!market) {
          throw new Error(`No market found for ${marketSymbol}. Available markets can be listed with get_markets.`);
        }

        // Snap quantity to tick size
        const qtyTickSize = parseFloat(market.quantityTickSize);
        const snappedQty = Math.floor(closeAmount / qtyTickSize) * qtyTickSize;
        if (snappedQty <= 0) {
          throw new Error(`Position too small to close. Amount: ${closeAmount}, minimum tick: ${market.quantityTickSize}`);
        }

        const quantityStr = snappedQty.toString();
        const quantityLots = toLots(quantityStr, market.quantityTickSize);

        // Place a market sell order — try WebSocket first, REST fallback
        if (osmium) {
          try {
            if (!osmium.isConnected) {
              osmium.setSubaccountId(subId);
            }

            const wsResult = await osmium.placeOrder({
              marketId: market.marketId,
              side: 'ASK',
              quantity: String(quantityLots),
              orderType: 'MARKET_WITH_PROTECTION',
              timeInForce: 'IOC',
              postOnly: false,
              cancelOnDisconnect: false,
            });

            const humanQty = fromLots(Number(wsResult.quantity), market.quantityTickSize);
            const humanPrice = wsResult.price ? fromLots(Number(wsResult.price), market.priceTickSize) : undefined;

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'closing',
                  via: 'websocket',
                  symbol,
                  market: market.symbol,
                  marketId: market.marketId,
                  side: 'ASK',
                  quantity: humanQty,
                  price: humanPrice,
                  percentage: params.percentage,
                  positionSize: positionAmount.toString(),
                  clientOrderId: wsResult.clientOrderId,
                  exchangeOrderId: wsResult.exchangeOrderId,
                  transactTime: wsResult.transactTime,
                }, null, 2),
              }],
            };
          } catch {
            // WebSocket failed — fall through to REST
          }
        }

        // REST fallback
        const result = await iridium.placeOrderRest({
          marketId: market.marketId,
          side: SIDE_MAP['ASK'],
          quantity: quantityLots,
          orderType: ORDER_TYPE_MAP['MARKET_WITH_PROTECTION'],
          timeInForce: TIF_MAP['IOC'],
          postOnly: 0,
          cancelOnDisconnect: false,
        });

        const humanQty = fromLots(result.quantity, market.quantityTickSize);
        const humanPrice = result.price ? fromLots(result.price, market.priceTickSize) : undefined;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'closing',
              via: 'rest',
              symbol,
              market: market.symbol,
              marketId: market.marketId,
              side: 'ASK',
              quantity: humanQty,
              price: humanPrice,
              percentage: params.percentage,
              positionSize: positionAmount.toString(),
              clientOrderId: result.clientOrderId,
              exchangeOrderId: result.exchangeOrderId,
              transactTime: result.transactTime,
            }, null, 2),
          }],
        };
      } catch (error) {
        return toolError(error, 'Close position failed');
      }
    }
  );
}
