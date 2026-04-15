/**
 * DuckDB-powered analytics engine for institutional-scale quantitative analysis.
 *
 * Uses DuckDB's analytical SQL for heavy lifting (rolling windows, cross-asset
 * joins, aggregations across hundreds of assets), then passes structured results
 * to pure function libs for factor decomposition and risk modeling.
 *
 * Implementation is split across submodules for maintainability:
 * - analytics-correlation.ts  — return series, rolling correlations, pairwise
 * - analytics-factor.ts       — factor returns, covariance, risk reports
 * - analytics-screening.ts    — cross-sectional sorts, screening, beta, regime
 *
 * This file re-exports all types and provides the AnalyticsStore class
 * for backward compatibility.
 */

import { MarketDataStore } from './datastore.js';

// Re-export submodule functions for direct use
export {
  getReturnsSeries,
  rollingCorrelationMatrix,
  pairwiseCorrelations,
} from './analytics-correlation.js';
export {
  factorReturnsFromDB,
  covarianceFromDB,
  riskReport,
  reorderCovMatrix,
} from './analytics-factor.js';
export {
  crossSectionalSort,
  formatCrossSectional,
  screenUniverse,
  rollingBeta,
  regimeStats,
} from './analytics-screening.js';

// Import for class delegation
import {
  getReturnsSeries as _getReturnsSeries,
  rollingCorrelationMatrix as _rollingCorrelationMatrix,
  pairwiseCorrelations as _pairwiseCorrelations,
} from './analytics-correlation.js';
import {
  factorReturnsFromDB as _factorReturnsFromDB,
  covarianceFromDB as _covarianceFromDB,
  riskReport as _riskReport,
  reorderCovMatrix as _reorderCovMatrix,
} from './analytics-factor.js';
import {
  crossSectionalSort as _crossSectionalSort,
  screenUniverse as _screenUniverse,
  rollingBeta as _rollingBeta,
  regimeStats as _regimeStats,
} from './analytics-screening.js';

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

  async getReturnsSeries(params: ReturnSeriesParams): Promise<Record<string, number[]>> {
    return _getReturnsSeries(this.store, params);
  }

  async rollingCorrelationMatrix(params: RollingCorrelationParams): Promise<RollingCorrelationEntry[]> {
    return _rollingCorrelationMatrix(this.store, params);
  }

  async crossSectionalSort(params: CrossSectionalParams): Promise<CrossSectionalEntry[]> {
    return _crossSectionalSort(this.store, params);
  }

  async factorReturnsFromDB(params: FactorReturnsParams): Promise<FactorReturnsResult> {
    return _factorReturnsFromDB(this.store, params);
  }

  async covarianceFromDB(params: CovarianceParams): Promise<CovarianceResult> {
    return _covarianceFromDB(this.store, params);
  }

  async rollingBeta(params: RollingBetaParams): Promise<RollingBetaEntry[]> {
    return _rollingBeta(this.store, params);
  }

  async riskReport(params: RiskReportParams): Promise<{
    pca: { factors: Array<{ eigenvalue: number; varianceExplained: number; loadings: Record<string, number> }>; totalVarianceExplained: number };
    componentVaR: { portfolioVaR: number; components: Array<{ index: number; componentVaR: number; pctContribution: number }> };
    riskDecomposition: { totalRisk: number; systematicRisk: number; idiosyncraticRisk: number; diversificationRatio: number; riskContributions: number[]; marginalRiskContributions: number[] };
    covariance: { matrix: number[][]; symbols: string[] };
    perAsset: Array<{ symbol: string; annualizedVol: number; meanReturn: number; sharpe: number }>;
  }> {
    return _riskReport(this.store, params);
  }

  async screenUniverse(params: ScreenParams): Promise<Array<{
    symbol: string;
    metrics: Record<string, number>;
  }>> {
    return _screenUniverse(this.store, params);
  }

  async pairwiseCorrelations(params: PairwiseCorrelationParams): Promise<PairwiseCorrelationEntry[]> {
    return _pairwiseCorrelations(this.store, params);
  }

  async regimeStats(params: RegimeStatsParams): Promise<RegimeStatsEntry[]> {
    return _regimeStats(this.store, params);
  }
}
