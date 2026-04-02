#!/usr/bin/env node

/**
 * Check CCXT exchange connectivity and auth status.
 * Usage: tsx src/cli/status.ts [--exchange coinbase]
 */

import { ExchangeClient } from '../client/exchange.js';

const args = process.argv.slice(2);
let exchangeId = 'coinbase';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exchange' && args[i + 1]) {
    exchangeId = args[i + 1];
    i++;
  }
}

exchangeId = process.env.CCXT_EXCHANGE ?? exchangeId;

const client = new ExchangeClient({
  exchangeId,
  apiKey: process.env.CCXT_API_KEY || undefined,
  secret: process.env.CCXT_SECRET || undefined,
  password: process.env.CCXT_PASSWORD || undefined,
  sandbox: process.env.CCXT_SANDBOX === 'true',
});

console.log(`Exchange: ${client.name} (${client.exchangeId})`);
console.log(`Auth:     ${client.hasCredentials ? 'API key configured' : 'none (market data only)'}`);
console.log(`Mode:     ${client.isSandbox ? 'sandbox/testnet' : 'production'}`);

// Test connectivity by loading markets
try {
  const markets = await client.loadMarkets();
  console.log(`Markets:  ${markets.length} available`);
  console.log('Status:   connected');
} catch (error: any) {
  console.log(`Status:   error — ${error.message}`);
  process.exit(1);
}
