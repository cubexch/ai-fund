#!/usr/bin/env node

/**
 * Check CCXT exchange connectivity and auth status.
 * Usage: tsx src/cli/status.ts [--exchange coinbase]
 */

import { ExchangeClient } from '../client/exchange.js';
import { loadCredentials, getBackendName } from '../client/credential-store.js';

const args = process.argv.slice(2);
let exchangeId = 'coinbase';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exchange' && args[i + 1]) {
    exchangeId = args[i + 1];
    i++;
  }
}

exchangeId = process.env.CCXT_EXCHANGE ?? exchangeId;

// Resolve credentials: env vars > credential store
const prefix = exchangeId.toUpperCase().replace(/-/g, '_');
let apiKey = process.env[`${prefix}_API_KEY`] ?? process.env.CCXT_API_KEY ?? '';
let secret = process.env[`${prefix}_SECRET`] ?? process.env.CCXT_SECRET ?? '';
let password = process.env[`${prefix}_PASSWORD`] ?? process.env[`${prefix}_PASSPHRASE`] ?? process.env.CCXT_PASSWORD ?? '';
let sandbox = process.env[`${prefix}_SANDBOX`] === 'true' || process.env.CCXT_SANDBOX === 'true';
let source = 'env';

if (!apiKey || !secret) {
  const creds = await loadCredentials(exchangeId);
  if (creds) {
    apiKey = creds.apiKey;
    secret = creds.secret;
    password = creds.password ?? password;
    sandbox = creds.sandbox || sandbox;
    source = await getBackendName();
  }
}

const client = new ExchangeClient({
  exchangeId,
  apiKey: apiKey || undefined,
  secret: secret || undefined,
  password: password || undefined,
  sandbox,
});

console.log(`Exchange: ${client.name} (${client.exchangeId})`);
console.log(`Auth:     ${client.hasCredentials ? `API key configured (via ${source})` : 'none (market data only)'}`);
console.log(`Mode:     ${client.isSandbox ? 'sandbox/testnet' : 'production'}`);
console.log(`Store:    ${await getBackendName()}`);

// Test connectivity by loading markets
try {
  const markets = await client.loadMarkets();
  console.log(`Markets:  ${markets.length} available`);
  console.log('Status:   connected');
} catch (error: any) {
  console.log(`Status:   error — ${error.message}`);
  process.exit(1);
}
