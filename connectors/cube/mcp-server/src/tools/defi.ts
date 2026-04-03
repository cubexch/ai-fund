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
          route: t.metadata.route ?? 'onchain',
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
    'Get a price quote for a trade. Checks both the orderbook and on-chain liquidity. Accepts asset symbols or on-chain addresses. If a symbol is ambiguous, returns matching assets to choose from.',
    {
      base: z.string().describe('Asset to trade — symbol (e.g. "SOL", "BONK") or on-chain address'),
      quote: z.string().default('USDC').describe('Quote asset (default "USDC")'),
      side: z.enum(['buy', 'sell']).describe('Buy or sell the base asset'),
      amount: z.string().describe('Amount of base asset in human-readable units (e.g. "1.5")'),
    },
    async params => {
      try {
        const baseSymbol = params.base.toUpperCase();
        const quoteSymbol = params.quote.toUpperCase();

        // ── Orderbook quote ──
        let orderbookPrice: number | null = null;
        let orderbookSpread: string | null = null;

        try {
          const tickers = await iridium.getTickers();
          const ticker = tickers.find(
            t => t.baseAsset.toUpperCase() === baseSymbol && t.quoteAsset.toUpperCase() === quoteSymbol
          );
          if (ticker) {
            orderbookPrice = params.side === 'buy' ? (ticker.askPrice ?? null) : (ticker.bidPrice ?? null);
            if (ticker.bidPrice && ticker.askPrice) {
              orderbookSpread = `${((ticker.askPrice - ticker.bidPrice) / ticker.askPrice * 100).toFixed(3)}%`;
            }
          }
        } catch {
          // Orderbook unavailable
        }

        // ── On-chain quote ──
        let onchainPrice: number | null = null;
        let onchainFee: string | null = null;
        let onchainError: string | null = null;

        try {
          const baseRes = await resolveToken(iridium, params.base);
          const quoteRes = await resolveToken(iridium, params.quote);

          if ('candidates' in baseRes) {
            if (baseRes.candidates.length > 1) {
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: `Multiple assets match "${params.base}". Specify the address.`,
                    matches: baseRes.candidates.map(formatToken),
                  }, null, 2),
                }],
                isError: true,
              };
            }
            onchainError = `Asset "${params.base}" not found on-chain.`;
          } else if ('candidates' in quoteRes) {
            onchainError = `Quote asset "${params.quote}" not found on-chain.`;
          } else {
            const rawAmount = Math.round(parseFloat(params.amount) * Math.pow(10, baseRes.decimals)).toString();
            const tokenIn = params.side === 'buy' ? quoteRes.mint : baseRes.mint;
            const tokenOut = params.side === 'buy' ? baseRes.mint : quoteRes.mint;

            const estimate = await iridium.getSwapEstimate({
              tokenIn, tokenOut,
              direction: params.side === 'buy' ? 'out' : 'in',
              ...(params.side === 'buy' ? { amountOut: rawAmount } : { amountIn: rawAmount }),
            });

            if (estimate.route) {
              const outMeta = estimate.metadata?.find(m => m.address === tokenOut);
              const outDecimals = outMeta?.decimals ?? 6;
              const outputAmount = Number(estimate.route.amount) / Math.pow(10, outDecimals);

              if (params.side === 'buy') {
                const inMeta = estimate.metadata?.find(m => m.address === tokenIn);
                const inDecimals = inMeta?.decimals ?? 6;
                const quoteSpent = Number(estimate.route.amount) / Math.pow(10, inDecimals);
                onchainPrice = quoteSpent / parseFloat(params.amount);
              } else {
                onchainPrice = outputAmount / parseFloat(params.amount);
              }
            }

            if (estimate.fee) {
              onchainFee = `${(estimate.fee.bps / 100).toFixed(2)}%`;
            }
          }
        } catch (e: any) {
          onchainError = e.message;
        }

        // ── Build result ──
        let recommendation: string;
        let spreadBps: number | null = null;

        if (orderbookPrice && onchainPrice) {
          const diff = params.side === 'buy'
            ? (orderbookPrice - onchainPrice) / orderbookPrice
            : (onchainPrice - orderbookPrice) / onchainPrice;
          spreadBps = Math.round(diff * 10000);

          if (Math.abs(spreadBps) < 10) {
            recommendation = 'NEUTRAL — venues within 10bps, prefer orderbook for speed';
          } else if (spreadBps > 0) {
            recommendation = `On-chain is ${spreadBps}bps cheaper`;
          } else {
            recommendation = `Orderbook is ${Math.abs(spreadBps)}bps cheaper`;
          }
        } else if (orderbookPrice) {
          recommendation = 'Orderbook only — no on-chain liquidity';
        } else if (onchainPrice) {
          recommendation = 'On-chain only — not listed on orderbook';
        } else {
          recommendation = 'No pricing available';
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              base: baseSymbol,
              quote: quoteSymbol,
              side: params.side,
              amount: params.amount,
              orderbook: {
                price: orderbookPrice,
                spread: orderbookSpread,
                available: orderbookPrice !== null,
              },
              onchain: {
                price: onchainPrice ? parseFloat(onchainPrice.toFixed(6)) : null,
                fee: onchainFee,
                available: onchainPrice !== null,
                ...(onchainError ? { error: onchainError } : {}),
              },
              recommendation,
              spreadBps,
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

  // ── Venue Comparison ─────────────────────────────────────

  server.tool(
    'compare_venues',
    'Compare prices between the orderbook and on-chain liquidity for an asset. Shows spread between venues and recommends optimal routing.',
    {
      symbol: z.string().describe('Asset symbol to compare (e.g. "SOL", "BONK", "JUP")'),
      side: z.enum(['buy', 'sell']).describe('Are you buying or selling this asset?'),
      amount: z.string().optional().describe('Amount in human-readable units for size-aware comparison (e.g. "1.5" SOL)'),
    },
    async params => {
      try {
        // 1. Get orderbook price
        const tickers = await iridium.getTickers();
        const orderbookTicker = tickers.find(
          t => t.baseAsset.toUpperCase() === params.symbol.toUpperCase() && t.quoteAsset === 'USDC'
        );

        // 2. Get on-chain quote
        let onchainPrice: number | null = null;
        let onchainRoute: string | null = null;
        let onchainError: string | null = null;

        try {
          const tokenResolved = await resolveToken(iridium, params.symbol);
          if ('mint' in tokenResolved) {
            const usdcMint = KNOWN_MINTS.USDC.mint;
            const decimals = tokenResolved.decimals || 9;

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
                onchainPrice = parseFloat(humanAmount) / outputAmount;
              } else {
                onchainPrice = outputAmount / parseFloat(humanAmount);
              }

              onchainRoute = `${estimate.route.steps.length} hops via ${Object.keys(estimate.route.mints).length} pools`;
            }
          } else {
            onchainError = 'Asset not found on-chain';
          }
        } catch (e: any) {
          onchainError = e.message;
        }

        // 3. Build comparison
        const bid = orderbookTicker?.bidPrice ?? null;
        const ask = orderbookTicker?.askPrice ?? null;
        const orderbookPrice = params.side === 'buy' ? ask : bid;
        const spread = (bid && ask) ? ((ask - bid) / ask * 100).toFixed(3) : null;

        let recommendation: string;
        let spreadBps: number | null = null;

        if (orderbookPrice && onchainPrice) {
          const diff = params.side === 'buy'
            ? (orderbookPrice - onchainPrice) / orderbookPrice
            : (onchainPrice - orderbookPrice) / onchainPrice;
          spreadBps = Math.round(diff * 10000);

          if (Math.abs(spreadBps) < 10) {
            recommendation = 'NEUTRAL — venues within 10bps, prefer orderbook for speed';
          } else if (spreadBps > 0) {
            recommendation = `On-chain is ${spreadBps}bps cheaper`;
          } else {
            recommendation = `Orderbook is ${Math.abs(spreadBps)}bps cheaper`;
          }
        } else if (orderbookPrice && !onchainPrice) {
          recommendation = 'Orderbook only — no on-chain liquidity';
        } else if (!orderbookPrice && onchainPrice) {
          recommendation = 'On-chain only — not listed on orderbook';
        } else {
          recommendation = 'No pricing available on either venue';
        }

        const result = {
          symbol: params.symbol.toUpperCase(),
          side: params.side,
          amount: params.amount ?? '1',
          orderbook: {
            venue: 'Cube Orderbook',
            bidPrice: bid,
            askPrice: ask,
            effectivePrice: orderbookPrice,
            spread: spread ? `${spread}%` : null,
            volume24h: orderbookTicker?.quoteVolume24h ?? 0,
            available: orderbookPrice !== null,
          },
          onchain: {
            venue: 'On-Chain Router',
            effectivePrice: onchainPrice ? parseFloat(onchainPrice.toFixed(6)) : null,
            route: onchainRoute,
            available: onchainPrice !== null,
            ...(onchainError ? { error: onchainError } : {}),
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

  // ── Swap: on-chain market order ───────────────────────────

  server.tool(
    'swap',
    'Swap one asset for another via on-chain liquidity. Like a market order routed through liquidity aggregators. Use this when you specifically want on-chain execution. For smart routing across all venues, use execute_trade instead.',
    {
      base: z.string().describe('Asset to trade — symbol (e.g. "SOL", "BONK") or on-chain mint address'),
      quote: z.string().default('USDC').describe('Quote asset (default "USDC")'),
      side: z.enum(['buy', 'sell']).describe('Buy or sell the base asset'),
      amount: z.string().describe('Amount of base asset in human-readable units (e.g. "1.5")'),
      slippageBps: z.number().default(50).describe('Max slippage in basis points (default 50 = 0.5%)'),
    },
    async params => {
      try {
        const baseResolved = await resolveToken(iridium, params.base);
        const quoteResolved = await resolveToken(iridium, params.quote);

        if ('candidates' in baseResolved) {
          if (baseResolved.candidates.length === 0) {
            return { content: [{ type: 'text' as const, text: `No asset found for "${params.base}". Use search_assets to find the correct asset.` }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Multiple assets match "${params.base}". Specify the address.`, matches: baseResolved.candidates.map(formatToken) }, null, 2) }], isError: true };
        }
        if ('candidates' in quoteResolved) {
          return { content: [{ type: 'text' as const, text: `Quote asset "${params.quote}" not found.` }], isError: true };
        }

        const rawAmount = Math.round(parseFloat(params.amount) * Math.pow(10, baseResolved.decimals)).toString();
        const tokenIn = params.side === 'buy' ? quoteResolved.mint : baseResolved.mint;
        const tokenOut = params.side === 'buy' ? baseResolved.mint : quoteResolved.mint;
        const tradeLabel = params.side === 'buy'
          ? `Buy ${params.amount} ${baseResolved.symbol} with ${quoteResolved.symbol}`
          : `Sell ${params.amount} ${baseResolved.symbol} for ${quoteResolved.symbol}`;

        const estimate = await iridium.getSwapEstimate({
          tokenIn, tokenOut,
          direction: params.side === 'buy' ? 'out' : 'in',
          ...(params.side === 'buy' ? { amountOut: rawAmount } : { amountIn: rawAmount }),
        });

        if (estimate.error || !estimate.route) {
          return { content: [{ type: 'text' as const, text: `No on-chain route: ${estimate.error ?? 'Empty route'}` }], isError: true };
        }

        const signingCreds = await getSigningCredentials();

        if (signingCreds && osmium) {
          try {
            const subaccountId = await iridium.getDefaultSubaccountId();
            const result = await osmium.submitIntent({
              subaccountId, sourceId: 3, intentType: 1,
              intentBytes: new TextEncoder().encode(JSON.stringify({
                tokenIn, tokenOut,
                direction: params.side === 'buy' ? 'out' : 'in',
                amount: rawAmount, slippageBps: params.slippageBps,
              })),
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'executed', venue: 'onchain', trade: tradeLabel, intentId: result.intentId, txnHash: result.txnHash, deltas: result.deltas }, null, 2) }] };
          } catch {
            // Fall through to REST
          }
        }

        try {
          const executeResult = await iridium.executeSwap({
            tokenIn, tokenOut,
            direction: params.side === 'buy' ? 'out' : 'in',
            ...(params.side === 'buy' ? { amountOut: rawAmount } : { amountIn: rawAmount }),
            slippageBps: params.slippageBps,
          });
          return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'executed', venue: 'onchain', trade: tradeLabel, result: executeResult }, null, 2) }] };
        } catch (execError: any) {
          const outDecimals = estimate.metadata?.find(m => m.address === tokenOut)?.decimals ?? 6;
          const outputHuman = Number(estimate.route.amount) / Math.pow(10, outDecimals);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'estimate_only', trade: tradeLabel,
                estimatedOutput: `${outputHuman} ${params.side === 'buy' ? baseResolved.symbol : quoteResolved.symbol}`,
                fee: estimate.fee ? `${(estimate.fee.bps / 100).toFixed(2)}%` : null,
                action: signingCreds
                  ? 'On-chain execution failed. Try again or execute at cube.exchange/swap.'
                  : 'Run `npm run login` to enable trading, or execute at cube.exchange/swap.',
                error: execError.message,
              }, null, 2),
            }],
            isError: true,
          };
        }
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${error.message}` }], isError: true };
      }
    }
  );

  // ── Execute Trade: unified best execution ───────────────

  server.tool(
    'execute_trade',
    'Execute a trade with smart routing. Checks both the orderbook and on-chain liquidity, routes to the best price. Works like a market order — specify what you want to buy or sell and the amount. Accepts symbols or on-chain mint addresses. Quote asset defaults to USDC if omitted.',
    {
      base: z.string().describe('Asset to trade — symbol (e.g. "SOL", "BTC", "BONK") or on-chain mint address'),
      quote: z.string().default('USDC').describe('Quote asset — symbol or mint address (default "USDC")'),
      side: z.enum(['buy', 'sell']).describe('Buy or sell the base asset'),
      amount: z.string().describe('Amount of base asset in human-readable units (e.g. "1.5")'),
      venue: z.enum(['auto', 'orderbook', 'onchain']).default('auto').describe('Force a venue or let the system pick the best price'),
      slippageBps: z.number().default(50).describe('Max slippage in basis points (default 50 = 0.5%)'),
    },
    async params => {
      try {
        const baseSymbol = params.base.toUpperCase();
        const quoteSymbol = params.quote.toUpperCase();
        const marketSymbol = `${baseSymbol}${quoteSymbol}`;

        // ── Get orderbook price ──
        let orderbookPrice: number | null = null;
        let orderbookMarket: { marketId: number; symbol: string; priceTickSize: string; quantityTickSize: string } | null = null;

        if (params.venue !== 'onchain') {
          try {
            const markets = await iridium.getMarkets();
            orderbookMarket = markets.find(m => m.symbol.toUpperCase() === marketSymbol) ?? null;
            if (orderbookMarket) {
              const tickers = await iridium.getTickers();
              const ticker = tickers.find(t => t.symbol === orderbookMarket!.symbol);
              orderbookPrice = params.side === 'buy' ? (ticker?.askPrice ?? null) : (ticker?.bidPrice ?? null);
            }
          } catch {
            // Orderbook unavailable
          }
        }

        // ── Get on-chain price ──
        let onchainPrice: number | null = null;
        let onchainEstimate: any = null;
        let baseResolved: { mint: string; symbol: string; decimals: number } | null = null;
        let quoteResolved: { mint: string; symbol: string; decimals: number } | null = null;

        if (params.venue !== 'orderbook') {
          try {
            const bRes = await resolveToken(iridium, params.base);
            const qRes = await resolveToken(iridium, params.quote);

            if (!('candidates' in bRes) && !('candidates' in qRes)) {
              baseResolved = bRes;
              quoteResolved = qRes;
              const rawAmount = Math.round(parseFloat(params.amount) * Math.pow(10, bRes.decimals)).toString();

              const tokenIn = params.side === 'buy' ? qRes.mint : bRes.mint;
              const tokenOut = params.side === 'buy' ? bRes.mint : qRes.mint;

              onchainEstimate = await iridium.getSwapEstimate({
                tokenIn, tokenOut,
                direction: params.side === 'buy' ? 'out' : 'in',
                ...(params.side === 'buy' ? { amountOut: rawAmount } : { amountIn: rawAmount }),
              });

              if (onchainEstimate.route) {
                const outMeta = onchainEstimate.metadata?.find((m: any) => m.address === tokenOut);
                const outDecimals = outMeta?.decimals ?? 6;
                const outputAmount = Number(onchainEstimate.route.amount) / Math.pow(10, outDecimals);

                if (params.side === 'buy') {
                  const inMeta = onchainEstimate.metadata?.find((m: any) => m.address === tokenIn);
                  const inDecimals = inMeta?.decimals ?? 6;
                  const quoteSpent = Number(onchainEstimate.route.amount) / Math.pow(10, inDecimals);
                  onchainPrice = quoteSpent / parseFloat(params.amount);
                } else {
                  onchainPrice = outputAmount / parseFloat(params.amount);
                }
              }
            }
          } catch {
            // On-chain unavailable
          }
        }

        // ── Route decision ──
        let chosenVenue: 'orderbook' | 'onchain';

        if (params.venue === 'orderbook') {
          if (!orderbookPrice || !orderbookMarket) {
            return { content: [{ type: 'text' as const, text: `No orderbook market found for ${marketSymbol}. Try venue: "onchain" or "auto".` }], isError: true };
          }
          chosenVenue = 'orderbook';
        } else if (params.venue === 'onchain') {
          if (!onchainPrice || !baseResolved || !quoteResolved) {
            return { content: [{ type: 'text' as const, text: `No on-chain route found for ${baseSymbol}/${quoteSymbol}. Try venue: "orderbook" or "auto".` }], isError: true };
          }
          chosenVenue = 'onchain';
        } else {
          // Auto: pick better price
          if (orderbookPrice && onchainPrice) {
            if (params.side === 'buy') {
              chosenVenue = orderbookPrice <= onchainPrice ? 'orderbook' : 'onchain';
            } else {
              chosenVenue = orderbookPrice >= onchainPrice ? 'orderbook' : 'onchain';
            }
          } else if (orderbookPrice) {
            chosenVenue = 'orderbook';
          } else if (onchainPrice) {
            chosenVenue = 'onchain';
          } else {
            return { content: [{ type: 'text' as const, text: `No liquidity found for ${baseSymbol}/${quoteSymbol} on any venue.` }], isError: true };
          }
        }

        const tradeLabel = params.side === 'buy'
          ? `Buy ${params.amount} ${baseSymbol} with ${quoteSymbol}`
          : `Sell ${params.amount} ${baseSymbol} for ${quoteSymbol}`;

        // ── Execute on orderbook ──
        if (chosenVenue === 'orderbook') {
          const market = orderbookMarket!;
          const { toLots, fromLots, SIDE_MAP, ORDER_TYPE_MAP, TIF_MAP } = await import('./orders.js');
          const quantityLots = toLots(params.amount, market.quantityTickSize);
          const normalizedSide = params.side === 'buy' ? 'BID' : 'ASK';

          // Try WebSocket first
          if (osmium) {
            try {
              if (!osmium.isConnected) {
                const subId = await iridium.getDefaultSubaccountId();
                osmium.setSubaccountId(subId);
              }
              const wsResult = await osmium.placeOrder({
                marketId: market.marketId,
                side: normalizedSide,
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
                    status: 'executed',
                    venue: 'orderbook',
                    trade: tradeLabel,
                    market: market.symbol,
                    price: humanPrice,
                    quantity: humanQty,
                    clientOrderId: wsResult.clientOrderId,
                    exchangeOrderId: wsResult.exchangeOrderId,
                    ...(onchainPrice ? { onchainPriceWas: onchainPrice.toFixed(6) } : {}),
                    ...(orderbookPrice && onchainPrice ? { savingBps: Math.abs(Math.round((orderbookPrice - onchainPrice) / orderbookPrice * 10000)) } : {}),
                  }, null, 2),
                }],
              };
            } catch {
              // Fall through to REST
            }
          }

          // REST fallback
          const result = await iridium.placeOrderRest({
            marketId: market.marketId,
            side: SIDE_MAP[normalizedSide],
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
                status: 'executed',
                venue: 'orderbook',
                trade: tradeLabel,
                market: market.symbol,
                price: humanPrice,
                quantity: humanQty,
                clientOrderId: result.clientOrderId,
                exchangeOrderId: result.exchangeOrderId,
              }, null, 2),
            }],
          };
        }

        // ── Execute on-chain ──
        const bRes = baseResolved!;
        const qRes = quoteResolved!;
        const rawAmount = Math.round(parseFloat(params.amount) * Math.pow(10, bRes.decimals)).toString();
        const tokenIn = params.side === 'buy' ? qRes.mint : bRes.mint;
        const tokenOut = params.side === 'buy' ? bRes.mint : qRes.mint;

        const signingCreds = await getSigningCredentials();

        if (signingCreds && osmium) {
          try {
            const subaccountId = await iridium.getDefaultSubaccountId();
            const result = await osmium.submitIntent({
              subaccountId,
              sourceId: 3,
              intentType: 1,
              intentBytes: new TextEncoder().encode(JSON.stringify({
                tokenIn, tokenOut,
                direction: params.side === 'buy' ? 'out' : 'in',
                amount: rawAmount,
                slippageBps: params.slippageBps,
              })),
            });

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'executed',
                  venue: 'onchain',
                  trade: tradeLabel,
                  intentId: result.intentId,
                  txnHash: result.txnHash,
                  deltas: result.deltas,
                  ...(orderbookPrice ? { orderbookPriceWas: orderbookPrice } : {}),
                }, null, 2),
              }],
            };
          } catch {
            // Fall through to REST
          }
        }

        try {
          const executeResult = await iridium.executeSwap({
            tokenIn, tokenOut,
            direction: params.side === 'buy' ? 'out' : 'in',
            ...(params.side === 'buy' ? { amountOut: rawAmount } : { amountIn: rawAmount }),
            slippageBps: params.slippageBps,
          });

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'executed',
                venue: 'onchain',
                trade: tradeLabel,
                result: executeResult,
              }, null, 2),
            }],
          };
        } catch (execError: any) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'estimate_only',
                trade: tradeLabel,
                venue: 'onchain',
                estimatedPrice: onchainPrice?.toFixed(6),
                ...(orderbookPrice ? { orderbookPrice } : {}),
                fee: onchainEstimate?.fee ? `${(onchainEstimate.fee.bps / 100).toFixed(2)}%` : null,
                action: signingCreds
                  ? 'On-chain execution failed. Try again or execute at cube.exchange/swap.'
                  : 'Run `npm run login` to enable trading, or execute at cube.exchange/swap.',
                error: execError.message,
              }, null, 2),
            }],
            isError: true,
          };
        }
      } catch (error: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${error.message}` }], isError: true };
      }
    }
  );
}
