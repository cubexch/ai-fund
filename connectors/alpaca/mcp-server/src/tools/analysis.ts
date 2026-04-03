import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AlpacaClient, AlpacaBar } from '../client/api';
import {
  sma, ema, rsi, macd, bollingerBands, atr, stochastic,
  type OHLCV,
} from '@ai-fund/lib/indicators';
import { kelly, fixedFractionalSize } from '@ai-fund/lib/math';
import { detectConfluence } from '@ai-fund/lib/confluence-detector';
import { assessPortfolioRisk } from '@ai-fund/lib/portfolio-analytics';
import { planTwap, estimateMarketImpact, realizedVolatility } from '@ai-fund/lib/execution-planner';
import { computeDcaSchedule } from '@ai-fund/lib/grid-trading';

// ── Helpers ─────────────────────────────────────────────────

function barsToOHLCV(bars: AlpacaBar[]): OHLCV[] {
  return bars.map(b => ({
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
    timestamp: new Date(b.t).getTime(),
  }));
}

function closes(bars: AlpacaBar[]): number[] {
  return bars.map(b => b.c);
}

function requiredBarsForIndicators(params: {
  indicators: string[];
  sma_period: number;
  ema_period: number;
  rsi_period: number;
}): number {
  let required = 2;

  for (const indicator of params.indicators) {
    switch (indicator) {
      case 'sma':
        required = Math.max(required, params.sma_period);
        break;
      case 'ema':
        required = Math.max(required, params.ema_period);
        break;
      case 'rsi':
        required = Math.max(required, params.rsi_period + 1);
        break;
      case 'macd':
        required = Math.max(required, 26);
        break;
      case 'bbands':
        required = Math.max(required, 20);
        break;
      case 'atr':
        required = Math.max(required, 15);
        break;
      case 'stochastic':
        required = Math.max(required, 16);
        break;
    }
  }

  return required;
}

// ── Registration ────────────────────────────────────────────

