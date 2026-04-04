/**
 * Cross-sectional screening, rolling beta, universe screening, regime stats.
 * Extracted from AnalyticsStore for modularity.
 */

import type { MarketDataStore } from './datastore.js';
import { mean, standardDeviation } from './math.js';
import { getReturnsSeries } from './analytics-correlation.js';
import type {
  CrossSectionalParams, CrossSectionalEntry,
  ScreenParams,
  RollingBetaParams, RollingBetaEntry,
  RegimeStatsParams, RegimeStatsEntry,
} from './analytics-store.js';

/**
 * Rank all assets by a metric in SQL.
 */
export async function crossSectionalSort(store: MarketDataStore, params: CrossSectionalParams): Promise<CrossSectionalEntry[]> {
  const { metric, interval, lookback, date } = params;

  const endDate = date ?? new Date();
  const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

  let metricExpr: string;
  switch (metric) {
    case 'momentum':
      metricExpr = '(LAST(close ORDER BY ts) - FIRST(close ORDER BY ts)) / NULLIF(FIRST(close ORDER BY ts), 0)';
      break;
    case 'volatility':
      metricExpr = 'STDDEV_SAMP((close - LAG(close) OVER (PARTITION BY symbol ORDER BY ts)) / NULLIF(LAG(close) OVER (PARTITION BY symbol ORDER BY ts), 0))';
      break;
    case 'volume':
      metricExpr = 'AVG(volume)';
      break;
    case 'return':
      metricExpr = '(LAST(close ORDER BY ts) - FIRST(close ORDER BY ts)) / NULLIF(FIRST(close ORDER BY ts), 0)';
      break;
  }

  if (metric === 'volatility') {
    const rows = await store.sql(`
      WITH rets AS (
        SELECT symbol, ts, close,
               LAG(close) OVER (PARTITION BY symbol ORDER BY ts) AS prev_close
        FROM ohlcv
        WHERE interval = ?
          AND ts >= ?
          AND ts <= ?
      ),
      vol AS (
        SELECT symbol,
               STDDEV_SAMP(CASE WHEN prev_close IS NOT NULL AND prev_close != 0
                 THEN (close - prev_close) / prev_close ELSE NULL END) AS metric_value
        FROM rets
        GROUP BY symbol
        HAVING COUNT(CASE WHEN prev_close IS NOT NULL THEN 1 END) >= 2
      )
      SELECT symbol, metric_value,
             ROW_NUMBER() OVER (ORDER BY metric_value DESC) AS rank
      FROM vol
      WHERE metric_value IS NOT NULL
      ORDER BY metric_value DESC
    `, [interval, startDate.toISOString(), endDate.toISOString()]);

    return formatCrossSectional(rows);
  }

  const rows = await store.sql(`
    WITH metrics AS (
      SELECT symbol,
             ${metricExpr} AS metric_value
      FROM ohlcv
      WHERE interval = ?
        AND ts >= ?
        AND ts <= ?
      GROUP BY symbol
      HAVING COUNT(*) >= 2
    )
    SELECT symbol, metric_value,
           ROW_NUMBER() OVER (ORDER BY metric_value DESC) AS rank
    FROM metrics
    WHERE metric_value IS NOT NULL
    ORDER BY metric_value DESC
  `, [interval, startDate.toISOString(), endDate.toISOString()]);

  return formatCrossSectional(rows);
}

export function formatCrossSectional(rows: Record<string, unknown>[]): CrossSectionalEntry[] {
  const total = rows.length;
  if (total === 0) return [];

  return rows.map(row => {
    const rank = row.rank as number;
    return {
      symbol: row.symbol as string,
      value: row.metric_value as number,
      rank,
      percentile: total === 1 ? 1 : 1 - (rank - 1) / (total - 1),
      quintile: Math.min(5, Math.ceil(rank / (total / 5))),
    };
  });
}

/**
 * SQL-based universe screener with multiple filter criteria.
 */
