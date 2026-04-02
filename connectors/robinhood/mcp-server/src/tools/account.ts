import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RobinhoodClient } from '../client/api.js';

// ── Robinhood API Response Types ─────────────────────────────

interface Account {
  url: string;
  account_number: string;
  buying_power: string;
  cash: string;
  portfolio_cash: string;
  uncleared_deposits: string;
  sma: string;
  state: string;
  type: string;
  deactivated: boolean;
  user: string;
}

interface Position {
  url: string;
  instrument: string;
  account: string;
  quantity: string;
  average_buy_price: string;
  shares_held_for_sells: string;
  shares_held_for_buys: string;
  shares_pending_from_options_events: string;
  created_at: string;
  updated_at: string;
}

interface CryptoPosition {
  id: string;
  currency: { code: string; name: string };
  quantity: string;
  quantity_available: string;
  cost_bases: Array<{ direct_cost_basis: string; direct_quantity: string }>;
  created_at: string;
  updated_at: string;
}

interface Order {
  id: string;
  url: string;
  instrument: string;
  side: string;
  type: string;
  time_in_force: string;
  quantity: string;
  price: string | null;
  stop_price: string | null;
  average_price: string | null;
  cumulative_quantity: string;
  state: string;
  created_at: string;
  updated_at: string;
  executions: Array<{
    id: string;
    price: string;
    quantity: string;
    timestamp: string;
    settlement_date: string;
  }>;
}

interface Portfolio {
  url: string;
  account: string;
  equity: string;
  extended_hours_equity: string | null;
  market_value: string;
  excess_margin: string;
  last_core_equity: string;
  last_core_market_value: string;
  equity_previous_close: string;
  adjusted_equity_previous_close: string;
}

// ── Instrument Resolution Cache ──────────────────────────────

const instrumentNameCache = new Map<string, { symbol: string; name: string; cachedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

async function resolveInstrumentInfo(
  client: RobinhoodClient,
  instrumentUrl: string
): Promise<{ symbol: string; name: string }> {
  const cached = instrumentNameCache.get(instrumentUrl);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const data = await client.get<{ symbol: string; name: string; simple_name: string | null }>(instrumentUrl);
    const info = { symbol: data.symbol, name: data.name || data.simple_name || data.symbol };
    instrumentNameCache.set(instrumentUrl, { ...info, cachedAt: Date.now() });
    return info;
  } catch {
    return { symbol: 'UNKNOWN', name: 'Unknown' };
  }
}

// ── Tool Registration ────────────────────────────────────────

export function registerAccountTools(server: McpServer, client: RobinhoodClient) {
  server.tool(
    'get_balances',
    'Get Robinhood account balances: buying power, cash, portfolio equity, and daily P&L.',
    {},
    async () => {
      try {
        const accounts = await client.get<{ results: Account[] }>('/accounts/');
        const account = accounts.results[0];
        if (!account) throw new Error('No Robinhood account found');

        const portfolio = await client.get<Portfolio>(
          `${account.url}portfolio/`
        );

        const equity = parseFloat(portfolio.equity);
        const prevClose = parseFloat(portfolio.equity_previous_close);
        const dayChange = equity - prevClose;
        const dayChangePct = prevClose > 0 ? (dayChange / prevClose) * 100 : 0;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              accountNumber: account.account_number,
              accountType: account.type,
              state: account.state,
              buyingPower: parseFloat(account.buying_power),
              cash: parseFloat(account.cash),
              unclearedDeposits: parseFloat(account.uncleared_deposits),
              equity: equity,
              marketValue: parseFloat(portfolio.market_value),
              extendedHoursEquity: portfolio.extended_hours_equity
                ? parseFloat(portfolio.extended_hours_equity)
                : null,
              dayChange: Math.round(dayChange * 100) / 100,
              dayChangePercent: Math.round(dayChangePct * 100) / 100,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_positions',
    'Get all current stock and crypto positions on Robinhood with quantity, average cost, and current value.',
    {
      includeZero: z.boolean().default(false)
        .describe('Include positions with zero quantity'),
    },
    async ({ includeZero }) => {
      try {
        // Fetch stock positions
        const stockPositions = await client.getAll<Position>('/positions/');

        const stocks = [];
        for (const pos of stockPositions) {
          const qty = parseFloat(pos.quantity);
          if (!includeZero && qty === 0) continue;

          const info = await resolveInstrumentInfo(client, pos.instrument);
          stocks.push({
            type: 'stock',
            symbol: info.symbol,
            name: info.name,
            quantity: qty,
            averageBuyPrice: parseFloat(pos.average_buy_price),
            sharesHeldForSells: parseFloat(pos.shares_held_for_sells),
            sharesHeldForBuys: parseFloat(pos.shares_held_for_buys),
            createdAt: pos.created_at,
          });
        }

        // Fetch crypto positions
        let cryptos: Array<Record<string, unknown>> = [];
        try {
          const cryptoPositions = await client.get<{ results: CryptoPosition[] }>('/nummus/positions/');
          cryptos = cryptoPositions.results
            .filter(p => includeZero || parseFloat(p.quantity) > 0)
            .map(p => {
              const costBasis = p.cost_bases[0];
              return {
                type: 'crypto',
                symbol: p.currency.code,
                name: p.currency.name,
                quantity: parseFloat(p.quantity),
                quantityAvailable: parseFloat(p.quantity_available),
                costBasis: costBasis ? parseFloat(costBasis.direct_cost_basis) : null,
                createdAt: p.created_at,
              };
            });
        } catch {
          // Crypto not available on all accounts
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              stockPositions: stocks,
              cryptoPositions: cryptos,
              totalPositions: stocks.length + cryptos.length,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'get_fills',
    'Get recent filled orders (trade execution history) on Robinhood.',
    {
      limit: z.number().default(20).describe('Maximum number of fills to return'),
    },
    async ({ limit }) => {
      try {
        const orders = await client.getAll<Order>('/orders/');

        const fills = orders
          .filter(o => o.state === 'filled' && o.executions.length > 0)
          .slice(0, limit)
          .map(o => {
            const executions = o.executions.map(e => ({
              price: parseFloat(e.price),
              quantity: parseFloat(e.quantity),
              timestamp: e.timestamp,
            }));

            return {
              orderId: o.id,
              side: o.side,
              type: o.type,
              quantity: parseFloat(o.quantity),
              averagePrice: o.average_price ? parseFloat(o.average_price) : null,
              cumulativeQuantity: parseFloat(o.cumulative_quantity),
              state: o.state,
              createdAt: o.created_at,
              executions,
            };
          });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              fills,
              count: fills.length,
            }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text' as const, text: `Failed: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
