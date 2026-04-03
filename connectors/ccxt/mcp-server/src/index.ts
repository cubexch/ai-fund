#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExchangeClient } from './client/exchange.js';
import { parseArgs, resolveCredentials, envPrefix } from './cli/common.js';
import { registerAccountTools } from './tools/account.js';
import { registerOrderTools } from './tools/orders.js';
import { registerMarketDataTools } from './tools/market-data.js';

// ── Parse CLI args + resolve credentials ──────────────────────

const { exchangeId, sandbox: cliSandbox } = parseArgs();
const creds = await resolveCredentials(exchangeId, cliSandbox);
const prefix = envPrefix(exchangeId);

// ── Initialize ─────────────────────────────────────────────

const server = new McpServer({
  name: `ccxt-${exchangeId}`,
  version: '0.1.0',
});

const client = new ExchangeClient({
  exchangeId,
  apiKey: creds.apiKey || undefined,
  secret: creds.secret || undefined,
  password: creds.password || undefined,
  sandbox: creds.sandbox,
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
