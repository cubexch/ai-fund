#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IridiumClient } from './client/iridium.js';
import { registerMarketResources } from './resources/markets.js';
import { registerPortfolioResources } from './resources/portfolio.js';
import { registerAccountTools } from './tools/account.js';
import { registerMarketDataTools } from './tools/market-data.js';
import { registerOrderTools } from './tools/orders.js';
import { registerRiskTools } from './tools/risk.js';
import { registerDefiTools } from './tools/defi.js';

const server = new McpServer({
  name: 'cube-trading',
  version: '0.1.0',
});

// Initialize client — REST-based for both reads and order placement
const iridium = new IridiumClient();

// Register tools (orders use REST API via iridium, no WebSocket needed)
registerOrderTools(server, null, iridium);
registerMarketDataTools(server, iridium);
registerAccountTools(server, iridium);
registerRiskTools(server, iridium);
registerDefiTools(server, iridium);

// Register resources
registerMarketResources(server, iridium);
registerPortfolioResources(server, iridium);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
