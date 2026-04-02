#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AlpacaClient } from './client/api.js';
import { registerAccountTools } from './tools/account.js';
import { registerOrderTools } from './tools/orders.js';
import { registerMarketDataTools } from './tools/market-data.js';

const server = new McpServer({
  name: 'alpaca-trading',
  version: '0.1.0',
});

// ── Initialize client ──────────────────────────────────────

const client = new AlpacaClient();

if (client.hasCredentials) {
  process.stderr.write(`[alpaca] Auth: API key loaded (${client.isPaper ? 'paper' : 'LIVE'})\n`);
} else {
  process.stderr.write('[alpaca] Auth: none — set APCA_API_KEY_ID and APCA_API_SECRET_KEY env vars\n');
}

// ── Register tools ──────────────────────────────────────────

registerAccountTools(server, client);
registerOrderTools(server, client);
registerMarketDataTools(server, client);

// ── Start server ────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
