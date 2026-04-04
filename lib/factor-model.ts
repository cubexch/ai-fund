/**
 * Risk factor models and factor decomposition.
 * Barrel re-export — all public API lives in submodules:
 *   - factor-extraction.ts: PCA, factor exposure, attribution, style analysis
 *   - factor-risk.ts: VaR decomposition, risk decomposition, covariance estimation
 *   - factor-models.ts: crypto/equity factor models, sector exposure, momentum
 *   - matrix.ts: internal linear-algebra utilities
 */

// Factor extraction: PCA, regression, attribution, style analysis
export {
  pcaFactors,
  factorExposure,
  factorAttribution,
  computeFactorReturns,
  styleAnalysis,
} from './factor-extraction.js';

export type {
  PcaFactor,
  PcaResult,
  FactorExposureResult,
  FactorContribution,
  FactorAttributionResult,
  FactorReturnsSeries,
  StyleAnalysisResult,
} from './factor-extraction.js';

// Factor risk: VaR, risk decomposition, covariance
export {
  marginalVaR,
  incrementalVaR,
  componentVaR,
  riskDecomposition,
  covarianceMatrix,
} from './factor-risk.js';

export type {
  MarginalVaREntry,
  IncrementalVaREntry,
  ComponentVaRResult,
  RiskDecompositionResult,
  CovarianceMatrixResult,
} from './factor-risk.js';

// Factor models: crypto, equity, sector, momentum
export {
  cryptoFactorModel,
  sectorExposure,
  equityFactorModel,
  crossSectionalMomentum,
} from './factor-models.js';

export type {
  CryptoFactorEntry,
  SectorEntry,
  SectorExposureResult,
  EquityFactorEntry,
  MomentumScore,
  CrossSectionalMomentumResult,
} from './factor-models.js';
