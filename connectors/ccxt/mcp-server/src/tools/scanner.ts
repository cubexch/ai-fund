/**
 * Market scanner tools — real-time signal generation and multi-symbol
 * scanning powered by the SignalGenerator engine.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient, BarResult } from '../client/exchange';
import { handler } from './handler';
import {
  SignalGenerator,
  type TradingSignal,
  type ScanResult,
} from '../client/signal-generator';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Shared helpers ───────────────────────────────────────────

const generator = new SignalGenerator();

async function fetchBarsForAnalysis(
  client: ExchangeClient,
  symbol: string,
  timeframe: string,
  limit: number = 250,
): Promise<BarResult[]> {
  return client.getBars(symbol, timeframe, undefined, limit);
}

function buildScanResult(
  symbol: string,
  signals: TradingSignal[],
): ScanResult {
  const { bias, score } = generator.scoreSignals(signals);
  const topSignal = signals.length > 0
    ? signals.reduce((best, s) =>
        s.confidence * strengthWeight(s.strength) > best.confidence * strengthWeight(best.strength)
          ? s
          : best)
    : null;

  return {
    symbol,
    signals,
    overallBias: bias,
    score,
    topSignal,
  };
}

function strengthWeight(s: TradingSignal['strength']): number {
  return s === 'strong' ? 3 : s === 'moderate' ? 2 : 1;
}

// ── Registration ─────────────────────────────────────────────

export function registerScannerTools(
  server: McpServer,
  getClient: () => ExchangeClient,
) {
  // ── 1. scan_signals ────────────────────────────────────────

  server.tool(
    'scan_signals',
    'Run full signal analysis on a single symbol. Returns all detected signals, overall score, and directional bias.',
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      limit: z.number().default(250).describe('Number of candles to fetch'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const bars = await fetchBarsForAnalysis(client, params.symbol, params.timeframe, params.limit);
      if (bars.length < 55) {
        throw new Error(`Need at least 55 candles for signal analysis, got ${bars.length}`);
      }

      const signals = generator.generateSignals(bars, params.symbol, params.timeframe);
      const result = buildScanResult(params.symbol, signals);

      return {
        symbol: result.symbol,
        currentPrice: bars[bars.length - 1].close,
        timeframe: params.timeframe,
        candlesAnalyzed: bars.length,
        overallBias: result.overallBias,
        score: result.score,
        signalCount: result.signals.length,
        topSignal: result.topSignal,
        signals: result.signals,
      };
    }),
  );

  // ── 2. scan_market ─────────────────────────────────────────

  server.tool(
    'scan_market',
    'Scan multiple symbols for trading opportunities. Returns ranked list of symbols with signals above the minimum score threshold.',
    {
      symbols: z.array(z.string()).describe('Array of trading pairs to scan'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      minScore: z.number().default(0).describe('Minimum absolute score to include (-100 to 100). Use 0 for all, 25 for moderate+ signals.'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const results: ScanResult[] = [];
      const errors: { symbol: string; error: string }[] = [];

      for (const symbol of params.symbols) {
        try {
          const bars = await fetchBarsForAnalysis(client, symbol, params.timeframe);
          if (bars.length < 55) {
            errors.push({ symbol, error: `Insufficient data: ${bars.length} candles` });
            continue;
          }
          const signals = generator.generateSignals(bars, symbol, params.timeframe);
          const result = buildScanResult(symbol, signals);

          if (Math.abs(result.score) >= params.minScore) {
            results.push(result);
          }
        } catch (err: any) {
          errors.push({ symbol, error: err.message ?? String(err) });
        }
      }

      // Sort by absolute score descending (strongest signals first)
      results.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

      return {
        timeframe: params.timeframe,
        scanned: params.symbols.length,
        matched: results.length,
        results: results.map(r => ({
          symbol: r.symbol,
          bias: r.overallBias,
          score: r.score,
          signalCount: r.signals.length,
          topSignal: r.topSignal ? {
            source: r.topSignal.source,
            type: r.topSignal.type,
            strength: r.topSignal.strength,
            confidence: r.topSignal.confidence,
          } : null,
        })),
        errors: errors.length > 0 ? errors : undefined,
      };
    }),
  );

  // ── 3. find_support_resistance ─────────────────────────────

  server.tool(
    'find_support_resistance',
    'Find key support and resistance price levels for a symbol using pivot point analysis and price clustering.',
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      limit: z.number().default(250).describe('Number of candles to analyze'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const bars = await fetchBarsForAnalysis(client, params.symbol, params.timeframe, params.limit);
      if (bars.length < 10) {
        throw new Error(`Need at least 10 candles for support/resistance, got ${bars.length}`);
      }

      const levels = generator.findSupportResistance(bars);
      const currentPrice = bars[bars.length - 1].close;

      // Add distance from current price as percentage
      const withDistance = (lvls: number[]) =>
        lvls.map(level => ({
          level,
          distancePercent: Math.round(((level - currentPrice) / currentPrice) * 10000) / 100,
        }));

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        currentPrice,
        candlesAnalyzed: bars.length,
        supports: withDistance(levels.supports),
        resistances: withDistance(levels.resistances),
        nearestSupport: levels.supports.length > 0
          ? levels.supports.reduce((closest, s) =>
              Math.abs(s - currentPrice) < Math.abs(closest - currentPrice) ? s : closest)
          : null,
        nearestResistance: levels.resistances.length > 0
          ? levels.resistances.reduce((closest, r) =>
              Math.abs(r - currentPrice) < Math.abs(closest - currentPrice) ? r : closest)
          : null,
      };
    }),
  );

  // ── 4. detect_patterns ─────────────────────────────────────

  server.tool(
    'detect_patterns',
    'Detect candlestick patterns (engulfing, doji, hammer, shooting star, three soldiers/crows). Returns detected patterns with signal details.',
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      lookbackBars: z.number().default(100).describe('Number of candles to analyze'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const bars = await fetchBarsForAnalysis(client, params.symbol, params.timeframe, params.lookbackBars);
      if (bars.length < 5) {
        throw new Error(`Need at least 5 candles for pattern detection, got ${bars.length}`);
      }

      const patterns = generator.detectCandlePatterns(bars, params.symbol, params.timeframe);

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        currentPrice: bars[bars.length - 1].close,
        candlesAnalyzed: bars.length,
        patternsDetected: patterns.length,
        patterns: patterns.map(p => ({
          source: p.source,
          type: p.type,
          strength: p.strength,
          confidence: p.confidence,
          metadata: p.metadata,
        })),
      };
    }),
  );

  // ── 5. get_signal_dashboard ────────────────────────────────

  server.tool(
    'get_signal_dashboard',
    'Comprehensive signal dashboard for a watchlist. Returns per-symbol: current price, bias, score, top signal, nearest support/resistance.',
    {
      symbols: z.array(z.string()).describe('Watchlist of trading pairs'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const dashboard: Record<string, unknown>[] = [];
      const errors: { symbol: string; error: string }[] = [];

      for (const symbol of params.symbols) {
        try {
          const bars = await fetchBarsForAnalysis(client, symbol, params.timeframe);
          if (bars.length < 55) {
            errors.push({ symbol, error: `Insufficient data: ${bars.length} candles` });
            continue;
          }

          const signals = generator.generateSignals(bars, symbol, params.timeframe);
          const { bias, score } = generator.scoreSignals(signals);
          const levels = generator.findSupportResistance(bars);
          const currentPrice = bars[bars.length - 1].close;

          const topSignal = signals.length > 0
            ? signals.reduce((best, s) =>
                s.confidence * strengthWeight(s.strength) >
                best.confidence * strengthWeight(best.strength) ? s : best)
            : null;

          const nearestSupport = levels.supports.length > 0
            ? levels.supports.reduce((c, s) =>
                Math.abs(s - currentPrice) < Math.abs(c - currentPrice) ? s : c)
            : null;
          const nearestResistance = levels.resistances.length > 0
            ? levels.resistances.reduce((c, r) =>
                Math.abs(r - currentPrice) < Math.abs(c - currentPrice) ? r : c)
            : null;

          dashboard.push({
            symbol,
            currentPrice,
            bias,
            score,
            signalCount: signals.length,
            topSignal: topSignal ? {
              source: topSignal.source,
              type: topSignal.type,
              strength: topSignal.strength,
              confidence: topSignal.confidence,
            } : null,
            nearestSupport,
            nearestResistance,
            supportDistance: nearestSupport !== null
              ? Math.round(((nearestSupport - currentPrice) / currentPrice) * 10000) / 100
              : null,
            resistanceDistance: nearestResistance !== null
              ? Math.round(((nearestResistance - currentPrice) / currentPrice) * 10000) / 100
              : null,
          });
        } catch (err: any) {
          errors.push({ symbol, error: err.message ?? String(err) });
        }
      }

      // Sort by absolute score descending
      dashboard.sort((a, b) => Math.abs(b.score as number) - Math.abs(a.score as number));

      return {
        timeframe: params.timeframe,
        symbolCount: params.symbols.length,
        dashboard,
        errors: errors.length > 0 ? errors : undefined,
      };
    }),
  );

  // ── 6. scan_divergences ────────────────────────────────────

  server.tool(
    'scan_divergences',
    'Scan multiple symbols for RSI and MACD divergences. Returns symbols with active bullish or bearish divergences.',
    {
      symbols: z.array(z.string()).describe('Array of trading pairs to scan'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const divergences: Record<string, unknown>[] = [];
      const errors: { symbol: string; error: string }[] = [];

      for (const symbol of params.symbols) {
        try {
          const bars = await fetchBarsForAnalysis(client, symbol, params.timeframe);
          if (bars.length < 55) {
            errors.push({ symbol, error: `Insufficient data: ${bars.length} candles` });
            continue;
          }

          const signals = generator.generateSignals(bars, symbol, params.timeframe);
          const divSignals = signals.filter(s =>
            s.source.includes('Divergence') || s.source.includes('divergence'),
          );

          if (divSignals.length > 0) {
            divergences.push({
              symbol,
              currentPrice: bars[bars.length - 1].close,
              divergences: divSignals.map(s => ({
                source: s.source,
                type: s.type,
                strength: s.strength,
                confidence: s.confidence,
                targetPrice: s.targetPrice,
                stopLoss: s.stopLoss,
                metadata: s.metadata,
              })),
            });
          }
        } catch (err: any) {
          errors.push({ symbol, error: err.message ?? String(err) });
        }
      }

      return {
        timeframe: params.timeframe,
        scanned: params.symbols.length,
        withDivergences: divergences.length,
        results: divergences,
        errors: errors.length > 0 ? errors : undefined,
      };
    }),
  );

  // ── 7. get_multi_timeframe_signals ─────────────────────────

  server.tool(
    'get_multi_timeframe_signals',
    'Analyze a symbol across multiple timeframes (1h, 4h, 1d). Returns signals from each timeframe and an alignment score indicating how strongly all timeframes agree.',
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframes: z.array(z.string()).default(['1h', '4h', '1d']).describe('Timeframes to analyze'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const timeframes: string[] = params.timeframes;
      const tfResults: Record<string, unknown>[] = [];
      const scores: number[] = [];
      const errors: { timeframe: string; error: string }[] = [];

      for (const tf of timeframes) {
        try {
          const bars = await fetchBarsForAnalysis(client, params.symbol, tf);
          if (bars.length < 55) {
            errors.push({ timeframe: tf, error: `Insufficient data: ${bars.length} candles` });
            continue;
          }

          const signals = generator.generateSignals(bars, params.symbol, tf);
          const { bias, score } = generator.scoreSignals(signals);
          scores.push(score);

          tfResults.push({
            timeframe: tf,
            candlesAnalyzed: bars.length,
            currentPrice: bars[bars.length - 1].close,
            bias,
            score,
            signalCount: signals.length,
            signals: signals.map(s => ({
              source: s.source,
              type: s.type,
              strength: s.strength,
              confidence: s.confidence,
            })),
          });
        } catch (err: any) {
          errors.push({ timeframe: tf, error: err.message ?? String(err) });
        }
      }

      // Alignment: all scores same sign = aligned, mix = conflicting
      const allPositive = scores.every(s => s > 0);
      const allNegative = scores.every(s => s < 0);
      const avgScore = scores.length > 0
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : 0;

      let alignment: 'strong_bullish' | 'strong_bearish' | 'mixed' | 'neutral';
      if (allPositive && avgScore > 25) alignment = 'strong_bullish';
      else if (allNegative && avgScore < -25) alignment = 'strong_bearish';
      else if (scores.some(s => s > 15) && scores.some(s => s < -15)) alignment = 'mixed';
      else alignment = 'neutral';

      return {
        symbol: params.symbol,
        alignment,
        averageScore: avgScore,
        timeframes: tfResults,
        errors: errors.length > 0 ? errors : undefined,
      };
    }),
  );

  // ── 8. scan_breakouts ──────────────────────────────────────

  server.tool(
    'scan_breakouts',
    'Scan for potential breakouts: symbols near support/resistance levels with volume confirmation. Useful for finding imminent breakout candidates.',
    {
      symbols: z.array(z.string()).describe('Array of trading pairs to scan'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      proximityPercent: z.number().default(2).describe('How close price must be to S/R level (percent, default 2%)'),
    } as any,
    handler(async (params: any) => {
      const client = getClient();
      const breakouts: Record<string, unknown>[] = [];
      const errors: { symbol: string; error: string }[] = [];
      const proximity = params.proximityPercent / 100;

      for (const symbol of params.symbols) {
        try {
          const bars = await fetchBarsForAnalysis(client, symbol, params.timeframe);
          if (bars.length < 25) {
            errors.push({ symbol, error: `Insufficient data: ${bars.length} candles` });
            continue;
          }

          const currentPrice = bars[bars.length - 1].close;
          const levels = generator.findSupportResistance(bars);

          // Check volume (current vs 20-bar average)
          const volumes = bars.map(b => b.volume);
          const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
          const currentVol = volumes[volumes.length - 1];
          const volRatio = avgVol > 0 ? currentVol / avgVol : 1;

          // Find nearest resistance within proximity
          const nearResistance = levels.resistances.find(r =>
            Math.abs(r - currentPrice) / currentPrice < proximity,
          );

          // Find nearest support within proximity
          const nearSupport = levels.supports.find(s =>
            Math.abs(s - currentPrice) / currentPrice < proximity,
          );

          if (nearResistance || nearSupport) {
            const direction = nearResistance ? 'bullish_breakout' : 'bearish_breakdown';
            const level = nearResistance ?? nearSupport!;
            const distPct = Math.round(((level - currentPrice) / currentPrice) * 10000) / 100;

            breakouts.push({
              symbol,
              currentPrice,
              direction,
              level,
              distancePercent: distPct,
              volumeRatio: Math.round(volRatio * 100) / 100,
              volumeConfirmation: volRatio > 1.5,
              allSupports: levels.supports,
              allResistances: levels.resistances,
            });
          }
        } catch (err: any) {
          errors.push({ symbol, error: err.message ?? String(err) });
        }
      }

      // Sort: volume-confirmed first, then by proximity
      breakouts.sort((a, b) => {
        if (a.volumeConfirmation !== b.volumeConfirmation) {
          return a.volumeConfirmation ? -1 : 1;
        }
        return Math.abs(a.distancePercent as number) - Math.abs(b.distancePercent as number);
      });

      return {
        timeframe: params.timeframe,
        scanned: params.symbols.length,
        breakoutCandidates: breakouts.length,
        proximityThreshold: `${params.proximityPercent}%`,
        results: breakouts,
        errors: errors.length > 0 ? errors : undefined,
      };
    }),
  );
}
