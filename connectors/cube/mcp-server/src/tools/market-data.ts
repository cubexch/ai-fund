import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { IridiumClient } from '../client/iridium.js';
import type { MendelevClient } from '../client/mendelev.js';
import { sma, ema, rsi, macd, bollingerBands, atr, adx, obv, stochastic } from '../../../../../lib/indicators.js';
import type { OHLCV } from '../../../../../lib/indicators.js';

export function registerMarketDataTools(server: McpServer, iridium: IridiumClient, mendelev?: MendelevClient) {
  const defaultSubaccountId = () => iridium.getDefaultSubaccountId();

  // Helper: resolve a symbol string to a market object
  async function resolveMarket(params: { symbol?: string; marketId?: number }) {
    const markets = await iridium.getMarkets();
    if (params.symbol) {
      const market = markets.find(m => m.symbol === params.symbol);
      if (!market) throw new Error(`Unknown symbol: ${params.symbol}`);
      return { market, markets };
    }
    if (params.marketId !== undefined) {
      const market = markets.find(m => m.marketId === params.marketId);
      if (!market) throw new Error(`Unknown marketId: ${params.marketId}`);
      return { market, markets };
    }
    throw new Error('Either symbol or marketId must be provided');
  }

  server.tool(
    'get_assets',
    'List all available trading assets with their trading pairs, lot sizes, tick sizes, and status.',
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
    'Get real-time ticker data for all assets: last price, bid/ask, 24h volume, 24h high/low/open, and 24h change %. Uses WebSocket for real-time data when available.',
    {},
    async () => {
      try {
        // If mendelev tops WebSocket is connected, augment REST data with real-time tops
        const tickers = await iridium.getTickers();

        if (mendelev?.isTopsConnected) {
          const tops = mendelev.getTops();
          if (tops.length > 0) {
            // Get markets to map marketId → symbol
            const markets = await iridium.getMarkets();
            const marketMap = new Map(markets.map(m => [m.marketId, m]));

            for (const top of tops) {
              const market = marketMap.get(top.marketId);
              if (!market) continue;

              const ticker = tickers.find(t => t.symbol === market.symbol);
              if (ticker && top.lastPrice !== null) {
                // WebSocket tops have raw lot prices — convert using tick size
                const tickSize = parseFloat(market.priceTickSize);
                if (tickSize > 0) {
                  const wsLastPrice = Number(top.lastPrice) * tickSize;
                  const wsBidPrice = top.bidPrice !== null ? Number(top.bidPrice) * tickSize : null;
                  const wsAskPrice = top.askPrice !== null ? Number(top.askPrice) * tickSize : null;

                  // Update with real-time WebSocket values
                  ticker.lastPrice = wsLastPrice;
                  if (wsBidPrice !== null) ticker.bidPrice = wsBidPrice;
                  if (wsAskPrice !== null) ticker.askPrice = wsAskPrice;

                  // Recalculate 24h change with updated price
                  if (ticker.open24h && ticker.lastPrice) {
                    ticker.change24h = ((ticker.lastPrice - ticker.open24h) / ticker.open24h) * 100;
                  }
                }
              }
            }
          }
        }

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
    'get_order_book',
    'Get the current order book (bids and asks with prices and quantities) for an asset. Uses WebSocket for real-time data when subscribed.',
    {
      symbol: z.string().optional().describe('Asset symbol, e.g. "BTCUSDC", "ETHUSDC", "SOLUSDC"'),
      marketId: z.number().optional().describe('Numeric market ID (alternative to symbol)'),
    },
    async params => {
      try {
        if (!params.symbol && params.marketId === undefined) {
          return {
            content: [{ type: 'text' as const, text: 'Either symbol or marketId must be provided' }],
            isError: true,
          };
        }

        const { market } = await resolveMarket(params);
        const marketSymbol = market.symbol;

        // Try WebSocket first if we have a subscription
        if (mendelev) {
          if (mendelev.isSubscribed(market.marketId)) {
            const book = mendelev.getOrderBook(market.marketId);
            if (book) {
              const tickSize = parseFloat(market.priceTickSize);
              const qtyTick = parseFloat(market.quantityTickSize);
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    ticker_id: marketSymbol,
                    source: 'websocket',
                    bids: book.bids.slice(0, 20).map(l => [
                      Number(l.price) * tickSize,
                      Number(l.quantity) * qtyTick,
                    ]),
                    asks: book.asks.slice(0, 20).map(l => [
                      Number(l.price) * tickSize,
                      Number(l.quantity) * qtyTick,
                    ]),
                  }, null, 2),
                }],
              };
            }
          }

          // Auto-subscribe for future calls (non-blocking)
          if (!mendelev.isSubscribed(market.marketId)) {
            mendelev.subscribe(market.marketId).catch(() => {});
          }
        }

        // Fall back to REST
        const book = await iridium.getOrderBook(marketSymbol);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(book, null, 2),
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
    'get_trades',
    'Get recent trades for an asset. Shows trade price, volume, timestamp, and side (buy/sell).',
    {
      symbol: z.string().optional().describe('Asset symbol, e.g. "BTCUSDC", "ETHUSDC", "SOLUSDC"'),
      marketId: z.number().optional().describe('Numeric market ID (alternative to symbol)'),
    },
    async params => {
      try {
        if (!params.symbol && params.marketId === undefined) {
          return {
            content: [{ type: 'text' as const, text: 'Either symbol or marketId must be provided' }],
            isError: true,
          };
        }

        const { market } = await resolveMarket(params);
        const marketSymbol = market.symbol;

        // Try WebSocket first if subscribed
        if (mendelev) {
          if (mendelev.isSubscribed(market.marketId)) {
            const trades = mendelev.getRecentTrades(market.marketId);
            if (trades.length > 0) {
              const tickSize = parseFloat(market.priceTickSize);
              const qtyTick = parseFloat(market.quantityTickSize);
              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    ticker_id: marketSymbol,
                    source: 'websocket',
                    trades: trades.map(t => ({
                      id: t.tradeId,
                      p: Number(t.price) * tickSize,
                      q: Number(t.quantity) * qtyTick,
                      side: t.side === 'BID' ? 'buy' : 'sell',
                      ts: Number(t.timestamp),
                    })),
                  }, null, 2),
                }],
              };
            }
          }
        }

        // Fall back to REST
        const trades = await iridium.getRecentTrades(marketSymbol);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(trades, null, 2),
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
    'get_bars',
    'Get historical OHLCV candlestick data for an asset. Useful for technical analysis, backtesting, and charting.',
    {
      symbol: z.string().optional().describe('Market symbol (e.g. "BTCUSDC", "SOLUSDC")'),
      marketId: z.number().optional().describe('Numeric market ID (alternative to symbol)'),
      interval: z.enum(['1s', '1m', '15m', '1h', '4h', '1d']).default('1h').describe('Candlestick interval'),
      limit: z.number().default(100).describe('Number of candles to return (max 1000)'),
    },
    async params => {
      try {
        if (!params.symbol && params.marketId === undefined) {
          return {
            content: [{ type: 'text' as const, text: 'Either symbol or marketId must be provided' }],
            isError: true,
          };
        }
        const { market } = await resolveMarket(params);
        const candles = await iridium.getPriceHistory(market.marketId, params.interval, params.limit);

        let freshnessWarning: string | undefined;
        if (candles.length > 0) {
          const mostRecentMs = candles[0].startTime;
          const ageMs = Date.now() - mostRecentMs;
          const ageHours = ageMs / 3_600_000;
          if (ageHours > 24) {
            const ageDays = Math.floor(ageHours / 24);
            freshnessWarning = `WARNING: Most recent candle is ${ageDays} day(s) old. This market may have low liquidity or be inactive.`;
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  ...(freshnessWarning ? { freshnessWarning } : {}),
                  candleCount: candles.length,
                  mostRecentCandle: candles.length > 0 ? new Date(candles[0].startTime).toISOString() : null,
                  candles,
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
    'get_fees',
    'Get estimated trading fees for a specific trade. Returns maker and taker fee rates.',
    {
      subaccountId: z.number().optional().describe('Subaccount ID (defaults to configured subaccount)'),
      symbol: z.string().optional().describe('Market symbol (e.g. "BTCUSDC", "SOLUSDC")'),
      marketId: z.number().optional().describe('Numeric market ID (alternative to symbol)'),
      side: z.enum(['Bid', 'Ask']).describe('Trade side'),
      price: z.number().describe('Order price'),
      postOnly: z.enum(['Disabled', 'Enabled']).default('Disabled').describe('Post-only mode'),
      quantity: z.number().optional().describe('Trade quantity (in base asset smallest unit)'),
      quoteQuantity: z.number().optional().describe('Trade quantity (in quote asset smallest unit)'),
    },
    async params => {
      try {
        if (!params.symbol && params.marketId === undefined) {
          return {
            content: [{ type: 'text' as const, text: 'Either symbol or marketId must be provided' }],
            isError: true,
          };
        }
        const { market } = await resolveMarket(params);
        const fees = await iridium.getEstimatedFees(
          params.subaccountId ?? await defaultSubaccountId(),
          market.marketId,
          params.side,
          params.price,
          params.postOnly,
          params.quantity,
          params.quoteQuantity
        );
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

  server.tool(
    'get_technical_analysis',
    'Run technical analysis on an asset: SMA, EMA, RSI, MACD, Bollinger Bands, ATR, ADX, OBV, and Stochastic.',
    {
      symbol: z.string().optional().describe('Market symbol (e.g. "BTCUSDC", "SOLUSDC")'),
      marketId: z.number().optional().describe('Numeric market ID (alternative to symbol)'),
      interval: z.enum(['1s', '1m', '15m', '1h', '4h', '1d']).default('1h').describe('Candlestick interval'),
      limit: z.number().default(200).describe('Number of candles to fetch (more = better indicator accuracy)'),
      indicators: z
        .array(z.enum(['sma', 'ema', 'rsi', 'macd', 'bollinger', 'atr', 'adx', 'obv', 'stochastic']))
        .default(['rsi', 'macd', 'bollinger', 'atr'])
        .describe('Which indicators to compute'),
    },
    async params => {
      try {
        if (!params.symbol && params.marketId === undefined) {
          return {
            content: [{ type: 'text' as const, text: 'Either symbol or marketId must be provided' }],
            isError: true,
          };
        }
        const { market: resolvedMarket } = await resolveMarket(params);
        const candles = await iridium.getPriceHistory(resolvedMarket.marketId, params.interval, params.limit);

        if (candles.length < 30) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Insufficient data: only ${candles.length} candles available. Need at least 30 for meaningful indicators.`,
              },
            ],
            isError: true,
          };
        }

        const sorted = [...candles].reverse();
        const closes = sorted.map(k => parseFloat(k.close));
        const ohlcv: OHLCV[] = sorted.map(k => ({
          open: parseFloat(k.open),
          high: parseFloat(k.high),
          low: parseFloat(k.low),
          close: parseFloat(k.close),
          volume: parseFloat(k.volume),
          timestamp: k.startTime,
        }));

        const result: Record<string, unknown> = {
          market: resolvedMarket.symbol,
          interval: params.interval,
          candleCount: candles.length,
          latestClose: closes[closes.length - 1],
          latestTimestamp: new Date(sorted[sorted.length - 1].startTime).toISOString(),
        };

        const ageMs = Date.now() - sorted[sorted.length - 1].startTime;
        if (ageMs > 86_400_000) {
          result.freshnessWarning = `Most recent candle is ${Math.floor(ageMs / 86_400_000)} day(s) old.`;
        }

        const last = (arr: number[]) => arr[arr.length - 1];
        const lastN = (arr: number[], n: number) => arr.slice(-n);

        for (const ind of params.indicators) {
          switch (ind) {
            case 'sma': {
              const sma20 = sma(closes, 20);
              const sma50 = sma(closes, 50);
              result.sma = {
                sma20: last(sma20)?.toFixed(2),
                sma50: sma50.length > 0 ? last(sma50).toFixed(2) : 'insufficient data',
                trend: sma20.length > 0 && sma50.length > 0
                  ? (last(sma20) > last(sma50) ? 'BULLISH' : 'BEARISH')
                  : 'unknown',
              };
              break;
            }
            case 'ema': {
              const ema12 = ema(closes, 12);
              const ema26 = ema(closes, 26);
              result.ema = {
                ema12: last(ema12)?.toFixed(2),
                ema26: last(ema26)?.toFixed(2),
                trend: last(ema12) > last(ema26) ? 'BULLISH' : 'BEARISH',
              };
              break;
            }
            case 'rsi': {
              const rsiValues = rsi(closes, 14);
              const currentRsi = last(rsiValues);
              result.rsi = {
                value: currentRsi?.toFixed(1),
                signal: currentRsi > 70 ? 'OVERBOUGHT' : currentRsi < 30 ? 'OVERSOLD' : 'NEUTRAL',
                recent: lastN(rsiValues, 5).map(v => parseFloat(v.toFixed(1))),
              };
              break;
            }
            case 'macd': {
              const macdResult = macd(closes);
              result.macd = {
                macd: last(macdResult.macd)?.toFixed(4),
                signal: last(macdResult.signal)?.toFixed(4),
                histogram: last(macdResult.histogram)?.toFixed(4),
                trend: last(macdResult.histogram) > 0 ? 'BULLISH' : 'BEARISH',
                recentHistogram: lastN(macdResult.histogram, 5).map(v => parseFloat(v.toFixed(4))),
              };
              break;
            }
            case 'bollinger': {
              const bb = bollingerBands(closes, 20, 2);
              const latestPrice = closes[closes.length - 1];
              const bbUpper = last(bb.upper);
              const bbLower = last(bb.lower);
              const bbMiddle = last(bb.middle);
              const bbWidth = last(bb.width);

              const recentWidths = bb.width.slice(-120);
              const sortedWidths = [...recentWidths].sort((a, b) => a - b);
              const percentileIdx = sortedWidths.findIndex(w => w >= bbWidth);
              const percentile = Math.round((percentileIdx / sortedWidths.length) * 100);

              result.bollinger = {
                upper: bbUpper?.toFixed(2),
                middle: bbMiddle?.toFixed(2),
                lower: bbLower?.toFixed(2),
                bandwidth: bbWidth?.toFixed(4),
                bandwidthPercentile: percentile,
                squeeze: percentile < 20 ? 'ACTIVE' : percentile < 40 ? 'BUILDING' : 'NONE',
                pricePosition: latestPrice > bbUpper ? 'ABOVE_UPPER' :
                  latestPrice < bbLower ? 'BELOW_LOWER' :
                  latestPrice > bbMiddle ? 'UPPER_HALF' : 'LOWER_HALF',
              };
              break;
            }
            case 'atr': {
              const atrValues = atr(ohlcv, 14);
              const currentAtr = last(atrValues);
              const avgAtr = atrValues.length >= 50
                ? atrValues.slice(-50).reduce((a, b) => a + b, 0) / 50
                : currentAtr;
              const atrRatio = currentAtr / avgAtr;

              result.atr = {
                value: currentAtr?.toFixed(4),
                avg50: avgAtr?.toFixed(4),
                regime: atrRatio < 0.8 ? 'CONTRACTING' :
                  atrRatio > 2.0 ? 'SPIKE' :
                  atrRatio > 1.2 ? 'EXPANDING' : 'STABLE',
                ratio: atrRatio?.toFixed(2),
              };
              break;
            }
            case 'adx': {
              const adxValues = adx(ohlcv, 14);
              const currentAdx = last(adxValues);
              result.adx = {
                value: currentAdx?.toFixed(1),
                strength: currentAdx > 50 ? 'STRONG_TREND' :
                  currentAdx > 25 ? 'TRENDING' :
                  currentAdx > 20 ? 'WEAK_TREND' : 'NO_TREND',
              };
              break;
            }
            case 'obv': {
              const obvValues = obv(ohlcv);
              const obvSlope = obvValues.length >= 10
                ? obvValues[obvValues.length - 1] - obvValues[obvValues.length - 10]
                : 0;
              result.obv = {
                current: last(obvValues)?.toFixed(0),
                slope10: obvSlope > 0 ? 'RISING' : 'FALLING',
              };
              break;
            }
            case 'stochastic': {
              const stochResult = stochastic(ohlcv, 14, 3);
              const k = last(stochResult.k);
              const d = last(stochResult.d);
              result.stochastic = {
                k: k?.toFixed(1),
                d: d?.toFixed(1),
                signal: k > 80 ? 'OVERBOUGHT' : k < 20 ? 'OVERSOLD' : 'NEUTRAL',
                crossover: k > d ? 'BULLISH' : 'BEARISH',
              };
              break;
            }
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
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
