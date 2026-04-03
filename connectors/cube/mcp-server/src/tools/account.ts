import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { IridiumClient } from '../client/iridium';

export function registerAccountTools(server: McpServer, iridium: IridiumClient) {
  const defaultSubaccountId = () => iridium.getDefaultSubaccountId();

  /** Resolve a symbol string to a marketId for optional filters */
  async function resolveMarketId(symbol?: string, marketId?: number): Promise<number | undefined> {
    if (marketId !== undefined) return marketId;
    if (!symbol) return undefined;
    const markets = await iridium.getMarkets();
    const upper = symbol.toUpperCase();
    const market = markets.find(m => m.symbol.toUpperCase() === upper);
    if (!market) throw new Error(`Market not found for symbol: ${symbol}. Use get_assets to list available markets.`);
    return market.marketId;
  }

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
      symbol: z.string().optional().describe('Filter by market symbol (e.g. "BTCUSDC")'),
      marketId: z.number().optional().describe('Filter by numeric market ID (alternative to symbol)'),
      limit: z.number().default(50).describe('Number of orders to return'),
    },
    async params => {
      try {
        const filterMarketId = await resolveMarketId(params.symbol, params.marketId);
        const orders = await iridium.getOrderHistory(params.subaccountId ?? await defaultSubaccountId(), {
          marketId: filterMarketId,
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
      symbol: z.string().optional().describe('Filter by market symbol (e.g. "BTCUSDC")'),
      marketId: z.number().optional().describe('Filter by numeric market ID (alternative to symbol)'),
      limit: z.number().default(50).describe('Number of fills to return'),
    },
    async params => {
      try {
        const filterMarketId = await resolveMarketId(params.symbol, params.marketId);
        const fills = await iridium.getFills(params.subaccountId ?? await defaultSubaccountId(), {
          marketId: filterMarketId,
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

  // ── Source/chain name resolution (from API) ─────────────

  async function getChainName(sourceId: number): Promise<string> {
    const sources = await iridium.getSources();
    const source = sources.get(sourceId);
    if (source) return source.name;
    return `Chain ${sourceId}`;
  }

  // ── Deposit Address ─────────────────────────────────────

  server.tool(
    'get_deposit_address',
    'Get deposit address for a specific chain. Returns the address and a funding link the user can open to deposit.',
    {
      chain: z.string().describe('Chain to deposit on (e.g. "solana", "ethereum", "bitcoin")'),
      token: z.string().optional().describe('Token to deposit (e.g. "USDC", "USDT"). Required for multi-token chains like Ethereum or Solana. Native assets (BTC, ETH, SOL) are assumed if omitted.'),
      amount: z.string().optional().describe('Requested deposit amount (e.g. "100", "0.5"). Shown on the deposit page as a suggested amount.'),
      label: z.string().optional().describe('Agent name requesting the deposit (e.g. "jesse-livermore", "risk-manager"). Shown on the deposit page.'),
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to primary)'),
    },
    async params => {
      try {
        const subId = params.subaccountId ?? await defaultSubaccountId();
        const detail = await iridium.getSubaccountDetail(subId);
        const addresses = detail.addresses;

        if (!addresses || Object.keys(addresses).length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No deposit addresses found. Addresses are generated when your account is created. If this persists, contact support.',
            }],
            isError: true,
          };
        }

        // Build address list with chain names
        const addressList = await Promise.all(
          Object.entries(addresses).map(async ([sourceId, address]) => ({
            chain: await getChainName(parseInt(sourceId)),
            address: address as string,
          }))
        );

        // Find matching chain
        const chainFilter = params.chain.toLowerCase();
        const match = addressList.find(a => a.chain.toLowerCase().includes(chainFilter));

        if (!match) {
          const available = addressList.map(a => a.chain).join(', ');
          return {
            content: [{
              type: 'text' as const,
              text: `No address found for "${params.chain}". Available chains: ${available}`,
            }],
            isError: true,
          };
        }

        const baseUrl = iridium.isStaging()
          ? 'https://staging.cube.exchange/agent/deposit'
          : 'https://cube.exchange/agent/deposit';

        const urlParams = new URLSearchParams({ address: match.address });
        if (params.token) urlParams.set('token', params.token.toUpperCase());
        if (params.amount) urlParams.set('amount', params.amount);
        if (params.label) urlParams.set('label', params.label);

        const depositUrl = `${baseUrl}?${urlParams.toString()}`;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              chain: match.chain,
              address: match.address,
              ...(params.token ? { token: params.token.toUpperCase() } : {}),
              ...(params.amount ? { amount: params.amount } : {}),
              ...(params.label ? { label: params.label } : {}),
              depositUrl,
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
