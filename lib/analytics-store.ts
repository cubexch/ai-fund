/**
 * DuckDB-powered analytics engine for institutional-scale quantitative analysis.
 *
 * Uses DuckDB's analytical SQL for heavy lifting (rolling windows, cross-asset
 * joins, aggregations across hundreds of assets), then passes structured results
 * to pure function libs for factor decomposition and risk modeling.
 */

import { MarketDataStore } from './datastore.js';
import { pcaFactors, componentVaR, covarianceMatrix, riskDecomposition } from './factor-model.js';
import { mean, standardDeviation, correlation, returns as computeReturns } from './math.js';

// ── Types ────────────────────────────────────────────────

export interface ReturnSeriesParams {
  symbols: string[];
  interval: string;
  start?: Date;
  end?: Date;
  exchange?: string;
}

export interface RollingCorrelationParams {
  symbols: string[];
  interval: string;
  window: number;
  step?: number;
}

export interface RollingCorrelationEntry {
  timestamp: Date;
  matrix: number[][];
  symbols: string[];
}

export interface CrossSectionalParams {
  metric: 'momentum' | 'volatility' | 'volume' | 'return';
  interval: string;
  lookback: number;
  date?: Date;
}

export interface CrossSectionalEntry {
  symbol: string;
  value: number;
  rank: number;
  percentile: number;
  quintile: number;
}

export interface FactorReturnsParams {
  interval: string;
  lookback: number;
  characteristics?: Record<string, { marketCap?: number; bookToMarket?: number }>;
}

export interface FactorReturnsResult {
  market: number[];
  smb: number[];
  momentum: number[];
  timestamps: Date[];
}

export interface CovarianceParams {
  symbols: string[];
  interval: string;
  lookback: number;
  method?: 'sample' | 'exponential';
  halfLife?: number;
}

export interface CovarianceResult {
  matrix: number[][];
  symbols: string[];
  method: string;
  dataPoints: number;
}

export interface RollingBetaParams {
  symbol: string;
  benchmark: string;
  interval: string;
  window: number;
}

export interface RollingBetaEntry {
  timestamp: Date;
  beta: number;
  alpha: number;
  rSquared: number;
}

export interface RiskReportParams {
  symbols: string[];
  interval: string;
  lookback?: number;
}

export interface ScreenParams {
  filters: Array<{
    metric: 'avg_volume' | 'volatility' | 'return' | 'sharpe';
    operator: '>' | '<' | '>=' | '<=';
    value: number;
    lookback: number;
  }>;
  interval: string;
  limit?: number;
}

export interface PairwiseCorrelationParams {
  symbols?: string[];
  interval: string;
  lookback: number;
  minCorrelation?: number;
}

export interface PairwiseCorrelationEntry {
  symbolA: string;
  symbolB: string;
  correlation: number;
}

export interface RegimeStatsParams {
  symbol: string;
  interval: string;
  lookback: number;
  regimeWindow?: number;
}

export interface RegimeStatsEntry {
  timestamp: Date;
  mean: number;
  volatility: number;
  skewness: number;
  kurtosis: number;
  regime: string;
}

// ── AnalyticsStore ──────────────────────────────────────

export class AnalyticsStore {
  private store: MarketDataStore;

  constructor(store: MarketDataStore) {
    this.store = store;
  }

  // ── 1. Return Series Extraction ─────────────────────────

