import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange.js';
import { handler } from './handler.js';
import { MarketDataStore, type OHLCVRow } from '../../../../../lib/datastore.js';
import type { TradeJournal } from '../client/trade-journal.js';
import {
  sma, ema, rsi, bollingerBands, atr, obv, type OHLCV,
} from '../../../../../lib/indicators.js';
import {
  correlation, correlationMatrix, returns, mean, standardDeviation,
  sharpeRatio, sortinoRatio, maxDrawdown,
} from '../../../../../lib/math.js';

// Cast schemas to any to avoid TS2589 "excessively deep type instantiation" with zod + MCP SDK
/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerDatastoreTools(server: McpServer, client: ExchangeClient) {
  const store = client.store;

  server.tool(
    'ingest_history',
    `Bulk ingest historical OHLCV data from ${client.name} into the local DuckDB cache. Fetches candles and stores them for fast SQL analytics. Run this before cross-symbol analysis.`,
    {
      symbols: z.string().describe('Comma-separated trading pairs (e.g., "BTC/USDT,ETH/USDT")'),
      timeframe: z.string().default('1d').describe('Candle timeframe (1m, 5m, 15m, 1h, 4h, 1d)'),
      limit: z.number().default(500).describe('Max candles per symbol to fetch'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const symbols = params.symbols.split(',').map((s: string) => s.trim()).filter(Boolean);
      const results: { symbol: string; rows: number; error?: string }[] = [];

      for (const symbol of symbols) {
        try {
          const lastTs = await store.lastTimestamp(symbol, params.timeframe, client.exchangeId);
          const since = lastTs ? lastTs.getTime() + 1 : undefined;
          const bars = await client.getBars(symbol, params.timeframe, since, params.limit);

          if (bars.length === 0) {
            results.push({ symbol, rows: 0 });
            continue;
          }

          const rows: OHLCVRow[] = bars.map(b => ({
            symbol,
            exchange: client.exchangeId,
            asset_type: 'crypto',
            interval: params.timeframe,
            ts: new Date(b.timestamp),
            open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
          }));

          const inserted = await store.insertOHLCV(rows);
          results.push({ symbol, rows: inserted });
        } catch (err: any) {
          results.push({ symbol, rows: 0, error: err.message });
        }
      }

      const totalRows = results.reduce((sum, r) => sum + r.rows, 0);
      return { exchange: client.exchangeId, timeframe: params.timeframe, totalRows, symbols: results };
    }),
  );

  server.tool(
    'query_market_data',
    `Run a SQL query against the local DuckDB market data cache. The ohlcv table has columns: symbol, exchange, asset_type, interval, ts, open, high, low, close, volume. Use for VWAP, volume profiles, cross-symbol analysis — like kdb+ for crypto.`,
    {
      sql: z.string().describe('SQL query against the ohlcv table (SELECT only)'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const query = params.sql.trim();
      // Security: only allow SELECT queries
      if (!/^SELECT\b/i.test(query)) {
        throw new Error('Only SELECT queries are allowed. Use ingest_history to insert data.');
      }
      // Block dangerous patterns
      if (/\b(DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|ATTACH|COPY|EXPORT)\b/i.test(query)) {
        throw new Error('Write operations are not allowed. Use ingest_history to manage data.');
      }

      const rows = await store.sql(query);
      return { rowCount: rows.length, rows: rows.slice(0, 1000) }; // cap at 1000 rows
    }),
  );

  server.tool(
    'get_cached_symbols',
    `List all symbols cached in the local DuckDB market data store. Shows available exchanges, intervals, date ranges, and row counts.`,
    {} as any,
    handler(async () => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const symbols = await store.symbols();
      const totalRows = await store.count();
      return { totalRows, symbols };
    }),
  );

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
}