export function registerAnalysisTools(server: McpServer, client: AlpacaClient) {

  // ── 1. get_technical_analysis ─────────────────────────────

  server.tool(
    'get_technical_analysis',
    'Run technical indicators (SMA, EMA, RSI, MACD, Bollinger Bands, ATR, Stochastic) on OHLCV data for a symbol.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL, TSLA)'),
      timeframe: z.string().default('1Day').describe('Bar timeframe (1Min, 5Min, 15Min, 1Hour, 1Day, 1Week, 1Month)'),
      limit: z.number().default(200).describe('Number of bars to fetch'),
      indicators: z.array(z.enum(['sma', 'ema', 'rsi', 'macd', 'bbands', 'atr', 'stochastic']))
        .default(['sma', 'ema', 'rsi', 'macd', 'bbands'])
        .describe('Which indicators to compute'),
      sma_period: z.number().default(20).describe('SMA period'),
      ema_period: z.number().default(20).describe('EMA period'),
      rsi_period: z.number().default(14).describe('RSI period'),
    },
    async (params) => {
      try {
        const bars = await client.getBars(params.symbol, {
          timeframe: params.timeframe,
          limit: params.limit,
        });

        const requiredBars = requiredBarsForIndicators(params);
        if (bars.length < requiredBars) {
          return {
            content: [{
              type: 'text' as const,
              text: `Insufficient data — need at least ${requiredBars} bars for the requested indicators, got ${bars.length}.`,
            }],
            isError: true,
          };
        }

        const c = closes(bars);
        const candles = barsToOHLCV(bars);
        const result: Record<string, unknown> = {
          symbol: params.symbol,
          timeframe: params.timeframe,
          bars: bars.length,
          latestClose: c[c.length - 1],
        };

        for (const ind of params.indicators) {
          switch (ind) {
            case 'sma': {
              const values = sma(c, params.sma_period);
              result.sma = { period: params.sma_period, current: values[values.length - 1], values: values.slice(-5) };
              break;
            }
            case 'ema': {
              const values = ema(c, params.ema_period);
              result.ema = { period: params.ema_period, current: values[values.length - 1], values: values.slice(-5) };
              break;
            }
            case 'rsi': {
              const values = rsi(c, params.rsi_period);
              const current = values[values.length - 1];
              result.rsi = {
                period: params.rsi_period,
                current,
                signal: current > 70 ? 'overbought' : current < 30 ? 'oversold' : 'neutral',
                values: values.slice(-5),
              };
              break;
            }
            case 'macd': {
              const m = macd(c);
              result.macd = {
                macd: m.macd[m.macd.length - 1],
                signal: m.signal[m.signal.length - 1],
                histogram: m.histogram[m.histogram.length - 1],
                trend: m.histogram[m.histogram.length - 1] > 0 ? 'bullish' : 'bearish',
              };
              break;
            }
            case 'bbands': {
              const bb = bollingerBands(c);
              const idx = bb.upper.length - 1;
              const price = c[c.length - 1];
              result.bollingerBands = {
                upper: bb.upper[idx],
                middle: bb.middle[idx],
                lower: bb.lower[idx],
                width: bb.width[idx],
                position: price > bb.upper[idx] ? 'above_upper' : price < bb.lower[idx] ? 'below_lower' : 'inside',
              };
              break;
            }
            case 'atr': {
              const values = atr(candles);
              result.atr = { current: values[values.length - 1], values: values.slice(-5) };
              break;
            }
            case 'stochastic': {
              const s = stochastic(candles);
              result.stochastic = {
                k: s.k[s.k.length - 1],
                d: s.d[s.d.length - 1],
                signal: s.k[s.k.length - 1] > 80 ? 'overbought' : s.k[s.k.length - 1] < 20 ? 'oversold' : 'neutral',
              };
              break;
            }
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${message}` }], isError: true };
      }
    },
  );

  // ── 2. detect_confluence ──────────────────────────────────

  server.tool(
    'detect_confluence',
    'Multi-timeframe confluence analysis. Fetches multiple timeframes for a symbol and detects bullish/bearish alignment.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL)'),
      timeframes: z.array(z.string()).default(['15Min', '1Hour', '1Day']).describe('Timeframes to analyze'),
      limit: z.number().default(100).describe('Bars per timeframe'),
    },
    async (params) => {
      try {
        const barsPerTimeframe: Record<string, OHLCV[]> = {};

        for (const tf of params.timeframes) {
          const bars = await client.getBars(params.symbol, {
            timeframe: tf,
            limit: params.limit,
          });
          if (bars.length < 51) {
            return {
              content: [{
                type: 'text' as const,
                text: `Insufficient data for ${tf} — need at least 51 bars, got ${bars.length}.`,
              }],
              isError: true,
            };
          }
          barsPerTimeframe[tf] = barsToOHLCV(bars);
        }

        const result = detectConfluence(barsPerTimeframe);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ symbol: params.symbol, ...result }, null, 2),
          }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${message}` }], isError: true };
      }
    },
  );

  // ── 3. assess_portfolio_risk ──────────────────────────────

  server.tool(
    'assess_portfolio_risk',
    'Portfolio-level risk assessment: VaR, volatility, Sharpe, Sortino, max drawdown, and correlation matrix across positions.',
    {
      confidence: z.number().default(0.95).describe('VaR confidence level (0.95 or 0.99)'),
      lookback_days: z.number().default(90).describe('Days of historical data to analyze'),
    },
    async (params) => {
      try {
        const positions = await client.getPositions();
        if (positions.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No open positions to analyze.' }], isError: true };
        }

        const account = await client.getAccount();
        const portfolioValue = parseFloat(account.portfolio_value);

        const symbolData: Record<string, number[]> = {};
        const weights: number[] = [];

        for (const pos of positions) {
          const bars = await client.getBars(pos.symbol, {
            timeframe: '1Day',
            limit: params.lookback_days,
          });
          if (bars.length > 1) {
            symbolData[pos.symbol] = closes(bars);
            weights.push(parseFloat(pos.market_value) / portfolioValue);
          }
        }

        if (Object.keys(symbolData).length === 0) {
          return { content: [{ type: 'text' as const, text: 'Insufficient bar data for risk analysis.' }], isError: true };
        }

        const result = assessPortfolioRisk(symbolData, weights, portfolioValue, params.confidence);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${message}` }], isError: true };
      }
    },
  );

  // ── 4. plan_twap ──────────────────────────────────────────

  server.tool(
    'plan_twap',
    'Plan a TWAP (Time-Weighted Average Price) execution schedule. Splits a large order into equal time slices.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL)'),
      total_amount: z.number().describe('Total quantity to execute'),
      duration_minutes: z.number().default(60).describe('Execution window in minutes'),
      num_slices: z.number().default(10).describe('Number of slices'),
    },
    async (params) => {
      try {
        const snapshot = await client.getSnapshots([params.symbol]);
        const snap = snapshot[params.symbol];
        if (!snap) {
          return { content: [{ type: 'text' as const, text: `No snapshot for ${params.symbol}` }], isError: true };
        }

        const currentPrice = snap.latestTrade.p;
        const dailyVolume = snap.dailyBar.v;

        const plan = planTwap({
          totalAmount: params.total_amount,
          durationMinutes: params.duration_minutes,
          numSlices: params.num_slices,
          currentPrice,
          dailyVolume,
          nowMs: Date.now(),
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              symbol: params.symbol,
              dailyVolume,
              ...plan,
              slices: plan.slices.map(s => ({
                ...s,
                scheduledTime: new Date(s.scheduledTime).toISOString(),
              })),
            }, null, 2),
          }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${message}` }], isError: true };
      }
    },
  );

  // ── 5. simulate_market_impact ─────────────────────────────

  server.tool(
    'simulate_market_impact',
    'Estimate the market impact cost of executing a given quantity. Uses Almgren-Chriss model with realized volatility.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL)'),
      amount: z.number().describe('Number of shares to execute'),
      lookback: z.number().default(60).describe('Bars of history for volatility estimate'),
    },
    async (params) => {
      try {
        const [snapshot, bars] = await Promise.all([
          client.getSnapshots([params.symbol]),
          client.getBars(params.symbol, { timeframe: '1Day', limit: params.lookback }),
        ]);

        const snap = snapshot[params.symbol];
        if (!snap) {
          return { content: [{ type: 'text' as const, text: `No snapshot for ${params.symbol}` }], isError: true };
        }

        const price = snap.latestTrade.p;
        const dailyVolume = snap.dailyBar.v;
        const vol = realizedVolatility(closes(bars));

        const impact = estimateMarketImpact({
          amount: params.amount,
          dailyVolume,
          volatility: vol,
          price,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              symbol: params.symbol,
              amount: params.amount,
              price,
              dailyVolume,
              realizedVolatility: Math.round(vol * 10000) / 10000,
              ...impact,
            }, null, 2),
          }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${message}` }], isError: true };
      }
    },
  );

  // ── 6. calculate_position_size ────────────────────────────

  server.tool(
    'calculate_position_size',
    'Calculate optimal position size using Kelly criterion and fixed-fractional methods.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL)'),
      entry_price: z.number().describe('Planned entry price'),
      stop_loss_price: z.number().describe('Stop loss price'),
      win_rate: z.number().describe('Historical win rate (0-1)'),
      avg_win_loss_ratio: z.number().describe('Average win / average loss ratio'),
      risk_per_trade: z.number().default(0.02).describe('Fraction of portfolio to risk per trade (e.g. 0.02 for 2%)'),
    },
    async (params) => {
      try {
        const account = await client.getAccount();
        const portfolioValue = parseFloat(account.portfolio_value);

        const kellyFraction = kelly(params.win_rate, params.avg_win_loss_ratio, true);
        const kellyFullFraction = kelly(params.win_rate, params.avg_win_loss_ratio, false);
        const fixedSize = fixedFractionalSize(
          portfolioValue,
          params.risk_per_trade,
          params.entry_price,
          params.stop_loss_price,
        );

        const riskPerUnit = Math.abs(params.entry_price - params.stop_loss_price);
        const kellySize = (portfolioValue * kellyFraction) / params.entry_price;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              symbol: params.symbol,
              portfolioValue,
              entryPrice: params.entry_price,
              stopLossPrice: params.stop_loss_price,
              riskPerUnit,
              winRate: params.win_rate,
              avgWinLossRatio: params.avg_win_loss_ratio,
              kelly: {
                fullKelly: Math.round(kellyFullFraction * 10000) / 10000,
                halfKelly: Math.round(kellyFraction * 10000) / 10000,
                suggestedShares: Math.floor(kellySize),
                notional: Math.round(kellySize * params.entry_price * 100) / 100,
              },
              fixedFractional: {
                riskPerTrade: params.risk_per_trade,
                maxLoss: Math.round(portfolioValue * params.risk_per_trade * 100) / 100,
                suggestedShares: Math.floor(fixedSize),
                notional: Math.round(fixedSize * params.entry_price * 100) / 100,
              },
              recommendation: kellySize < fixedSize
                ? 'Kelly suggests smaller size — use Kelly for conservative sizing'
                : 'Fixed-fractional suggests smaller size — use it unless you have high conviction',
            }, null, 2),
          }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${message}` }], isError: true };
      }
    },
  );

  // ── 7. calculate_dca_schedule ─────────────────────────────

  server.tool(
    'calculate_dca_schedule',
    'Compute a DCA (Dollar-Cost Averaging) schedule, optionally adjusted by rolling volatility.',
    {
      symbol: z.string().describe('Stock symbol (e.g., AAPL)'),
      total_amount: z.number().describe('Total dollar amount to deploy'),
      num_orders: z.number().default(10).describe('Number of DCA orders'),
      vol_adjust: z.boolean().default(true).describe('Adjust order sizes inversely to volatility'),
    },
    async (params) => {
      try {
        const snapshot = await client.getSnapshots([params.symbol]);
        const snap = snapshot[params.symbol];
        if (!snap) {
          return { content: [{ type: 'text' as const, text: `No snapshot for ${params.symbol}` }], isError: true };
        }

        const currentPrice = snap.latestTrade.p;
        const bars = await client.getBars(params.symbol, {
          timeframe: '1Day',
          limit: 60,
        });
        const c = closes(bars);

        const schedule = computeDcaSchedule({
          totalAmount: params.total_amount,
          numOrders: params.num_orders,
          currentPrice,
          closes: c,
          volAdjust: params.vol_adjust,
        });

        const totalBase = schedule.reduce((s, o) => s + o.estimatedAmountBase, 0);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              symbol: params.symbol,
              currentPrice,
              totalAmount: params.total_amount,
              numOrders: params.num_orders,
              volAdjusted: params.vol_adjust,
              estimatedTotalShares: Math.round(totalBase * 1000) / 1000,
              schedule,
            }, null, 2),
          }],
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text' as const, text: `Failed: ${message}` }], isError: true };
      }
    },
  );
}
