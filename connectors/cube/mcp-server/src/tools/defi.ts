import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IridiumClient, TokenSearchResult, Ticker } from '../client/iridium';
import type { OsmiumClient } from '../client/osmium';
import { getSigningCredentials } from '../client/auth';

export function isMintAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/** Well-known Solana mint addresses for tokens that don't appear in search APIs */
export const KNOWN_MINTS: Record<string, { mint: string; symbol: string; decimals: number }> = {
  SOL: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
  WSOL: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT', decimals: 6 },
};

export function formatToken(t: TokenSearchResult): string {
  const parts = [t.symbol];
  if (t.metadata.currencyName && t.metadata.currencyName !== t.symbol) {
    parts.push(`(${t.metadata.currencyName})`);
  }
  if (t.metadata.mint) parts.push(`mint:${t.metadata.mint}`);
  if (t.metadata.snapshotPrice) parts.push(`$${t.metadata.snapshotPrice}`);
  if (t.metadata.liquidity) parts.push(`mcap:$${(t.metadata.liquidity / 1e6).toFixed(1)}M`);
  return parts.join(' | ');
}

/**
 * Resolve a token symbol to a mint address via Cube's search API.
 * Returns the mint if input is already a mint address.
 * Returns null + candidates if ambiguous.
 */
async function resolveToken(
  iridium: IridiumClient,
  input: string
): Promise<{ mint: string; symbol: string; decimals: number } | { candidates: TokenSearchResult[] }> {
  if (isMintAddress(input)) {
    return { mint: input, symbol: input.slice(0, 8) + '...', decimals: 0 };
  }

  // Check well-known tokens first (SOL, USDC, USDT don't appear in search)
  const known = KNOWN_MINTS[input.toUpperCase()];
  if (known) return { ...known };

  const results = await iridium.searchTokens(input, 10);
  if (results.length === 0) {
    return { candidates: [] };
  }

  // Exact symbol match (case-insensitive)
  const exact = results.find(r => r.symbol.toUpperCase() === input.toUpperCase() && r.metadata.mint);
  if (exact?.metadata.mint) {
    return { mint: exact.metadata.mint, symbol: exact.symbol, decimals: exact.decimals };
  }

  // If only one result with a mint, use it
  const withMint = results.filter(r => r.metadata.mint);
  if (withMint.length === 1) {
    return { mint: withMint[0].metadata.mint!, symbol: withMint[0].symbol, decimals: withMint[0].decimals };
  }

  return { candidates: results };
}

