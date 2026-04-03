import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { IridiumClient } from '../client/iridium';

export function registerAccountTools(server: McpServer, iridium: IridiumClient) {
  const defaultSubaccountId = () => iridium.getDefaultSubaccountId();

  server.tool(
    'get_positions',
    'Get all current positions (asset holdings) for the trading subaccount. Shows amounts per asset grouped by accounting type.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
    },
    async params => {
      try {
        const positions = await iridium.getPositions(params.subaccountId ?? await defaultSubaccountId());
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
    'get_account',
    'Get account summary with balances, total portfolio value, and holdings.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
    },
    async params => {
      try {
        const subId = params.subaccountId ?? await defaultSubaccountId();
        const [positionGroups, tickers, registry] = await Promise.all([
          iridium.getPositions(subId),
          iridium.getTickers(),
          iridium.getAssetRegistry(),
        ]);

        const tickerMap = new Map(tickers.map(t => [t.symbol, t]));
        let totalValue = 0;

        const balances: {
          symbol: string;
          icon: string;
          amount: number;
          usdPrice: number | null;
          usdValue: number;
        }[] = [];

        for (const [, group] of Object.entries(positionGroups)) {
          for (const entry of group.inner) {
            const amt = parseFloat(entry.amount);
            if (amt <= 0) continue;

            const asset = registry.getById(entry.assetId);
            const symbol = asset?.symbol ?? `ASSET-${entry.assetId}`;
            const icon = asset?.icon ?? '';
            const isStable = ['USDC', 'USDT'].includes(symbol);
            const ticker = tickerMap.get(`${symbol}USDC`);
            const usdPrice = isStable ? 1 : (ticker?.lastPrice ?? null);
            const usdValue = usdPrice !== null ? amt * usdPrice : 0;
            totalValue += usdValue;

            balances.push({ symbol, icon, amount: amt, usdPrice, usdValue });
          }
        }

        // Sort by USD value descending
        balances.sort((a, b) => b.usdValue - a.usdValue);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  totalValue: `$${totalValue.toFixed(2)}`,
                  balances: balances.map(b => ({
                    asset: b.icon ? `${b.icon} ${b.symbol}` : b.symbol,
                    symbol: b.symbol,
                    amount: b.amount,
                    usdPrice: b.usdPrice !== null ? `$${b.usdPrice.toFixed(2)}` : 'N/A',
                    usdValue: `$${b.usdValue.toFixed(2)}`,
                  })),
                },
                null,
                2
              ),
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
        const orders = await iridium.getOrderHistory(params.subaccountId ?? await defaultSubaccountId(), {
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
        const fills = await iridium.getFills(params.subaccountId ?? await defaultSubaccountId(), {
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
