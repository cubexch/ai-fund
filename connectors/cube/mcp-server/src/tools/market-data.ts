import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IridiumClient } from '../client/iridium.js';

export function registerMarketDataTools(server: McpServer, iridium: IridiumClient) {
  server.tool(
    'get_markets',
    'List all available markets on Cube Exchange with their trading pairs, precision, and status.',
    {},
    async () => {
      try {
        const markets = await iridium.getMarkets();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(markets, null, 2),
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
    'get_tickers',
    'Get real-time ticker data for all markets: last price, bid/ask, 24h volume, 24h high/low, and 24h change.',
    {},
    async () => {
      try {
        const tickers = await iridium.getTickers();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(tickers, null, 2),
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
    'get_price_history',
    'Get historical OHLCV candlestick data for a market. Useful for technical analysis, backtesting, and charting.',
    {
      marketId: z.number().describe('Market ID to get history for'),
      interval: z.enum(['1s', '1m', '15m', '1h', '4h', '1d']).default('1h').describe('Candlestick interval'),
      limit: z.number().default(100).describe('Number of candles to return (max 1000)'),
    },
    async params => {
      try {
        const candles = await iridium.getPriceHistory(params.marketId, params.interval, params.limit);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(candles, null, 2),
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
    'get_estimated_fees',
    'Get estimated trading fees for a specific trade. Returns maker and taker fee rates.',
    {
      marketId: z.number().describe('Market ID'),
      side: z.enum(['BID', 'ASK']).describe('Trade side'),
      quantity: z.string().describe('Trade quantity'),
    },
    async params => {
      try {
        const fees = await iridium.getEstimatedFees(params.marketId, params.side, params.quantity);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(fees, null, 2),
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
}