  /**
   * Extract aligned return series via SQL with GROUP BY.
   * Returns per-period percentage returns keyed by symbol.
   */
  async getReturnsSeries(params: ReturnSeriesParams): Promise<Record<string, number[]>> {
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

    // Build symbol filter
    const placeholders = symbols.map(() => '?').join(', ');
    conditions.push(`symbol IN (${placeholders})`);
    sqlParams.push(...symbols);

    const rows = await this.store.sql(`
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

    // Group by symbol preserving time alignment
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

  // ── 2. Rolling Correlation Matrix ───────────────────────

  /**
   * Rolling correlation matrices using DuckDB window functions.
   * Computes correlation over a sliding window of return observations.
   */
  async rollingCorrelationMatrix(params: RollingCorrelationParams): Promise<RollingCorrelationEntry[]> {
    const { symbols, interval, window, step = 1 } = params;

    if (symbols.length < 2) return [];

    // Extract aligned close prices
    const placeholders = symbols.map(() => '?').join(', ');
    const rows = await this.store.sql(`
      SELECT ts, symbol, close
      FROM ohlcv
      WHERE symbol IN (${placeholders})
        AND interval = ?
      ORDER BY ts, symbol
    `, [...symbols, interval]);

    if (rows.length === 0) return [];

    // Build time-aligned price matrix
    const timeMap = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const tsKey = new Date(row.ts as string | Date).toISOString();
      if (!timeMap.has(tsKey)) timeMap.set(tsKey, new Map());
      timeMap.get(tsKey)!.set(row.symbol as string, row.close as number);
    }

    // Filter to timestamps where all symbols have data
    const timestamps: string[] = [];
    const priceMatrix: number[][] = []; // [timeIdx][symbolIdx]
    for (const [ts, symbolMap] of timeMap) {
      if (symbols.every(s => symbolMap.has(s))) {
        timestamps.push(ts);
        priceMatrix.push(symbols.map(s => symbolMap.get(s)!));
      }
    }

    if (priceMatrix.length < window + 1) return [];

    // Compute returns
    const returnMatrix: number[][] = [];
    for (let i = 1; i < priceMatrix.length; i++) {
      returnMatrix.push(
        symbols.map((_, j) =>
          priceMatrix[i - 1][j] === 0 ? 0 : (priceMatrix[i][j] - priceMatrix[i - 1][j]) / priceMatrix[i - 1][j]
        )
      );
    }

    // Rolling correlation windows
    const results: RollingCorrelationEntry[] = [];
    for (let i = window - 1; i < returnMatrix.length; i += step) {
      const windowReturns = returnMatrix.slice(i - window + 1, i + 1);
      const n = symbols.length;
      const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));

      // Extract per-symbol series for this window
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
        timestamp: new Date(timestamps[i + 1]), // +1 because returns are shifted by one
        matrix,
        symbols: [...symbols],
      });
    }

    return results;
  }

  // ── 3. Cross-Sectional Sort ─────────────────────────────

  /**
   * Rank all assets by a metric in SQL.
   * Returns sorted array with rank, percentile, and quintile.
   */
  async crossSectionalSort(params: CrossSectionalParams): Promise<CrossSectionalEntry[]> {
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

    // volatility needs window functions which can't nest in aggregate; use CTE approach
    if (metric === 'volatility') {
      const rows = await this.store.sql(`
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

      return this.formatCrossSectional(rows);
    }

    const rows = await this.store.sql(`
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

    return this.formatCrossSectional(rows);
  }

  private formatCrossSectional(rows: Record<string, unknown>[]): CrossSectionalEntry[] {
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

  // ── 4. Factor Returns from DB ───────────────────────────

  /**
   * Build factor returns (market, SMB, momentum) from stored data.
   * Market factor = equal-weight universe return.
   * SMB = small minus big (by market cap if provided, else by volume proxy).
   * Momentum = top-quintile minus bottom-quintile by trailing return.
   */
  async factorReturnsFromDB(params: FactorReturnsParams): Promise<FactorReturnsResult> {
    const { interval, lookback, characteristics } = params;

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

    // Get all symbols with data in range
    const symbolRows = await this.store.sql(`
      SELECT DISTINCT symbol FROM ohlcv
      WHERE interval = ? AND ts >= ? AND ts <= ?
    `, [interval, startDate.toISOString(), endDate.toISOString()]);

    const symbols = symbolRows.map(r => r.symbol as string);
    if (symbols.length < 4) {
      return { market: [], smb: [], momentum: [], timestamps: [] };
    }

    // Get all returns
    const returnsSeries = await this.getReturnsSeries({
      symbols,
      interval,
      start: startDate,
      end: endDate,
    });

    // Find minimum aligned length
    const lengths = Object.values(returnsSeries).map(s => s.length);
    const minLen = Math.min(...lengths);
    if (minLen < 2) {
      return { market: [], smb: [], momentum: [], timestamps: [] };
    }

    // Trim to aligned length
    const aligned: Record<string, number[]> = {};
    for (const [sym, rets] of Object.entries(returnsSeries)) {
      aligned[sym] = rets.slice(rets.length - minLen);
    }
    const syms = Object.keys(aligned);

    // Get timestamps
    const tsRows = await this.store.sql(`
      SELECT DISTINCT ts FROM ohlcv
      WHERE interval = ? AND ts >= ? AND ts <= ?
      ORDER BY ts
    `, [interval, startDate.toISOString(), endDate.toISOString()]);

    const allTimestamps = tsRows.map(r => new Date(r.ts as string | Date));
    const timestamps = allTimestamps.slice(allTimestamps.length - minLen);

    // Market factor: equal-weight average return
    const market: number[] = [];
    for (let t = 0; t < minLen; t++) {
      const vals = syms.map(s => aligned[s][t]);
      market.push(mean(vals));
    }

    // SMB: sort by market cap or avg volume, long bottom half / short top half
    let sortedBySize: string[];
    if (characteristics) {
      sortedBySize = [...syms].sort((a, b) =>
        (characteristics[a]?.marketCap ?? 0) - (characteristics[b]?.marketCap ?? 0)
      );
    } else {
      // Use average volume as size proxy
      const volRows = await this.store.sql(`
        SELECT symbol, AVG(volume) as avg_vol
        FROM ohlcv
        WHERE interval = ? AND ts >= ? AND ts <= ?
        GROUP BY symbol
        ORDER BY avg_vol ASC
      `, [interval, startDate.toISOString(), endDate.toISOString()]);
      sortedBySize = volRows.map(r => r.symbol as string).filter(s => syms.includes(s));
    }

    const halfIdx = Math.floor(sortedBySize.length / 2);
    const smallCap = sortedBySize.slice(0, halfIdx);
    const bigCap = sortedBySize.slice(halfIdx);

    const smb: number[] = [];
    for (let t = 0; t < minLen; t++) {
      const smallRet = smallCap.length > 0 ? mean(smallCap.map(s => aligned[s]?.[t] ?? 0)) : 0;
      const bigRet = bigCap.length > 0 ? mean(bigCap.map(s => aligned[s]?.[t] ?? 0)) : 0;
      smb.push(smallRet - bigRet);
    }

    // Momentum factor: trailing cumulative return, long winners / short losers
    const momLookback = Math.min(20, Math.floor(minLen / 2));
    const momentum: number[] = [];
    for (let t = 0; t < minLen; t++) {
      if (t < momLookback) {
        momentum.push(0);
        continue;
      }
      // Rank by trailing return
      const trailingRets = syms.map(s => ({
        sym: s,
        ret: aligned[s].slice(t - momLookback, t).reduce((a, b) => a + b, 0),
      }));
      trailingRets.sort((a, b) => b.ret - a.ret);
      const quintileSize = Math.max(1, Math.floor(trailingRets.length / 5));
      const winners = trailingRets.slice(0, quintileSize).map(x => x.sym);
      const losers = trailingRets.slice(-quintileSize).map(x => x.sym);
      const winRet = mean(winners.map(s => aligned[s][t]));
      const loseRet = mean(losers.map(s => aligned[s][t]));
      momentum.push(winRet - loseRet);
    }

    return { market, smb, momentum, timestamps };
  }

  // ── 5. Covariance from DB ───────────────────────────────

  /**
   * Covariance matrix using DuckDB extraction + covarianceMatrix() from factor-model.
   */
  async covarianceFromDB(params: CovarianceParams): Promise<CovarianceResult> {
    const { symbols, interval, lookback, method = 'sample', halfLife } = params;

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

    const returnsSeries = await this.getReturnsSeries({
      symbols,
      interval,
      start: startDate,
      end: endDate,
    });

    // Count data points (min across symbols)
    const lengths = Object.values(returnsSeries).map(s => s.length);
    const dataPoints = lengths.length > 0 ? Math.min(...lengths) : 0;

    if (dataPoints < 2) {
      return {
        matrix: Array.from({ length: symbols.length }, () => Array(symbols.length).fill(0)),
        symbols,
        method,
        dataPoints: 0,
      };
    }

    const factorMethod = method === 'exponential' ? 'exponential' : 'sample';
    const covResult = covarianceMatrix(
      returnsSeries,
      factorMethod,
      halfLife !== undefined ? { halfLife } : undefined,
    );

    return {
      matrix: covResult.matrix,
      symbols: covResult.symbols,
      method: covResult.method,
      dataPoints,
    };
  }

  // ── 6. Rolling Beta ─────────────────────────────────────

  /**
   * Rolling beta of a symbol against a benchmark.
   * Returns beta, alpha, and R-squared for each window.
   */
  async rollingBeta(params: RollingBetaParams): Promise<RollingBetaEntry[]> {
    const { symbol, benchmark, interval, window } = params;

    // Get aligned returns via SQL
    const rows = await this.store.sql(`
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

    // Filter out nulls
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

      // R-squared
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

  // ── 7. Risk Report ──────────────────────────────────────

  /**
   * Full risk report using PCA, component VaR, and risk decomposition
   * from factor-model.ts.
   */
  async riskReport(params: RiskReportParams): Promise<{
    pca: { factors: Array<{ eigenvalue: number; varianceExplained: number; loadings: Record<string, number> }>; totalVarianceExplained: number };
    componentVaR: { portfolioVaR: number; components: Array<{ index: number; componentVaR: number; pctContribution: number }> };
    riskDecomposition: { totalRisk: number; systematicRisk: number; idiosyncraticRisk: number; diversificationRatio: number; riskContributions: number[]; marginalRiskContributions: number[] };
    covariance: { matrix: number[][]; symbols: string[] };
    perAsset: Array<{ symbol: string; annualizedVol: number; meanReturn: number; sharpe: number }>;
  }> {
    const { symbols, interval, lookback = 90 } = params;

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

    const returnsSeries = await this.getReturnsSeries({
      symbols,
      interval,
      start: startDate,
      end: endDate,
    });

    // Per-asset metrics
    const perAsset = symbols.map(s => {
      const rets = returnsSeries[s] ?? [];
      const vol = rets.length >= 2 ? standardDeviation(rets) * Math.sqrt(365) : 0;
      const avgRet = mean(rets);
      const sharpe = vol === 0 ? 0 : (avgRet * 365) / vol;
      return { symbol: s, annualizedVol: vol, meanReturn: avgRet, sharpe };
    });

    // PCA
    const pcaResult = pcaFactors(returnsSeries);

    // Covariance
    const covResult = covarianceMatrix(returnsSeries);

    // Equal-weight portfolio for VaR and risk decomposition
    const n = symbols.length;
    const weights = n > 0 ? Array(n).fill(1 / n) : [];

    // Map symbols to covariance matrix order
    const orderedCov = this.reorderCovMatrix(covResult.matrix, covResult.symbols, symbols);

    const cVaR = componentVaR(weights, orderedCov);
    const riskDecomp = riskDecomposition(weights, orderedCov);

    return {
      pca: {
        factors: pcaResult.factors,
        totalVarianceExplained: pcaResult.totalVarianceExplained,
      },
      componentVaR: cVaR,
      riskDecomposition: riskDecomp,
      covariance: { matrix: orderedCov, symbols },
      perAsset,
    };
  }

  /**
   * Reorder covariance matrix to match target symbol order.
   */
  private reorderCovMatrix(matrix: number[][], fromSymbols: string[], toSymbols: string[]): number[][] {
    const n = toSymbols.length;
    const result: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
    const indexMap = new Map(fromSymbols.map((s, i) => [s, i]));

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const fi = indexMap.get(toSymbols[i]);
        const fj = indexMap.get(toSymbols[j]);
        if (fi !== undefined && fj !== undefined && fi < matrix.length && fj < matrix.length) {
          result[i][j] = matrix[fi][fj];
        }
      }
    }
    return result;
  }

