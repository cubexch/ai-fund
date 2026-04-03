/**
 * DuckDB-backed trade journal.
 * Persists every order and fill for execution analytics,
 * P&L tracking, and strategy evaluation.
 */

import { Database } from 'duckdb';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ── Types ────────────────────────────────────────────────────

export interface TradeRecord {
  id: string;
  exchange: string;
  symbol: string;
  side: string;
  type: string;
  amount: number;
  price: number | null;
  cost: number | null;
  fee: number | null;
  feeCurrency: string | null;
  timestamp: number;
  orderId: string | null;
  strategy: string | null;  // which agent/strategy placed this
}

export interface PnlReport {
  totalTrades: number;
  buyVolume: number;
  sellVolume: number;
  totalFees: number;
  realizedPnl: number;
  symbols: string[];
}

// ── Constants ────────────────────────────────────────────────

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS trades (
    id            VARCHAR NOT NULL,
    exchange      VARCHAR NOT NULL,
    symbol        VARCHAR NOT NULL,
    side          VARCHAR NOT NULL,
    type          VARCHAR NOT NULL,
    amount        DOUBLE NOT NULL,
    price         DOUBLE,
    cost          DOUBLE,
    fee           DOUBLE,
    fee_currency  VARCHAR,
    ts            BIGINT NOT NULL,
    order_id      VARCHAR,
    strategy      VARCHAR,
    PRIMARY KEY (id, exchange)
  );
`;

const CREATE_INDEX_LOOKUP_SQL = `
  CREATE INDEX IF NOT EXISTS idx_trades_lookup
    ON trades (exchange, symbol, ts);
`;

const CREATE_INDEX_STRATEGY_SQL = `
  CREATE INDEX IF NOT EXISTS idx_trades_strategy
    ON trades (strategy, ts);
