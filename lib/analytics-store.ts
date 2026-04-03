/**
 * DuckDB-powered analytics engine for institutional-scale quantitative analysis.
 * Uses SQL for heavy lifting (rolling windows, cross-asset joins), then passes
 * results to pure function libs for final computation.
 */

import { MarketDataStore } from './datastore.js';
import { pcaFactors, componentVaR, covarianceMatrix, riskDecomposition } from './factor-model.js';
import { mean, standardDeviation, correlation, returns as computeReturns } from './math.js';

// ── Types ────────────────────────────────────────────────

export interface RollingCorrelationSnapshot {
  timestamp: Date;
  matrix: number[][];
  symbols: string[];
}

export interface CrossSectionalEntry {
  symbol: string;
  value: number;
  rank: number;
  percentile: number;
  quintile: number;
}

export interface FactorReturnsFromDB {
  market: number[];
  smb: number[];
  momentum: number[];
  timestamps: Date[];
}

export interface CovarianceFromDB {
  matrix: number[][];
  symbols: string[];
  method: string;
  dataPoints: number;
}

export interface RollingBetaEntry {
  timestamp: Date;
  beta: number;
  alpha: number;
  rSquared: number;
}

export interface RiskReportResult {
  symbols: string[];
  covMatrix: number[][];
  pcaFactors: Array<{ eigenvalue: number; varianceExplained: number; loadings: Record<string, number> }>;
  componentVaR: { portfolioVaR: number; components: Array<{ index: number; componentVaR: number; pctContribution: number }> };
  riskDecomp: {
    totalRisk: number;
    systematicRisk: number;
    idiosyncraticRisk: number;
    diversificationRatio: number;
  };
  dataPoints: number;
}

export interface ScreenResult {
  symbol: string;
  metrics: Record<string, number>;
}

export interface PairCorrelation {
  symbolA: string;
  symbolB: string;
  correlation: number;
}

export interface RegimeStatEntry {
  timestamp: Date;
  mean: number;
  volatility: number;
  skewness: number;
  kurtosis: number;
  regime: string;
}

// ── Analytics Store ──────────────────────────────────────

export class AnalyticsStore {
  constructor(private store: MarketDataStore) {}

  /**
   * Extract aligned return series for multiple assets via SQL.
   */
  async getReturnsSeries(params: {
    symbols: string[];
    interval: string;
    start?: Date;
    end?: Date;
    exchange?: string;
  }): Promise<Record<string, number[]>> {
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

    // Fetch close prices for all symbols
    const placeholders = symbols.map(() => '?').join(', ');
    conditions.push(`symbol IN (${placeholders})`);
    sqlParams.push(...symbols);

    const rows = await this.store.sql(
      `SELECT symbol, ts, close
       FROM ohlcv
       WHERE ${conditions.join(' AND ')}
       ORDER BY symbol, ts ASC`,
      sqlParams,
    );

    // Group by symbol
    const pricesBySymbol: Record<string, number[]> = {};
    for (const row of rows) {
      const sym = row.symbol as string;
      if (!pricesBySymbol[sym]) pricesBySymbol[sym] = [];
      pricesBySymbol[sym].push(row.close as number);
    }

    // Convert prices to returns
    const result: Record<string, number[]> = {};
    for (const [sym, prices] of Object.entries(pricesBySymbol)) {
      if (prices.length < 2) continue;
      result[sym] = computeReturns(prices);
    }

    return result;
  }

  /**
   * Compute rolling correlation matrices.
   */
  async rollingCorrelationMatrix(params: {
    symbols: string[];
    interval: string;
    window: number;
    step?: number;
  }): Promise<RollingCorrelationSnapshot[]> {
    const { symbols, interval, window, step = 1 } = params;
    const returnsSeries = await this.getReturnsSeries({ symbols, interval });

    const symList = symbols.filter(s => returnsSeries[s]?.length > 0);
    if (symList.length < 2) return [];

    const n = Math.min(...symList.map(s => returnsSeries[s].length));
    if (n < window) return [];

    const snapshots: RollingCorrelationSnapshot[] = [];

    for (let i = window - 1; i < n; i += step) {
      const matrix: number[][] = [];
      for (let a = 0; a < symList.length; a++) {
        const row: number[] = [];
        for (let b = 0; b < symList.length; b++) {
          if (a === b) {
            row.push(1);
          } else {
            const sliceA = returnsSeries[symList[a]].slice(i - window + 1, i + 1);
            const sliceB = returnsSeries[symList[b]].slice(i - window + 1, i + 1);
            row.push(correlation(sliceA, sliceB));
          }
        }
        matrix.push(row);
      }

      snapshots.push({
        timestamp: new Date(), // Would need timestamp mapping from DB
        matrix,
        symbols: symList,
      });
    }

    return snapshots;
  }

