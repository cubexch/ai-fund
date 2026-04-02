/**
 * Yahoo Finance data ingester.
 *
 * Fetches historical OHLCV data for stocks, ETFs, indices, and crypto
 * from Yahoo Finance (free, no API key required) and stores in DuckDB.
 *
 * Uses the `yahoo-finance2` npm package.
 */

import yahooFinance from 'yahoo-finance2';
import { MarketDataStore, type OHLCVRow } from '../datastore.js';

// ── Types ────────────────────────────────────────────────────

export interface IngestResult {
  symbol: string;
  rows: number;
  startDate: string | null;
  endDate: string | null;
  error?: string;
}

export interface IngestOptions {
  interval?: '1d' | '1wk' | '1mo';
  period1?: Date | string;    // Start date (default: 5 years ago)
  period2?: Date | string;    // End date (default: today)
  incremental?: boolean;      // Only fetch new data (default: true)
}

// ── Asset Type Detection ─────────────────────────────────────

function detectAssetType(symbol: string): string {
  const upper = symbol.toUpperCase();

  // Crypto pairs on Yahoo: BTC-USD, ETH-USD, SOL-USD, etc.
  if (upper.includes('-USD') || upper.includes('-EUR') || upper.includes('-GBP')) {
    return 'crypto';
  }

  // Common ETF patterns
  const etfSymbols = new Set([
    'SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'VEA', 'VWO',
    'GLD', 'SLV', 'TLT', 'HYG', 'LQD', 'XLF', 'XLE', 'XLK',
    'XLV', 'XLI', 'XLP', 'XLU', 'XLB', 'XLY', 'XLRE',
    'ARKK', 'ARKW', 'ARKG', 'ARKF', 'ARKQ',
    'IBIT', 'FBTC', 'GBTC', 'ETHE', 'BITO',
  ]);
  if (etfSymbols.has(upper)) return 'etf';

  // Index symbols on Yahoo: ^GSPC, ^DJI, ^IXIC, etc.
  if (upper.startsWith('^')) return 'index';

  return 'stock';
}

// ── Yahoo Interval Mapping ───────────────────────────────────

function mapInterval(interval: string): string {
  switch (interval) {
    case '1d': return '1d';
    case '1wk': return '1wk';
    case '1mo': return '1mo';
    default: return '1d';
  }
}

// ── Ingest Function ──────────────────────────────────────────

/**
 * Ingest OHLCV data from Yahoo Finance into the local DuckDB store.
 *
 * @param store - MarketDataStore instance (must be initialized)
 * @param symbols - Array of Yahoo Finance symbols (e.g. ['AAPL', 'BTC-USD', 'SPY'])
 * @param options - Ingestion options (interval, date range, incremental mode)
 * @returns Array of results per symbol
 */
export async function ingestYahoo(
  store: MarketDataStore,
  symbols: string[],
  options: IngestOptions = {},
): Promise<IngestResult[]> {
  const {
    interval = '1d',
    incremental = true,
  } = options;

  const results: IngestResult[] = [];

  for (const symbol of symbols) {
    try {
      // Determine start date
      let period1: Date;
      if (options.period1) {
        period1 = new Date(options.period1);
      } else if (incremental) {
        const lastTs = await store.lastTimestamp(symbol, mapInterval(interval), 'yahoo');
        if (lastTs) {
          // Start from the day after the last stored timestamp
          period1 = new Date(lastTs.getTime() + 1);
        } else {
          // First ingestion: 5 years of history
          period1 = new Date();
          period1.setFullYear(period1.getFullYear() - 5);
        }
      } else {
        period1 = new Date();
        period1.setFullYear(period1.getFullYear() - 5);
      }

      const period2 = options.period2 ? new Date(options.period2) : new Date();

      // Skip if we're already up to date
      if (period1 >= period2) {
        results.push({
          symbol,
          rows: 0,
          startDate: null,
          endDate: null,
        });
        continue;
      }

      // Fetch from Yahoo Finance
      const data = await yahooFinance.chart(symbol, {
        period1,
        period2,
        interval: interval as '1d' | '1wk' | '1mo',
      });

      if (!data.quotes || data.quotes.length === 0) {
        results.push({
          symbol,
          rows: 0,
          startDate: null,
          endDate: null,
        });
        continue;
      }

      // Convert to OHLCVRow format
      const assetType = detectAssetType(symbol);
      const rows: OHLCVRow[] = data.quotes
        .filter(q => q.open != null && q.close != null && q.high != null && q.low != null)
        .map(q => ({
          symbol: symbol.toUpperCase(),
          exchange: 'yahoo',
          asset_type: assetType,
          interval: mapInterval(interval),
          ts: new Date(q.date),
          open: q.open!,
          high: q.high!,
          low: q.low!,
          close: q.close!,
          volume: q.volume ?? 0,
        }));

      // Insert into DuckDB
      const inserted = await store.insertOHLCV(rows);

      results.push({
        symbol,
        rows: inserted,
        startDate: rows.length > 0 ? rows[0].ts.toISOString() : null,
        endDate: rows.length > 0 ? rows[rows.length - 1].ts.toISOString() : null,
      });
    } catch (error: any) {
      results.push({
        symbol,
        rows: 0,
        startDate: null,
        endDate: null,
        error: error.message,
      });
    }
  }

  return results;
}

/**
 * Convenience: ingest a standard watchlist of popular symbols.
 */
export const DEFAULT_STOCK_WATCHLIST = [
  // Mega caps
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'BRK-B',
  // Popular indices (ETFs)
  'SPY', 'QQQ', 'IWM', 'DIA',
  // Sector ETFs
  'XLF', 'XLE', 'XLK', 'XLV',
];

export const DEFAULT_CRYPTO_WATCHLIST = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD',
  'AVAX-USD', 'LINK-USD', 'UNI-USD', 'MATIC-USD',
];