  // ── 8. Universe Screener ────────────────────────────────

  /**
   * SQL-based universe screener with multiple filter criteria.
   */
  async screenUniverse(params: ScreenParams): Promise<Array<{
    symbol: string;
    metrics: Record<string, number>;
  }>> {
    const { filters, interval, limit = 100 } = params;

    if (filters.length === 0) return [];

    // Determine the max lookback needed
    const maxLookback = Math.max(...filters.map(f => f.lookback));
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - maxLookback * 24 * 60 * 60 * 1000);

    // Build CTE with returns and metrics per symbol
    const rows = await this.store.sql(`
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

    // Apply filters in TypeScript (dynamic SQL with operators is error-prone)
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

  // ── 9. Pairwise Correlations ────────────────────────────

  /**
   * All pairwise correlations via DuckDB self-join.
   * If symbols not specified, uses all symbols in the store.
   */
  async pairwiseCorrelations(params: PairwiseCorrelationParams): Promise<PairwiseCorrelationEntry[]> {
    const { symbols, interval, lookback, minCorrelation = -1 } = params;

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

    // Determine symbols to use
    let targetSymbols: string[];
    if (symbols && symbols.length > 0) {
      targetSymbols = symbols;
    } else {
      const symRows = await this.store.sql(`
        SELECT DISTINCT symbol FROM ohlcv
        WHERE interval = ? AND ts >= ? AND ts <= ?
      `, [interval, startDate.toISOString(), endDate.toISOString()]);
      targetSymbols = symRows.map(r => r.symbol as string);
    }

    if (targetSymbols.length < 2) return [];

    // Get returns for all symbols
    const returnsSeries = await this.getReturnsSeries({
      symbols: targetSymbols,
      interval,
      start: startDate,
      end: endDate,
    });

    // Compute all pairwise correlations
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

    // Sort by absolute correlation descending
    results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

    return results;
  }

  // ── 10. Regime Stats ────────────────────────────────────

  /**
   * Rolling regime statistics using DuckDB window functions.
   * Computes rolling mean, volatility, skewness, kurtosis, and classifies regime.
   */
  async regimeStats(params: RegimeStatsParams): Promise<RegimeStatsEntry[]> {
    const { symbol, interval, lookback, regimeWindow = 20 } = params;

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

    // Use DuckDB window functions for rolling statistics
    const rows = await this.store.sql(`
      WITH rets AS (
        SELECT ts, close,
               LAG(close) OVER (ORDER BY ts) AS prev_close,
               CASE WHEN LAG(close) OVER (ORDER BY ts) IS NOT NULL
                    AND LAG(close) OVER (ORDER BY ts) != 0
                    THEN (close - LAG(close) OVER (ORDER BY ts))
                         / LAG(close) OVER (ORDER BY ts)
                    ELSE NULL END AS ret
        FROM ohlcv
        WHERE symbol = ? AND interval = ? AND ts >= ? AND ts <= ?
        ORDER BY ts
      ),
      filtered AS (
        SELECT ts, ret FROM rets WHERE ret IS NOT NULL
      ),
      rolling AS (
        SELECT ts, ret,
               AVG(ret) OVER w AS roll_mean,
               STDDEV_SAMP(ret) OVER w AS roll_vol,
               COUNT(ret) OVER w AS roll_count
        FROM filtered
        WINDOW w AS (ORDER BY ts ROWS BETWEEN ? PRECEDING AND CURRENT ROW)
      )
      SELECT ts, ret, roll_mean, roll_vol, roll_count
      FROM rolling
      WHERE roll_count >= ?
      ORDER BY ts
    `, [symbol, interval, startDate.toISOString(), endDate.toISOString(),
        regimeWindow - 1, Math.min(regimeWindow, 5)]);

    if (rows.length === 0) return [];

    // Compute skewness and kurtosis in TypeScript (DuckDB aggregates are limited in OVER)
    // We already have rolling mean and vol from DuckDB; compute higher moments manually
    const allRets: { ts: Date; ret: number }[] = [];
    const retRows = await this.store.sql(`
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

    for (const r of retRows) {
      allRets.push({ ts: new Date(r.ts as string | Date), ret: r.ret as number });
    }

    const results: RegimeStatsEntry[] = [];
    for (let i = regimeWindow - 1; i < allRets.length; i++) {
      const windowRets = allRets.slice(i - regimeWindow + 1, i + 1).map(r => r.ret);
      const m = mean(windowRets);
      const vol = standardDeviation(windowRets);
      const n = windowRets.length;

      // Skewness
      let skew = 0;
      if (n >= 3 && vol > 0) {
        const m3 = windowRets.reduce((s, v) => s + ((v - m) / vol) ** 3, 0) / n;
        skew = m3;
      }

      // Kurtosis (excess)
      let kurt = 0;
      if (n >= 4 && vol > 0) {
        const m4 = windowRets.reduce((s, v) => s + ((v - m) / vol) ** 4, 0) / n;
        kurt = m4 - 3;
      }

      // Classify regime
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
}
