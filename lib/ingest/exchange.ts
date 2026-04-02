/**
 * Exchange data ingester.
 *
 * Generic ingester that stores OHLCV data from any connected exchange
 * (via MCP tools like get_price_history) into the local DuckDB store.
 */

import { MarketDataStore, type OHLCVRow } from '../datastore.js';
import type { OHLCV } from '../indicators.js';

// ── Types ────────────────────────────────────────────────────

export interface ExchangeIngestResult {
  symbol: string;
  rows: number;
  error?: string;
}

/**
 * Function signature for fetching OHLCV data from an exchange.
 * This should be bound to the specific exchange's get_price_history tool.
 */
export type HistoryFetcher = (
  symbol: string,
  interval: string,
  limit: number,
) => Promise<OHLCV[]>;

// ── Ingest Function ──────────────────────────────────────────

/**
 * Ingest OHLCV data from a connected exchange into the local DuckDB store.
 *
 * @param store - MarketDataStore instance (must be initialized)
 * @param exchangeName - Name of the exchange (e.g. 'cube', 'robinhood', 'binance')
 * @param symbols - Array of trading pair symbols (e.g. ['BTC-USDC', 'ETH-USDC'])
 * @param interval - Candle interval (e.g. '1h', '1d')
 * @param fetcher - Function that fetches OHLCV from the exchange
 * @param assetType - Asset type for all symbols (default: 'crypto')
 * @returns Array of results per symbol
 */
export async function ingestFromExchange(
  store: MarketDataStore,
  exchangeName: string,
  symbols: string[],
  interval: string,
  fetcher: HistoryFetcher,
  assetType: string = 'crypto',
): Promise<ExchangeIngestResult[]> {
  const results: ExchangeIngestResult[] = [];

  for (const symbol of symbols) {
    try {
      // Check what we already have
      const lastTs = await store.lastTimestamp(symbol, interval, exchangeName);

      // Fetch max candles from exchange
      const candles = await fetcher(symbol, interval, 1000);

      if (candles.length === 0) {
        results.push({ symbol, rows: 0 });
        continue;
      }

      // Filter to only new candles if we have existing data
      const newCandles = lastTs
        ? candles.filter(c => c.timestamp > lastTs.getTime())
        : candles;

      if (newCandles.length === 0) {
        results.push({ symbol, rows: 0 });
        continue;
      }

      // Convert to OHLCVRow format
      const rows: OHLCVRow[] = newCandles.map(c => ({
        symbol,
        exchange: exchangeName,
        asset_type: assetType,
        interval,
        ts: new Date(c.timestamp),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

      const inserted = await store.insertOHLCV(rows);
      results.push({ symbol, rows: inserted });
    } catch (error: any) {
      results.push({ symbol, rows: 0, error: error.message });
    }
  }

  return results;
}
