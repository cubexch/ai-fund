#!/usr/bin/env npx tsx
/**
 * CLI for syncing market data from Cube Exchange into the local DuckDB store.
 *
 * Usage:
 *   npx tsx scripts/sync-data.ts                        # sync all markets, 1h + 1d
 *   npx tsx scripts/sync-data.ts --symbols BTCUSDC,ETHUSDC
 *   npx tsx scripts/sync-data.ts --intervals 1m,1h,1d
 *   npx tsx scripts/sync-data.ts --trades --orderbook   # also fetch trades + book snapshots
 *   npx tsx scripts/sync-data.ts --status               # show what's in the store
 *   npx tsx scripts/sync-data.ts --query "SELECT ..."   # run a SQL query
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
    if (args.status) {
      await printStatus(store);
      return;
    }

    if (args.query && typeof args.query === 'string') {
      const result = await store.query(args.query, 0);
      if (result.rows.length === 0) {
        console.log('No results.');
      } else {
        console.table(result.rows);
      }
      return;
    }

    // Sync mode
    const symbols = typeof args.symbols === 'string'
      ? args.symbols.split(',').map(s => s.trim())
      : undefined;

    const intervals = typeof args.intervals === 'string'
      ? args.intervals.split(',').map(s => s.trim())
      : ['1h', '1d'];

    console.log('╔══════════════════════════════════════╗');
    console.log('║   Cube Market Data Sync              ║');
    console.log('╚══════════════════════════════════════╝');
    console.log();

    const start = Date.now();
    const total = await syncCube(store, {
      symbols,
      intervals,
      trades: !!args.trades,
      orderbook: !!args.orderbook,
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
