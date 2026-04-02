#!/usr/bin/env npx tsx
/**
 * CLI for syncing market data from Cube Exchange into the local DuckDB store.
 *
 * Medallion architecture: data flows Bronze (raw Parquet) → Silver (DuckDB) → Gold (features).
 *
 * Usage:
 *   npx tsx scripts/sync-data.ts                            # sync all markets, 1h + 1d
 *   npx tsx scripts/sync-data.ts --symbols BTCUSDC,ETHUSDC  # specific pairs
 *   npx tsx scripts/sync-data.ts --intervals 1m,1h,1d       # specific timeframes
 *   npx tsx scripts/sync-data.ts --trades --orderbook        # also fetch trades + book snapshots
 *   npx tsx scripts/sync-data.ts --status                    # show what's in the store
 *   npx tsx scripts/sync-data.ts --instruments               # list registered instruments
 *   npx tsx scripts/sync-data.ts --query "SELECT ..."        # run a read-only SQL query
 *   npx tsx scripts/sync-data.ts --export ohlcv              # export silver → Parquet
 *
 * Security:
 *   --query is restricted to read-only SQL (SELECT only; no COPY, ATTACH, LOAD, etc.)
 *   --export validates table name against an allowlist
 *   --instruments validates asset class filter
 */

import { DataStore } from '../lib/data/store.js';
import { syncCube, printStatus } from '../lib/data/sync.js';

/** Tables that can be exported via --export. */
const EXPORTABLE_TABLES = new Set([
  'ohlcv', 'trades', 'quotes', 'orderbook',
  'funding_rates', 'open_interest', 'macro', 'features',
]);

/** Valid symbol pattern for --symbols filter. */
const SAFE_SYMBOL = /^[A-Z0-9]{2,20}$/;

/** Valid interval pattern for --intervals filter. */
const VALID_INTERVALS = new Set(['1s', '1m', '15m', '1h', '4h', '1d']);

/** Valid asset class for --instruments filter. */
const VALID_ASSET_CLASSES = new Set(['crypto', 'equity', 'fx', 'commodity', 'rate']);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const store = await DataStore.open();

  try {
    // ── Status mode ──────────────────────────────────────
    if (args.status) {
      await printStatus(store);
      return;
    }

    // ── Instruments listing ──────────────────────────────
    if (args.instruments) {
      let filter: string | undefined;
      if (typeof args.instruments === 'string') {
        if (!VALID_ASSET_CLASSES.has(args.instruments)) {
          console.error(`Invalid asset class: ${args.instruments}. Valid: ${[...VALID_ASSET_CLASSES].join(', ')}`);
          process.exit(1);
        }
        filter = args.instruments;
      }
      const result = await store.listInstruments(filter);
      if (result.rows.length === 0) {
        console.log('No instruments registered. Run a sync first.');
      } else {
        console.table(result.rows);
      }
      return;
    }

    // ── Ad-hoc SQL query (read-only) ─────────────────────
    if (args.query && typeof args.query === 'string') {
      // store.query() enforces read-only by default — blocks INSERT, COPY, ATTACH, LOAD, etc.
      try {
        const result = await store.query(args.query, 0);
        if (result.rows.length === 0) {
          console.log('No results.');
        } else {
          console.table(result.rows);
        }
      } catch (err) {
        console.error(`Query error: ${(err as Error).message}`);
        process.exit(1);
      }
      return;
    }

    // ── Export silver layer to Parquet ────────────────────
    if (args.export && typeof args.export === 'string') {
      const table = args.export;
      if (!EXPORTABLE_TABLES.has(table)) {
        console.error(`Invalid table: ${table}. Exportable: ${[...EXPORTABLE_TABLES].join(', ')}`);
        process.exit(1);
      }
      const outDir = store.layerPath('silver', table);
      console.log(`Exporting ${table} → ${outDir}/...`);
      await store.exportTable(table, `${outDir}/export.parquet`);
      console.log('Done.');
      return;
    }

    // ── Sync mode ────────────────────────────────────────
    let symbols: string[] | undefined;
    if (typeof args.symbols === 'string') {
      symbols = args.symbols.split(',').map(s => s.trim());
      for (const s of symbols) {
        if (!SAFE_SYMBOL.test(s)) {
          console.error(`Invalid symbol: ${s}. Must be 2-20 uppercase alphanumeric chars.`);
          process.exit(1);
        }
      }
    }

    let intervals: string[] = ['1h', '1d'];
    if (typeof args.intervals === 'string') {
      intervals = args.intervals.split(',').map(s => s.trim());
      for (const i of intervals) {
        if (!VALID_INTERVALS.has(i)) {
          console.error(`Invalid interval: ${i}. Valid: ${[...VALID_INTERVALS].join(', ')}`);
          process.exit(1);
        }
      }
    }

    console.log('╔══════════════════════════════════════════╗');
    console.log('║   Cube Market Data Sync                  ║');
    console.log('║   Bronze → Silver → Gold                 ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log();

    const start = Date.now();
    const total = await syncCube(store, {
      symbols,
      intervals,
      trades: !!args.trades,
      orderbook: !!args.orderbook,
      quotes: !args['no-quotes'],
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log();
    console.log(`Done. ${total} records inserted in ${elapsed}s.`);
    console.log();

    await printStatus(store);
  } finally {
    await store.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
