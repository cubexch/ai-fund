#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './client/auth.js';
import { RobinhoodClient } from './client/api.js';
import { registerMarketDataTools } from './tools/market-data.js';
import { registerAccountTools } from './tools/account.js';
import { registerOrderTools } from './tools/orders.js';

const server = new McpServer({
  name: 'robinhood-trading',
  version: '0.1.0',
});

// ── Initialize auth ─────────────────────────────────────────

const auth = new AuthManager();
const client = new RobinhoodClient(auth);

auth.init().then(authenticated => {
  if (authenticated) {
    process.stderr.write('[robinhood] Auth: authenticated (token loaded from keychain)\n');
  } else {
    process.stderr.write('[robinhood] Auth: none — run `npm run login` in connectors/robinhood/mcp-server to authenticate\n');
  }
}).catch(() => {});

// ── Register tools ──────────────────────────────────────────

// Market data: quotes, historicals, instrument search
registerMarketDataTools(server, client);

// Account: positions, balances, fills
registerAccountTools(server, client);

// Orders: place, cancel, status
registerOrderTools(server, client);

// ── Start server ────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
