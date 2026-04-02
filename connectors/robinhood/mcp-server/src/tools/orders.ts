import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RobinhoodClient } from '../client/api.js';
import { resolveInstrument } from './market-data.js';

// ── Robinhood API Response Types ─────────────────────────────

interface OrderResponse {
  id: string;
  url: string;
  state: string;
  side: string;
  type: string;
  time_in_force: string;
  quantity: string;
  price: string | null;
  stop_price: string | null;
  average_price: string | null;
  cumulative_quantity: string;
  reject_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface CryptoOrderResponse {
  id: string;
  state: string;
  side: string;
  type: string;
  quantity: string;
  price: string | null;
  average_price: string | null;
  cumulative_quantity: string;
  created_at: string;
  updated_at: string;
  currency_pair_id: string;
}

// ── Crypto Currency Pairs ────────────────────────────────────

const CRYPTO_SYMBOLS = new Set([
  'BTC', 'ETH', 'DOGE', 'SOL', 'AVAX', 'SHIB', 'LTC', 'ETC',
  'LINK', 'UNI', 'AAVE', 'COMP', 'XLM', 'BCH', 'MATIC',
]);

function isCryptoSymbol(symbol: string): boolean {
  return CRYPTO_SYMBOLS.has(symbol.toUpperCase());
}

// ── Tool Registration ────────────────────────────────────────

export function registerOrderTools(server: McpServer, client: RobinhoodClient) {
  server.tool(
    'place_order',
    `Place a stock or crypto order on Robinhood. Supports market, limit, stop-loss, and stop-limit orders. Auto-detects stock vs crypto based on symbol. WARNING: Robinhood has no paper trading — all orders execute with real money.`,
    {
      symbol: z.string().describe('Stock or crypto symbol (e.g. "AAPL", "BTC")'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      quantity: z.number().positive().describe('Number of shares or coins'),
      type: z.enum(['market', 'limit', 'stop_loss', 'stop_limit']).default('market')
        .describe('Order type'),
      price: z.number().positive().optional()
        .describe('Limit price (required for limit and stop_limit orders)'),
      stopPrice: z.number().positive().optional()
        .describe('Stop/trigger price (required for stop_loss and stop_limit orders)'),
      timeInForce: z.enum(['gfd', 'gtc', 'ioc', 'opg']).default('gfd')
        .describe('Time in force: gfd (good for day), gtc (good til cancelled), ioc (immediate or cancel), opg (market on open)'),
    },
    async ({ symbol, side, quantity, type, price, stopPrice, timeInForce }) => {
      try {
        // Validate required prices
        if ((type === 'limit' || type === 'stop_limit') && !price) {
          return {
            content: [{ type: 'text' as const, text: 'Limit price required for limit/stop_limit orders' }],
            isError: true,
          };
        }
        if ((type === 'stop_loss' || type === 'stop_limit') && !stopPrice) {
          return {
            content: [{ type: 'text' as const, text: 'Stop price required for stop_loss/stop_limit orders' }],
            isError: true,
          };
        }

        const upperSymbol = symbol.toUpperCase();

        if (isCryptoSymbol(upperSymbol)) {
          return await placeCryptoOrder(client, upperSymbol, side, quantity, type, price);
        }

        return await placeStockOrder(client, upperSymbol, side, quantity, type, price, stopPrice, timeInForce);
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Order failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'cancel_order',
    'Cancel a pending stock order on Robinhood by order ID.',
    {
      orderId: z.string().describe('The order ID to cancel'),
    },
    async ({ orderId }) => {
      try {
        await client.post(`/orders/${orderId}/cancel/`, {});
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: 'cancelled',
              orderId,
              message: `Order ${orderId} cancellation requested`,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Cancel failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_order_status',
    'Check the status of a specific order on Robinhood.',
    {
      orderId: z.string().describe('The order ID to check'),
    },
    async ({ orderId }) => {
      try {
        const order = await client.get<OrderResponse>(`/orders/${orderId}/`);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              orderId: order.id,
              state: order.state,
              side: order.side,
              type: order.type,
              quantity: parseFloat(order.quantity),
              price: order.price ? parseFloat(order.price) : null,
              stopPrice: order.stop_price ? parseFloat(order.stop_price) : null,
              averagePrice: order.average_price ? parseFloat(order.average_price) : null,
              filledQuantity: parseFloat(order.cumulative_quantity),
              timeInForce: order.time_in_force,
              rejectReason: order.reject_reason,
              createdAt: order.created_at,
              updatedAt: order.updated_at,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}

// ── Stock Order Placement ────────────────────────────────────

async function placeStockOrder(
  client: RobinhoodClient,
  symbol: string,
  side: string,
  quantity: number,
  type: string,
  price?: number,
  stopPrice?: number,
  timeInForce: string = 'gfd',
) {
  const instrument = await resolveInstrument(client, symbol);

  // Robinhood requires a price for market orders too (use 0.01 as a ceiling marker for market buys)
  const orderBody: Record<string, unknown> = {
    account: await getAccountUrl(client),
    instrument: instrument.url,
    symbol,
    side,
    type,
    quantity: quantity.toString(),
    time_in_force: timeInForce,
    trigger: (type === 'stop_loss' || type === 'stop_limit') ? 'stop' : 'immediate',
  };

  if (price) orderBody.price = price.toFixed(2);
  if (stopPrice) orderBody.stop_price = stopPrice.toFixed(2);

  const order = await client.post<OrderResponse>('/orders/', orderBody);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        orderId: order.id,
        status: order.state,
        symbol,
        side: order.side,
        type: order.type,
        quantity: parseFloat(order.quantity),
        price: order.price ? parseFloat(order.price) : null,
        stopPrice: order.stop_price ? parseFloat(order.stop_price) : null,
        timeInForce: order.time_in_force,
        createdAt: order.created_at,
      }, null, 2),
    }],
  };
}

// ── Crypto Order Placement ───────────────────────────────────

async function placeCryptoOrder(
  client: RobinhoodClient,
  symbol: string,
  side: string,
  quantity: number,
  type: string,
  price?: number,
) {
  const orderBody: Record<string, unknown> = {
    currency_pair_id: `${symbol}-USD`,
    side,
    type,
    quantity: quantity.toString(),
    time_in_force: 'gtc',
  };

  if (price) orderBody.price = price.toFixed(2);

  const order = await client.post<CryptoOrderResponse>('/nummus/orders/', orderBody);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        orderId: order.id,
        status: order.state,
        symbol,
        side: order.side,
        type: order.type,
        quantity: parseFloat(order.quantity),
        averagePrice: order.average_price ? parseFloat(order.average_price) : null,
        createdAt: order.created_at,
      }, null, 2),
    }],
  };
}

// ── Account URL Helper ───────────────────────────────────────

let cachedAccountUrl: string | null = null;

async function getAccountUrl(client: RobinhoodClient): Promise<string> {
  if (cachedAccountUrl) return cachedAccountUrl;

  const accounts = await client.get<{ results: Array<{ url: string }> }>('/accounts/');
  const account = accounts.results[0];
  if (!account) throw new Error('No Robinhood account found');

  cachedAccountUrl = account.url;
  return cachedAccountUrl;
}
