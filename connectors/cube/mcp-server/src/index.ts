#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IridiumClient } from './client/iridium';
import { OsmiumClient } from './client/osmium';
import { MendelevClient } from './client/mendelev';
import { resolveAuth } from './client/auth';
import { registerMarketResources } from './resources/markets';
import { registerPortfolioResources } from './resources/portfolio';
import { registerAccountTools } from './tools/account';
import { registerMarketDataTools } from './tools/market-data';
import { registerOrderTools } from './tools/orders';
import { registerRiskTools } from './tools/risk';
import { registerAnalysisTools } from './tools/analysis';
import { registerTradingTools } from './tools/defi';
import { registerContentTools } from './tools/content';

const server = new McpServer({
  name: 'cube-trading',
  version: '0.1.0',
});

// ── Initialize clients ──────────────────────────────────────

// Iridium: REST API for markets, account, orders (fallback)
const iridium = new IridiumClient();

// Mendelev: WebSocket market data — NO AUTH REQUIRED
// Connects on startup so market data is available immediately
const mendelev = new MendelevClient();

// Osmium: WebSocket trading — uses verification key auth
// Connects lazily on first trade (requires auth)
const osmium = new OsmiumClient();

// Stream order lifecycle events via MCP logging notifications
osmium.onOrderProgress = (event) => {
  server.server.sendLoggingMessage({
    level: event.stage === 'rejected' ? 'error' : event.stage === 'fill' || event.stage === 'done' ? 'info' : 'debug',
    logger: 'osmium',
    data: event,
  }).catch(() => {});
};

// Stream fill events via MCP logging
osmium.onFill = (fill) => {
  server.server.sendLoggingMessage({
    level: 'info',
    logger: 'osmium',
    data: {
      type: 'fill',
      marketId: fill.marketId.toString(),
      clientOrderId: fill.clientOrderId.toString(),
      fillPrice: fill.fillPrice.toString(),
      fillQuantity: fill.fillQuantity.toString(),
      leavesQuantity: fill.leavesQuantity.toString(),
      side: fill.side,
      tradeId: fill.tradeId.toString(),
    },
  }).catch(() => {});
};

// Stream position updates via MCP logging
osmium.onPositionUpdate = (position) => {
  server.server.sendLoggingMessage({
    level: 'info',
    logger: 'osmium',
    data: { type: 'position_update', ...position },
  }).catch(() => {});
};

// ── Register tools (BEFORE connect — must be ready for tools/list) ──

// Orders: WebSocket via Osmium (preferred), REST via Iridium (fallback)
registerOrderTools(server, osmium, iridium);

// Market data: WebSocket via Mendelev (real-time), REST via Iridium (fallback)
registerMarketDataTools(server, iridium, mendelev);

// Account: REST via Iridium (requires auth)
registerAccountTools(server, iridium);

// Risk: REST via Iridium (requires auth for positions)
registerRiskTools(server, iridium);

// Analysis: confluence, squeeze, portfolio risk, stress test, execution planning, microstructure
registerAnalysisTools(server, iridium);

// DeFi: REST via Iridium + WebSocket via Osmium wallet (requires auth)
registerTradingTools(server, iridium, osmium);

// Content: Cube article discovery + metadata from sitemap
registerContentTools(server);

// ── Register resources ──────────────────────────────────────

registerMarketResources(server, iridium);
registerPortfolioResources(server, iridium);

// ── Start server (connect FIRST, then do async init) ────────

const transport = new StdioServerTransport();
await server.connect(transport);

// ── Resolve auth and log status (non-blocking, after connect) ─

const env = iridium.isStaging() ? 'Staging' : 'Production';
resolveAuth()
  .then((auth) => {
    if (auth) {
      process.stderr.write(`[cube] Auth: verification key (Ed25519)\n`);
    } else {
      process.stderr.write(`[cube] Auth: none — run \`npm run login\` in connectors/cube/mcp-server to authenticate\n`);
    }
    process.stderr.write(`[cube] Mode: ${env} | Auth: ${auth ? 'Ed25519' : 'none'} | WS events: order progress, fills, positions\n`);
  })
  .catch(() => {
    process.stderr.write(`[cube] Auth: none — run \`npm run login\` in connectors/cube/mcp-server to authenticate\n`);
    process.stderr.write(`[cube] Mode: ${env} | Auth: none | WS events: order progress, fills, positions\n`);
  });

// ── Connect market data WebSocket (no auth, non-blocking) ───

mendelev.connectTops().catch(() => {
  // Tops connection failed — will auto-reconnect.
  // Market data tools fall back to REST via Iridium.
});

process.stderr.write(`[cube] Cube MCP Server running on stdio\n`);