export async function screenUniverse(store: MarketDataStore, params: ScreenParams): Promise<Array<{
  symbol: string;
  metrics: Record<string, number>;
}>> {
  const { filters, interval, limit = 100 } = params;

  if (filters.length === 0) return [];

  const maxLookback = Math.max(...filters.map(f => f.lookback));
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - maxLookback * 24 * 60 * 60 * 1000);

  const rows = await store.sql(`
    WITH base AS (
      SELECT symbol, ts, close, volume,
             LAG(close) OVER (PARTITION BY symbol ORDER BY ts) AS prev_close
      FROM ohlcv
      WHERE interval = ?
        AND ts >= ?
        AND ts <= ?
    ),
    rets AS (
      SELECT symbol, ts, close, volume,
             CASE WHEN prev_close IS NOT NULL AND prev_close != 0
                  THEN (close - prev_close) / prev_close ELSE NULL END AS ret
      FROM base
    ),
    metrics AS (
      SELECT symbol,
             AVG(volume) AS avg_volume,
             STDDEV_SAMP(ret) AS volatility,
             (LAST(close ORDER BY ts) - FIRST(close ORDER BY ts))
               / NULLIF(FIRST(close ORDER BY ts), 0) AS return,
             CASE WHEN STDDEV_SAMP(ret) > 0
                  THEN AVG(ret) / STDDEV_SAMP(ret) * SQRT(365)
                  ELSE 0 END AS sharpe
      FROM rets
      GROUP BY symbol
      HAVING COUNT(ret) >= 2
    )
    SELECT * FROM metrics
    ORDER BY symbol
  `, [interval, startDate.toISOString(), endDate.toISOString()]);

  const filtered = rows.filter(row => {
    return filters.every(f => {
      const val = row[f.metric] as number | null;
      if (val === null || val === undefined) return false;
      switch (f.operator) {
        case '>': return val > f.value;
        case '<': return val < f.value;
        case '>=': return val >= f.value;
        case '<=': return val <= f.value;
      }
    });
  });

  return filtered.slice(0, limit).map(row => ({
    symbol: row.symbol as string,
    metrics: {
      avg_volume: row.avg_volume as number,
      volatility: row.volatility as number,
      return: row.return as number,
      sharpe: row.sharpe as number,
    },
  }));
}

/**
 * Rolling beta of a symbol against a benchmark.
 */
export async function rollingBeta(store: MarketDataStore, params: RollingBetaParams): Promise<RollingBetaEntry[]> {
  const { symbol, benchmark, interval, window } = params;

  const rows = await store.sql(`
    WITH asset_prices AS (
      SELECT ts, close AS asset_close
      FROM ohlcv
      WHERE symbol = ? AND interval = ?
      ORDER BY ts
    ),
    bench_prices AS (
      SELECT ts, close AS bench_close
      FROM ohlcv
      WHERE symbol = ? AND interval = ?
      ORDER BY ts
    ),
    joined AS (
      SELECT a.ts,
             a.asset_close,
             b.bench_close
      FROM asset_prices a
      INNER JOIN bench_prices b ON a.ts = b.ts
      ORDER BY a.ts
    ),
    with_prev AS (
      SELECT ts,
             asset_close,
             bench_close,
             LAG(asset_close) OVER (ORDER BY ts) AS prev_asset,
             LAG(bench_close) OVER (ORDER BY ts) AS prev_bench
      FROM joined
    )
    SELECT ts,
           CASE WHEN prev_asset IS NOT NULL AND prev_asset != 0
                THEN (asset_close - prev_asset) / prev_asset ELSE NULL END AS asset_ret,
           CASE WHEN prev_bench IS NOT NULL AND prev_bench != 0
                THEN (bench_close - prev_bench) / prev_bench ELSE NULL END AS bench_ret
    FROM with_prev
    WHERE prev_asset IS NOT NULL
    ORDER BY ts
  `, [symbol, interval, benchmark, interval]);

  const data = rows.filter(r => r.asset_ret !== null && r.bench_ret !== null);

  if (data.length < window) return [];

  const results: RollingBetaEntry[] = [];
  for (let i = window - 1; i < data.length; i++) {
    const windowData = data.slice(i - window + 1, i + 1);
    const assetRets = windowData.map(r => r.asset_ret as number);
    const benchRets = windowData.map(r => r.bench_ret as number);

    const benchMean = mean(benchRets);
    const assetMean = mean(assetRets);

    let covar = 0;
    let benchVar = 0;
    for (let j = 0; j < windowData.length; j++) {
      const da = assetRets[j] - assetMean;
      const db = benchRets[j] - benchMean;
      covar += da * db;
      benchVar += db * db;
    }
    covar /= (windowData.length - 1);
    benchVar /= (windowData.length - 1);

    const beta = benchVar === 0 ? 1 : covar / benchVar;
    const alpha = assetMean - beta * benchMean;

    const predicted = benchRets.map(b => alpha + beta * b);
    const ssRes = assetRets.reduce((s, a, j) => s + (a - predicted[j]) ** 2, 0);
    const ssTot = assetRets.reduce((s, a) => s + (a - assetMean) ** 2, 0);
    const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

    results.push({
      timestamp: new Date(data[i].ts as string | Date),
      beta,
      alpha,
      rSquared: Math.max(0, rSquared),
    });
  }

  return results;
}

