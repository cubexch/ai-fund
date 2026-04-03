#!/usr/bin/env node

/**
 * CCXT logout CLI — removes exchange credentials from the credential store.
 *
 * Usage:
 *   npm run logout                          # Coinbase (default)
 *   npm run logout -- --exchange binance    # Binance
 */

import { deleteCredentials, getBackendName } from '../client/credential-store.js';
import { parseArgs } from './common.js';

async function main() {
  const { exchangeId } = parseArgs();
  const backend = await getBackendName();
  await deleteCredentials(exchangeId);
  console.error(`${exchangeId} credentials removed from ${backend}`);
}

main().catch(err => {
  console.error(`Logout failed: ${err.message}`);
  process.exit(1);
});
