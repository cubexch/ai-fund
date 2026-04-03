/* eslint-disable @typescript-eslint/no-explicit-any */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import {
  sma, ema, rsi, macd, bollingerBands, atr, obv, stochastic,
  type OHLCV,
} from '@ai-fund/lib/indicators';
import {
  mean, standardDeviation, zScore, returns, annualizedVolatility,
} from '@ai-fund/lib/math';
import {
  detectConfluence,
  detectBbSqueeze,
  scanMeanReversion,
  computeVolTermStructure,
  PERIODS_PER_YEAR,
} from '@ai-fund/lib/confluence-detector';

export function registerStrategyAnalysisTools(server: McpServer, client: ExchangeClient) {
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
    'detect_confluence',
    `Multi-timeframe signal confluence detector on ${client.name}. Analyzes RSI, MACD, SMA trend, Bollinger Band position, and price vs EMA across multiple timeframes to find agreement.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframes: z.string().default('5m,15m,1h,4h,1d').describe('Comma-separated timeframes to analyze'),
    } as any,
    handler(async (params: any) => {
      const tfList = params.timeframes.split(',').map((t: string) => t.trim());

      const barsPerTimeframe: Record<string, OHLCV[]> = {};
      for (const tf of tfList) {
        const bars = await client.getBars(params.symbol, tf, undefined, 100);
        if (bars.length < 51) {
          throw new Error(`Insufficient data for timeframe ${tf}: got ${bars.length} bars, need at least 51`);
        }
        barsPerTimeframe[tf] = bars.map((b: any) => ({
          open: b.open, high: b.high, low: b.low, close: b.close,
          volume: b.volume, timestamp: b.timestamp,
        }));
      }

      const result = detectConfluence(barsPerTimeframe);

      return {
        symbol: params.symbol,
        timeframes: tfList,
        ...result,
      };
    }),
  );

  server.tool(
    'detect_bb_squeeze',
    `Bollinger Band squeeze detector on ${client.name}. Identifies low-volatility compression that often precedes breakouts. Scans multiple symbols and ranks by squeeze intensity.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., BTC/USDT,ETH/USDT)'),
      timeframe: z.string().default('4h').describe('Candle timeframe'),
      period: z.number().default(20).describe('Bollinger Band period'),
      squeeze_threshold: z.number().default(0.5).describe('Squeeze if bandwidth < threshold * mean bandwidth'),
    } as any,
    handler(async (params: any) => {
      const symbolList = params.symbols.split(',').map((s: string) => s.trim());
      const results: {
        symbol: string;
        inSqueeze: boolean;
        bandwidth: number;
        avgBandwidth: number;
        squeezeRatio: number;
        squeezeDuration: number;
        pricePosition: string;
        signal: string;
      }[] = [];

      for (const symbol of symbolList) {
        const bars = await client.getBars(symbol, params.timeframe, undefined, 120);
        if (bars.length < params.period + 1) {
          throw new Error(`Insufficient data for ${symbol}: got ${bars.length} bars, need at least ${params.period + 1}`);
        }

        const closes = bars.map((b: any) => b.close);
        const squeezeResult = detectBbSqueeze(closes, params.period, params.squeeze_threshold);

        results.push({
          symbol,
          ...squeezeResult,
        });
      }

      // Sort by squeeze ratio (lowest = tightest squeeze first)
      results.sort((a, b) => a.squeezeRatio - b.squeezeRatio);

      return {
        timeframe: params.timeframe,
        results,
      };
    }),
  );

  server.tool(
    'scan_mean_reversion',
    `Scan cached DuckDB data for mean reversion opportunities using Z-scores on ${client.name}. Flags overbought/oversold symbols based on deviation from rolling mean.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., BTC/USDT,ETH/USDT,SOL/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      lookback: z.number().default(50).describe('Lookback period for mean/std calculation'),
      zscore_threshold: z.number().default(2.0).describe('Z-score threshold to flag opportunities'),
    } as any,
    handler(async (params: any) => {
      const symbolList = params.symbols.split(',').map((s: string) => s.trim());
      const store = client.store;

      if (!store) {
        throw new Error('DuckDB store not configured — mean reversion scan requires cached OHLCV data. Use get_bars first to populate the cache.');
      }

      const results: any[] = [];

      for (const symbol of symbolList) {
        const candles = await store.query({
          symbol,
          interval: params.timeframe,
          limit: params.lookback + 1,
        });

        if (candles.length < params.lookback) {
          results.push({
            symbol,
            error: `Insufficient data: got ${candles.length} candles, need ${params.lookback}`,
          });
          continue;
        }

        const closes = candles.map(c => c.close);
        const entry = scanMeanReversion(closes, params.lookback, params.zscore_threshold);

        results.push({
          symbol,
          ...entry,
        });
      }

      // Sort by absolute z-score descending
      results.sort((a: any, b: any) => {
        const aZ = Math.abs(a.zscore ?? 0);
        const bZ = Math.abs(b.zscore ?? 0);
        return bZ - aZ;
      });

      const opportunities = results.filter((r: any) => r.signal && r.signal !== 'neutral' && !r.error);

      return {
        scanned: symbolList.length,
        timeframe: params.timeframe,
        lookback: params.lookback,
        zscoreThreshold: params.zscore_threshold,
        opportunities: opportunities.length,
        results,
      };
    }),
  );

  server.tool(
    'get_volatility_term_structure',
    `Build volatility term structure from multiple timeframes on ${client.name}. Computes annualized volatility per timeframe and classifies the term structure as normal or inverted.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframes: z.string().default('1h,4h,1d,1w').describe('Comma-separated timeframes to analyze'),
    } as any,
    handler(async (params: any) => {
      const tfList = params.timeframes.split(',').map((t: string) => t.trim());

      const barsPerTimeframe: Record<string, number[]> = {};
      for (const tf of tfList) {
        const bars = await client.getBars(params.symbol, tf, undefined, 100);
        if (bars.length < 2) {
          throw new Error(`Insufficient data for timeframe ${tf}: got ${bars.length} bars, need at least 2`);
        }
        barsPerTimeframe[tf] = bars.map((b: any) => b.close);
      }

      const result = computeVolTermStructure(barsPerTimeframe);

      return {
        symbol: params.symbol,
        ...result,
      };
    }),
  );
}