  /**
   * Cross-sectional ranking of all assets by a metric.
   */
  async crossSectionalSort(params: {
    metric: 'momentum' | 'volatility' | 'volume' | 'return';
    interval: string;
    lookback: number;
    date?: Date;
  }): Promise<CrossSectionalEntry[]> {
    const { metric, interval, lookback } = params;

    let sql: string;
    const sqlParams: unknown[] = [interval, lookback];

    switch (metric) {
      case 'momentum':
      case 'return':
        sql = `
          WITH ranked AS (
            SELECT symbol,
              (LAST(close ORDER BY ts) - FIRST(close ORDER BY ts)) / NULLIF(FIRST(close ORDER BY ts), 0) as value
            FROM ohlcv
            WHERE interval = ? AND ts >= (SELECT MAX(ts) - INTERVAL ? DAY FROM ohlcv WHERE interval = ?)
            GROUP BY symbol
            HAVING COUNT(*) >= 5
          )
          SELECT symbol, value FROM ranked ORDER BY value DESC
        `;
        sqlParams.push(interval);
        break;
      case 'volatility':
        sql = `
          WITH daily_rets AS (
            SELECT symbol, ts,
              (close - LAG(close) OVER (PARTITION BY symbol ORDER BY ts))
                / NULLIF(LAG(close) OVER (PARTITION BY symbol ORDER BY ts), 0) as ret
            FROM ohlcv
            WHERE interval = ? AND ts >= (SELECT MAX(ts) - INTERVAL ? DAY FROM ohlcv WHERE interval = ?)
          )
          SELECT symbol, STDDEV(ret) as value
          FROM daily_rets
          WHERE ret IS NOT NULL
          GROUP BY symbol
          HAVING COUNT(*) >= 5
          ORDER BY value DESC
        `;
        sqlParams.push(interval);
        break;
      case 'volume':
        sql = `
          SELECT symbol, AVG(volume) as value
          FROM ohlcv
          WHERE interval = ? AND ts >= (SELECT MAX(ts) - INTERVAL ? DAY FROM ohlcv WHERE interval = ?)
          GROUP BY symbol
          HAVING COUNT(*) >= 5
          ORDER BY value DESC
        `;
        sqlParams.push(interval);
        break;
      default:
        return [];
    }

    const rows = await this.store.sql(sql, sqlParams);
    const total = rows.length;

    return rows.map((row, idx) => ({
      symbol: row.symbol as string,
      value: (row.value as number) ?? 0,
      rank: idx + 1,
      percentile: total === 0 ? 0 : ((total - idx) / total) * 100,
      quintile: Math.min(5, Math.ceil(((idx + 1) / total) * 5)) as 1 | 2 | 3 | 4 | 5,
    }));
  }

