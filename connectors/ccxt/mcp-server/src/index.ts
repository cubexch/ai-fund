#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ExchangeClient } from './client/exchange.js';
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

// ── Initialize ─────────────────────────────────────────────

const server = new McpServer({
  name: `ccxt-${exchangeId}`,
  version: '0.1.0',
});

const apiKey = process.env.CCXT_API_KEY ?? '';
const secret = process.env.CCXT_SECRET ?? '';
const password = process.env.CCXT_PASSWORD ?? '';

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
  process.stderr.write(`[ccxt-${exchangeId}] Auth: none — market data only. Set CCXT_API_KEY and CCXT_SECRET to trade.\n`);
}

// ── Register tools ─────────────────────────────────────────

registerMarketDataTools(server, client);
registerOrderTools(server, client);
registerAccountTools(server, client);

// ── Start server ───────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
