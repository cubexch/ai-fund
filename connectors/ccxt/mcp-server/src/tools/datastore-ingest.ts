import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ExchangeClient } from '../client/exchange';
import { handler } from './handler';
import type { OHLCVRow } from '@ai-fund/lib/datastore';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function registerDatastoreIngestTools(server: McpServer, client: ExchangeClient) {
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
    'export_to_parquet',
    `Export cached market data to a Parquet file for external analysis (Python, R, DuckDB CLI). Filters by symbol, timeframe, and exchange before writing.`,
    {
      symbol: z.string().describe('Trading pair to export (e.g., BTC/USDT)'),
      timeframe: z.string().default('1d').describe('Candle timeframe to export'),
      output_path: z.string().optional().describe('Output file path (default: .desk/exports/{symbol}_{timeframe}.parquet)'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      // Validate inputs to prevent SQL injection (exportParquet uses raw SQL in COPY)
      const symbolPattern = /^[A-Za-z0-9]+\/[A-Za-z0-9]+$/;
      const timeframePattern = /^[0-9]+[smhdwMy]$/;
      if (!symbolPattern.test(params.symbol)) {
        throw new Error(`Invalid symbol format: ${params.symbol}. Expected format: BASE/QUOTE (e.g., BTC/USDT)`);
      }
      if (!timeframePattern.test(params.timeframe)) {
        throw new Error(`Invalid timeframe format: ${params.timeframe}. Expected format like 1m, 5m, 1h, 1d`);
      }

      const safeSymbol = params.symbol.replace(/\//g, '-');
      const outputPath: string = params.output_path
        ?? `.desk/exports/${safeSymbol}_${params.timeframe}.parquet`;

      // exchangeId is server-controlled (not user input), symbol/timeframe validated above
      const query = `SELECT * FROM ohlcv WHERE symbol = '${params.symbol}' AND interval = '${params.timeframe}' AND exchange = '${client.exchangeId}'`;

      await store.exportParquet(query, outputPath);

      // Get row count for confirmation
      const countRows = await store.sql(
        `SELECT COUNT(*) as cnt FROM ohlcv WHERE symbol = ? AND interval = ? AND exchange = ?`,
        [params.symbol, params.timeframe, client.exchangeId],
      );
      const rowCount = countRows[0]?.cnt ?? 0;

      return {
        symbol: params.symbol,
        timeframe: params.timeframe,
        exchange: client.exchangeId,
        outputPath,
        rowCount,
      };
    }),
  );

  server.tool(
    'ingest_recent_trades',
    `Fetch recent public trades from ${client.name} and store as 1-second OHLCV candles in the local DuckDB cache. Each second of trade activity becomes one candle (open=first price, close=last price, volume=sum). Useful for tick-level analysis and microstructure research.`,
    {
      symbol: z.string().describe('Trading pair (e.g., BTC/USDT)'),
      limit: z.number().default(500).describe('Max trades to fetch from the exchange'),
    } as any,
    handler(async (params: any) => {
      if (!store) throw new Error('DuckDB datastore not configured. Restart with data caching enabled.');

      const trades = await client.getTrades(params.symbol, undefined, params.limit);
      if (trades.length === 0) {
        return { exchange: client.exchangeId, symbol: params.symbol, tradesFetched: 0, secondsStored: 0 };
      }

      // Group trades by second (floor timestamp to nearest 1000ms)
      const buckets = new Map<number, typeof trades>();
      for (const t of trades) {
        if (t.timestamp == null) continue;
        const sec = Math.floor(t.timestamp / 1000) * 1000;
        let bucket = buckets.get(sec);
        if (!bucket) {
          bucket = [];
          buckets.set(sec, bucket);
        }
        bucket.push(t);
      }

      // Convert each second-bucket into an OHLCV row
      const rows: OHLCVRow[] = [];
      for (const [sec, bucket] of buckets) {
        const prices = bucket.map(t => t.price);
        const volumes = bucket.map(t => t.amount);
        rows.push({
          symbol: params.symbol,
          exchange: client.exchangeId,
          asset_type: 'crypto',
          interval: '1s',
          ts: new Date(sec),
          open: prices[0],
          high: Math.max(...prices),
          low: Math.min(...prices),
          close: prices[prices.length - 1],
          volume: volumes.reduce((s, v) => s + v, 0),
        });
      }

      const inserted = await store.insertOHLCV(rows);

      // Compute time range
      const timestamps = [...buckets.keys()].sort((a, b) => a - b);
      return {
        exchange: client.exchangeId,
        symbol: params.symbol,
        tradesFetched: trades.length,
        secondsStored: inserted,
        timeRange: {
          from: new Date(timestamps[0]).toISOString(),
          to: new Date(timestamps[timestamps.length - 1]).toISOString(),
        },
      };
    }),
  );
}
