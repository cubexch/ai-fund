#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExchangeClient } from './client/exchange';
import { parseArgs, resolveCredentials, envPrefix } from './cli/common';
import { registerAccountTools } from './tools/account';
import { registerOrderTools } from './tools/orders';
import { registerMarketDataTools } from './tools/market-data';
import { registerStrategyTools } from './tools/strategy';
import { registerDatastoreTools } from './tools/datastore';
import { registerExecutionTools } from './tools/execution';
import { registerScannerTools } from './tools/scanner';
import { registerRegimeTools } from './tools/regime';
import { registerBacktestTools } from './tools/backtest';
import { registerAlgorithmTools } from './tools/algorithms';
import { registerRiskTools } from './tools/risk';
import { MarketDataStore } from '@ai-fund/lib/datastore';

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
registerExecutionTools(server, client);
registerScannerTools(server, () => client);
registerRegimeTools(server, client);
registerBacktestTools(server, () => client);
registerAlgorithmTools(server, client);
registerRiskTools(server, client);

// ── Start server ───────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
