/**
 * Incremental sync orchestrator for the local market data store.
 *
 * Follows the medallion architecture:
 *   1. Fetch raw data from Cube Exchange public APIs
 *   2. Register instruments in the master table
 *   3. Insert into silver layer (cleaned DuckDB tables)
 *   4. Export to bronze layer (append-only Parquet for replay)
 *   5. Track sync progress in sync_state (incremental, never re-download)
 */

import { DataStore } from './store.js';
import { INTERVAL_MS } from './schema.js';
import {
  fetchMarkets,
  fetchAllKlines,
  fetchTickers,
  fetchRecentTrades,
  fetchOrderBook,
  parseSymbol,
  cubeIid,
  type CubeMarket,
  type CubeKline,
} from './sources/cube.js';

export type LogFn = (msg: string) => void;

export interface SyncOptions {
  /** Symbols to sync (e.g. ['BTCUSDC', 'ETHUSDC']). Empty = all active markets. */
  symbols?: string[];
  /** Candle intervals to fetch (default: ['1h', '1d']). */
  intervals?: string[];
  /** Also snapshot the current order book (default: false). */
  orderbook?: boolean;
  /** Also fetch recent trades (default: false). */
  trades?: boolean;
  /** Also capture current quotes/tickers (default: true). */
  quotes?: boolean;
  /** Logger function (default: console.log). */
  log?: LogFn;
}

// Silver table column definitions (kdb+ convention: ts first, then iid)
const OHLCV_COLS = ['ts', 'iid', 'interval', 'open', 'high', 'low', 'close', 'volume'];
const TRADE_COLS = ['ts', 'iid', 'trade_id', 'price', 'size', 'side'];
const QUOTE_COLS = ['ts', 'iid', 'bid', 'ask', 'bid_size', 'ask_size'];
const BOOK_COLS  = ['ts', 'iid', 'side', 'level', 'price', 'size'];

// ── Sync state helpers ─────────────────────────────────────

async function getLastSync(store: DataStore, iid: string, dataType: string): Promise<number | null> {
  const result = await store.query(
    `SELECT last_ts FROM sync_state WHERE iid = '${iid}' AND data_type = '${dataType}'`, 1
  );
  if (result.rows.length === 0) return null;
  const ts = result.rows[0].last_ts;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  return null;
}

async function updateSyncState(
  store: DataStore, iid: string, dataType: string, lastTs: number, count: number,
): Promise<void> {
  await store.exec(`
    INSERT OR REPLACE INTO sync_state (iid, data_type, last_ts, last_synced, record_count)
    VALUES (
      '${iid}', '${dataType}',
      epoch_ms(${lastTs}), epoch_ms(${Date.now()}),
      COALESCE((SELECT record_count FROM sync_state
        WHERE iid = '${iid}' AND data_type = '${dataType}'), 0) + ${count}
    )
  `);
}

// ── Instrument registration ────────────────────────────────

/** Register all Cube markets in the instrument master. */
async function registerCubeInstruments(
  store: DataStore, markets: CubeMarket[], log: LogFn,
): Promise<void> {
  let registered = 0;
  for (const m of markets) {
    const { base, quote } = parseSymbol(m.symbol);
    const existing = await store.getInstrument('cube', m.symbol);
    if (!existing) {
      await store.registerInstrument({
        exchange: 'cube',
        symbol: m.symbol,
        assetClass: 'crypto',
        instrumentType: 'spot',
        base,
        quote,
        tickSize: parseFloat(m.priceTickSize),
        lotSize: parseFloat(m.quantityTickSize),
      });
      registered++;
    }
  }
  if (registered > 0) {
    log(`  Registered ${registered} new instrument(s) in master table`);
  }
}

// ── Per-data-type sync functions ───────────────────────────

