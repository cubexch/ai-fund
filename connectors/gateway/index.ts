#!/usr/bin/env node

/**
 * Gateway MCP server (experimental) — single process that loads all configured connectors
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
): number {
  const p = prefix ? `${prefix}_` : '';
  const { capabilities } = connector.meta;
  let toolCount = 0;

  const registerTool = (...args: Parameters<McpServer['tool']>) => {
    server.tool(...args);
    toolCount++;
  };

  const ok = (payload: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  });

  const fail = (label: string, err: unknown) => ({
    content: [{
      type: 'text' as const,
      text: `${label}: ${err instanceof Error ? err.message : String(err)}`,
    }],
    isError: true,
  });

  if (capabilities.account) {
    registerTool(
      `${p}get_account`,
      `Get account summary from ${connector.meta.displayName}. Returns buying power, cash, portfolio value.`,
      {},
      async () => {
        try {
          return ok(await connector.getAccount());
        } catch (err) {
          return fail('Failed', err);
        }
      },
    );
  }

  if (capabilities.positions) {
    registerTool(
      `${p}get_positions`,
      `Get current positions from ${connector.meta.displayName}. Shows symbol, qty, avg entry, P&L.`,
      {},
      async () => {
        try {
          return ok(await connector.getPositions());
        } catch (err) {
          return fail('Failed', err);
        }
      },
    );
  }

  if (capabilities.orders) {
    registerTool(
      `${p}get_orders`,
      `Get orders from ${connector.meta.displayName}. Filter by status: open, closed, all.`,
      {
        status: z.enum(['open', 'closed', 'all']).default('open')
          .describe('Order status filter'),
      },
      async ({ status }) => {
        try {
          return ok(await connector.getOrders(status));
        } catch (err) {
          return fail('Failed', err);
        }
      },
    );
  }

  if (capabilities.placeOrder) {
    registerTool(
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
          return ok(await connector.placeOrder(params));
        } catch (err) {
          return fail('Order failed', err);
        }
      },
    );
  }

  if (capabilities.cancelOrder) {
    registerTool(
      `${p}cancel_order`,
      `Cancel an order on ${connector.meta.displayName} by order ID.`,
      {
        orderId: z.string().describe('Order ID to cancel'),
      },
      async ({ orderId }) => {
        try {
          await connector.cancelOrder(orderId);
          return ok({ status: 'cancelled', orderId });
        } catch (err) {
          return fail('Cancel failed', err);
        }
      },
    );
  }

  if (capabilities.cancelAllOrders) {
    registerTool(
      `${p}cancel_all_orders`,
      `Cancel all open orders on ${connector.meta.displayName}.`,
      {},
      async () => {
        try {
          await connector.cancelAllOrders();
          return ok({ status: 'all_cancelled' });
        } catch (err) {
          return fail('Cancel all failed', err);
        }
      },
    );
  }

  if (capabilities.quote) {
    registerTool(
      `${p}get_quote`,
      `Get current quote from ${connector.meta.displayName}. Returns bid, ask, last price.`,
      {
        symbol: z.string().describe('Symbol (e.g. "AAPL", "BTC/USDT")'),
      },
      async ({ symbol }) => {
        try {
          return ok(await connector.getQuote(symbol));
        } catch (err) {
          return fail('Failed', err);
        }
      },
    );
  }

  if (capabilities.bars) {
    registerTool(
      `${p}get_bars`,
      `Get historical OHLCV bars from ${connector.meta.displayName}.`,
      {
        symbol: z.string().describe('Symbol'),
        timeframe: z.string().default('1Day').describe('Timeframe (1Min, 5Min, 1Hour, 1Day, etc.)'),
        limit: z.number().default(100).describe('Number of bars'),
      },
      async ({ symbol, timeframe, limit }) => {
        try {
          return ok(await connector.getBars(symbol, timeframe, limit));
        } catch (err) {
          return fail('Failed', err);
        }
      },
    );
  }

  if (capabilities.portfolioHistory) {
    registerTool(
      `${p}get_portfolio_history`,
      `Get portfolio equity history from ${connector.meta.displayName}.`,
      {
        period: z.string().default('1M').describe('Period: 1D, 1W, 1M, 3M, 1A, all'),
      },
      async ({ period }) => {
        try {
          return ok(await connector.getPortfolioHistory(period));
        } catch (err) {
          return fail('Failed', err);
        }
      },
    );
  }

  // is_market_open
  registerTool(
    `${p}is_market_open`,
    `Check if the market is open on ${connector.meta.displayName}.`,
    {},
    async () => {
      try {
        const isOpen = await connector.isMarketOpen();
        return ok({
          isOpen,
          exchange: connector.meta.displayName,
          marketHours: connector.meta.marketHours,
        });
      } catch (err) {
        return fail('Failed', err);
      }
    },
  );

  return toolCount;
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
let registeredToolCount = 0;
for (const c of connectors) {
  // Always register with prefix
  registeredToolCount += registerConnectorTools(server, c, c.meta.name);

  // If only one connector, also register without prefix for convenience
  if (connectors.length === 1) {
    registeredToolCount += registerConnectorTools(server, c, '');
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
      status: c.meta.status,
      assetClasses: c.meta.assetClasses,
      isPaper: c.meta.isPaper,
      supportsShorts: c.meta.supportsShorts,
      capabilities: c.meta.capabilities,
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
  process.stderr.write(`[gateway] ${connectors.length} connector(s) ready. ${registeredToolCount + 1} tools registered.\n`);
}

// ── Start ───────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