`;

// ── Helpers ──────────────────────────────────────────────────

/** Coerce BigInt values to numbers in a row object. */
function coerceBigInts(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return out;
}

function runQuery(db: Database, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, ...params, (err: Error | null, rows: Record<string, unknown>[]) => {
      if (err) reject(err);
      else resolve((rows ?? []).map(coerceBigInts));
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

// ── TradeJournal ─────────────────────────────────────────────

export class TradeJournal {
  private db: Database | null = null;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    if (this.dbPath !== ':memory:') {
      await mkdir(dirname(this.dbPath), { recursive: true });
    }

    this.db = new Database(this.dbPath);
    await runExec(this.db, CREATE_TABLE_SQL);
    await runExec(this.db, CREATE_INDEX_LOOKUP_SQL);
    await runExec(this.db, CREATE_INDEX_STRATEGY_SQL);
  }

  private ensureDb(): Database {
    if (!this.db) throw new Error('TradeJournal not initialized. Call init() first.');
    return this.db;
  }

  /**
   * Record a single trade.
   */
  async record(trade: TradeRecord): Promise<void> {
    const db = this.ensureDb();
    await runQuery(
      db,
      `INSERT OR REPLACE INTO trades (id, exchange, symbol, side, type, amount, price, cost, fee, fee_currency, ts, order_id, strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trade.id,
        trade.exchange,
        trade.symbol,
        trade.side,
        trade.type,
        trade.amount,
        trade.price,
        trade.cost,
        trade.fee,
        trade.feeCurrency,
        trade.timestamp,
        trade.orderId,
        trade.strategy,
      ],
    );
  }

  /**
   * Bulk insert trades with batching (500 per batch).
   */
  async recordBatch(trades: TradeRecord[]): Promise<number> {
    if (trades.length === 0) return 0;

    const db = this.ensureDb();
    const batchSize = 500;
    let inserted = 0;

    for (let i = 0; i < trades.length; i += batchSize) {
      const batch = trades.slice(i, i + batchSize);
      const placeholders = batch
        .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .join(', ');

      const values: unknown[] = [];
      for (const t of batch) {
        values.push(
          t.id,
          t.exchange,
          t.symbol,
          t.side,
          t.type,
          t.amount,
          t.price,
          t.cost,
          t.fee,
          t.feeCurrency,
          t.timestamp,
          t.orderId,
          t.strategy,
        );
      }

      await runQuery(
        db,
        `INSERT OR REPLACE INTO trades (id, exchange, symbol, side, type, amount, price, cost, fee, fee_currency, ts, order_id, strategy)
         VALUES ${placeholders}`,
        values,
      );
      inserted += batch.length;
    }

    return inserted;
  }

  /**
   * Query trades with optional filters.
   */
  async query(opts: {
    exchange?: string;
    symbol?: string;
    strategy?: string;
    since?: number;
    until?: number;
    limit?: number;
  }): Promise<TradeRecord[]> {
    const db = this.ensureDb();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.exchange) {
      conditions.push('exchange = ?');
      params.push(opts.exchange);
    }
    if (opts.symbol) {
      conditions.push('symbol = ?');
      params.push(opts.symbol);
    }
    if (opts.strategy) {
      conditions.push('strategy = ?');
      params.push(opts.strategy);
    }
    if (opts.since) {
      conditions.push('ts >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      conditions.push('ts <= ?');
      params.push(opts.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let sql = `SELECT id, exchange, symbol, side, type, amount, price, cost, fee, fee_currency, ts, order_id, strategy
               FROM trades ${where}
               ORDER BY ts DESC`;

    if (opts.limit != null) {
      const n = Number(opts.limit);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error('limit must be a positive integer');
      }
      sql += ` LIMIT ${n}`;
    }

    const rows = await runQuery(db, sql, params);

    return rows.map(row => ({
      id: row.id as string,
      exchange: row.exchange as string,
      symbol: row.symbol as string,
      side: row.side as string,
      type: row.type as string,
      amount: row.amount as number,
      price: row.price as number | null,
      cost: row.cost as number | null,
      fee: row.fee as number | null,
      feeCurrency: row.fee_currency as string | null,
      timestamp: row.ts as number,
      orderId: row.order_id as string | null,
      strategy: row.strategy as string | null,
    }));
  }

  /**
   * Compute P&L summary from trade history.
   * P&L = total sell cost - total buy cost - total fees.
   */
  async pnl(opts: {
    exchange?: string;
    symbol?: string;
    strategy?: string;
    since?: number;
  }): Promise<PnlReport> {
    const db = this.ensureDb();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.exchange) {
      conditions.push('exchange = ?');
      params.push(opts.exchange);
    }
    if (opts.symbol) {
      conditions.push('symbol = ?');
      params.push(opts.symbol);
    }
    if (opts.strategy) {
      conditions.push('strategy = ?');
      params.push(opts.strategy);
    }
    if (opts.since) {
      conditions.push('ts >= ?');
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const rows = await runQuery(
      db,
      `SELECT
         COUNT(*) as total_trades,
         COALESCE(SUM(CASE WHEN side = 'buy' THEN COALESCE(cost, amount * COALESCE(price, 0)) ELSE 0 END), 0) as buy_volume,
         COALESCE(SUM(CASE WHEN side = 'sell' THEN COALESCE(cost, amount * COALESCE(price, 0)) ELSE 0 END), 0) as sell_volume,
         COALESCE(SUM(COALESCE(fee, 0)), 0) as total_fees
       FROM trades ${where}`,
      params,
    );

    const row = rows[0];
    const totalTrades = (row?.total_trades as number) ?? 0;
    const buyVolume = (row?.buy_volume as number) ?? 0;
    const sellVolume = (row?.sell_volume as number) ?? 0;
    const totalFees = (row?.total_fees as number) ?? 0;
    const realizedPnl = sellVolume - buyVolume - totalFees;

    // Get distinct symbols
    const symbolRows = await runQuery(
      db,
      `SELECT DISTINCT symbol FROM trades ${where} ORDER BY symbol`,
      params,
    );
    const symbols = symbolRows.map(r => r.symbol as string);

    return {
      totalTrades,
      buyVolume,
      sellVolume,
      totalFees,
      realizedPnl,
      symbols,
    };
  }

  /**
   * Execute a raw SQL query (SELECT only).
   */
  async sql(query: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const db = this.ensureDb();

    const trimmed = query.trim();
    if (!/^SELECT\b/i.test(trimmed)) {
      throw new Error('Only SELECT queries are allowed.');
    }

    return runQuery(db, trimmed, params ?? []);
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