async function syncOHLCV(
  store: DataStore, market: CubeMarket, interval: string, log: LogFn,
): Promise<number> {
  const iid = cubeIid(market.symbol);
  const dataType = `ohlcv_${interval}`;
  const lastTs = await getLastSync(store, iid, dataType);
  let totalInserted = 0;

  log(`  ${market.symbol} ${interval}: fetching${lastTs ? ` since ${new Date(lastTs).toISOString()}` : ' full history'}...`);

  for await (const batch of fetchAllKlines(market.marketId, market.symbol, interval, lastTs ?? undefined)) {
    const rows = batch.map((k: CubeKline) => [
      new Date(k.startTime), // ts
      iid,                   // iid
      interval,
      k.open, k.high, k.low, k.close, k.volume,
    ]);

    const inserted = await store.insertRows('ohlcv', OHLCV_COLS, rows);
    totalInserted += inserted;

    const newestTs = Math.max(...batch.map(k => k.startTime));
    await updateSyncState(store, iid, dataType, newestTs, inserted);
  }

  if (totalInserted > 0) {
    log(`  ${market.symbol} ${interval}: +${totalInserted} candles`);
  } else {
    log(`  ${market.symbol} ${interval}: up to date`);
  }

  return totalInserted;
}

async function syncTrades(
  store: DataStore, market: CubeMarket, log: LogFn,
): Promise<number> {
  const iid = cubeIid(market.symbol);
  log(`  ${market.symbol}: fetching recent trades...`);

  const trades = await fetchRecentTrades(market.symbol);
  const rows = trades.map(t => [
    new Date(t.timestamp), iid, t.id, t.price, t.quantity, t.side,
  ]);

  const inserted = await store.insertRows('trades', TRADE_COLS, rows);
  if (inserted > 0) {
    const newestTs = Math.max(...trades.map(t => t.timestamp));
    await updateSyncState(store, iid, 'trades', newestTs, inserted);
    log(`  ${market.symbol}: +${inserted} trades`);
  }
  return inserted;
}

async function syncQuotes(
  store: DataStore, markets: CubeMarket[], log: LogFn,
): Promise<number> {
  log('  Fetching current tickers/quotes...');
  const tickers = await fetchTickers();
  const now = new Date();
  const marketSymbols = new Set(markets.map(m => m.symbol));

  const rows = tickers
    .filter(t => marketSymbols.has(t.symbol))
    .filter(t => t.bid !== null || t.ask !== null)
    .map(t => [
      now, cubeIid(t.symbol),
      t.bid, t.ask,
      null, null, // bid_size, ask_size (not available from tickers endpoint)
    ]);

  const inserted = await store.insertRows('quotes', QUOTE_COLS, rows);
  if (inserted > 0) {
    log(`  +${inserted} quote snapshots`);
  }
  return inserted;
}

async function syncOrderBook(
  store: DataStore, market: CubeMarket, log: LogFn,
): Promise<number> {
  const iid = cubeIid(market.symbol);
  log(`  ${market.symbol}: snapshotting order book...`);

  const book = await fetchOrderBook(market.symbol);
  const now = new Date();
  const rows: unknown[][] = [];

  book.bids.forEach(([price, qty], i) => {
    rows.push([now, iid, 'bid', i, price, qty]);
  });
  book.asks.forEach(([price, qty], i) => {
    rows.push([now, iid, 'ask', i, price, qty]);
  });

  const inserted = await store.insertRows('orderbook', BOOK_COLS, rows);
  if (inserted > 0) {
    await updateSyncState(store, iid, 'orderbook', Date.now(), inserted);
    log(`  ${market.symbol}: +${inserted} book levels`);
  }
  return inserted;
}

// ── Main orchestrator ──────────────────────────────────────

/**
 * Run a full incremental sync against Cube Exchange.
 * Returns total number of records inserted.
 */
