import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { handler, authHandler } from './handler.js';
import {
  sma, ema, rsi, macd, bollingerBands, atr, adx, obv, stochastic,
  type OHLCV,
} from '../../../../../lib/indicators.js';
import {
  kelly, fixedFractionalSize,
} from '../../../../../lib/math.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerStrategyTools(server: McpServer, client: ExchangeClient) {
  server.tool(
    'get_technical_analysis',
    `Run technical analysis on ${client.name} OHLCV data. Computes SMA, EMA, RSI, MACD, Bollinger Bands, ATR, ADX, OBV, and Stochastic. Essential for trading signals.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      limit: z.number().default(100).describe('Number of candles to analyze'),
    } as any,
    handler(async (params: any) => {
      const bars = await client.getBars(params.symbol, params.timeframe, undefined, params.limit);
      if (bars.length < 26) {
        throw new Error(`Need at least 26 candles for analysis, got ${bars.length}`);
      }

      const candles: OHLCV[] = bars.map(b => ({
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        timestamp: b.timestamp,
      }));
      const closes = candles.map(c => c.close);

      const sma20 = sma(closes, 20);
      const sma50 = sma(closes, 50);
      const ema12 = ema(closes, 12);
      const ema26 = ema(closes, 26);
      const rsi14 = rsi(closes, 14);
      const macdResult = macd(closes, 12, 26, 9);
      const bb = bollingerBands(closes, 20, 2);
      const atr14 = atr(candles, 14);
      const obvValues = obv(candles);
      const stochResult = stochastic(candles, 14, 3);

      // Latest values
      const latest = {
        price: closes[closes.length - 1],
        sma20: sma20.length > 0 ? sma20[sma20.length - 1] : null,
        sma50: sma50.length > 0 ? sma50[sma50.length - 1] : null,
        ema12: ema12.length > 0 ? ema12[ema12.length - 1] : null,
        ema26: ema26.length > 0 ? ema26[ema26.length - 1] : null,
        rsi: rsi14.length > 0 ? Math.round(rsi14[rsi14.length - 1] * 100) / 100 : null,
        macd: macdResult.macd.length > 0 ? {
          macd: Math.round(macdResult.macd[macdResult.macd.length - 1] * 100) / 100,
          signal: Math.round(macdResult.signal[macdResult.signal.length - 1] * 100) / 100,
          histogram: Math.round(macdResult.histogram[macdResult.histogram.length - 1] * 100) / 100,
        } : null,
        bollingerBands: bb.upper.length > 0 ? {
          upper: Math.round(bb.upper[bb.upper.length - 1] * 100) / 100,
          middle: Math.round(bb.middle[bb.middle.length - 1] * 100) / 100,
          lower: Math.round(bb.lower[bb.lower.length - 1] * 100) / 100,
        } : null,
        atr: atr14.length > 0 ? Math.round(atr14[atr14.length - 1] * 100) / 100 : null,
        obv: obvValues.length > 0 ? obvValues[obvValues.length - 1] : null,
        stochastic: stochResult.k.length > 0 ? {
          k: Math.round(stochResult.k[stochResult.k.length - 1] * 100) / 100,
          d: Math.round(stochResult.d[stochResult.d.length - 1] * 100) / 100,
        } : null,
      };

      // Signals
      const signals: string[] = [];
      if (latest.rsi != null) {
        if (latest.rsi > 70) signals.push('RSI overbought (>70)');
        else if (latest.rsi < 30) signals.push('RSI oversold (<30)');
      }
      if (latest.macd?.histogram != null) {
        if (latest.macd.histogram > 0) signals.push('MACD bullish (histogram > 0)');
        else signals.push('MACD bearish (histogram < 0)');
      }
      if (latest.sma20 != null && latest.sma50 != null) {
        if (latest.sma20 > latest.sma50) signals.push('SMA20 > SMA50 (bullish trend)');
        else signals.push('SMA20 < SMA50 (bearish trend)');
      }
      if (latest.bollingerBands != null) {
        if (latest.price > latest.bollingerBands.upper) signals.push('Price above upper Bollinger Band');
        else if (latest.price < latest.bollingerBands.lower) signals.push('Price below lower Bollinger Band');
      }

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        candles: bars.length,
        latest,
        signals,
      };
    }),
  );

  server.tool(
    'calculate_position_size',
    `Calculate optimal position size using Kelly criterion or fixed-fractional method. Uses portfolio value, win rate, and risk parameters.`,
    {
      method: z.enum(['kelly', 'fixed_fractional']).describe('Sizing method'),
      portfolio_value: z.number().describe('Total portfolio value in quote currency'),
      win_rate: z.number().optional().describe('Historical win rate (0-1, for Kelly)'),
      avg_win_loss_ratio: z.number().optional().describe('Average win / average loss (for Kelly)'),
      risk_per_trade: z.number().optional().describe('Risk per trade as decimal (e.g., 0.02 for 2%, for fixed-fractional)'),
      entry_price: z.number().optional().describe('Planned entry price (for fixed-fractional)'),
      stop_loss_price: z.number().optional().describe('Stop-loss price (for fixed-fractional)'),
      symbol: z.string().optional().describe('Trading pair — used to round to exchange precision'),
    } as any,
    handler(async (params: any) => {
      if (params.method === 'kelly') {
        if (params.win_rate == null || params.avg_win_loss_ratio == null) {
          throw new Error('Kelly method requires win_rate and avg_win_loss_ratio');
        }
        const fraction = kelly(params.win_rate, params.avg_win_loss_ratio, true);
        const capitalToRisk = params.portfolio_value * fraction;
        const price = params.entry_price ?? 1;
        let positionSize = capitalToRisk / price;

        if (params.symbol) {
          await client.ensureMarkets();
          positionSize = client.roundAmount(params.symbol, positionSize);
        }

        return {
          method: 'kelly',
          halfKelly: true,
          kellyFraction: Math.round(fraction * 10000) / 10000,
          capitalToRisk: Math.round(capitalToRisk * 100) / 100,
          positionSize,
          entryPrice: params.entry_price,
          portfolioValue: params.portfolio_value,
        };
      }

      // Fixed fractional
      if (params.risk_per_trade == null || params.entry_price == null || params.stop_loss_price == null) {
        throw new Error('Fixed-fractional method requires risk_per_trade, entry_price, and stop_loss_price');
      }
      let positionSize = fixedFractionalSize(
        params.portfolio_value,
        params.risk_per_trade,
        params.entry_price,
        params.stop_loss_price,
      );
      const maxLoss = params.portfolio_value * params.risk_per_trade;

      if (params.symbol) {
        await client.ensureMarkets();
        positionSize = client.roundAmount(params.symbol, positionSize);
      }

      return {
        method: 'fixed_fractional',
        positionSize,
        riskPerTrade: params.risk_per_trade,
        maxLoss: Math.round(maxLoss * 100) / 100,
        entryPrice: params.entry_price,
        stopLossPrice: params.stop_loss_price,
        riskPerUnit: Math.abs(params.entry_price - params.stop_loss_price),
        portfolioValue: params.portfolio_value,
      };
    }),
  );

  server.tool(
    'get_fees',
    `Get trading fee rates on ${client.name}. Returns maker and taker fee percentages — critical for arbitrage profitability calculations.`,
    {
      symbol: z.string().optional().describe('Trading pair to get fees for (omit for top markets)'),
    } as any,
    handler(async (params: any) => {
      return client.getTradingFees(params.symbol);
    }),
  );

  server.tool(
    'get_exchange_info',
    `Get ${client.name} exchange capabilities — supported order types, timeframes, rate limits, market count. Use to check what features are available.`,
    {} as any,
    handler(async () => {
      return client.getExchangeInfo();
    }),
  );

  server.tool(
    'get_market_info',
    `Get detailed market information for a symbol on ${client.name} — precision rules, min/max order sizes, and fee rates. Essential before placing orders to know valid amounts.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
    } as any,
    handler(async (params: any) => {
      return client.getMarketInfo(params.symbol);
    }),
  );
}
