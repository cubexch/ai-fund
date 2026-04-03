#!/usr/bin/env node

/**
 * Check CCXT exchange connectivity and auth status.
 * Usage: tsx src/cli/status.ts [--exchange coinbase]
 */

import { ExchangeClient } from '../client/exchange';
import { getBackendName } from '../client/credential-store';
import { parseArgs, resolveCredentials } from './common';

const { exchangeId, sandbox: cliSandbox } = parseArgs();
const creds = await resolveCredentials(exchangeId, cliSandbox);

const client = new ExchangeClient({
  exchangeId,
  apiKey: creds.apiKey || undefined,
  secret: creds.secret || undefined,
  password: creds.password || undefined,
  sandbox: creds.sandbox,
});

console.log(`Exchange: ${client.name} (${client.exchangeId})`);
console.log(`Auth:     ${client.hasCredentials ? `API key configured (via ${creds.source})` : 'none (market data only)'}`);
console.log(`Mode:     ${client.isSandbox ? 'sandbox/testnet' : 'production'}`);
console.log(`Store:    ${await getBackendName()}`);

try {
  const markets = await client.loadMarkets();
  console.log(`Markets:  ${markets.length} available`);
  console.log('Status:   connected');
} catch (error: any) {
  console.log(`Status:   error — ${error.message}`);
  process.exit(1);
}
