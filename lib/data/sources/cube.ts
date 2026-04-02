/**
 * Cube Exchange public REST API data source.
 * Uses native fetch() — no additional dependencies.
 *
 * Public endpoints (no auth required):
 *   GET /ir/v0/markets              — list all markets
 *   GET /ir/v0/history/klines       — OHLCV candles (max 1000 per request)
 *   GET /md/parsed/tickers          — current tickers
 *   GET /md/parsed/book/{sym}/snapshot       — order book snapshot
 *   GET /md/parsed/book/{sym}/recent-trades  — recent trades
 */

import { INTERVAL_MS } from '../schema.js';

const API_BASE = 'https://api.cube.exchange';
const REST_URL = `${API_BASE}/ir/v0`;
const MD_URL = `${API_BASE}/md`;

// ── Types ──────────────────────────────────────────────────

export interface CubeMarket {
  marketId: number;
  symbol: string;
  baseAssetId: number;
  quoteAssetId: number;
  priceDisplayDecimals: number;
  priceTickSize: string;
  quantityTickSize: string;
  status: number;
}

export interface CubeKline {
  startTime: number;  // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CubeTrade {
  id: string;
  price: number;
  quantity: number;
  side: 'buy' | 'sell';
  timestamp: number;
}

// ── API calls ──────────────────────────────────────────────

async function cubeGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Cube API ${res.status}: ${res.statusText} — ${url}`);
  }
  const json = await res.json() as { result?: T } & T;
  return (json.result ?? json) as T;
}

/** Fetch all available Cube markets. */
export async function fetchMarkets(): Promise<CubeMarket[]> {
  const data = await cubeGet<{ markets: CubeMarket[] }>(`${REST_URL}/markets`);
  return data.markets.filter(m => m.status === 1); // active only
}

/**
 * Fetch OHLCV klines for a single page.
 * Cube returns newest-first array of [timestamp, open, high, low, close, volume].
 * Max 1000 candles per request.
 */
export async function fetchKlines(
  marketId: number,
  interval: string = '1h',
  limit: number = 1000,
): Promise<CubeKline[]> {
  const raw = await cubeGet<number[][]>(
    `${REST_URL}/history/klines?marketId=${marketId}&interval=${interval}&limit=${limit}`
  );

  return raw.map(k => ({
    startTime: k[0],
    open: k[1],
    high: k[2],
    low: k[3],
    close: k[4],
    volume: k[5],
  }));
}

/**
 * Fetch all available OHLCV history for a market by paginating backwards.
 * Yields batches of klines (oldest-first within each batch).
 *
 * Cube's klines endpoint returns the most recent `limit` candles.
 * To go further back, we track the oldest timestamp we've seen and
 * use the interval math to determine if more data exists.
 */
export async function* fetchAllKlines(
  marketId: number,
  symbol: string,
  interval: string = '1h',
  sinceMs?: number,
): AsyncGenerator<CubeKline[]> {
  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`Unknown interval: ${interval}`);

  let oldestSeen: number | undefined;
  let totalFetched = 0;
  const pageSize = 1000;

  while (true) {
    const klines = await fetchKlines(marketId, interval, pageSize);

    if (klines.length === 0) break;

    // Cube returns newest-first; sort oldest-first for storage
    klines.sort((a, b) => a.startTime - b.startTime);

    // If we have a sinceMs filter, drop anything before it
    const filtered = sinceMs
      ? klines.filter(k => k.startTime > sinceMs)
      : klines;

    if (filtered.length > 0) {
      yield filtered;
      totalFetched += filtered.length;
    }

    const batchOldest = klines[0].startTime;

    // If we got less than a full page, we've reached the beginning of history
    if (klines.length < pageSize) break;

    // If the oldest candle hasn't changed, we're stuck
    if (oldestSeen !== undefined && batchOldest >= oldestSeen) break;

    // If sinceMs is set and we've fetched past it, we're done
    if (sinceMs && batchOldest <= sinceMs) break;

    oldestSeen = batchOldest;

    // Rate limit: 200ms between requests
    await sleep(200);
  }
}

/**
 * Fetch recent trades for a market symbol.
 * Returns the most recent ~100 trades.
 */
export async function fetchRecentTrades(marketSymbol: string): Promise<CubeTrade[]> {
  const data = await cubeGet<{ ticker_id: string; trades: Array<{ id: number; p: number; q: number; side: string; ts: number }> }>(
    `${MD_URL}/parsed/book/${marketSymbol}/recent-trades`
  );

  return data.trades.map(t => ({
    id: String(t.id),
    price: t.p,
    quantity: t.q,
    side: t.side as 'buy' | 'sell',
    timestamp: t.ts,
  }));
}

/**
 * Fetch current order book snapshot for a market symbol.
 * Returns bids and asks as [price, quantity] pairs.
 */
export async function fetchOrderBook(marketSymbol: string): Promise<{
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
}> {
  const data = await cubeGet<{
    ticker_id: string;
    timestamp: number;
    bids: [number, number][];
    asks: [number, number][];
  }>(`${MD_URL}/parsed/book/${marketSymbol}/snapshot`);

  return {
    bids: data.bids,
    asks: data.asks,
    timestamp: data.timestamp,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
