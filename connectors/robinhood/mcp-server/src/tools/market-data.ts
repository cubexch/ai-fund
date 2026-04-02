import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RobinhoodClient } from '../client/api.js';

// ── Robinhood API Response Types ─────────────────────────────

interface Quote {
  symbol: string;
  last_trade_price: string;
  last_extended_hours_trade_price: string | null;
  bid_price: string;
  bid_size: string;
  ask_price: string;
  ask_size: string;
  previous_close: string;
  adjusted_previous_close: string;
  updated_at: string;
  trading_halted: boolean;
  has_traded: boolean;
  instrument: string;
  instrument_id: string;
}

interface Historical {
  begins_at: string;
  open_price: string;
  close_price: string;
  high_price: string;
  low_price: string;
  volume: number;
  session: string;
  interpolated: boolean;
}

interface HistoricalsResponse {
  symbol: string;
  historicals: Historical[];
  interval: string;
  span: string;
  bounds: string;
}

interface Instrument {
  id: string;
  url: string;
  symbol: string;
  name: string;
  type: string;
  country: string;
  market: string;
  simple_name: string | null;
  tradeable: boolean;
  tradability: string;
  state: string;
  day_trade_ratio: string;
  maintenance_ratio: string;
  margin_initial_ratio: string;
  min_tick_size: string | null;
  list_date: string | null;
}

// ── Instrument Cache ─────────────────────────────────────────

const instrumentCache = new Map<string, { instrument: Instrument; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function resolveInstrument(client: RobinhoodClient, symbol: string): Promise<Instrument> {
  const cached = instrumentCache.get(symbol);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.instrument;
  }

  const data = await client.get<{ results: Instrument[] }>('/instruments/', { symbol: symbol.toUpperCase() });
  const instrument = data.results[0];
  if (!instrument) {
    throw new Error(`Instrument not found for symbol: ${symbol}`);
  }

  instrumentCache.set(symbol, { instrument, cachedAt: Date.now() });
  return instrument;
}

// ── Tool Registration ────────────────────────────────────────

export function registerMarketDataTools(server: McpServer, client: RobinhoodClient) {
  server.tool(
    'get_markets',
    'Search for tradeable instruments on Robinhood by symbol or name. Returns instrument details including symbol, name, type, and tradeability.',
    { query: z.string().describe('Symbol or company name to search (e.g. "AAPL", "Apple")') },
    async ({ query }) => {
      try {
        const data = await client.get<{ results: Instrument[] }>('/instruments/', {
          query: query.toUpperCase(),
        });

        const instruments = data.results
          .filter(i => i.state === 'active')
          .map(i => ({
            symbol: i.symbol,
            name: i.name || i.simple_name,
            type: i.type,
            tradeable: i.tradeable,
            country: i.country,
            listDate: i.list_date,
          }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(instruments, null, 2),
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
    'get_tickers',
    'Get real-time quotes for one or more symbols on Robinhood. Returns last price, bid/ask, previous close, and trading status.',
    {
      symbols: z.string().describe('Comma-separated symbols (e.g. "AAPL,TSLA,MSFT")'),
    },
    async ({ symbols }) => {
      try {
        const data = await client.get<{ results: Quote[] }>('/marketdata/quotes/', {
          symbols: symbols.toUpperCase(),
        });

        const tickers = data.results.map(q => {
          const last = parseFloat(q.last_trade_price);
          const prevClose = parseFloat(q.previous_close);
          const change = last - prevClose;
          const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;

          return {
            symbol: q.symbol,
            lastPrice: last,
            bidPrice: parseFloat(q.bid_price),
            bidSize: parseInt(q.bid_size, 10),
            askPrice: parseFloat(q.ask_price),
            askSize: parseInt(q.ask_size, 10),
            previousClose: prevClose,
            change: Math.round(change * 100) / 100,
            changePercent: Math.round(changePct * 100) / 100,
            extendedHoursPrice: q.last_extended_hours_trade_price
              ? parseFloat(q.last_extended_hours_trade_price)
              : null,
            tradingHalted: q.trading_halted,
            updatedAt: q.updated_at,
          };
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(tickers, null, 2),
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
    'get_price_history',
    'Get historical OHLCV candles for a symbol on Robinhood. Returns open, high, low, close, volume, and timestamp for each candle.',
    {
      symbol: z.string().describe('Stock symbol (e.g. "AAPL")'),
      interval: z.enum(['5minute', '10minute', 'hour', 'day', 'week']).default('day')
        .describe('Candle interval'),
      span: z.enum(['day', 'week', 'month', '3month', 'year', '5year']).default('year')
        .describe('Time span of data'),
    },
    async ({ symbol, interval, span }) => {
      try {
        const data = await client.get<HistoricalsResponse>(
          `/marketdata/historicals/${symbol.toUpperCase()}/`,
          { interval, span, bounds: 'regular' }
        );

        const candles = data.historicals.map(h => ({
          timestamp: new Date(h.begins_at).getTime(),
          open: parseFloat(h.open_price),
          high: parseFloat(h.high_price),
          low: parseFloat(h.low_price),
          close: parseFloat(h.close_price),
          volume: h.volume,
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              symbol: data.symbol,
              interval: data.interval,
              span: data.span,
              candles: candles.length,
              mostRecentCandle: candles.length > 0
                ? new Date(candles[candles.length - 1].timestamp).toISOString()
                : null,
              data: candles,
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
