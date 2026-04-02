import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AlpacaClient } from '../client/api.js';

export function registerAccountTools(server: McpServer, client: AlpacaClient) {
  server.tool(
    'get_account',
    'Get Alpaca account summary — buying power, cash, portfolio value, equity, and day trade count.',
    {},
    async () => {
      try {
        const account = await client.getAccount();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              id: account.id,
              status: account.status,
              currency: account.currency,
              buyingPower: `$${parseFloat(account.buying_power).toFixed(2)}`,
              cash: `$${parseFloat(account.cash).toFixed(2)}`,
              portfolioValue: `$${parseFloat(account.portfolio_value).toFixed(2)}`,
              equity: `$${parseFloat(account.equity).toFixed(2)}`,
              longMarketValue: `$${parseFloat(account.long_market_value).toFixed(2)}`,
              shortMarketValue: `$${parseFloat(account.short_market_value).toFixed(2)}`,
              daytradeCount: account.daytrade_count,
              patternDayTrader: account.pattern_day_trader,
              tradingBlocked: account.trading_blocked,
              paper: client.isPaper,
            }, null, 2),
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
    'get_positions',
    'Get all current positions with unrealized P&L, market value, and cost basis.',
    {},
    async () => {
      try {
        const positions = await client.getPositions();
        const formatted = positions.map(p => ({
          symbol: p.symbol,
          qty: parseFloat(p.qty),
          side: p.side,
          avgEntryPrice: parseFloat(p.avg_entry_price),
          currentPrice: parseFloat(p.current_price),
          marketValue: parseFloat(p.market_value),
          costBasis: parseFloat(p.cost_basis),
          unrealizedPl: parseFloat(p.unrealized_pl),
          unrealizedPlPct: `${(parseFloat(p.unrealized_plpc) * 100).toFixed(2)}%`,
          changeToday: `${(parseFloat(p.change_today) * 100).toFixed(2)}%`,
          assetClass: p.asset_class,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(formatted, null, 2),
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
    'close_position',
    'Close a position by symbol. Optionally specify quantity or percentage to partially close.',
    {
      symbol: z.string().describe('Stock/crypto symbol (e.g., AAPL, BTC/USD)'),
      qty: z.string().optional().describe('Quantity to close (omit for full close)'),
      percentage: z.string().optional().describe('Percentage to close, e.g. "50" for 50%'),
    },
    async (params) => {
      try {
        const order = await client.closePosition(params.symbol, {
          qty: params.qty,
          percentage: params.percentage,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              orderId: order.id,
              symbol: order.symbol,
              side: order.side,
              qty: order.qty,
              type: order.type,
              status: order.status,
            }, null, 2),
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
    'get_clock',
    'Get market clock — whether the market is open and next open/close times.',
    {},
    async () => {
      try {
        const clock = await client.getClock();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              isOpen: clock.is_open,
              timestamp: clock.timestamp,
              nextOpen: clock.next_open,
              nextClose: clock.next_close,
            }, null, 2),
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