export async function syncCube(store: DataStore, options: SyncOptions = {}): Promise<number> {
  const {
    symbols,
    intervals = ['1h', '1d'],
    orderbook = false,
    trades = false,
    quotes = true,
    log = console.log,
  } = options;

  // 1. Fetch and filter markets
  log('Fetching Cube markets...');
  const allMarkets = await fetchMarkets();
  const markets = symbols
    ? allMarkets.filter(m => symbols.includes(m.symbol))
    : allMarkets;

  log(`Syncing ${markets.length} market(s): ${markets.map(m => m.symbol).join(', ')}`);

  // 2. Register instruments in master table
  await registerCubeInstruments(store, markets, log);

  let totalInserted = 0;

  // 3. Quotes snapshot (one call for all markets)
  if (quotes) {
    try {
      totalInserted += await syncQuotes(store, markets, log);
    } catch (err) {
      log(`  ERROR syncing quotes: ${(err as Error).message}`);
    }
  }

  // 4. Per-market sync
  for (const market of markets) {
    // OHLCV for each interval
    for (const interval of intervals) {
      if (!INTERVAL_MS[interval]) {
        log(`  Skipping unknown interval: ${interval}`);
        continue;
      }
      try {
        totalInserted += await syncOHLCV(store, market, interval, log);
      } catch (err) {
        log(`  ERROR syncing ${market.symbol} ${interval}: ${(err as Error).message}`);
      }
    }

    // Recent trades
    if (trades) {
      try {
        totalInserted += await syncTrades(store, market, log);
      } catch (err) {
        log(`  ERROR syncing trades ${market.symbol}: ${(err as Error).message}`);
      }
    }

    // Order book snapshot
    if (orderbook) {
      try {
        totalInserted += await syncOrderBook(store, market, log);
      } catch (err) {
        log(`  ERROR snapshotting book ${market.symbol}: ${(err as Error).message}`);
      }
    }

    // Rate limit between markets
    await new Promise(r => setTimeout(r, 100));
  }

  return totalInserted;
}

// ── Status / reporting ─────────────────────────────────────

/** Print a summary of what's in the data store. */
export async function printStatus(store: DataStore, log: LogFn = console.log): Promise<void> {
  // Instruments summary
  const instruments = await store.query(
    `SELECT asset_class, COUNT(*) as count FROM instruments GROUP BY asset_class ORDER BY asset_class`, 0
  );

  if (instruments.rows.length > 0) {
    log('\n  Instruments');
    log('  ──────────────────────────');
    for (const row of instruments.rows) {
      log(`  ${String(row.asset_class).padEnd(12)} ${row.count} registered`);
    }
  }

  // Sync state
  const result = await store.query(`
    SELECT
      s.iid,
      i.asset_class,
      i.exchange,
      s.data_type,
      s.last_ts,
      s.last_synced,
      s.record_count
    FROM sync_state s
    LEFT JOIN instruments i ON s.iid = i.iid
    ORDER BY i.exchange, s.iid, s.data_type
  `, 0);

  if (result.rows.length === 0) {
    log('\nNo data synced yet. Run: npx tsx scripts/sync-data.ts');
    return;
  }

  log('\n  IID                │ Class   │ Data Type   │ Records   │ Last Data             │ Last Sync');
  log('  ───────────────────┼─────────┼─────────────┼───────────┼───────────────────────┼─────────────────');

  for (const row of result.rows) {
    const iid = String(row.iid).padEnd(19);
    const cls = String(row.asset_class ?? '?').padEnd(7);
    const dtype = String(row.data_type).padEnd(11);
    const count = String(row.record_count).padStart(9);
    const lastTs = row.last_ts instanceof Date ? row.last_ts.toISOString().slice(0, 19) : String(row.last_ts ?? '').slice(0, 19);
    const lastSync = row.last_synced instanceof Date ? row.last_synced.toISOString().slice(0, 19) : String(row.last_synced ?? '').slice(0, 19);
    log(`  ${iid} │ ${cls} │ ${dtype} │ ${count} │ ${lastTs.padEnd(21)} │ ${lastSync}`);
  }

  // Totals
  const totals = await store.query(`SELECT SUM(record_count) as total FROM sync_state`, 1);
  const total = totals.rows[0]?.total ?? 0;

  // Table row counts
  const tables = ['ohlcv', 'trades', 'quotes', 'orderbook', 'funding_rates', 'open_interest', 'macro', 'features'];
  log('\n  Table Sizes');
  log('  ──────────────────────────');
  for (const table of tables) {
    try {
      const r = await store.query(`SELECT COUNT(*) as n FROM ${table}`, 1);
      const n = r.rows[0]?.n ?? 0;
      if (Number(n) > 0) {
        log(`  ${table.padEnd(20)} ${String(n).padStart(10)} rows`);
      }
    } catch {
      // table may not exist yet
    }
  }

  log(`\n  Total synced records: ${total}`);
}