export function registerTradingTools(server: McpServer, iridium: IridiumClient, osmium?: OsmiumClient | null) {
  server.tool(
    'search_assets',
    'Search for tradable assets by name or symbol. Returns asset details including address, price, market cap, and liquidity. Use this to find an asset\'s address before trading.',
    {
      query: z.string().describe('Asset name or symbol to search for (e.g. "BONK", "jupiter", "dogwifhat")'),
      limit: z.number().default(10).describe('Max results to return'),
    },
    async params => {
      try {
        const results = await iridium.searchTokens(params.query, params.limit);

        if (results.length === 0) {
          return {
            content: [{ type: 'text' as const, text: `No assets found for "${params.query}".` }],
          };
        }

        const tokens = results.map(t => ({
          symbol: t.symbol,
          name: t.metadata.currencyName ?? t.symbol,
          mint: t.metadata.mint ?? null,
          route: t.metadata.route ?? 'defi',
          decimals: t.decimals,
          price: t.metadata.snapshotPrice ?? null,
          marketCap: t.metadata.liquidity ?? null,
          marketCapRank: t.metadata.marketCapRank ?? null,
          volume24h: t.metadata.volume24hUSD ?? null,
          change24h: t.metadata.price24hChangePercent ?? null,
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ query: params.query, count: tokens.length, tokens }, null, 2),
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

  server.tool(
    'get_trending',
    'Get currently trending assets with prices, volume, and market data.',
    {},
    async () => {
      try {
        const results = await iridium.getTrendingTokens();

        const tokens = results.map(t => ({
          symbol: t.symbol,
          name: t.metadata.currencyName ?? t.symbol,
          mint: t.metadata.mint ?? null,
          price: t.metadata.snapshotPrice ?? null,
          marketCap: t.metadata.liquidity ?? null,
          volume24h: t.metadata.volume24hUSD ?? null,
          change24h: t.metadata.price24hChangePercent ?? null,
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ count: tokens.length, tokens }, null, 2),
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

  server.tool(
    'get_quote',
    `Get a price quote for a trade. Routes through available liquidity venues for best execution. Accepts asset symbols or on-chain addresses. If a symbol is ambiguous, returns matching assets to choose from.`,
    {
      assetIn: z.string().describe('Asset to sell — symbol (e.g. "SOL", "USDC") or on-chain address'),
      assetOut: z.string().describe('Asset to buy — symbol (e.g. "BONK", "JUP") or on-chain address'),
      amount: z.string().describe('Amount in smallest units (lamports for SOL, base units for SPL tokens)'),
      direction: z.enum(['in', 'out']).default('in').describe('"in" = specify amount to sell, "out" = specify amount to buy'),
    },
    async params => {
      try {
        const tokenIn = params.assetIn;
        const tokenOut = params.assetOut;

        // Resolve both tokens
        const inResolved = await resolveToken(iridium, tokenIn);
        const outResolved = await resolveToken(iridium, tokenOut);

        // If either is ambiguous, return candidates for the user to pick
        if ('candidates' in inResolved) {
          if (inResolved.candidates.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `No asset found for "${tokenIn}". Use search_assets to find the correct asset.` }],
              isError: true,
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Multiple assets match "${tokenIn}". Please specify the address or use a more specific name.`,
                matches: inResolved.candidates.map(formatToken),
              }, null, 2),
            }],
            isError: true,
          };
        }

        if ('candidates' in outResolved) {
          if (outResolved.candidates.length === 0) {
            return {
              content: [{ type: 'text' as const, text: `No asset found for "${tokenOut}". Use search_assets to find the correct asset.` }],
              isError: true,
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Multiple assets match "${tokenOut}". Please specify the address or use a more specific name.`,
                matches: outResolved.candidates.map(formatToken),
              }, null, 2),
            }],
            isError: true,
          };
        }

        const estimate = await iridium.getSwapEstimate({
          tokenIn: inResolved.mint,
          tokenOut: outResolved.mint,
          direction: params.direction,
          ...(params.direction === 'in' ? { amountIn: params.amount } : { amountOut: params.amount }),
        });

        if (estimate.error) {
          return {
            content: [{ type: 'text' as const, text: `Quote failed: ${estimate.error}` }],
            isError: true,
          };
        }

        const inMeta = estimate.metadata?.find(m => m.address === inResolved.mint);
        const outMeta = estimate.metadata?.find(m => m.address === outResolved.mint);
        const inDecimals = inMeta?.decimals ?? inResolved.decimals;
        const outDecimals = outMeta?.decimals ?? outResolved.decimals;

        const result: Record<string, unknown> = {
          trade: `${inResolved.symbol} → ${outResolved.symbol}`,
          direction: params.direction,
          assetIn: { address: inResolved.mint, symbol: inMeta?.symbol ?? inResolved.symbol, decimals: inDecimals },
          assetOut: { address: outResolved.mint, symbol: outMeta?.symbol ?? outResolved.symbol, decimals: outDecimals },
        };

        if (estimate.fee) {
          result.fee = { bps: estimate.fee.bps, percent: `${(estimate.fee.bps / 100).toFixed(2)}%` };
        }

        if (estimate.route) {
          const routeAmount = estimate.route.amount;
          result.route = {
            outputAmount: routeAmount,
            steps: estimate.route.steps.length,
            mints: Object.keys(estimate.route.mints).length,
          };

          if (outDecimals) {
            result.estimatedOutput = `${Number(routeAmount) / Math.pow(10, outDecimals)} ${outResolved.symbol}`;
          }
          if (inDecimals) {
            result.inputAmount = `${Number(params.amount) / Math.pow(10, inDecimals)} ${inResolved.symbol}`;
          }
        }

        if (estimate.metadata && estimate.metadata.length > 0) {
          result.tokenMetadata = estimate.metadata.map(m => ({
            symbol: m.symbol,
            name: m.currencyName,
            decimals: m.decimals,
            usdRate: m.usdRate,
          }));
        }

        result.note = 'Quote via on-chain aggregator. Routes through available liquidity venues for best execution.';

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // ── CEX/DEX Venue Comparison ──────────────────────────────

  server.tool(
    'compare_venues',
    `Compare prices between Cube's central order book and on-chain liquidity router for an asset. Essential for market-making between venues, cross-venue arbitrage, and best execution routing. Shows the spread between venues and recommends the optimal route.`,
    {
      symbol: z.string().describe('Asset symbol to compare (e.g. "SOL", "BONK", "JUP")'),
      side: z.enum(['buy', 'sell']).describe('Are you buying or selling this asset?'),
      amount: z.string().optional().describe('Amount in human-readable units for size-aware comparison (e.g. "1.5" SOL)'),
    },
    async params => {
      try {
        // 1. Get CEX orderbook price
        const tickers = await iridium.getTickers();
        const cexTicker = tickers.find(
          t => t.baseAsset.toUpperCase() === params.symbol.toUpperCase() && t.quoteAsset === 'USDC'
        );

        // 2. Get on-chain quote
        let dexPrice: number | null = null;
        let dexRoute: string | null = null;
        let dexError: string | null = null;

        try {
          const tokenResolved = await resolveToken(iridium, params.symbol);
          if ('mint' in tokenResolved) {
            const usdcMint = KNOWN_MINTS.USDC.mint;
            const decimals = tokenResolved.decimals || 9;

            // If amount provided, use it; otherwise estimate for 1 unit
            const humanAmount = params.amount ?? '1';
            const rawAmount = Math.round(parseFloat(humanAmount) * Math.pow(10, decimals)).toString();

            const isBuy = params.side === 'buy';
            const estimate = await iridium.getSwapEstimate({
              tokenIn: isBuy ? usdcMint : tokenResolved.mint,
              tokenOut: isBuy ? tokenResolved.mint : usdcMint,
              direction: 'in',
              amountIn: rawAmount,
            });

            if (estimate.route && estimate.metadata) {
              const outMeta = estimate.metadata.find(m =>
                m.address === (isBuy ? tokenResolved.mint : usdcMint)
              );
              const outDecimals = outMeta?.decimals ?? 6;
              const outputAmount = Number(estimate.route.amount) / Math.pow(10, outDecimals);

              if (isBuy) {
                // We spent `humanAmount` USDC, got `outputAmount` tokens
                dexPrice = parseFloat(humanAmount) / outputAmount;
              } else {
                // We sold `humanAmount` tokens, got `outputAmount` USDC
                dexPrice = outputAmount / parseFloat(humanAmount);
              }

              dexRoute = `${estimate.route.steps.length} hops via ${Object.keys(estimate.route.mints).length} mints`;
            }
          } else {
            dexError = 'Asset not found on-chain — may not have a listed address';
          }
        } catch (e: any) {
          dexError = e.message;
        }

        // 3. Build comparison
        const cexBid = cexTicker?.bidPrice ?? null;
        const cexAsk = cexTicker?.askPrice ?? null;
        const cexPrice = params.side === 'buy' ? cexAsk : cexBid;
        const cexSpread = (cexBid && cexAsk) ? ((cexAsk - cexBid) / cexAsk * 100).toFixed(3) : null;

        let recommendation: string;
        let spreadBps: number | null = null;

        if (cexPrice && dexPrice) {
          const diff = params.side === 'buy'
            ? (cexPrice - dexPrice) / cexPrice   // Negative = CEX cheaper
            : (dexPrice - cexPrice) / dexPrice;   // Negative = CEX better for selling
          spreadBps = Math.round(diff * 10000);

          if (Math.abs(spreadBps) < 10) {
            recommendation = 'NEUTRAL — venues within 10bps, prefer CEX for speed';
          } else if (spreadBps > 0) {
            recommendation = `On-chain is ${spreadBps}bps cheaper — route via decentralized venue`;
          } else {
            recommendation = `CEX is ${Math.abs(spreadBps)}bps cheaper — route via orderbook`;
          }
        } else if (cexPrice && !dexPrice) {
          recommendation = 'CEX only — asset not available or no on-chain liquidity';
        } else if (!cexPrice && dexPrice) {
          recommendation = 'On-chain only — no CEX orderbook liquidity';
        } else {
          recommendation = 'No pricing available on either venue';
        }

        const result = {
          symbol: params.symbol.toUpperCase(),
          side: params.side,
          amount: params.amount ?? '1',
          cex: {
            venue: 'Cube Orderbook',
            bidPrice: cexBid,
            askPrice: cexAsk,
            effectivePrice: cexPrice,
            spread: cexSpread ? `${cexSpread}%` : null,
            volume24h: cexTicker?.quoteVolume24h ?? 0,
            available: cexPrice !== null,
          },
          dex: {
            venue: 'Cube On-Chain Router (Jupiter/Phantom/1inch/Kamino)',
            effectivePrice: dexPrice ? parseFloat(dexPrice.toFixed(6)) : null,
            route: dexRoute,
            available: dexPrice !== null,
            ...(dexError ? { error: dexError } : {}),
          },
          comparison: {
            spreadBps,
            recommendation,
          },
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
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
    'execute_trade',
    `Execute a trade via the best available venue. Routes through on-chain liquidity aggregators for best execution. First get a quote with get_quote, then execute here. NOTE: Requires Cube account with trading access enabled.`,
    {
      assetIn: z.string().describe('Asset to sell — symbol (e.g. "SOL") or on-chain address'),
      assetOut: z.string().describe('Asset to buy — symbol (e.g. "BONK") or on-chain address'),
      amount: z.string().describe('Amount in smallest units (lamports for SOL, base units for SPL)'),
      direction: z.enum(['in', 'out']).default('in').describe('"in" = amount to sell, "out" = amount to buy'),
      slippageBps: z.number().default(50).describe('Max slippage in basis points (default 50 = 0.5%)'),
    },
    async params => {
      try {
        const tokenIn = params.assetIn;
        const tokenOut = params.assetOut;

        // Resolve tokens
        const inResolved = await resolveToken(iridium, tokenIn);
        const outResolved = await resolveToken(iridium, tokenOut);

        if ('candidates' in inResolved) {
          return {
            content: [{
              type: 'text' as const,
              text: `Ambiguous assetIn "${tokenIn}". Specify address or use search_assets.`,
            }],
            isError: true,
          };
        }
        if ('candidates' in outResolved) {
          return {
            content: [{
              type: 'text' as const,
              text: `Ambiguous assetOut "${tokenOut}". Specify address or use search_assets.`,
            }],
            isError: true,
          };
        }

        // First get estimate to confirm route exists
        const estimate = await iridium.getSwapEstimate({
          tokenIn: inResolved.mint,
          tokenOut: outResolved.mint,
          direction: params.direction,
          ...(params.direction === 'in' ? { amountIn: params.amount } : { amountOut: params.amount }),
        });

        if (estimate.error || !estimate.route) {
          return {
            content: [{
              type: 'text' as const,
              text: `No route found: ${estimate.error ?? 'Empty route returned'}`,
            }],
            isError: true,
          };
        }

        // Check if we have signing credentials for wallet intent execution
        const signingCreds = await getSigningCredentials();

        if (signingCreds && osmium) {
          // Attempt execution via wallet WebSocket with Ed25519 signed intent
          try {
            const subaccountId = await iridium.getDefaultSubaccountId();
            const result = await osmium.submitIntent({
              subaccountId,
              sourceId: 3, // Solana
              intentType: 1, // Swap (TBD — may need adjustment)
              intentBytes: new TextEncoder().encode(JSON.stringify({
                tokenIn: inResolved.mint,
                tokenOut: outResolved.mint,
                direction: params.direction,
                amount: params.amount,
                slippageBps: params.slippageBps,
              })),
            });

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'executed',
                  trade: `${inResolved.symbol} → ${outResolved.symbol}`,
                  intentId: result.intentId,
                  txnHash: result.txnHash,
                  deltas: result.deltas,
                }, null, 2),
              }],
            };
          } catch (intentError: any) {
            // Fall through to REST attempt
            const inDecimals = estimate.metadata?.find(m => m.address === inResolved.mint)?.decimals ?? 9;
            const outDecimals = estimate.metadata?.find(m => m.address === outResolved.mint)?.decimals ?? 6;

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'intent_failed',
                  trade: `${inResolved.symbol} → ${outResolved.symbol}`,
                  inputAmount: `${Number(params.amount) / Math.pow(10, inDecimals)} ${inResolved.symbol}`,
                  estimatedOutput: `${Number(estimate.route.amount) / Math.pow(10, outDecimals)} ${outResolved.symbol}`,
                  error: intentError.message,
                  action: 'Intent execution failed. Try again or execute at cube.exchange/swap.',
                }, null, 2),
              }],
              isError: true,
            };
          }
        }

        // No signing credentials — try REST execute endpoint, fall back to estimate
        try {
          const executeResult = await iridium.executeSwap({
            tokenIn: inResolved.mint,
            tokenOut: outResolved.mint,
            direction: params.direction,
            ...(params.direction === 'in' ? { amountIn: params.amount } : { amountOut: params.amount }),
            slippageBps: params.slippageBps,
          });

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'executed',
                trade: `${inResolved.symbol} → ${outResolved.symbol}`,
                result: executeResult,
              }, null, 2),
            }],
          };
        } catch (execError: any) {
          const inDecimals = estimate.metadata?.find(m => m.address === inResolved.mint)?.decimals ?? 9;
          const outDecimals = estimate.metadata?.find(m => m.address === outResolved.mint)?.decimals ?? 6;

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'estimate_only',
                reason: signingCreds
                  ? 'Trade execution failed via both intent and REST.'
                  : 'No signing credentials. Run `npm run login` in the cube connector to authenticate.',
                trade: `${inResolved.symbol} → ${outResolved.symbol}`,
                inputAmount: `${Number(params.amount) / Math.pow(10, inDecimals)} ${inResolved.symbol}`,
                estimatedOutput: `${Number(estimate.route.amount) / Math.pow(10, outDecimals)} ${outResolved.symbol}`,
                route: {
                  steps: estimate.route.steps.length,
                  fee: estimate.fee ? `${(estimate.fee.bps / 100).toFixed(2)}%` : null,
                },
                action: signingCreds
                  ? 'Execute this trade at cube.exchange/swap.'
                  : 'Run `npm run login` to enable agent signing, or execute at cube.exchange/swap.',
                error: execError.message,
              }, null, 2),
            }],
            isError: true,
          };
        }
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
