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

      const signals: Record<string, {
        rsi: number;
        rsiSignal: string;
        macd: string;
        trend: string;
        bbPosition: string;
        priceVsEma: string;
      }> = {};

      let bullishCount = 0;
      let bearishCount = 0;

      for (const tf of tfList) {
        const bars = await client.getBars(params.symbol, tf, undefined, 100);
        if (bars.length < 51) {
          throw new Error(`Insufficient data for timeframe ${tf}: got ${bars.length} bars, need at least 51`);
        }

        const candles: OHLCV[] = bars.map((b: any) => ({
          open: b.open, high: b.high, low: b.low, close: b.close,
          volume: b.volume, timestamp: b.timestamp,
        }));
        const closes = candles.map(c => c.close);
        const currentPrice = closes[closes.length - 1];

        // RSI(14)
        const rsi14 = rsi(closes, 14);
        const rsiValue = rsi14.length > 0 ? Math.round(rsi14[rsi14.length - 1] * 100) / 100 : 50;
        const rsiSignal = rsiValue > 70 ? 'overbought' : rsiValue < 30 ? 'oversold' : 'neutral';

        // MACD histogram sign
        const macdResult = macd(closes, 12, 26, 9);
        const histogram = macdResult.histogram.length > 0
          ? macdResult.histogram[macdResult.histogram.length - 1] : 0;
        const macdSignal = histogram > 0 ? 'bullish' : 'bearish';

        // SMA(20) vs SMA(50)
        const sma20 = sma(closes, 20);
        const sma50 = sma(closes, 50);
        const sma20Val = sma20.length > 0 ? sma20[sma20.length - 1] : 0;
        const sma50Val = sma50.length > 0 ? sma50[sma50.length - 1] : 0;
        const trend = sma20Val > sma50Val ? 'bullish' : 'bearish';

        // Bollinger Band position
        const bb = bollingerBands(closes, 20, 2);
        let bbPosition = 'inside';
        if (bb.upper.length > 0) {
          const upperVal = bb.upper[bb.upper.length - 1];
          const lowerVal = bb.lower[bb.lower.length - 1];
          if (currentPrice > upperVal) bbPosition = 'above_upper';
          else if (currentPrice < lowerVal) bbPosition = 'below_lower';
        }

        // Price vs EMA(20)
        const ema20 = ema(closes, 20);
        const ema20Val = ema20.length > 0 ? ema20[ema20.length - 1] : currentPrice;
        const priceVsEma = currentPrice > ema20Val ? 'above' : 'below';

        // Count bullish/bearish signals for this timeframe
        let tfBullish = 0;
        let tfBearish = 0;

        if (macdSignal === 'bullish') tfBullish++; else tfBearish++;
        if (trend === 'bullish') tfBullish++; else tfBearish++;
        if (priceVsEma === 'above') tfBullish++; else tfBearish++;
        if (rsiSignal === 'overbought') tfBearish++;
        else if (rsiSignal === 'oversold') tfBullish++;
        if (bbPosition === 'above_upper') tfBearish++;
        else if (bbPosition === 'below_lower') tfBullish++;

        if (tfBullish > tfBearish) bullishCount++;
        else if (tfBearish > tfBullish) bearishCount++;

        signals[tf] = {
          rsi: rsiValue,
          rsiSignal,
          macd: macdSignal,
          trend,
          bbPosition,
          priceVsEma,
        };
      }

      const total = tfList.length;
      const dominant = bullishCount >= bearishCount ? 'bullish' : 'bearish';
      const dominantCount = Math.max(bullishCount, bearishCount);
      const score = Math.round((dominantCount / total) * 100);
      const strength = score >= 80 ? 'strong' : score >= 60 ? 'moderate' : 'weak';

      return {
        symbol: params.symbol,
        timeframes: tfList,
        signals,
        confluence: {
          bullish: bullishCount,
          bearish: bearishCount,
          score,
          direction: dominant,
          strength,
        },
        recommendation: `${strength.charAt(0).toUpperCase() + strength.slice(1)} ${dominant} confluence across ${dominantCount}/${total} timeframes`,
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
        const bb = bollingerBands(closes, params.period, 2);

        if (bb.upper.length === 0) {
          throw new Error(`Could not compute Bollinger Bands for ${symbol}`);
        }

        // Compute bandwidth series: (upper - lower) / middle * 100
        const bandwidthSeries: number[] = [];
        for (let i = 0; i < bb.upper.length; i++) {
          const bw = bb.middle[i] !== 0
            ? ((bb.upper[i] - bb.lower[i]) / bb.middle[i]) * 100
            : 0;
          bandwidthSeries.push(bw);
        }

        const currentBandwidth = bandwidthSeries[bandwidthSeries.length - 1];
        const avgBandwidth = mean(bandwidthSeries);
        const squeezeRatio = avgBandwidth !== 0 ? currentBandwidth / avgBandwidth : 1;
        const inSqueeze = squeezeRatio < params.squeeze_threshold;

        // Squeeze duration: consecutive bars below threshold
        let squeezeDuration = 0;
        if (inSqueeze) {
          for (let i = bandwidthSeries.length - 1; i >= 0; i--) {
            const ratio = avgBandwidth !== 0 ? bandwidthSeries[i] / avgBandwidth : 1;
            if (ratio < params.squeeze_threshold) {
              squeezeDuration++;
            } else {
              break;
            }
          }
        }

        // Direction hint: price vs middle band
        const currentPrice = closes[closes.length - 1];
        const currentMiddle = bb.middle[bb.middle.length - 1];
        const pricePosition = currentPrice > currentMiddle ? 'above_middle' : 'below_middle';

        // Build signal string
        let signal: string;
        if (inSqueeze) {
          const bias = pricePosition === 'above_middle' ? 'bullish' : 'bearish';
          if (squeezeDuration >= 10) {
            signal = `Extended squeeze (${squeezeDuration} bars) — breakout imminent, bias ${bias}`;
          } else {
            signal = `Tight squeeze — breakout imminent, bias ${bias}`;
          }
        } else {
          signal = 'No squeeze — normal volatility';
        }

        results.push({
          symbol,
          inSqueeze,
          bandwidth: Math.round(currentBandwidth * 10000) / 10000,
          avgBandwidth: Math.round(avgBandwidth * 10000) / 10000,
          squeezeRatio: Math.round(squeezeRatio * 10000) / 10000,
          squeezeDuration,
          pricePosition,
          signal,
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
        const lookbackCloses = closes.slice(-params.lookback);
        const currentPrice = closes[closes.length - 1];

        const avg = mean(lookbackCloses);
        const std = standardDeviation(lookbackCloses);

        if (std === 0) {
          results.push({
            symbol,
            currentPrice,
            mean: avg,
            std: 0,
            zscore: 0,
            signal: 'neutral' as const,
            deviationPct: 0,
          });
          continue;
        }

        const z = zScore(currentPrice, lookbackCloses);
        const deviationPct = ((currentPrice - avg) / avg) * 100;

        let signal: 'overbought' | 'oversold' | 'neutral';
        if (z > params.zscore_threshold) {
          signal = 'overbought';
        } else if (z < -params.zscore_threshold) {
          signal = 'oversold';
        } else {
          signal = 'neutral';
        }

        results.push({
          symbol,
          currentPrice: Math.round(currentPrice * 100) / 100,
          mean: Math.round(avg * 100) / 100,
          std: Math.round(std * 100) / 100,
          zscore: Math.round(z * 10000) / 10000,
          signal,
          deviationPct: Math.round(deviationPct * 100) / 100,
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

      // Periods per year for annualization
      const periodsPerYear: Record<string, number> = {
        '1m': 525600,
        '5m': 105120,
        '15m': 35040,
        '1h': 8760,
        '4h': 2190,
        '1d': 365,
        '1w': 52,
      };

      const structure: {
        timeframe: string;
        annualizedVolatility: number;
        sampleSize: number;
        periodsPerYear: number;
      }[] = [];

      for (const tf of tfList) {
        const bars = await client.getBars(params.symbol, tf, undefined, 100);
        if (bars.length < 2) {
          throw new Error(`Insufficient data for timeframe ${tf}: got ${bars.length} bars, need at least 2`);
        }

        const closes = bars.map((b: any) => b.close);
        const rets = returns(closes);
        const std = standardDeviation(rets);
        const ppy = periodsPerYear[tf] ?? 365;
        const annVol = std * Math.sqrt(ppy);

        structure.push({
          timeframe: tf,
          annualizedVolatility: Math.round(annVol * 10000) / 10000,
          sampleSize: rets.length,
          periodsPerYear: ppy,
        });
      }

      // Compute volatility ratios between adjacent timeframes
      const ratios: { from: string; to: string; ratio: number | null }[] = [];
      for (let i = 0; i < structure.length - 1; i++) {
        const ratio = structure[i + 1].annualizedVolatility !== 0
          ? structure[i].annualizedVolatility / structure[i + 1].annualizedVolatility
          : null;
        ratios.push({
          from: structure[i].timeframe,
          to: structure[i + 1].timeframe,
          ratio: ratio != null ? Math.round(ratio * 10000) / 10000 : null,
        });
      }

      // Classify: normal = longer timeframes have higher annualized vol;
      // inverted = shorter timeframes have higher annualized vol
      let increasingCount = 0;
      let decreasingCount = 0;
      for (let i = 0; i < structure.length - 1; i++) {
        if (structure[i + 1].annualizedVolatility > structure[i].annualizedVolatility) {
          increasingCount++;
        } else {
          decreasingCount++;
        }
      }

      const classification: 'normal' | 'inverted' | 'mixed' =
        structure.length <= 1 ? 'normal' :
        increasingCount > decreasingCount ? 'normal' :
        decreasingCount > increasingCount ? 'inverted' :
        'mixed';

      return {
        symbol: params.symbol,
        structure,
        ratios,
        classification,
      };
    }),
  );
}
