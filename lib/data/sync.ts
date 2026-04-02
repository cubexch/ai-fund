/**
 * Incremental sync orchestrator for the local market data store.
 * Fetches data from Cube Exchange public APIs and inserts into DuckDB.
 * Tracks sync progress in the sync_state table to avoid re-downloading.
 */

import { DataStore } from './store.js';
import { INTERVAL_MS } from './schema.js';
import {
  fetchMarkets,
  fetchAllKlines,
  fetchRecentTrades,
  fetchOrderBook,
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
  /** Logger function (default: console.log). */
  log?: LogFn;
}

const OHLCV_COLUMNS = ['source', 'symbol', 'interval', 'ts', 'open', 'high', 'low', 'close', 'volume'];
const TRADE_COLUMNS = ['source', 'symbol', 'trade_id', 'ts', 'price', 'quantity', 'side'];
const ORDERBOOK_COLUMNS = ['source', 'symbol', 'ts', 'side', 'level', 'price', 'quantity'];

/** Get the last synced timestamp for a (source, symbol, data_type) combo. */
async function getLastSync(store: DataStore, source: string, symbol: string, dataType: string): Promise<number | null> {
  const result = await store.query(
    `SELECT last_ts FROM sync_state WHERE source = '${source}' AND symbol = '${symbol}' AND data_type = '${dataType}'`,
    1
  );
  if (result.rows.length === 0) return null;
  const ts = result.rows[0].last_ts;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  return null;
}

/** Update sync state after a successful batch. */
async function updateSyncState(
  store: DataStore,
  source: string,
  symbol: string,
  dataType: string,
  lastTs: number,
  count: number,
): Promise<void> {
  await store.exec(`
    INSERT OR REPLACE INTO sync_state (source, symbol, data_type, last_ts, last_synced, record_count)
    VALUES (
      '${source}', '${symbol}', '${dataType}',
      epoch_ms(${lastTs}),
      epoch_ms(${Date.now()}),
      COALESCE((SELECT record_count FROM sync_state
        WHERE source = '${source}' AND symbol = '${symbol}' AND data_type = '${dataType}'), 0) + ${count}
    )
  `);
}

/** Sync OHLCV candles for a single market + interval. */
async function syncOHLCV(
  store: DataStore,
  market: CubeMarket,
  interval: string,
  log: LogFn,
): Promise<number> {
  const dataType = `ohlcv_${interval}`;
  const lastTs = await getLastSync(store, 'cube', market.symbol, dataType);
  let totalInserted = 0;

  log(`  ${market.symbol} ${interval}: fetching${lastTs ? ` since ${new Date(lastTs).toISOString()}` : ' full history'}...`);

  for await (const batch of fetchAllKlines(market.marketId, market.symbol, interval, lastTs ?? undefined)) {
    const rows = batch.map((k: CubeKline) => [
      'cube',
      market.symbol,
      interval,
      new Date(k.startTime),
      k.open,
      k.high,
      k.low,
      k.close,
      k.volume,
    ]);

    const inserted = await store.insertRows('ohlcv', OHLCV_COLUMNS, rows);
    totalInserted += inserted;

    // Update sync state with the newest timestamp in this batch
    const newestTs = Math.max(...batch.map(k => k.startTime));
    await updateSyncState(store, 'cube', market.symbol, dataType, newestTs, inserted);
  }

  if (totalInserted > 0) {
    log(`  ${market.symbol} ${interval}: +${totalInserted} candles`);
  } else {
    log(`  ${market.symbol} ${interval}: up to date`);
  }

  return totalInserted;
}

/** Sync recent trades for a single market. */
async function syncTrades(
  store: DataStore,
  market: CubeMarket,
  log: LogFn,
): Promise<number> {
  log(`  ${market.symbol}: fetching recent trades...`);
  const trades = await fetchRecentTrades(market.symbol);

  const rows = trades.map(t => [
    'cube',
    market.symbol,
    t.id,
    new Date(t.timestamp),
    t.price,
    t.quantity,
    t.side,
  ]);

  const inserted = await store.insertRows('trades', TRADE_COLUMNS, rows);
  if (inserted > 0) {
    const newestTs = Math.max(...trades.map(t => t.timestamp));
    await updateSyncState(store, 'cube', market.symbol, 'trades', newestTs, inserted);
    log(`  ${market.symbol}: +${inserted} trades`);
  }

  return inserted;
}

/** Snapshot order book for a single market. */
async function syncOrderBook(
  store: DataStore,
  market: CubeMarket,
  log: LogFn,
): Promise<number> {
  log(`  ${market.symbol}: snapshotting order book...`);
  const book = await fetchOrderBook(market.symbol);
  const now = new Date();
  const rows: unknown[][] = [];

  book.bids.forEach(([price, qty], i) => {
    rows.push(['cube', market.symbol, now, 'bid', i, price, qty]);
  });
  book.asks.forEach(([price, qty], i) => {
    rows.push(['cube', market.symbol, now, 'ask', i, price, qty]);
  });

  const inserted = await store.insertRows('orderbook_snapshots', ORDERBOOK_COLUMNS, rows);
  if (inserted > 0) {
    await updateSyncState(store, 'cube', market.symbol, 'orderbook', Date.now(), inserted);
    log(`  ${market.symbol}: +${inserted} book levels`);
  }

  return inserted;
}

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
    log = console.log,
  } = options;

  log('Fetching Cube markets...');
  const allMarkets = await fetchMarkets();
  const markets = symbols
    ? allMarkets.filter(m => symbols.includes(m.symbol))
    : allMarkets;

  log(`Syncing ${markets.length} market(s): ${markets.map(m => m.symbol).join(', ')}`);

  let totalInserted = 0;

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

/** Print a summary of what's in the data store. */
export async function printStatus(store: DataStore, log: LogFn = console.log): Promise<void> {
  const result = await store.query(`
    SELECT
      source,
      symbol,
      data_type,
      last_ts,
      last_synced,
      record_count
    FROM sync_state
    ORDER BY source, symbol, data_type
  `, 0);

  if (result.rows.length === 0) {
    log('No data synced yet. Run: npx tsx scripts/sync-data.ts');
    return;
  }

  log('\n  Source  │ Symbol     │ Data Type   │ Records   │ Last Data             │ Last Sync');
  log('  ───────┼────────────┼─────────────┼───────────┼───────────────────────┼─────────────────');

  for (const row of result.rows) {
    const source = String(row.source).padEnd(6);
    const symbol = String(row.symbol).padEnd(10);
    const dtype = String(row.data_type).padEnd(11);
    const count = String(row.record_count).padStart(9);
    const lastTs = row.last_ts instanceof Date ? row.last_ts.toISOString().slice(0, 19) : String(row.last_ts).slice(0, 19);
    const lastSync = row.last_synced instanceof Date ? row.last_synced.toISOString().slice(0, 19) : String(row.last_synced).slice(0, 19);
    log(`  ${source} │ ${symbol} │ ${dtype} │ ${count} │ ${lastTs.padEnd(21)} │ ${lastSync}`);
  }

  // Total row count
  const totals = await store.query(`SELECT SUM(record_count) as total FROM sync_state`, 1);
  const total = totals.rows[0]?.total ?? 0;
  log(`\n  Total records: ${total}`);
}
