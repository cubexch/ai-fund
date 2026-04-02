#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExchangeClient } from './client/exchange.js';
import { loadCredentials } from './client/credential-store.js';
import { registerAccountTools } from './tools/account.js';
import { registerOrderTools } from './tools/orders.js';
import { registerMarketDataTools } from './tools/market-data.js';

// ── Parse CLI args ─────────────────────────────────────────

const args = process.argv.slice(2);
let exchangeId = 'coinbase';
let sandbox = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--exchange' && args[i + 1]) {
    exchangeId = args[i + 1];
    i++;
  }
  if (args[i] === '--sandbox') {
    sandbox = true;
  }
}

// Env var overrides
exchangeId = process.env.CCXT_EXCHANGE ?? exchangeId;
sandbox = process.env.CCXT_SANDBOX === 'true' || sandbox;

// ── Resolve credentials ────────────────────────────────────
// Priority: env vars > credential store (keychain/secret-tool/file)
// Per-exchange env vars: COINBASE_API_KEY, BINANCE_SECRET, etc.
// Falls back to generic CCXT_* vars, then credential store.

const prefix = exchangeId.toUpperCase().replace(/-/g, '_');

let apiKey = process.env[`${prefix}_API_KEY`] ?? process.env.CCXT_API_KEY ?? '';
let secret = process.env[`${prefix}_SECRET`] ?? process.env.CCXT_SECRET ?? '';
let password = process.env[`${prefix}_PASSWORD`] ?? process.env[`${prefix}_PASSPHRASE`] ?? process.env.CCXT_PASSWORD ?? '';
sandbox = process.env[`${prefix}_SANDBOX`] === 'true' || sandbox;

if (!apiKey || !secret) {
  const creds = await loadCredentials(exchangeId);
  if (creds) {
    apiKey = creds.apiKey;
    secret = creds.secret;
    password = creds.password ?? password;
    sandbox = creds.sandbox || sandbox;
  }
}

// ── Initialize ─────────────────────────────────────────────

const server = new McpServer({
  name: `ccxt-${exchangeId}`,
  version: '0.1.0',
});

const client = new ExchangeClient({
  exchangeId,
  apiKey: apiKey || undefined,
  secret: secret || undefined,
  password: password || undefined,
  sandbox,
});

if (client.hasCredentials) {
  process.stderr.write(`[ccxt-${exchangeId}] Auth: API key loaded (${client.isSandbox ? 'sandbox' : 'LIVE'})\n`);
} else {
  process.stderr.write(`[ccxt-${exchangeId}] Auth: none — market data only. Run \`npm run login\` or set ${prefix}_API_KEY and ${prefix}_SECRET.\n`);
}

// ── Register tools ─────────────────────────────────────────

registerMarketDataTools(server, client);
registerOrderTools(server, client);
registerAccountTools(server, client);

// ── Start server ───────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
