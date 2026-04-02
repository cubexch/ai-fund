#!/usr/bin/env node

/**
 * Gateway MCP server — single process that loads all configured connectors
 * and registers tools namespaced by exchange.
 *
 * Cube runs as its own MCP server (built-in).
 * Everything else (Alpaca, Hyperliquid, CCXT) runs through this gateway.
 *
 * Tool naming: {connector}_{method}
 *   alpaca_get_account, hyperliquid_get_positions, ccxt_binance_get_quote, etc.
 *
 * If only one connector is loaded, tools are also registered without prefix
 * for convenience: get_account, get_positions, etc.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ExchangeConnector } from '../../lib/connector-interface.js';
import { register } from '../../lib/connector-registry.js';

// ── Connector Loading ───────────────────────────────────────

async function loadConnectors(): Promise<ExchangeConnector[]> {
  const connectors: ExchangeConnector[] = [];

  // Cube — always available (public market data works without auth)
  try {
    const { createCubeConnector } = await import('../cube/index.js');
    const cube = await createCubeConnector();
    connectors.push(cube);
    process.stderr.write(`[gateway] Loaded: Cube Exchange (${cube.isPaper() ? 'staging' : 'production'})\n`);
  } catch {
    process.stderr.write('[gateway] Cube: failed to load\n');
  }

  // Alpaca — load if credentials available
  try {
    const { createAlpacaConnector } = await import('../alpaca/index.js');
    const alpaca = await createAlpacaConnector();
    connectors.push(alpaca);
    process.stderr.write(`[gateway] Loaded: Alpaca (${alpaca.isPaper() ? 'paper' : 'live'})\n`);
  } catch {
    process.stderr.write('[gateway] Alpaca: not configured\n');
  }

  // Hyperliquid — load if credentials available
  try {
    const { createHyperliquidConnector } = await import('../hyperliquid/index.js');
    const hl = await createHyperliquidConnector();
    connectors.push(hl);
    process.stderr.write(`[gateway] Loaded: Hyperliquid (${hl.isPaper() ? 'testnet' : 'mainnet'})\n`);
  } catch {
    process.stderr.write('[gateway] Hyperliquid: not configured\n');
  }

  // CCXT — load if credentials available
  try {
    const { createCcxtConnector } = await import('../ccxt/index.js');
    const ccxt = await createCcxtConnector();
    connectors.push(ccxt);
    process.stderr.write(`[gateway] Loaded: ${ccxt.meta.displayName} (${ccxt.isPaper() ? 'sandbox' : 'live'})\n`);
  } catch {
    process.stderr.write('[gateway] CCXT: not configured\n');
  }

  return connectors;
}

// ── Tool Registration ───────────────────────────────────────

function registerConnectorTools(
  server: McpServer,
  connector: ExchangeConnector,
  prefix: string,
) {
  const p = prefix ? `${prefix}_` : '';

  // get_account
  server.tool(
    `${p}get_account`,
    `Get account summary from ${connector.meta.displayName}. Returns buying power, cash, portfolio value.`,
    {},
    async () => {
      try {
        const account = await connector.getAccount();
        return { content: [{ type: 'text' as const, text: JSON.stringify(account, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  // get_positions
  server.tool(
    `${p}get_positions`,
    `Get current positions from ${connector.meta.displayName}. Shows symbol, qty, avg entry, P&L.`,
    {},
    async () => {
      try {
        const positions = await connector.getPositions();
        return { content: [{ type: 'text' as const, text: JSON.stringify(positions, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  // get_orders
  server.tool(
    `${p}get_orders`,
    `Get orders from ${connector.meta.displayName}. Filter by status: open, closed, all.`,
    {
      status: z.enum(['open', 'closed', 'all']).default('open')
        .describe('Order status filter'),
    },
    async ({ status }) => {
      try {
        const orders = await connector.getOrders(status);
        return { content: [{ type: 'text' as const, text: JSON.stringify(orders, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  // place_order
  server.tool(
    `${p}place_order`,
    `Place an order on ${connector.meta.displayName}. ${connector.meta.isPaper ? '(PAPER MODE)' : '⚠️ LIVE — real money'}`,
    {
      symbol: z.string().describe('Symbol (e.g. "AAPL", "BTC/USDT")'),
      side: z.enum(['buy', 'sell']).describe('Order side'),
      type: z.enum(['market', 'limit', 'stop', 'stop_limit']).default('market')
        .describe('Order type'),
      qty: z.number().positive().describe('Quantity'),
      limitPrice: z.number().positive().optional().describe('Limit price (required for limit/stop_limit)'),
      stopPrice: z.number().positive().optional().describe('Stop price (required for stop/stop_limit)'),
      timeInForce: z.enum(['day', 'gtc', 'ioc', 'fok']).default('day')
        .describe('Time in force'),
    },
    async (params) => {
      try {
        const order = await connector.placeOrder(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(order, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Order failed: ${err.message}` }], isError: true };
      }
    },
  );

  // cancel_order
  server.tool(
    `${p}cancel_order`,
    `Cancel an order on ${connector.meta.displayName} by order ID.`,
    {
      orderId: z.string().describe('Order ID to cancel'),
    },
    async ({ orderId }) => {
      try {
        await connector.cancelOrder(orderId);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'cancelled', orderId }) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Cancel failed: ${err.message}` }], isError: true };
      }
    },
  );

  // cancel_all_orders
  server.tool(
    `${p}cancel_all_orders`,
    `Cancel all open orders on ${connector.meta.displayName}.`,
    {},
    async () => {
      try {
        await connector.cancelAllOrders();
        return { content: [{ type: 'text' as const, text: '{"status":"all_cancelled"}' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Cancel all failed: ${err.message}` }], isError: true };
      }
    },
  );

  // get_quote
  server.tool(
    `${p}get_quote`,
    `Get current quote from ${connector.meta.displayName}. Returns bid, ask, last price.`,
    {
      symbol: z.string().describe('Symbol (e.g. "AAPL", "BTC/USDT")'),
    },
    async ({ symbol }) => {
      try {
        const quote = await connector.getQuote(symbol);
        return { content: [{ type: 'text' as const, text: JSON.stringify(quote, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  // get_bars
  server.tool(
    `${p}get_bars`,
    `Get historical OHLCV bars from ${connector.meta.displayName}.`,
    {
      symbol: z.string().describe('Symbol'),
      timeframe: z.string().default('1Day').describe('Timeframe (1Min, 5Min, 1Hour, 1Day, etc.)'),
      limit: z.number().default(100).describe('Number of bars'),
    },
    async ({ symbol, timeframe, limit }) => {
      try {
        const bars = await connector.getBars(symbol, timeframe, limit);
        return { content: [{ type: 'text' as const, text: JSON.stringify(bars, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  // get_portfolio_history
  server.tool(
    `${p}get_portfolio_history`,
    `Get portfolio equity history from ${connector.meta.displayName}.`,
    {
      period: z.string().default('1M').describe('Period: 1D, 1W, 1M, 3M, 1A, all'),
    },
    async ({ period }) => {
      try {
        const history = await connector.getPortfolioHistory(period);
        return { content: [{ type: 'text' as const, text: JSON.stringify(history, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  // is_market_open
  server.tool(
    `${p}is_market_open`,
    `Check if the market is open on ${connector.meta.displayName}.`,
    {},
    async () => {
      try {
        const isOpen = await connector.isMarketOpen();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              isOpen,
              exchange: connector.meta.displayName,
              marketHours: connector.meta.marketHours,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );
}

// ── Main ────────────────────────────────────────────────────

const server = new McpServer({
  name: 'ai-fund-gateway',
  version: '0.1.0',
});

const connectors = await loadConnectors();

// Register each connector in the global registry
for (const c of connectors) {
  register(c);
}

// Register tools for each connector
for (const c of connectors) {
  // Always register with prefix
  registerConnectorTools(server, c, c.meta.name);

  // If only one connector, also register without prefix for convenience
  if (connectors.length === 1) {
    registerConnectorTools(server, c, '');
  }
}

// Meta tool: list connected exchanges
server.tool(
  'list_exchanges',
  'List all connected exchanges with their status, asset classes, and trading mode.',
  {},
  async () => {
    const exchanges = connectors.map(c => ({
      name: c.meta.name,
      displayName: c.meta.displayName,
      assetClasses: c.meta.assetClasses,
      isPaper: c.meta.isPaper,
      supportsShorts: c.meta.supportsShorts,
      marketHours: c.meta.marketHours,
    }));
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ count: exchanges.length, exchanges }, null, 2),
      }],
    };
  },
);

if (connectors.length === 0) {
  process.stderr.write('[gateway] No connectors loaded. Run /setup to configure exchanges.\n');
} else {
  process.stderr.write(`[gateway] ${connectors.length} connector(s) ready. ${connectors.length * 10 + 1} tools registered.\n`);
}

// ── Start ───────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
