/**
 * DuckDB-based local market data store.
 *
 * Provides a local columnar database for historical OHLCV data
 * with SQL query support, Parquet I/O, and incremental updates.
 * Free alternative to kdb/ClickHouse — no server process needed.
 */

import { Database } from 'duckdb';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OHLCV } from './indicators.js';

// ── Types ────────────────────────────────────────────────────

export interface OHLCVRow {
  symbol: string;
  exchange: string;      // 'yahoo', 'robinhood', 'cube', 'binance'
  asset_type: string;    // 'stock', 'crypto', 'etf'
  interval: string;      // '1m', '5m', '15m', '1h', '1d'
  ts: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolInfo {
  symbol: string;
  exchange: string;
  asset_type: string;
  intervals: string[];
  rowCount: number;
  firstDate: string;
  lastDate: string;
}

// ── Constants ────────────────────────────────────────────────

const DEFAULT_DB_PATH = 'data/market.duckdb';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ohlcv (
    symbol      VARCHAR NOT NULL,
    exchange    VARCHAR NOT NULL,
    asset_type  VARCHAR NOT NULL,
    interval    VARCHAR NOT NULL,
    ts          TIMESTAMP NOT NULL,
    open        DOUBLE NOT NULL,
    high        DOUBLE NOT NULL,
    low         DOUBLE NOT NULL,
    close       DOUBLE NOT NULL,
    volume      DOUBLE NOT NULL,
    PRIMARY KEY (symbol, exchange, interval, ts)
  );
`;

const CREATE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_ohlcv_lookup
    ON ohlcv (symbol, interval, ts);
`;

// ── Helpers ──────────────────────────────────────────────────

function runQuery(db: Database, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: Record<string, unknown>[]) => {
      if (err) reject(err);
      else resolve(rows ?? []);
    });
  });
}

function runExec(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ── MarketDataStore ──────────────────────────────────────────

export class MarketDataStore {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? DEFAULT_DB_PATH;
  }

  /**
   * Initialize the database: create tables and indexes.
   */
  async init(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });

    this.db = new Database(this.dbPath);
    await runExec(this.db, CREATE_TABLE_SQL);
    await runExec(this.db, CREATE_INDEX_SQL);
  }

  private ensureDb(): Database {
    if (!this.db) throw new Error('MarketDataStore not initialized. Call init() first.');
    return this.db;
  }

  /**
   * Bulk insert OHLCV rows. Uses INSERT OR REPLACE to handle duplicates.
   */
  async insertOHLCV(rows: OHLCVRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const db = this.ensureDb();

    // Build bulk insert with parameterized values
    const batchSize = 500;
    let inserted = 0;

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const placeholders = batch
        .map(() => `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .join(', ');

      const values: unknown[] = [];
      for (const row of batch) {
        values.push(
          row.symbol,
          row.exchange,
          row.asset_type,
          row.interval,
          row.ts.toISOString(),
          row.open,
          row.high,
          row.low,
          row.close,
          row.volume,
        );
      }

      await runQuery(
        db,
        `INSERT OR REPLACE INTO ohlcv (symbol, exchange, asset_type, interval, ts, open, high, low, close, volume)
         VALUES ${placeholders}`,
        values,
      );
      inserted += batch.length;
    }

    return inserted;
  }

  /**
   * Query OHLCV data. Returns in the same format as lib/indicators.ts OHLCV.
   */
  async query(opts: {
    symbol: string;
    interval: string;
    start?: Date;
    end?: Date;
    exchange?: string;
    limit?: number;
  }): Promise<OHLCV[]> {
    const db = this.ensureDb();

    const conditions = ['symbol = ?', 'interval = ?'];
    const params: unknown[] = [opts.symbol, opts.interval];

    if (opts.exchange) {
      conditions.push('exchange = ?');
      params.push(opts.exchange);
    }
    if (opts.start) {
      conditions.push('ts >= ?');
      params.push(opts.start.toISOString());
    }
    if (opts.end) {
      conditions.push('ts <= ?');
      params.push(opts.end.toISOString());
    }

    let sql = `SELECT ts, open, high, low, close, volume
               FROM ohlcv
               WHERE ${conditions.join(' AND ')}
               ORDER BY ts ASC`;

    if (opts.limit) {
      sql += ` LIMIT ${opts.limit}`;
    }

    const rows = await runQuery(db, sql, params);

    return rows.map(row => ({
      timestamp: new Date(row.ts as string).getTime(),
      open: row.open as number,
      high: row.high as number,
      low: row.low as number,
      close: row.close as number,
      volume: row.volume as number,
    }));
  }

  /**
   * List all symbols in the store with metadata.
   */
  async symbols(): Promise<SymbolInfo[]> {
    const db = this.ensureDb();

    const rows = await runQuery(db, `
      SELECT
        symbol,
        exchange,
        asset_type,
        LIST(DISTINCT interval ORDER BY interval) as intervals,
        COUNT(*) as row_count,
        MIN(ts) as first_date,
        MAX(ts) as last_date
      FROM ohlcv
      GROUP BY symbol, exchange, asset_type
      ORDER BY symbol, exchange
    `);

    return rows.map(row => ({
      symbol: row.symbol as string,
      exchange: row.exchange as string,
      asset_type: row.asset_type as string,
      intervals: row.intervals as string[],
      rowCount: row.row_count as number,
      firstDate: (row.first_date as Date).toISOString(),
      lastDate: (row.last_date as Date).toISOString(),
    }));
  }

  /**
   * Get the most recent timestamp for a symbol/interval.
   * Used for incremental updates.
   */
  async lastTimestamp(
    symbol: string,
    interval: string,
    exchange?: string,
  ): Promise<Date | null> {
    const db = this.ensureDb();

    const conditions = ['symbol = ?', 'interval = ?'];
    const params: unknown[] = [symbol, interval];

    if (exchange) {
      conditions.push('exchange = ?');
      params.push(exchange);
    }

    const rows = await runQuery(
      db,
      `SELECT MAX(ts) as last_ts FROM ohlcv WHERE ${conditions.join(' AND ')}`,
      params,
    );

    const row = rows[0];
    if (!row || !row.last_ts) return null;
    return new Date(row.last_ts as string);
  }

  /**
   * Execute a raw SQL query. Useful for advanced analytics.
   */
  async sql(query: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    return runQuery(this.ensureDb(), query, params);
  }

  /**
   * Export query results to a Parquet file.
   */
  async exportParquet(query: string, outputPath: string): Promise<void> {
    const db = this.ensureDb();
    await mkdir(dirname(outputPath), { recursive: true });
    await runExec(db, `COPY (${query}) TO '${outputPath}' (FORMAT PARQUET)`);
  }

  /**
   * Import data from a Parquet file into the ohlcv table.
   */
  async importParquet(parquetPath: string): Promise<number> {
    const db = this.ensureDb();
    await runExec(db, `
      INSERT OR REPLACE INTO ohlcv
      SELECT * FROM read_parquet('${parquetPath}')
    `);

    const rows = await runQuery(db, `SELECT COUNT(*) as cnt FROM read_parquet('${parquetPath}')`);
    return (rows[0]?.cnt as number) ?? 0;
  }

  /**
   * Get total row count.
   */
  async count(symbol?: string, interval?: string): Promise<number> {
    const db = this.ensureDb();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (symbol) {
      conditions.push('symbol = ?');
      params.push(symbol);
    }
    if (interval) {
      conditions.push('interval = ?');
      params.push(interval);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await runQuery(db, `SELECT COUNT(*) as cnt FROM ohlcv ${where}`, params);
    return (rows[0]?.cnt as number) ?? 0;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
