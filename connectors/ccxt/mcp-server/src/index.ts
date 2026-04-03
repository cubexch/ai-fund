#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExchangeClient } from './client/exchange.js';
import { parseArgs, resolveCredentials, envPrefix } from './cli/common.js';
import { registerAccountTools } from './tools/account.js';
import { registerOrderTools } from './tools/orders.js';
import { registerMarketDataTools } from './tools/market-data.js';
import { registerStrategyTools } from './tools/strategy.js';
import { registerDatastoreTools } from './tools/datastore.js';
import { MarketDataStore } from '../../../../lib/datastore.js';

// ── Parse CLI args + resolve credentials ──────────────────────

const { exchangeId, sandbox: cliSandbox } = parseArgs();
const creds = await resolveCredentials(exchangeId, cliSandbox);
const prefix = envPrefix(exchangeId);

// ── Initialize ─────────────────────────────────────────────

const server = new McpServer({
  name: `ccxt-${exchangeId}`,
  version: '0.1.0',
});

// ── Initialize DuckDB store (lazy — only created on first use) ──
const dbPath = process.env.MARKET_DB_PATH || `.desk/data/${exchangeId}.duckdb`;
let store: MarketDataStore | undefined;
try {
  store = new MarketDataStore(dbPath);
  await store.init();
  process.stderr.write(`[ccxt-${exchangeId}] DuckDB: ${dbPath}\n`);
} catch (err: any) {
  process.stderr.write(`[ccxt-${exchangeId}] DuckDB: disabled (${err.message})\n`);
  store = undefined;
}

const client = new ExchangeClient({
  exchangeId,
  apiKey: creds.apiKey || undefined,
  secret: creds.secret || undefined,
  password: creds.password || undefined,
  sandbox: creds.sandbox,
  store,
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
registerStrategyTools(server, client);
registerDatastoreTools(server, client);

// ── Start server ───────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
