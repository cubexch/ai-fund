#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IridiumClient } from './client/iridium.js';
import { OsmiumClient } from './client/osmium.js';
import { registerMarketResources } from './resources/markets.js';
import { registerPortfolioResources } from './resources/portfolio.js';
import { registerAccountTools } from './tools/account.js';
import { registerMarketDataTools } from './tools/market-data.js';
import { registerOrderTools } from './tools/orders.js';
import { registerRiskTools } from './tools/risk.js';

const server = new McpServer({
  name: 'cube-trading',
  version: '0.1.0',
});

// Initialize clients
const iridium = new IridiumClient();
const osmium = new OsmiumClient();

// Register tools
registerOrderTools(server, osmium);
registerMarketDataTools(server, iridium);
registerAccountTools(server, iridium);
registerRiskTools(server, iridium);

// Register resources
registerMarketResources(server, iridium);
registerPortfolioResources(server, iridium);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
