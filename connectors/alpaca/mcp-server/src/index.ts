#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AlpacaClient } from './client/api';
import { loadCredentials } from './client/credential-store';
import { registerAccountTools } from './tools/account';
import { registerOrderTools } from './tools/orders';
import { registerMarketDataTools } from './tools/market-data';
import { registerAnalysisTools } from './tools/analysis';

const server = new McpServer({
  name: 'alpaca-trading',
  version: '0.1.0',
});

// ── Initialize client ──────────────────────────────────────
// Priority: env vars > credential store

let apiKey = process.env.APCA_API_KEY_ID ?? '';
let apiSecret = process.env.APCA_API_SECRET_KEY ?? '';
let paper = process.env.APCA_PAPER !== 'false';

if (!apiKey || !apiSecret) {
  const creds = await loadCredentials();
  if (creds) {
    apiKey = creds.apiKey;
    apiSecret = creds.apiSecret;
    paper = creds.paper;
  }
}

const client = new AlpacaClient({ apiKey, apiSecret, paper });

if (client.hasCredentials) {
  process.stderr.write(`[alpaca] Auth: API key loaded (${client.isPaper ? 'paper' : 'LIVE'})\n`);
} else {
  process.stderr.write('[alpaca] Auth: none — run `npm run login` in connectors/alpaca/mcp-server to authenticate\n');
}

// ── Register tools ──────────────────────────────────────────

registerAccountTools(server, client);
registerOrderTools(server, client);
registerMarketDataTools(server, client);
registerAnalysisTools(server, client);

// ── Start server ────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