  /**
   * Build factor return series from stored OHLCV data.
   */
  async factorReturnsFromDB(params: {
    interval: string;
    lookback: number;
    characteristics?: Record<string, { marketCap?: number; bookToMarket?: number }>;
  }): Promise<FactorReturnsFromDB> {
    const returnsSeries = await this.getReturnsSeries({
      symbols: [],  // Will need to fetch all
      interval: params.interval,
    });

    const symbols = Object.keys(returnsSeries);
    if (symbols.length < 4) {
      return { market: [], smb: [], momentum: [], timestamps: [] };
    }

    const n = Math.min(...symbols.map(s => returnsSeries[s].length));
    if (n < 2) return { market: [], smb: [], momentum: [], timestamps: [] };

    // Market factor: equal-weight average of all returns
    const market: number[] = [];
    for (let t = 0; t < n; t++) {
      const rets = symbols.map(s => returnsSeries[s][t]);
      market.push(mean(rets));
    }

    // SMB: sort by proxy (average volume * price → market cap proxy)
    // Use characteristics if provided, otherwise use return volatility as proxy
    const chars = params.characteristics ?? {};
    const symbolsBySize = [...symbols].sort((a, b) => {
      const capA = chars[a]?.marketCap ?? standardDeviation(returnsSeries[a]);
      const capB = chars[b]?.marketCap ?? standardDeviation(returnsSeries[b]);
      return capA - capB;
    });

    const smallN = Math.ceil(symbols.length / 3);
    const bigN = Math.floor(symbols.length * 2 / 3);
    const smalls = symbolsBySize.slice(0, smallN);
    const bigs = symbolsBySize.slice(bigN);

    const smb: number[] = [];
    for (let t = 0; t < n; t++) {
      const smallRet = mean(smalls.map(s => returnsSeries[s][t]));
      const bigRet = mean(bigs.map(s => returnsSeries[s][t]));
      smb.push(smallRet - bigRet);
    }

    // Momentum: cumulative returns over lookback, long winners short losers
    const momentum: number[] = [];
    const lookback = Math.min(params.lookback, n - 1);

    for (let t = 0; t < n; t++) {
      if (t < lookback) {
        momentum.push(0);
        continue;
      }
      // Rank by past cumulative return
      const ranked = symbols.map(s => ({
        sym: s,
        cumRet: returnsSeries[s].slice(t - lookback, t).reduce((a, b) => a + b, 0),
      })).sort((a, b) => b.cumRet - a.cumRet);

      const winN = Math.ceil(ranked.length / 3);
      const loseN = Math.floor(ranked.length * 2 / 3);
      const winners = ranked.slice(0, winN);
      const losers = ranked.slice(loseN);

      const winRet = mean(winners.map(w => returnsSeries[w.sym][t]));
      const loseRet = mean(losers.map(l => returnsSeries[l.sym][t]));
      momentum.push(winRet - loseRet);
    }

    return { market, smb, momentum, timestamps: [] };
  }

  /**
   * Compute covariance matrix from DB data using factor-model lib.
   */
  async covarianceFromDB(params: {
    symbols: string[];
    interval: string;
    lookback: number;
    method?: 'sample' | 'exponential';
    halfLife?: number;
  }): Promise<CovarianceFromDB> {
    const returnsSeries = await this.getReturnsSeries({
      symbols: params.symbols,
      interval: params.interval,
    });

    const validSymbols = params.symbols.filter(s => returnsSeries[s]?.length > 0);
    if (validSymbols.length === 0) {
      return { matrix: [], symbols: [], method: params.method ?? 'sample', dataPoints: 0 };
    }

    // Trim to lookback
    const trimmed: Record<string, number[]> = {};
    let minLen = Infinity;
    for (const s of validSymbols) {
      const rets = returnsSeries[s];
      trimmed[s] = rets.slice(Math.max(0, rets.length - params.lookback));
      minLen = Math.min(minLen, trimmed[s].length);
    }

    const method = params.method === 'exponential' ? 'exponential' : 'sample';
    const result = covarianceMatrix(trimmed, method, { halfLife: params.halfLife });

    return {
      matrix: result.matrix,
      symbols: result.symbols,
      method: result.method,
      dataPoints: minLen,
    };
  }

