import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { handler } from './handler.js';
import { RegimeDetector } from '../client/regime-detector.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerRegimeTools(server: McpServer, client: ExchangeClient) {
  const detector = new RegimeDetector();

  // ── detect_market_regime ─────────────────────────────────

  server.tool(
    'detect_market_regime',
    `Classify the current market regime for a symbol on ${client.name}. Returns trending_up, trending_down, ranging, volatile, quiet, or breakout — with confidence scores, indicator details, recent transitions, and strategy recommendations.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
    } as any,
    handler(async (params: any) => {
      const bars = await client.getBars(params.symbol, params.timeframe, undefined, 300);
      if (bars.length < 50) {
        throw new Error(`Need at least 50 bars for regime detection, got ${bars.length}`);
      }
      const analysis = detector.analyze(bars);
      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        barsAnalyzed: bars.length,
        ...analysis,
      };
    }),
  );

  // ── scan_regime_changes ──────────────────────────────────

  server.tool(
    'scan_regime_changes',
    `Scan multiple symbols on ${client.name} for recent regime changes. Identifies symbols that transitioned between regimes within the lookback window — useful for catching emerging trends or breakdowns.`,
    {
      symbols: z.array(z.string()).describe('Array of trading pairs (e.g., ["BTC/USDT", "ETH/USDT"])'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      lookbackBars: z.number().default(20).describe('Only report transitions within this many recent bars'),
    } as any,
    handler(async (params: any) => {
      const results: {
        symbol: string;
        currentRegime: string;
        confidence: number;
        recentTransitions: { from: string; to: string; barsAgo: number }[];
      }[] = [];

      for (const symbol of params.symbols) {
        try {
          const bars = await client.getBars(symbol, params.timeframe, undefined, 300);
          if (bars.length < 50) continue;

          const analysis = detector.analyze(bars);
          const recentTransitions = (analysis.transitions ?? [])
            .filter(t => t.barsAgo <= params.lookbackBars)
            .map(t => ({ from: t.from, to: t.to, barsAgo: t.barsAgo }));

          if (recentTransitions.length > 0) {
            results.push({
              symbol,
              currentRegime: analysis.currentRegime,
              confidence: analysis.confidence,
              recentTransitions,
            });
          }
        } catch {
          // Skip symbols that fail (delisted, insufficient data, etc.)
        }
      }

      return {
        timeframe: params.timeframe,
        lookbackBars: params.lookbackBars,
        symbolsScanned: params.symbols.length,
        symbolsWithChanges: results.length,
        results,
      };
    }),
  );

  // ── get_regime_history ───────────────────────────────────

  server.tool(
    'get_regime_history',
    `Get the regime history for a symbol on ${client.name}. Shows a timeline of regime classifications with durations — useful for understanding how long regimes persist and what transitions look like.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      lookbackBars: z.number().default(300).describe('Number of bars to analyze'),
    } as any,
    handler(async (params: any) => {
      const bars = await client.getBars(params.symbol, params.timeframe, undefined, params.lookbackBars);
      if (bars.length < 50) {
        throw new Error(`Need at least 50 bars for regime history, got ${bars.length}`);
      }

      const history = detector.getHistory(bars);

      // Compute summary stats
      const regimeCounts: Record<string, number> = {};
      const regimeDurations: Record<string, number[]> = {};
      for (const entry of history) {
        regimeCounts[entry.regime] = (regimeCounts[entry.regime] ?? 0) + 1;
        if (!regimeDurations[entry.regime]) regimeDurations[entry.regime] = [];
        regimeDurations[entry.regime].push(entry.durationBars);
      }

      const summary: Record<string, { count: number; avgDurationBars: number; totalBars: number }> = {};
      for (const [regime, durations] of Object.entries(regimeDurations)) {
        const total = durations.reduce((a, b) => a + b, 0);
        summary[regime] = {
          count: regimeCounts[regime],
          avgDurationBars: Math.round(total / durations.length),
          totalBars: total,
        };
      }

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        barsAnalyzed: bars.length,
        totalRegimePeriods: history.length,
        summary,
        history: history.map(h => ({
          regime: h.regime,
          startTimestamp: h.startTimestamp,
          endTimestamp: h.endTimestamp,
          durationBars: h.durationBars,
          confidence: h.confidence,
        })),
      };
    }),
  );

  // ── match_strategy_to_regime ─────────────────────────────

  server.tool(
    'match_strategy_to_regime',
    `Given the current market regime on ${client.name}, recommend optimal trading strategies and parameters adjusted for risk tolerance. Returns regime classification, recommended strategies, position sizing, and actionable advice.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe'),
      riskTolerance: z.enum(['conservative', 'moderate', 'aggressive']).default('moderate').describe('Risk tolerance level'),
    } as any,
    handler(async (params: any) => {
      const bars = await client.getBars(params.symbol, params.timeframe, undefined, 300);
      if (bars.length < 50) {
        throw new Error(`Need at least 50 bars for strategy matching, got ${bars.length}`);
      }

      const analysis = detector.matchStrategy(bars, params.riskTolerance);

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        riskTolerance: params.riskTolerance,
        barsAnalyzed: bars.length,
        currentRegime: analysis.currentRegime,
        confidence: analysis.confidence,
        indicators: analysis.indicators,
        recommendation: analysis.recommendation,
        regimeScores: analysis.regimeScores,
      };
    }),
  );
}
