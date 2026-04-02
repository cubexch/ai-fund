/**
 * DuckDB connection manager for local market data storage.
 *
 * Follows institutional patterns:
 *   - Parquet-first: bronze layer is raw Parquet files on disk
 *   - DuckDB for silver/gold: cleaned data in tables + Parquet export
 *   - Hive-style partitioning: date-partitioned directories for pruning
 *   - Instrument-centric: all queries go through instrument IDs (iid)
 */

import duckdb from 'duckdb';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_SQL } from './schema.js';

const DEFAULT_DATA_DIR = join(process.cwd(), '.desk', 'data');

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

/** Directory layout following medallion architecture. */
const LAYER_DIRS = [
  // Bronze: raw, append-only Parquet
  'bronze/ohlcv', 'bronze/trades', 'bronze/quotes', 'bronze/orderbook',
  'bronze/funding', 'bronze/open_interest',
  // Silver: cleaned (also in DuckDB tables)
  'silver/ohlcv', 'silver/trades', 'silver/quotes', 'silver/orderbook',
  // Gold: features, signals
  'gold/features', 'gold/signals',
  // Reference: instruments, exchanges
  'reference',
];

export class DataStore {
  private db: duckdb.Database;
  private conn: duckdb.Connection;
  readonly dataDir: string;

  private constructor(db: duckdb.Database, conn: duckdb.Connection, dataDir: string) {
    this.db = db;
    this.conn = conn;
    this.dataDir = dataDir;
  }

  /** Open (or create) the local data store with medallion directory structure. */
  static async open(dataDir: string = DEFAULT_DATA_DIR): Promise<DataStore> {
    for (const sub of LAYER_DIRS) {
      mkdirSync(join(dataDir, sub), { recursive: true });
    }

    const dbPath = join(dataDir, 'metadata.duckdb');
    const db = await new Promise<duckdb.Database>((resolve, reject) => {
      const instance = new duckdb.Database(dbPath, (err) => {
        if (err) reject(err);
        else resolve(instance);
      });
    });

    const conn = await new Promise<duckdb.Connection>((resolve, reject) => {
      const c = new duckdb.Connection(db, (err) => {
        if (err) reject(err);
        else resolve(c);
      });
    });

    const store = new DataStore(db, conn, dataDir);
    await store.exec(SCHEMA_SQL);
    return store;
  }

  // ── Path helpers for Parquet file layout ─────────────────

  /** Get the Parquet directory for a given layer and data type. */
  layerPath(layer: 'bronze' | 'silver' | 'gold' | 'reference', dataType: string): string {
    return join(this.dataDir, layer, dataType);
  }

  /** Build a Hive-style Parquet path: bronze/ohlcv/exchange=cube/date=2024-01-15/ */
  bronzePath(dataType: string, exchange: string, date: string): string {
    const dir = join(this.dataDir, 'bronze', dataType, `exchange=${exchange}`, `date=${date}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ── SQL execution ────────────────────────────────────────

  /** Execute a SQL statement (no results). */
  async exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Run a query and return typed results. */
  async query(sql: string, limit: number = 10000): Promise<QueryResult> {
    const safeSql = limit > 0 && !/\blimit\b/i.test(sql)
      ? `${sql} LIMIT ${limit}`
      : sql;

    return new Promise((resolve, reject) => {
      this.conn.all(safeSql, (err, rows) => {
        if (err) return reject(err);
        const result = rows as Record<string, unknown>[];
        const columns = result.length > 0 ? Object.keys(result[0]) : [];
        resolve({ columns, rows: result, rowCount: result.length });
      });
    });
  }

  /** Insert rows into a table using prepared statement. */
  async insertRows(table: string, columns: string[], rows: unknown[][]): Promise<number> {
    if (rows.length === 0) return 0;

    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;

    const stmt = await new Promise<duckdb.Statement>((resolve, reject) => {
      const s = this.conn.prepare(sql, (err) => {
        if (err) reject(err);
        else resolve(s);
      });
    });

    let inserted = 0;
    for (const row of rows) {
      await new Promise<void>((resolve, reject) => {
        stmt.run(...row, (err: Error | null) => {
          if (err) reject(err);
          else { inserted++; resolve(); }
        });
      });
    }

    await new Promise<void>((resolve, reject) => {
      stmt.finalize((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    return inserted;
  }

  // ── Parquet I/O ──────────────────────────────────────────

  /** Export a query result to a Parquet file with ZSTD compression. */
  async exportParquet(sql: string, filePath: string): Promise<void> {
    await this.exec(`COPY (${sql}) TO '${filePath}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  }

  /** Export with Hive-style partitioning. */
  async exportPartitioned(sql: string, dirPath: string, partitionBy: string[]): Promise<void> {
    const partCols = partitionBy.join(', ');
    await this.exec(
      `COPY (${sql}) TO '${dirPath}' (FORMAT PARQUET, COMPRESSION ZSTD, PARTITION_BY (${partCols}))`
    );
  }

  /** Query Parquet files directly using glob pattern with Hive partitioning. */
  async queryParquet(globPattern: string, whereSql?: string, limit?: number): Promise<QueryResult> {
    let sql = `SELECT * FROM read_parquet('${globPattern}', hive_partitioning = true)`;
    if (whereSql) sql += ` WHERE ${whereSql}`;
    return this.query(sql, limit);
  }

  // ── Instrument helpers ───────────────────────────────────

  /** Register an instrument in the master table. Returns the iid. */
  async registerInstrument(params: {
    exchange: string;
    symbol: string;
    assetClass: string;
    instrumentType: string;
    base?: string;
    quote?: string;
    tickSize?: number;
    lotSize?: number;
  }): Promise<string> {
    const iid = `${params.exchange}:${params.symbol}`;
    await this.insertRows('instruments', [
      'iid', 'symbol', 'asset_class', 'instrument_type',
      'base', 'quote', 'exchange', 'tick_size', 'lot_size',
    ], [[
      iid, params.symbol, params.assetClass, params.instrumentType,
      params.base ?? null, params.quote ?? null, params.exchange,
      params.tickSize ?? null, params.lotSize ?? null,
    ]]);
    return iid;
  }

  /** Look up an instrument by exchange and symbol. */
  async getInstrument(exchange: string, symbol: string): Promise<Record<string, unknown> | null> {
    const iid = `${exchange}:${symbol}`;
    const result = await this.query(
      `SELECT * FROM instruments WHERE iid = '${iid}'`, 1
    );
    return result.rows[0] ?? null;
  }

  /** List all registered instruments, optionally filtered by asset class. */
  async listInstruments(assetClass?: string): Promise<QueryResult> {
    const where = assetClass ? ` WHERE asset_class = '${assetClass}'` : '';
    return this.query(`SELECT * FROM instruments${where} ORDER BY exchange, symbol`, 0);
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
