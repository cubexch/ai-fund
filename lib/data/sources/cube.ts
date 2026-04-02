/**
 * Cube Exchange public REST API data source.
 * Uses native fetch() — no additional dependencies.
 *
 * Public endpoints (no auth required):
 *   GET /ir/v0/markets              — list all markets
 *   GET /ir/v0/history/klines       — OHLCV candles (max 1000 per request)
 *   GET /md/parsed/tickers          — current tickers with 24h summary
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

export interface CubeTicker {
  symbol: string;
  lastPrice: number | null;
  bid: number | null;
  ask: number | null;
  baseVolume24h: number;
  quoteVolume24h: number;
  high24h: number | null;
  low24h: number | null;
  open24h: number | null;
}

// ── Security helpers ───────────────────────────────────────

/** Alphanumeric symbols only — reject anything that could be a path traversal or injection. */
const SAFE_SYMBOL = /^[A-Z0-9]{2,20}$/;

function validateSymbol(symbol: string): void {
  if (!SAFE_SYMBOL.test(symbol)) {
    throw new Error(`Invalid market symbol: ${symbol}. Must be 2-20 uppercase alphanumeric chars.`);
  }
}

/** Valid kline interval values (hardcoded allowlist). */
const VALID_INTERVALS = new Set(['1s', '1m', '15m', '1h', '4h', '1d']);

function validateInterval(interval: string): void {
  if (!VALID_INTERVALS.has(interval)) {
    throw new Error(`Invalid interval: ${interval}. Allowed: ${[...VALID_INTERVALS].join(', ')}`);
  }
}

// ── Instrument helpers ─────────────────────────────────────

/** Parse a Cube market symbol like 'BTCUSDC' into base/quote. */
export function parseSymbol(symbol: string): { base: string; quote: string } {
  // Cube symbols are concatenated without separator: BTCUSDC, ETHUSDC, SOLUSDC
  // Quote is typically USDC or USDT (4 chars)
  const quoteAssets = ['USDC', 'USDT', 'BTC', 'ETH'];
  for (const q of quoteAssets) {
    if (symbol.endsWith(q) && symbol.length > q.length) {
      return { base: symbol.slice(0, -q.length), quote: q };
    }
  }
  return { base: symbol, quote: 'USD' };
}

/** Build the canonical instrument ID for a Cube market. */
export function cubeIid(symbol: string): string {
  validateSymbol(symbol);
  return `cube:${symbol}`;
}

// ── API calls ──────────────────────────────────────────────

/**
 * Fetch from Cube API. URL is always constructed from hardcoded base + validated params.
 * Never accepts arbitrary URLs to prevent SSRF.
 */
async function cubeGet<T>(url: string): Promise<T> {
  // Defense-in-depth: ensure URL is always under our known API base
  if (!url.startsWith(REST_URL) && !url.startsWith(MD_URL)) {
    throw new Error(`SSRF blocked: URL ${url} is not under the Cube API base`);
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Cube API ${res.status}: ${res.statusText}`);
  }
  const json = await res.json() as { result?: T } & T;
  return (json.result ?? json) as T;
}

/** Fetch all available Cube markets. */
export async function fetchMarkets(): Promise<CubeMarket[]> {
  const data = await cubeGet<{ markets: CubeMarket[] }>(`${REST_URL}/markets`);
  return data.markets.filter(m => m.status === 1); // active only
}

/** Fetch current tickers for all markets. */
export async function fetchTickers(): Promise<CubeTicker[]> {
  const raw = await cubeGet<Array<{
    ticker_id: string;
    last_price: number | null;
    bid: number | null;
    ask: number | null;
    base_volume: number;
    quote_volume: number;
    high: number | null;
    low: number | null;
    open: number | null;
  }>>(`${MD_URL}/parsed/tickers`);

  return raw.map(t => ({
    symbol: t.ticker_id,
    lastPrice: t.last_price,
    bid: t.bid,
    ask: t.ask,
    baseVolume24h: t.base_volume,
    quoteVolume24h: t.quote_volume,
    high24h: t.high,
    low24h: t.low,
    open24h: t.open,
  }));
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
  if (!Number.isInteger(marketId) || marketId < 0) throw new Error(`Invalid marketId: ${marketId}`);
  validateInterval(interval);
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 1000);
  const raw = await cubeGet<number[][]>(
    `${REST_URL}/history/klines?marketId=${encodeURIComponent(marketId)}&interval=${encodeURIComponent(interval)}&limit=${safeLimit}`
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
 * Fetch all available OHLCV history for a market by paginating.
 * Yields batches of klines (oldest-first within each batch).
 *
 * Cube's klines endpoint returns the most recent `limit` candles.
 * We track the oldest timestamp to detect end-of-history.
 */
export async function* fetchAllKlines(
  marketId: number,
  symbol: string,
  interval: string = '1h',
  sinceMs?: number,
): AsyncGenerator<CubeKline[]> {
  validateInterval(interval);
  const intervalMs = INTERVAL_MS[interval];

  let oldestSeen: number | undefined;
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
  validateSymbol(marketSymbol);
  const data = await cubeGet<{ ticker_id: string; trades: Array<{ id: number; p: number; q: number; side: string; ts: number }> }>(
    `${MD_URL}/parsed/book/${encodeURIComponent(marketSymbol)}/recent-trades`
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
  validateSymbol(marketSymbol);
  const data = await cubeGet<{
    ticker_id: string;
    timestamp: number;
    bids: [number, number][];
    asks: [number, number][];
  }>(`${MD_URL}/parsed/book/${encodeURIComponent(marketSymbol)}/snapshot`);

  return {
    bids: data.bids,
    asks: data.asks,
    timestamp: data.timestamp,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
