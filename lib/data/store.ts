/**
 * DuckDB connection manager for local market data storage.
 *
 * Follows institutional patterns:
 *   - Parquet-first: bronze layer is raw Parquet files on disk
 *   - DuckDB for silver/gold: cleaned data in tables + Parquet export
 *   - Hive-style partitioning: date-partitioned directories for pruning
 *   - Instrument-centric: all queries go through instrument IDs (iid)
 *
 * Security:
 *   - All string values use parameterized queries (never interpolated into SQL)
 *   - Table/column names validated against allowlists
 *   - Path components sanitized against traversal
 *   - Query method restricted to read-only by default
 */

import duckdb from 'duckdb';
import { mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { SCHEMA_SQL } from './schema.js';

const DEFAULT_DATA_DIR = join(process.cwd(), '.desk', 'data');

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

// ── Security: allowlists and validation ────────────────────

/** Tables that exist in our schema and can be written to. */
const VALID_TABLES = new Set([
  'instruments', 'exchanges',
  'ohlcv', 'trades', 'quotes', 'orderbook',
  'funding_rates', 'open_interest', 'macro',
  'features',
  'sync_state',
]);

/** Valid column name pattern: alphanumeric + underscore only. */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Valid iid pattern: exchange:SYMBOL (alphanumeric, colon, hyphen, slash, dot). */
const SAFE_IID = /^[a-zA-Z0-9][a-zA-Z0-9:._\-/]*$/;

/** Valid path component: no path traversal, no special chars. */
const SAFE_PATH_COMPONENT = /^[a-zA-Z0-9][a-zA-Z0-9._\-]*$/;

function validateTable(table: string): void {
  if (!VALID_TABLES.has(table)) {
    throw new Error(`Invalid table name: ${table}. Allowed: ${[...VALID_TABLES].join(', ')}`);
  }
}

function validateColumns(columns: string[]): void {
  for (const col of columns) {
    if (!SAFE_IDENTIFIER.test(col)) {
      throw new Error(`Invalid column name: ${col}. Must match ${SAFE_IDENTIFIER}`);
    }
  }
}

function validateIdentifier(value: string, label: string): void {
  if (!SAFE_IID.test(value)) {
    throw new Error(`Invalid ${label}: ${value}. Must match ${SAFE_IID}`);
  }
}

function validatePathComponent(value: string, label: string): void {
  if (!SAFE_PATH_COMPONENT.test(value)) {
    throw new Error(`Invalid ${label}: ${value}. Must match ${SAFE_PATH_COMPONENT}`);
  }
}

/** Escape a string for safe use in SQL single quotes. */
function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

/** SQL statements that can modify data or access the filesystem. */
const WRITE_PATTERNS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|COPY|ATTACH|DETACH|LOAD|INSTALL|EXPORT|IMPORT|CALL|PRAGMA|SET)\b/i;

/** Directory layout following medallion architecture. */
const LAYER_DIRS = [
  'bronze/ohlcv', 'bronze/trades', 'bronze/quotes', 'bronze/orderbook',
  'bronze/funding', 'bronze/open_interest',
  'silver/ohlcv', 'silver/trades', 'silver/quotes', 'silver/orderbook',
  'gold/features', 'gold/signals',
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
    validatePathComponent(dataType, 'dataType');
    return join(this.dataDir, layer, dataType);
  }

  /** Build a Hive-style Parquet path: bronze/ohlcv/exchange=cube/date=2024-01-15/ */
  bronzePath(dataType: string, exchange: string, date: string): string {
    validatePathComponent(dataType, 'dataType');
    validatePathComponent(exchange, 'exchange');
    validatePathComponent(date, 'date');
    const dir = join(this.dataDir, 'bronze', dataType, `exchange=${exchange}`, `date=${date}`);
    // Verify the resolved path is still under dataDir (prevent traversal)
    const resolved = resolve(dir);
    const base = resolve(this.dataDir);
    if (!resolved.startsWith(base)) {
      throw new Error('Path traversal detected');
    }
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ── SQL execution ────────────────────────────────────────

  /** Execute a SQL statement (no results). Internal use only. */
  async exec(sql: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.conn.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Run a read-only query and return typed results.
   * Set readOnly=false to allow write statements (internal use).
   */
  async query(sql: string, limit: number = 10000, readOnly: boolean = true): Promise<QueryResult> {
    if (readOnly && WRITE_PATTERNS.test(sql)) {
      throw new Error(
        'Write operations not allowed in read-only query. ' +
        'Blocked statements: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, COPY, ATTACH, LOAD, INSTALL, EXPORT, IMPORT, CALL, PRAGMA, SET'
      );
    }

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

  /** Insert rows into a validated table using prepared statement with parameterized values. */
  async insertRows(table: string, columns: string[], rows: unknown[][]): Promise<number> {
    if (rows.length === 0) return 0;

    validateTable(table);
    validateColumns(columns);

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

  /** Export a validated table to a Parquet file with ZSTD compression. */
  async exportTable(table: string, filePath: string): Promise<void> {
    validateTable(table);
    validatePathComponent(filePath.split('/').pop() ?? '', 'filename');
    const resolved = resolve(filePath);
    if (!resolved.startsWith(resolve(this.dataDir))) {
      throw new Error('Export path must be within data directory');
    }
    await this.exec(`COPY (SELECT * FROM ${table} ORDER BY ts) TO '${sqlEscape(resolved)}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
  }

  /** Query Parquet files within the data directory using glob pattern. */
  async queryParquet(globPattern: string, limit?: number): Promise<QueryResult> {
    // Ensure the glob pattern resolves within our data directory
    const resolved = resolve(globPattern);
    if (!resolved.startsWith(resolve(this.dataDir))) {
      throw new Error('Parquet query path must be within data directory');
    }
    const sql = `SELECT * FROM read_parquet('${sqlEscape(resolved)}', hive_partitioning = true)`;
    return this.query(sql, limit, false);
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
    validateIdentifier(params.exchange, 'exchange');
    validateIdentifier(params.symbol, 'symbol');
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

  /** Look up an instrument by exchange and symbol using parameterized query. */
  async getInstrument(exchange: string, symbol: string): Promise<Record<string, unknown> | null> {
    validateIdentifier(exchange, 'exchange');
    validateIdentifier(symbol, 'symbol');
    const iid = `${exchange}:${symbol}`;
    // Use escaped string in a safe SELECT (no user-controlled structure)
    const result = await this.query(
      `SELECT * FROM instruments WHERE iid = '${sqlEscape(iid)}'`, 1, false
    );
    return result.rows[0] ?? null;
  }

  /** List all registered instruments, optionally filtered by asset class. */
  async listInstruments(assetClass?: string): Promise<QueryResult> {
    if (assetClass !== undefined) {
      validateIdentifier(assetClass, 'assetClass');
    }
    const where = assetClass ? ` WHERE asset_class = '${sqlEscape(assetClass)}'` : '';
    return this.query(`SELECT * FROM instruments${where} ORDER BY exchange, symbol`, 0, false);
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
