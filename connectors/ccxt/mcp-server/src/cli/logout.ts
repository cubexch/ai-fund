#!/usr/bin/env node

/**
 * CCXT logout CLI — removes exchange credentials from the credential store.
 *
 * Usage:
 *   npm run logout                          # Coinbase (default)
 *   npm run logout -- --exchange binance    # Binance
 */

import { deleteCredentials, getBackendName } from '../client/credential-store.js';

async function main() {
  const args = process.argv.slice(2);
  let exchangeId = 'coinbase';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exchange' && args[i + 1]) {
      exchangeId = args[i + 1];
      i++;
    }
  }

  exchangeId = process.env.CCXT_EXCHANGE ?? exchangeId;

  const backend = await getBackendName();
  await deleteCredentials(exchangeId);
  console.error(`${exchangeId} credentials removed from ${backend}`);
}

main().catch(err => {
  console.error(`Logout failed: ${err.message}`);
  process.exit(1);
});