/**
 * Rolling regime statistics using DuckDB window functions.
 */
export async function regimeStats(store: MarketDataStore, params: RegimeStatsParams): Promise<RegimeStatsEntry[]> {
  const { symbol, interval, lookback, regimeWindow = 20 } = params;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

  const retRows = await store.sql(`
    WITH rets AS (
      SELECT ts,
             CASE WHEN LAG(close) OVER (ORDER BY ts) IS NOT NULL
                  AND LAG(close) OVER (ORDER BY ts) != 0
                  THEN (close - LAG(close) OVER (ORDER BY ts))
                       / LAG(close) OVER (ORDER BY ts)
                  ELSE NULL END AS ret
      FROM ohlcv
      WHERE symbol = ? AND interval = ? AND ts >= ? AND ts <= ?
      ORDER BY ts
    )
    SELECT ts, ret FROM rets WHERE ret IS NOT NULL ORDER BY ts
  `, [symbol, interval, startDate.toISOString(), endDate.toISOString()]);

  const allRets: { ts: Date; ret: number }[] = [];
  for (const r of retRows) {
    allRets.push({ ts: new Date(r.ts as string | Date), ret: r.ret as number });
  }

  const results: RegimeStatsEntry[] = [];
  for (let i = regimeWindow - 1; i < allRets.length; i++) {
    const windowRets = allRets.slice(i - regimeWindow + 1, i + 1).map(r => r.ret);
    const m = mean(windowRets);
    const vol = standardDeviation(windowRets);
    const n = windowRets.length;

    let skew = 0;
    if (n >= 3 && vol > 0) {
      const m3 = windowRets.reduce((s, v) => s + ((v - m) / vol) ** 3, 0) / n;
      skew = m3;
    }

    let kurt = 0;
    if (n >= 4 && vol > 0) {
      const m4 = windowRets.reduce((s, v) => s + ((v - m) / vol) ** 4, 0) / n;
      kurt = m4 - 3;
    }

    const annualizedVol = vol * Math.sqrt(365);
    let regime: string;
    if (annualizedVol > 0.8) {
      regime = 'crisis';
    } else if (annualizedVol > 0.5) {
      regime = 'high-volatility';
    } else if (Math.abs(m) > vol * 0.5) {
      regime = m > 0 ? 'trending-up' : 'trending-down';
    } else {
      regime = 'mean-reverting';
    }

    results.push({
      timestamp: allRets[i].ts,
      mean: m,
      volatility: vol,
      skewness: skew,
      kurtosis: kurt,
      regime,
    });
  }

  return results;
}
