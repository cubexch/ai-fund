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