  /**
   * Rolling beta of asset vs benchmark.
   */
  async rollingBeta(params: {
    symbol: string;
    benchmark: string;
    interval: string;
    window: number;
  }): Promise<RollingBetaEntry[]> {
    const returnsSeries = await this.getReturnsSeries({
      symbols: [params.symbol, params.benchmark],
      interval: params.interval,
    });

    const assetRets = returnsSeries[params.symbol];
    const benchRets = returnsSeries[params.benchmark];
    if (!assetRets || !benchRets) return [];

    const n = Math.min(assetRets.length, benchRets.length);
    const { window } = params;
    if (n < window) return [];

    const results: RollingBetaEntry[] = [];

    for (let i = window - 1; i < n; i++) {
      const aSlice = assetRets.slice(i - window + 1, i + 1);
      const bSlice = benchRets.slice(i - window + 1, i + 1);

      const bMean = mean(bSlice);
      const aMean = mean(aSlice);

      let covAB = 0, varB = 0;
      for (let j = 0; j < window; j++) {
        const db = bSlice[j] - bMean;
        covAB += (aSlice[j] - aMean) * db;
        varB += db * db;
      }
      covAB /= (window - 1);
      varB /= (window - 1);

      const beta = varB === 0 ? 0 : covAB / varB;
      const alpha = aMean - beta * bMean;

      // R²
      let ssRes = 0, ssTot = 0;
      for (let j = 0; j < window; j++) {
        const pred = alpha + beta * bSlice[j];
        ssRes += (aSlice[j] - pred) ** 2;
        ssTot += (aSlice[j] - aMean) ** 2;
      }
      const rSquared = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

      results.push({ timestamp: new Date(), beta, alpha, rSquared });
    }

    return results;
  }

  /**
   * Comprehensive risk report using PCA, VaR, and risk decomposition.
   */
  async riskReport(params: {
    symbols: string[];
    interval: string;
    lookback?: number;
  }): Promise<RiskReportResult> {
    const lookback = params.lookback ?? 252;
    const returnsSeries = await this.getReturnsSeries({
      symbols: params.symbols,
      interval: params.interval,
    });

    const validSymbols = params.symbols.filter(s => returnsSeries[s]?.length > 0);
    if (validSymbols.length === 0) {
      return {
        symbols: [], covMatrix: [], pcaFactors: [],
        componentVaR: { portfolioVaR: 0, components: [] },
        riskDecomp: { totalRisk: 0, systematicRisk: 0, idiosyncraticRisk: 0, diversificationRatio: 1 },
        dataPoints: 0,
      };
    }

    // Trim and compute covariance
    const trimmed: Record<string, number[]> = {};
    let minLen = Infinity;
    for (const s of validSymbols) {
      const rets = returnsSeries[s];
      trimmed[s] = rets.slice(Math.max(0, rets.length - lookback));
      minLen = Math.min(minLen, trimmed[s].length);
    }

    const cov = covarianceMatrix(trimmed, 'shrinkage');
    const pca = pcaFactors(trimmed, Math.min(3, validSymbols.length));

    // Equal weight for VaR decomposition
    const n = validSymbols.length;
    const weights = Array(n).fill(1 / n);
    const cVaR = componentVaR(weights, cov.matrix, 0.95);
    const rDecomp = riskDecomposition(weights, cov.matrix);

    return {
      symbols: validSymbols,
      covMatrix: cov.matrix,
      pcaFactors: pca.factors,
      componentVaR: cVaR,
      riskDecomp: {
        totalRisk: rDecomp.totalRisk,
        systematicRisk: rDecomp.systematicRisk,
        idiosyncraticRisk: rDecomp.idiosyncraticRisk,
        diversificationRatio: rDecomp.diversificationRatio,
      },
      dataPoints: minLen,
    };
  }

  /**
   * Screen the stored universe using SQL-based filters.
   */
  async screenUniverse(params: {
    filters: Array<{
      metric: 'avg_volume' | 'volatility' | 'return' | 'sharpe';
      operator: '>' | '<' | '>=' | '<=';
      value: number;
      lookback: number;
    }>;
    interval: string;
    limit?: number;
  }): Promise<ScreenResult[]> {
    const { filters, interval, limit = 100 } = params;

    // Get all symbols first
    const allSymbols = await this.store.sql(
      'SELECT DISTINCT symbol FROM ohlcv WHERE interval = ?',
      [interval],
    );

    const results: ScreenResult[] = [];

    for (const row of allSymbols) {
      const symbol = row.symbol as string;
      const data = await this.store.sql(
        'SELECT close, volume FROM ohlcv WHERE symbol = ? AND interval = ? ORDER BY ts DESC LIMIT ?',
        [symbol, interval, Math.max(...filters.map(f => f.lookback))],
      );

      if (data.length < 5) continue;

      const closes = data.map(d => d.close as number).reverse();
      const volumes = data.map(d => d.volume as number).reverse();
      const rets = computeReturns(closes);

      const metrics: Record<string, number> = {
        avg_volume: mean(volumes),
        volatility: standardDeviation(rets),
        return: closes.length >= 2 ? (closes[closes.length - 1] / closes[0] - 1) : 0,
        sharpe: 0,
      };

      const vol = metrics.volatility;
      const avgRet = rets.length > 0 ? mean(rets) : 0;
      metrics.sharpe = vol === 0 ? 0 : (avgRet / vol) * Math.sqrt(252);

      // Apply filters
      let passes = true;
      for (const f of filters) {
        const val = metrics[f.metric] ?? 0;
        switch (f.operator) {
          case '>': if (!(val > f.value)) passes = false; break;
          case '<': if (!(val < f.value)) passes = false; break;
          case '>=': if (!(val >= f.value)) passes = false; break;
          case '<=': if (!(val <= f.value)) passes = false; break;
        }
      }

      if (passes) results.push({ symbol, metrics });
      if (results.length >= limit) break;
    }

    return results;
  }

