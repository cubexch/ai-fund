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
 *   npx tsx scripts/sync-data.ts --query "SELECT ..."        # run a SQL query
 *   npx tsx scripts/sync-data.ts --export ohlcv              # export silver → Parquet
 */

import { DataStore } from '../lib/data/store.js';
import { syncCube, printStatus } from '../lib/data/sync.js';

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
      const result = await store.listInstruments(
        typeof args.instruments === 'string' ? args.instruments : undefined
      );
      if (result.rows.length === 0) {
        console.log('No instruments registered. Run a sync first.');
      } else {
        console.table(result.rows);
      }
      return;
    }

    // ── Ad-hoc SQL query ─────────────────────────────────
    if (args.query && typeof args.query === 'string') {
      const result = await store.query(args.query, 0);
      if (result.rows.length === 0) {
        console.log('No results.');
      } else {
        console.table(result.rows);
      }
      return;
    }

    // ── Export silver layer to Parquet ────────────────────
    if (args.export && typeof args.export === 'string') {
      const table = args.export;
      const outDir = store.layerPath('silver', table);
      console.log(`Exporting ${table} → ${outDir}/...`);
      await store.exportParquet(
        `SELECT * FROM ${table} ORDER BY ts`,
        `${outDir}/export.parquet`
      );
      console.log('Done.');
      return;
    }

    // ── Sync mode ────────────────────────────────────────
    const symbols = typeof args.symbols === 'string'
      ? args.symbols.split(',').map(s => s.trim())
      : undefined;

    const intervals = typeof args.intervals === 'string'
      ? args.intervals.split(',').map(s => s.trim())
      : ['1h', '1d'];

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
