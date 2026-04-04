/**
 * Rolling correlation and pairwise correlation analytics.
 * Extracted from AnalyticsStore for modularity.
 * Pure async functions that accept a MarketDataStore for SQL queries.
 */

import type { MarketDataStore } from './datastore.js';
import { correlation, mean } from './math.js';
import type { ReturnSeriesParams, RollingCorrelationParams, RollingCorrelationEntry, PairwiseCorrelationParams, PairwiseCorrelationEntry } from './analytics-store.js';

/**
 * Extract aligned return series via SQL with GROUP BY.
 * Returns per-period percentage returns keyed by symbol.
 */
export async function getReturnsSeries(store: MarketDataStore, params: ReturnSeriesParams): Promise<Record<string, number[]>> {
  const { symbols, interval, start, end, exchange } = params;

  if (symbols.length === 0) return {};

  const conditions = ['interval = ?'];
  const sqlParams: unknown[] = [interval];

  if (exchange) {
    conditions.push('exchange = ?');
    sqlParams.push(exchange);
  }
  if (start) {
    conditions.push('ts >= ?');
    sqlParams.push(start.toISOString());
  }
  if (end) {
    conditions.push('ts <= ?');
    sqlParams.push(end.toISOString());
  }

  const placeholders = symbols.map(() => '?').join(', ');
  conditions.push(`symbol IN (${placeholders})`);
  sqlParams.push(...symbols);

  const rows = await store.sql(`
    WITH prices AS (
      SELECT symbol, ts, close,
             LAG(close) OVER (PARTITION BY symbol ORDER BY ts) AS prev_close
      FROM ohlcv
      WHERE ${conditions.join(' AND ')}
    ),
    rets AS (
      SELECT symbol, ts,
             CASE WHEN prev_close IS NOT NULL AND prev_close != 0
                  THEN (close - prev_close) / prev_close
                  ELSE NULL END AS ret
      FROM prices
    )
    SELECT symbol, ts, ret
    FROM rets
    WHERE ret IS NOT NULL
    ORDER BY ts, symbol
  `, sqlParams);

  const result: Record<string, number[]> = {};
  for (const s of symbols) {
    result[s] = [];
  }
  for (const row of rows) {
    const sym = row.symbol as string;
    if (result[sym]) {
      result[sym].push(row.ret as number);
    }
  }

  return result;
}

/**
 * Rolling correlation matrices using DuckDB window functions.
 */
export async function rollingCorrelationMatrix(store: MarketDataStore, params: RollingCorrelationParams): Promise<RollingCorrelationEntry[]> {
  const { symbols, interval, window, step = 1 } = params;

  if (symbols.length < 2) return [];

  const placeholders = symbols.map(() => '?').join(', ');
  const rows = await store.sql(`
    SELECT ts, symbol, close
    FROM ohlcv
    WHERE symbol IN (${placeholders})
      AND interval = ?
    ORDER BY ts, symbol
  `, [...symbols, interval]);

  if (rows.length === 0) return [];

  const timeMap = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const tsKey = new Date(row.ts as string | Date).toISOString();
    if (!timeMap.has(tsKey)) timeMap.set(tsKey, new Map());
    timeMap.get(tsKey)!.set(row.symbol as string, row.close as number);
  }

  const timestamps: string[] = [];
  const priceMatrix: number[][] = [];
  for (const [ts, symbolMap] of timeMap) {
    if (symbols.every(s => symbolMap.has(s))) {
      timestamps.push(ts);
      priceMatrix.push(symbols.map(s => symbolMap.get(s)!));
    }
  }

  if (priceMatrix.length < window + 1) return [];

  const returnMatrix: number[][] = [];
  for (let i = 1; i < priceMatrix.length; i++) {
    returnMatrix.push(
      symbols.map((_, j) =>
        priceMatrix[i - 1][j] === 0 ? 0 : (priceMatrix[i][j] - priceMatrix[i - 1][j]) / priceMatrix[i - 1][j]
      )
    );
  }

  const results: RollingCorrelationEntry[] = [];
  for (let i = window - 1; i < returnMatrix.length; i += step) {
    const windowReturns = returnMatrix.slice(i - window + 1, i + 1);
    const n = symbols.length;
    const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

    const seriesBySymbol: number[][] = symbols.map((_, j) =>
      windowReturns.map(row => row[j])
    );

    for (let a = 0; a < n; a++) {
      for (let b = a; b < n; b++) {
        const corr = a === b ? 1 : correlation(seriesBySymbol[a], seriesBySymbol[b]);
        matrix[a][b] = corr;
        matrix[b][a] = corr;
      }
    }

    results.push({
      timestamp: new Date(timestamps[i + 1]),
      matrix,
      symbols: [...symbols],
    });
  }

  return results;
}

/**
 * All pairwise correlations.
 */
export async function pairwiseCorrelations(store: MarketDataStore, params: PairwiseCorrelationParams): Promise<PairwiseCorrelationEntry[]> {
  const { symbols, interval, lookback, minCorrelation = -1 } = params;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

  let targetSymbols: string[];
  if (symbols && symbols.length > 0) {
    targetSymbols = symbols;
  } else {
    const symRows = await store.sql(`
      SELECT DISTINCT symbol FROM ohlcv
      WHERE interval = ? AND ts >= ? AND ts <= ?
    `, [interval, startDate.toISOString(), endDate.toISOString()]);
    targetSymbols = symRows.map(r => r.symbol as string);
  }

  if (targetSymbols.length < 2) return [];

  const returnsSeries = await getReturnsSeries(store, {
    symbols: targetSymbols,
    interval,
    start: startDate,
    end: endDate,
  });

  const results: PairwiseCorrelationEntry[] = [];
  const syms = Object.keys(returnsSeries);

  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      const corr = correlation(returnsSeries[syms[i]], returnsSeries[syms[j]]);
      if (Math.abs(corr) >= Math.abs(minCorrelation)) {
        results.push({
          symbolA: syms[i],
          symbolB: syms[j],
          correlation: corr,
        });
      }
    }
  }

  results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  return results;
}