  /**
   * All pairwise correlations.
   */
  async pairwiseCorrelations(params: {
    symbols?: string[];
    interval: string;
    lookback: number;
    minCorrelation?: number;
  }): Promise<PairCorrelation[]> {
    const symbols = params.symbols ?? (await this.store.sql(
      'SELECT DISTINCT symbol FROM ohlcv WHERE interval = ?',
      [params.interval],
    )).map(r => r.symbol as string);

    const returnsSeries = await this.getReturnsSeries({
      symbols,
      interval: params.interval,
    });

    const validSymbols = symbols.filter(s => returnsSeries[s]?.length > 0);
    const minCorr = params.minCorrelation ?? 0;
    const results: PairCorrelation[] = [];

    for (let i = 0; i < validSymbols.length; i++) {
      for (let j = i + 1; j < validSymbols.length; j++) {
        const a = returnsSeries[validSymbols[i]];
        const b = returnsSeries[validSymbols[j]];
        const n = Math.min(a.length, b.length, params.lookback);
        if (n < 5) continue;

        const corr = correlation(a.slice(-n), b.slice(-n));
        if (Math.abs(corr) >= minCorr) {
          results.push({ symbolA: validSymbols[i], symbolB: validSymbols[j], correlation: corr });
        }
      }
    }

    return results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  }

  /**
   * Rolling regime statistics.
   */
  async regimeStats(params: {
    symbol: string;
    interval: string;
    lookback: number;
    regimeWindow?: number;
  }): Promise<RegimeStatEntry[]> {
    const window = params.regimeWindow ?? 20;

    const rows = await this.store.sql(
      `SELECT ts, close FROM ohlcv
       WHERE symbol = ? AND interval = ?
       ORDER BY ts DESC LIMIT ?`,
      [params.symbol, params.interval, params.lookback + window],
    );

    if (rows.length < window + 1) return [];

    const closes = rows.map(r => r.close as number).reverse();
    const timestamps = rows.map(r => new Date(r.ts as string)).reverse();

    // Compute returns
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      rets.push(closes[i] / closes[i - 1] - 1);
    }

    const results: RegimeStatEntry[] = [];

    for (let i = window - 1; i < rets.length; i++) {
      const slice = rets.slice(i - window + 1, i + 1);
      const m = mean(slice);
      const vol = standardDeviation(slice);

      // Skewness
      const n = slice.length;
      let skew = 0;
      if (vol > 0 && n > 2) {
        const s3 = slice.reduce((s, r) => s + ((r - m) / vol) ** 3, 0);
        skew = (n / ((n - 1) * (n - 2))) * s3;
      }

      // Kurtosis
      let kurt = 0;
      if (vol > 0 && n > 3) {
        const s4 = slice.reduce((s, r) => s + ((r - m) / vol) ** 4, 0);
        kurt = ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * s4
          - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
      }

      // Classify regime
      let regime: string;
      const annVol = vol * Math.sqrt(252);
      if (annVol > 0.6) regime = 'crisis';
      else if (annVol > 0.3) regime = 'high_vol';
      else if (annVol < 0.1) regime = 'low_vol';
      else if (m > 0) regime = 'trending_up';
      else regime = 'trending_down';

      results.push({
        timestamp: timestamps[i + 1] ?? new Date(),
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
