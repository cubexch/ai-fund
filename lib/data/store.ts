/**
 * DuckDB connection manager for local market data storage.
 * Provides a thin async wrapper over duckdb-node for querying
 * OHLCV candles, trades, funding rates, and macro data stored
 * as Parquet files with a lightweight metadata catalog.
 */

import duckdb from 'duckdb';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_SQL } from './schema.js';

const DEFAULT_DATA_DIR = join(process.cwd(), '.desk', 'data');

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export class DataStore {
  private db: duckdb.Database;
  private conn: duckdb.Connection;
  readonly dataDir: string;

  private constructor(db: duckdb.Database, conn: duckdb.Connection, dataDir: string) {
    this.db = db;
    this.conn = conn;
    this.dataDir = dataDir;
  }

  /** Open (or create) the local data store. */
  static async open(dataDir: string = DEFAULT_DATA_DIR): Promise<DataStore> {
    // Ensure directory structure exists
    for (const sub of ['ohlcv', 'trades', 'funding', 'open_interest', 'orderbook', 'macro']) {
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

  /** Export a table/query to Parquet file. */
  async exportParquet(sql: string, filePath: string): Promise<void> {
    await this.exec(`COPY (${sql}) TO '${filePath}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  }

  /** Import a Parquet file as a queryable view. */
  async importParquet(filePath: string, viewName: string): Promise<void> {
    await this.exec(`CREATE OR REPLACE VIEW ${viewName} AS SELECT * FROM read_parquet('${filePath}')`);
  }

  /** Query Parquet files directly using glob pattern. */
  async queryParquet(globPattern: string, sql?: string): Promise<QueryResult> {
    const baseSql = sql
      ? sql.replace('$PARQUET', `read_parquet('${globPattern}')`)
      : `SELECT * FROM read_parquet('${globPattern}')`;
    return this.query(baseSql);
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
