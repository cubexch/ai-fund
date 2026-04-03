import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IridiumClient } from '../client/iridium';

export function registerRiskTools(server: McpServer, iridium: IridiumClient) {
  const defaultSubaccountId = () => iridium.getDefaultSubaccountId();

  server.tool(
    'get_portfolio',
    'Get portfolio summary with all positions, current prices, total value, and allocation percentages.',
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

        // Flatten position groups and resolve assetId → symbol via registry
        const flatPositions: { symbol: string; assetId: number; amount: number; icon: string }[] = [];
        for (const [, group] of Object.entries(positionGroups)) {
          for (const entry of group.inner) {
            const amt = parseFloat(entry.amount);
            if (amt > 0) {
              const asset = registry.getById(entry.assetId);
              const symbol = asset?.symbol ?? `ASSET-${entry.assetId}`;
              const icon = asset?.icon ?? '';
              flatPositions.push({ symbol, assetId: entry.assetId, amount: amt, icon });
            }
          }
        }

        const enriched = flatPositions.map(position => {
          // Stablecoins are worth $1 — no ticker lookup needed
          const isStable = ['USDC', 'USDT'].includes(position.symbol);
          const ticker = tickerMap.get(`${position.symbol}USDC`);
          const price = isStable ? 1 : (ticker?.lastPrice ?? 0);
          const value = position.amount * price;
          totalValue += value;

          return {
            asset: position.symbol,
            icon: position.icon,
            label: position.icon ? `${position.icon} ${position.symbol}` : position.symbol,
            amount: position.amount,
            price: price || 'N/A',
            value: value.toFixed(2),
          };
        });

        const summary = enriched.map(p => ({
          ...p,
          allocation: totalValue > 0 ? `${((parseFloat(p.value) / totalValue) * 100).toFixed(1)}%` : '0%',
        }));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  totalPortfolioValue: `$${totalValue.toFixed(2)}`,
                  positions: summary,
                  positionCount: summary.length,
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
    'calculate_position_size',
    'Calculate recommended position size based on risk parameters. Uses Kelly criterion or fixed fractional sizing.',
    {
      portfolioValue: z.number().describe('Total portfolio value in USD'),
      riskPerTrade: z.number().default(0.02).describe('Max risk per trade as decimal (0.02 = 2%)'),
      entryPrice: z.number().describe('Planned entry price'),
      stopLossPrice: z.number().describe('Stop loss price'),
      winRate: z.number().optional().describe('Historical win rate (0-1) for Kelly sizing'),
      avgWinLoss: z.number().optional().describe('Average win/loss ratio for Kelly sizing'),
    },
    async params => {
      const riskPerUnit = Math.abs(params.entryPrice - params.stopLossPrice);

      if (riskPerUnit === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Error: Entry price and stop loss price cannot be the same.',
            },
          ],
          isError: true,
        };
      }

      // Fixed fractional sizing
      const maxLoss = params.portfolioValue * params.riskPerTrade;
      const fixedFractionalSize = maxLoss / riskPerUnit;
      const fixedFractionalValue = fixedFractionalSize * params.entryPrice;

      let kellySize: number | undefined;
      let kellyFraction: number | undefined;

      // Kelly criterion (if win rate and avg win/loss provided)
      if (params.winRate && params.avgWinLoss) {
        kellyFraction = params.winRate - (1 - params.winRate) / params.avgWinLoss;
        // Half-Kelly for safety
        const halfKelly = Math.max(0, kellyFraction * 0.5);
        kellySize = (params.portfolioValue * halfKelly) / params.entryPrice;
      }

      const recommendedSize = kellySize ? Math.min(fixedFractionalSize, kellySize) : fixedFractionalSize;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                fixedFractional: {
                  size: fixedFractionalSize.toFixed(6),
                  value: `$${fixedFractionalValue.toFixed(2)}`,
                  maxLoss: `$${maxLoss.toFixed(2)}`,
                  riskPercent: `${(params.riskPerTrade * 100).toFixed(1)}%`,
                },
                ...(kellySize
                  ? {
                      kelly: {
                        fullKelly: `${((kellyFraction ?? 0) * 100).toFixed(1)}%`,
                        halfKelly: `${((kellyFraction ?? 0) * 0.5 * 100).toFixed(1)}%`,
                        size: kellySize.toFixed(6),
                        value: `$${(kellySize * params.entryPrice).toFixed(2)}`,
                      },
                    }
                  : {}),
                recommended: {
                  size: recommendedSize.toFixed(6),
                  value: `$${(recommendedSize * params.entryPrice).toFixed(2)}`,
                  method: kellySize ? 'min(fixedFractional, halfKelly)' : 'fixedFractional',
                },
                params: {
                  entryPrice: params.entryPrice,
                  stopLossPrice: params.stopLossPrice,
                  riskPerUnit: riskPerUnit.toFixed(2),
                  direction: params.entryPrice > params.stopLossPrice ? 'LONG' : 'SHORT',
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
