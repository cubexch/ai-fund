import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import type { TradeJournal } from '../client/trade-journal';
import { sma } from '@ai-fund/lib/indicators';
import {
  returns, maxDrawdown, sharpeRatio, sortinoRatio, winRate, profitFactor,
} from '@ai-fund/lib/math';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerDatastoreJournalTools(server: McpServer, client: ExchangeClient) {
  const store = client.store;

  // ── Trade Journal Tools ─────────────────────────────────────

  server.tool(
    'get_trade_journal',
    `Query the trade journal for execution history. Filter by exchange, symbol, strategy, and time range. Returns individual trade records ordered by timestamp (newest first).`,
    {
      exchange: z.string().optional().describe('Filter by exchange ID'),
      symbol: z.string().optional().describe('Filter by trading pair (e.g., BTC/USDT)'),
      strategy: z.string().optional().describe('Filter by strategy/agent name'),
      since: z.string().optional().describe('Start date (ISO 8601, e.g., "2024-01-01")'),
      limit: z.number().default(100).describe('Max trades to return'),
    } as any,
    handler(async (params: any) => {
      const journal = (client as any).journal as TradeJournal | undefined;
      if (!journal) throw new Error('Trade journal not configured.');

      const sinceTs = params.since ? new Date(params.since).getTime() : undefined;

      const trades = await journal.query({
        exchange: params.exchange,
        symbol: params.symbol,
        strategy: params.strategy,
        since: sinceTs,
        limit: params.limit,
      });

      return {
        exchange: client.exchangeId,
        count: trades.length,
        trades,
      };
    }),
  );

  server.tool(
    'get_pnl_report',
    `P&L summary from the trade journal. Computes realized P&L, buy/sell volume, total fees, and traded symbols. Filter by exchange, symbol, strategy, and time range.`,
    {
      exchange: z.string().optional().describe('Filter by exchange ID'),
      symbol: z.string().optional().describe('Filter by trading pair (e.g., BTC/USDT)'),
      strategy: z.string().optional().describe('Filter by strategy/agent name'),
      since: z.string().optional().describe('Start date (ISO 8601, e.g., "2024-01-01")'),
    } as any,
    handler(async (params: any) => {
      const journal = (client as any).journal as TradeJournal | undefined;
      if (!journal) throw new Error('Trade journal not configured.');

      const sinceTs = params.since ? new Date(params.since).getTime() : undefined;

      const report = await journal.pnl({
        exchange: params.exchange,
        symbol: params.symbol,
        strategy: params.strategy,
        since: sinceTs,
      });

      return {
        exchange: client.exchangeId,
        ...report,
      };
    }),
  );

  server.tool(
    'backtest_strategy',
    `Run a simple moving average crossover backtest on cached DuckDB data. Buys when fast SMA crosses above slow SMA, sells when fast crosses below. Returns trade list, equity curve, and performance stats (Sharpe, Sortino, max drawdown, win rate, profit factor).`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      fast_period: z.number().default(10).describe('Fast MA period'),
      slow_period: z.number().default(30).describe('Slow MA period'),
      initial_capital: z.number().default(10000).describe('Starting capital in quote currency'),
      position_size_pct: z.number().default(1.0).describe('Fraction of capital to use per trade (0-1)'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const fastPeriod: number = params.fast_period;
      const slowPeriod: number = params.slow_period;
      if (fastPeriod >= slowPeriod) {
        throw new Error(`fast_period (${fastPeriod}) must be less than slow_period (${slowPeriod})`);
      }

      const candles = await store.query({
        symbol: params.symbol,
        interval: params.timeframe,
        exchange: client.exchangeId,
        limit: 10000, // fetch as much as available
      });

      if (candles.length < slowPeriod + 1) {
        throw new Error(`Insufficient cached data (${candles.length} candles, need at least ${slowPeriod + 1}). Run ingest_history first.`);
      }

      const closes = candles.map((c: any) => c.close);

      // Compute SMAs
      const fastSma = sma(closes, fastPeriod);
      const slowSma = sma(closes, slowPeriod);

      // Align: slowSma starts at index (slowPeriod - 1) in closes
      // fastSma starts at index (fastPeriod - 1) in closes
      // We need both to exist, so start at (slowPeriod - 1)
      const startIdx = slowPeriod - 1;

      // Simulate trades
      const trades: { type: string; price: number; bar: number; pnl?: number; pnlPct?: number }[] = [];
      let capital = params.initial_capital as number;
      const positionSizePct = params.position_size_pct as number;
      let inPosition = false;
      let entryPrice = 0;
      let entryCapital = 0;
      const equityCurve: number[] = [capital];

      for (let i = startIdx + 1; i < closes.length; i++) {
        // fastSma index: i - (fastPeriod - 1)
        // slowSma index: i - (slowPeriod - 1)
        const fastIdx = i - (fastPeriod - 1);
        const slowIdx = i - (slowPeriod - 1);
        const prevFastIdx = fastIdx - 1;
        const prevSlowIdx = slowIdx - 1;

        if (prevFastIdx < 0 || prevSlowIdx < 0) continue;

        const fastNow = fastSma[fastIdx];
        const slowNow = slowSma[slowIdx];
        const fastPrev = fastSma[prevFastIdx];
        const slowPrev = slowSma[prevSlowIdx];

        // Buy signal: fast crosses above slow
        if (!inPosition && fastPrev <= slowPrev && fastNow > slowNow) {
          entryPrice = closes[i];
          entryCapital = capital * positionSizePct;
          inPosition = true;
          trades.push({ type: 'buy', price: Math.round(entryPrice * 100) / 100, bar: i });
        }
        // Sell signal: fast crosses below slow
        else if (inPosition && fastPrev >= slowPrev && fastNow < slowNow) {
          const exitPrice = closes[i];
          const pnl = entryCapital * ((exitPrice - entryPrice) / entryPrice);
          const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
          capital += pnl;
          inPosition = false;
          trades.push({
            type: 'sell',
            price: Math.round(exitPrice * 100) / 100,
            bar: i,
            pnl: Math.round(pnl * 100) / 100,
            pnlPct: Math.round(pnlPct * 100) / 100,
          });
          equityCurve.push(Math.round(capital * 100) / 100);
        }
      }

      // Close open position at last bar
      if (inPosition) {
        const exitPrice = closes[closes.length - 1];
        const pnl = entryCapital * ((exitPrice - entryPrice) / entryPrice);
        const pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        capital += pnl;
        trades.push({
          type: 'sell',
          price: Math.round(exitPrice * 100) / 100,
          bar: closes.length - 1,
          pnl: Math.round(pnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 100) / 100,
        });
        equityCurve.push(Math.round(capital * 100) / 100);
      }

      // Compute stats from trade P&Ls
      const tradePnls = trades
        .filter(t => t.type === 'sell' && t.pnl != null)
        .map(t => t.pnl as number);

      const winners = tradePnls.filter(p => p > 0).length;
      const losers = tradePnls.filter(p => p <= 0).length;
      const totalTrades = tradePnls.length;

      // Compute returns series from equity curve for Sharpe/Sortino
      const equityReturns = returns(equityCurve);
      const dd = maxDrawdown(equityCurve);
      const totalReturn = ((capital - params.initial_capital) / params.initial_capital) * 100;

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        fastPeriod,
        slowPeriod,
        totalBars: closes.length,
        trades,
        totalTrades,
        winners,
        losers,
        winRate: totalTrades > 0 ? Math.round(winRate(tradePnls) * 1000) / 1000 : 0,
        profitFactor: totalTrades > 0 ? Math.round(profitFactor(tradePnls) * 100) / 100 : 0,
        totalReturn: Math.round(totalReturn * 100) / 100,
        sharpe: equityReturns.length > 1 ? Math.round(sharpeRatio(equityReturns) * 100) / 100 : 0,
        sortino: equityReturns.length > 1 ? Math.round(sortinoRatio(equityReturns) * 100) / 100 : 0,
        maxDrawdown: Math.round(dd.maxDrawdown * 10000) / 100,
        initialCapital: params.initial_capital,
        finalCapital: Math.round(capital * 100) / 100,
        equityCurve,
      };
    }),
  );

  // ── P&L Attribution ───────────────────────────────────────

  server.tool(
    'get_pnl_attribution',
    `Detailed P&L attribution from the trade journal. Group realized P&L by symbol, strategy, calendar day, or hour of day. Essential for identifying which pairs, agents, or time windows drive performance.`,
    {
      group_by: z.enum(['symbol', 'strategy', 'day', 'hour']).default('symbol').describe('Dimension to group P&L by'),
      since: z.string().optional().describe('Start date (ISO 8601, e.g., "2024-01-01")'),
    } as any,
    handler(async (params: any) => {
      const journal = (client as any).journal as TradeJournal | undefined;
      if (!journal) throw new Error('Trade journal not configured.');

      const groupBy: string = params.group_by;
      const sinceClause = params.since
        ? `WHERE timestamp >= ${new Date(params.since).getTime()}`
        : '';

      let sql: string;
      switch (groupBy) {
        case 'symbol':
          sql = `SELECT symbol as dimension, SUM(CASE WHEN side = 'sell' THEN cost ELSE -cost END) as pnl, SUM(COALESCE(fee, 0)) as fees, COUNT(*) as trades FROM trades ${sinceClause} GROUP BY symbol ORDER BY pnl DESC`;
          break;
        case 'strategy':
          sql = `SELECT COALESCE(strategy, 'unknown') as dimension, SUM(CASE WHEN side = 'sell' THEN cost ELSE -cost END) as pnl, SUM(COALESCE(fee, 0)) as fees, COUNT(*) as trades FROM trades ${sinceClause} GROUP BY strategy ORDER BY pnl DESC`;
          break;
        case 'day':
          sql = `SELECT CAST(epoch_ms(timestamp) AS DATE) as dimension, SUM(CASE WHEN side = 'sell' THEN cost ELSE -cost END) as pnl, SUM(COALESCE(fee, 0)) as fees, COUNT(*) as trades FROM trades ${sinceClause} GROUP BY CAST(epoch_ms(timestamp) AS DATE) ORDER BY pnl DESC`;
          break;
        case 'hour':
          sql = `SELECT EXTRACT(HOUR FROM epoch_ms(timestamp)) as dimension, SUM(CASE WHEN side = 'sell' THEN cost ELSE -cost END) as pnl, SUM(COALESCE(fee, 0)) as fees, COUNT(*) as trades FROM trades ${sinceClause} GROUP BY EXTRACT(HOUR FROM epoch_ms(timestamp)) ORDER BY pnl DESC`;
          break;
        default:
          throw new Error(`Invalid group_by: ${groupBy}. Use symbol, strategy, day, or hour.`);
      }

      const rows = await journal.sql(sql);

      return {
        exchange: client.exchangeId,
        groupBy,
        since: params.since ?? null,
        rows,
      };
    }),
  );
}
