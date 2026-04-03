import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import {
  correlation, correlationMatrix, returns, mean, standardDeviation,
  sharpeRatio, sortinoRatio, maxDrawdown,
} from '@ai-fund/lib/math';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerDatastoreAnalysisTools(server: McpServer, client: ExchangeClient) {
  const store = client.store;

  server.tool(
    'analyze_cross_symbol',
    `Cross-symbol statistical analysis using cached DuckDB data. Computes correlation matrix, relative returns, Sharpe ratios, and max drawdowns across multiple symbols — essential for pairs trading and portfolio construction.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., "BTC/USDT,ETH/USDT,SOL/USDT")'),
      timeframe: z.string().default('1d').describe('Candle timeframe to analyze'),
      period: z.number().default(90).describe('Number of candles to analyze'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const symbolList = params.symbols.split(',').map((s: string) => s.trim()).filter(Boolean);
      if (symbolList.length < 2) throw new Error('Need at least 2 symbols for cross-symbol analysis.');

      // Fetch close prices for each symbol from cache
      const seriesMap: Record<string, number[]> = {};
      const statsMap: Record<string, any> = {};

      for (const symbol of symbolList) {
        const candles = await store.query({
          symbol,
          interval: params.timeframe,
          exchange: client.exchangeId,
          limit: params.period,
        });

        if (candles.length < 10) {
          throw new Error(`Insufficient cached data for ${symbol} (${candles.length} candles). Run ingest_history first.`);
        }

        const closes = candles.map(c => c.close);
        const rets = returns(closes);
        seriesMap[symbol] = closes;

        const dd = maxDrawdown(closes);
        statsMap[symbol] = {
          candles: candles.length,
          firstPrice: closes[0],
          lastPrice: closes[closes.length - 1],
          totalReturn: Math.round(((closes[closes.length - 1] / closes[0]) - 1) * 10000) / 100,
          avgDailyReturn: Math.round(mean(rets) * 10000) / 100,
          volatility: Math.round(standardDeviation(rets) * 10000) / 100,
          sharpe: Math.round(sharpeRatio(rets) * 100) / 100,
          sortino: Math.round(sortinoRatio(rets) * 100) / 100,
          maxDrawdown: Math.round(dd.maxDrawdown * 10000) / 100,
        };
      }

      // Correlation matrix
      const returnSeries = symbolList.map((s: string) => returns(seriesMap[s]));
      // Align lengths to shortest
      const minLen = Math.min(...returnSeries.map((r: number[]) => r.length));
      const aligned = returnSeries.map((r: number[]) => r.slice(r.length - minLen));
      const corrResult = correlationMatrix(aligned, symbolList);

      // Format as labeled matrix
      const correlations: Record<string, Record<string, number>> = {};
      for (let i = 0; i < symbolList.length; i++) {
        correlations[symbolList[i]] = {};
        for (let j = 0; j < symbolList.length; j++) {
          correlations[symbolList[i]][symbolList[j]] =
            Math.round(corrResult.matrix[i][j] * 1000) / 1000;
        }
      }

      return {
        exchange: client.exchangeId,
        timeframe: params.timeframe,
        period: params.period,
        stats: statsMap,
        correlations,
      };
    }),
  );

  server.tool(
    'get_volume_profile',
    `Compute volume profile (price-weighted volume distribution) from cached DuckDB data. Shows where the most trading activity occurred — essential for support/resistance and optimal order placement.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1h').describe('Candle timeframe'),
      period: z.number().default(200).describe('Number of candles to analyze'),
      bins: z.number().default(20).describe('Number of price bins'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const candles = await store.query({
        symbol: params.symbol,
        interval: params.timeframe,
        exchange: client.exchangeId,
        limit: params.period,
      });

      if (candles.length < 10) {
        throw new Error(`Insufficient cached data (${candles.length} candles). Run ingest_history first.`);
      }

      // Find price range
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const priceMin = Math.min(...lows);
      const priceMax = Math.max(...highs);
      const binSize = (priceMax - priceMin) / params.bins;

      // Build volume profile
      const profile: { priceLevel: number; volume: number; pct: number }[] = [];
      let totalVolume = 0;

      for (let i = 0; i < params.bins; i++) {
        const lo = priceMin + i * binSize;
        const hi = lo + binSize;
        let binVolume = 0;
        for (const c of candles) {
          // Proportional volume allocation based on overlap
          const overlap = Math.max(0,
            Math.min(c.high, hi) - Math.max(c.low, lo)
          );
          const range = c.high - c.low || 1;
          binVolume += c.volume * (overlap / range);
        }
        totalVolume += binVolume;
        profile.push({
          priceLevel: Math.round(((lo + hi) / 2) * 100) / 100,
          volume: Math.round(binVolume * 100) / 100,
          pct: 0,
        });
      }

      // Calculate percentages
      for (const bin of profile) {
        bin.pct = Math.round((bin.volume / totalVolume) * 10000) / 100;
      }

      // Point of control (highest volume bin)
      const poc = profile.reduce((max, b) => b.volume > max.volume ? b : max, profile[0]);

      // Value area (70% of volume around POC)
      const sorted = [...profile].sort((a, b) => b.volume - a.volume);
      let vaVolume = 0;
      const vaTarget = totalVolume * 0.7;
      const vaBins: number[] = [];
      for (const bin of sorted) {
        if (vaVolume >= vaTarget) break;
        vaVolume += bin.volume;
        vaBins.push(bin.priceLevel);
      }

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        candles: candles.length,
        priceRange: { min: Math.round(priceMin * 100) / 100, max: Math.round(priceMax * 100) / 100 },
        pointOfControl: poc.priceLevel,
        valueArea: {
          high: Math.round(Math.max(...vaBins) * 100) / 100,
          low: Math.round(Math.min(...vaBins) * 100) / 100,
        },
        profile,
      };
    }),
  );

  server.tool(
    'get_vwap',
    `Compute VWAP (Volume-Weighted Average Price) from cached DuckDB data. The execution benchmark used by every institutional desk. Compares current price to VWAP for mean-reversion signals.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1h').describe('Candle timeframe'),
      period: z.number().default(24).describe('Number of candles for VWAP calculation'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      // Use SQL for VWAP — this is what DuckDB excels at
      const rows = await store.sql(
        `SELECT
           SUM(close * volume) / NULLIF(SUM(volume), 0) as vwap,
           SUM(volume) as total_volume,
           COUNT(*) as candles,
           MIN(ts) as start_ts,
           MAX(ts) as end_ts
         FROM (
           SELECT close, volume, ts FROM ohlcv
           WHERE symbol = ? AND interval = ? AND exchange = ?
           ORDER BY ts DESC
           LIMIT ?
         )`,
        [params.symbol, params.timeframe, client.exchangeId, params.period],
      );

      const row = rows[0];
      if (!row || !row.vwap) {
        throw new Error(`No cached data for ${params.symbol}. Run ingest_history first.`);
      }

      // Get current price for comparison
      let currentPrice: number | undefined;
      try {
        const ticker = await client.getTicker(params.symbol);
        currentPrice = ticker.last ?? undefined;
      } catch { /* best effort */ }

      const vwap = row.vwap as number;
      const deviation = currentPrice != null
        ? Math.round(((currentPrice - vwap) / vwap) * 10000) / 100
        : undefined;

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        vwap: Math.round(vwap * 100) / 100,
        totalVolume: Math.round((row.total_volume as number) * 100) / 100,
        candles: row.candles,
        startTime: row.start_ts,
        endTime: row.end_ts,
        currentPrice,
        deviationFromVwapPct: deviation,
        signal: deviation != null
          ? (deviation > 2 ? 'Above VWAP (potential resistance)'
            : deviation < -2 ? 'Below VWAP (potential support)'
            : 'Near VWAP (neutral)')
          : undefined,
      };
    }),
  );

  server.tool(
    'detect_correlation_regime',
    `Rolling correlation with regime change detection between two symbols. Computes rolling correlation over a sliding window, detects regime transitions (decorrelation events, sign flips), and classifies the current regime. Essential for pairs trading and dynamic hedging.`,
    {
      symbol_a: z.string().describe('First trading pair (e.g., BTC/USDT)'),
      symbol_b: z.string().describe('Second trading pair (e.g., ETH/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      window: z.number().default(30).describe('Rolling correlation window size'),
      lookback: z.number().default(200).describe('Total number of bars to analyze'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const window: number = params.window;
      const lookback: number = params.lookback;

      // Fetch candles for both symbols
      const candlesA = await store.query({
        symbol: params.symbol_a,
        interval: params.timeframe,
        exchange: client.exchangeId,
        limit: lookback,
      });
      const candlesB = await store.query({
        symbol: params.symbol_b,
        interval: params.timeframe,
        exchange: client.exchangeId,
        limit: lookback,
      });

      if (candlesA.length < window + 1) {
        throw new Error(`Insufficient cached data for ${params.symbol_a} (${candlesA.length} candles, need ${window + 1}). Run ingest_history first.`);
      }
      if (candlesB.length < window + 1) {
        throw new Error(`Insufficient cached data for ${params.symbol_b} (${candlesB.length} candles, need ${window + 1}). Run ingest_history first.`);
      }

      const closesA = candlesA.map((c: any) => c.close);
      const closesB = candlesB.map((c: any) => c.close);

      // Align to same length
      const minLen = Math.min(closesA.length, closesB.length);
      const alignedA = closesA.slice(closesA.length - minLen);
      const alignedB = closesB.slice(closesB.length - minLen);

      const returnsA = returns(alignedA);
      const returnsB = returns(alignedB);

      // Compute rolling correlation
      const rollingCorr: { index: number; correlation: number }[] = [];
      for (let i = window - 1; i < returnsA.length; i++) {
        const sliceA = returnsA.slice(i - window + 1, i + 1);
        const sliceB = returnsB.slice(i - window + 1, i + 1);
        const corr = correlation(sliceA, sliceB);
        rollingCorr.push({ index: i, correlation: Math.round(corr * 1000) / 1000 });
      }

      // Detect regime transitions: zero crossings and sign flips
      const transitions: { index: number; from: number; to: number; type: string }[] = [];
      for (let i = 1; i < rollingCorr.length; i++) {
        const prev = rollingCorr[i - 1].correlation;
        const curr = rollingCorr[i].correlation;
        if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) {
          transitions.push({
            index: rollingCorr[i].index,
            from: prev,
            to: curr,
            type: prev >= 0 && curr < 0 ? 'decorrelation' : 'recorrelation',
          });
        }
      }

      // Classify current regime
      const currentCorr = rollingCorr.length > 0
        ? rollingCorr[rollingCorr.length - 1].correlation
        : 0;

      let currentRegime: string;
      if (currentCorr > 0.7) currentRegime = 'highly_correlated';
      else if (currentCorr > 0.3) currentRegime = 'moderately_correlated';
      else if (currentCorr >= -0.3) currentRegime = 'uncorrelated';
      else currentRegime = 'inversely_correlated';

      // Average correlation
      const avgCorr = rollingCorr.length > 0
        ? Math.round(mean(rollingCorr.map(r => r.correlation)) * 1000) / 1000
        : 0;

      // Sample the rolling series to avoid huge payloads (max ~50 points)
      const step = Math.max(1, Math.floor(rollingCorr.length / 50));
      const sampled = rollingCorr.filter((_, i) => i % step === 0 || i === rollingCorr.length - 1);

      return {
        symbolA: params.symbol_a,
        symbolB: params.symbol_b,
        timeframe: params.timeframe,
        window,
        dataPoints: rollingCorr.length,
        currentCorrelation: currentCorr,
        currentRegime,
        averageCorrelation: avgCorr,
        transitions,
        rollingSeries: sampled,
      };
    }),
  );
}
