/**
 * Factor analytics: factor returns from DB, covariance estimation, risk reports.
 * Extracted from AnalyticsStore for modularity.
 */

import type { MarketDataStore } from './datastore.js';
import { pcaFactors, componentVaR, covarianceMatrix, riskDecomposition } from './factor-model.js';
import { mean, standardDeviation } from './math.js';
import { getReturnsSeries } from './analytics-correlation.js';
import type {
  FactorReturnsParams, FactorReturnsResult,
  CovarianceParams, CovarianceResult,
  RiskReportParams,
} from './analytics-store.js';

/**
 * Build factor returns (market, SMB, momentum) from stored data.
 */
export async function factorReturnsFromDB(store: MarketDataStore, params: FactorReturnsParams): Promise<FactorReturnsResult> {
  const { interval, lookback, characteristics } = params;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

  const symbolRows = await store.sql(`
    SELECT DISTINCT symbol FROM ohlcv
    WHERE interval = ? AND ts >= ? AND ts <= ?
  `, [interval, startDate.toISOString(), endDate.toISOString()]);

  const symbols = symbolRows.map(r => r.symbol as string);
  if (symbols.length < 4) {
    return { market: [], smb: [], momentum: [], timestamps: [] };
  }

  const returnsSeries = await getReturnsSeries(store, {
    symbols,
    interval,
    start: startDate,
    end: endDate,
  });

  const lengths = Object.values(returnsSeries).map(s => s.length);
  const minLen = Math.min(...lengths);
  if (minLen < 2) {
    return { market: [], smb: [], momentum: [], timestamps: [] };
  }

  const aligned: Record<string, number[]> = {};
  for (const [sym, rets] of Object.entries(returnsSeries)) {
    aligned[sym] = rets.slice(rets.length - minLen);
  }
  const syms = Object.keys(aligned);

  const tsRows = await store.sql(`
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

  // SMB
  let sortedBySize: string[];
  if (characteristics) {
    sortedBySize = [...syms].sort((a, b) =>
      (characteristics[a]?.marketCap ?? 0) - (characteristics[b]?.marketCap ?? 0)
    );
  } else {
    const volRows = await store.sql(`
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

  // Momentum factor
  const momLookback = Math.min(20, Math.floor(minLen / 2));
  const momentum: number[] = [];
  for (let t = 0; t < minLen; t++) {
    if (t < momLookback) {
      momentum.push(0);
      continue;
    }
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

/**
 * Covariance matrix using DuckDB extraction + covarianceMatrix() from factor-model.
 */
export async function covarianceFromDB(store: MarketDataStore, params: CovarianceParams): Promise<CovarianceResult> {
  const { symbols, interval, lookback, method = 'sample', halfLife } = params;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

  const returnsSeries = await getReturnsSeries(store, {
    symbols,
    interval,
    start: startDate,
    end: endDate,
  });

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

/**
 * Full risk report using PCA, component VaR, and risk decomposition.
 */
export async function riskReport(store: MarketDataStore, params: RiskReportParams): Promise<{
  pca: { factors: Array<{ eigenvalue: number; varianceExplained: number; loadings: Record<string, number> }>; totalVarianceExplained: number };
  componentVaR: { portfolioVaR: number; components: Array<{ index: number; componentVaR: number; pctContribution: number }> };
  riskDecomposition: { totalRisk: number; systematicRisk: number; idiosyncraticRisk: number; diversificationRatio: number; riskContributions: number[]; marginalRiskContributions: number[] };
  covariance: { matrix: number[][]; symbols: string[] };
  perAsset: Array<{ symbol: string; annualizedVol: number; meanReturn: number; sharpe: number }>;
}> {
  const { symbols, interval, lookback = 90 } = params;

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - lookback * 24 * 60 * 60 * 1000);

  const returnsSeries = await getReturnsSeries(store, {
    symbols,
    interval,
    start: startDate,
    end: endDate,
  });

  const perAsset = symbols.map(s => {
    const rets = returnsSeries[s] ?? [];
    const vol = rets.length >= 2 ? standardDeviation(rets) * Math.sqrt(365) : 0;
    const avgRet = mean(rets);
    const sharpe = vol === 0 ? 0 : (avgRet * 365) / vol;
    return { symbol: s, annualizedVol: vol, meanReturn: avgRet, sharpe };
  });

  const pcaResult = pcaFactors(returnsSeries);
  const covResult = covarianceMatrix(returnsSeries);

  const n = symbols.length;
  const weights = n > 0 ? Array(n).fill(1 / n) : [];

  const orderedCov = reorderCovMatrix(covResult.matrix, covResult.symbols, symbols);

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
export function reorderCovMatrix(matrix: number[][], fromSymbols: string[], toSymbols: string[]): number[][] {
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
