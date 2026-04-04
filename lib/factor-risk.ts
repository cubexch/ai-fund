/**
 * VaR decomposition, risk decomposition, and robust covariance estimation.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import { mean } from './math.js';
import {
  matVecMultiply,
  vecDot,
  sampleCov,
  zScoreForConfidence,
} from './matrix.js';

// ── Types ────────────────────────────────────────────────

export interface MarginalVaREntry {
  index: number;
  marginalVaR: number;
  componentVaR: number;
  pctContribution: number;
}

export interface IncrementalVaREntry {
  index: number;
  incrementalVaR: number;
  diversificationBenefit: number;
}

export interface ComponentVaRResult {
  portfolioVaR: number;
  components: Array<{
    index: number;
    componentVaR: number;
    pctContribution: number;
  }>;
}

export interface RiskDecompositionResult {
  totalRisk: number;
  systematicRisk: number;
  idiosyncraticRisk: number;
  diversificationRatio: number;
  riskContributions: number[];
  marginalRiskContributions: number[];
}

export interface CovarianceMatrixResult {
  matrix: number[][];
  symbols: string[];
  method: string;
}

// ── Public Functions ─────────────────────────────────────

/**
 * Marginal contribution to VaR per asset.
 * Marginal VaR = d(portfolioVaR) / d(weight_i).
 */
export function marginalVaR(
  weights: number[],
  covMatrix: number[][],
  portfolioVaR: number
): MarginalVaREntry[] {
  const covW = matVecMultiply(covMatrix, weights);
  const portVariance = vecDot(weights, covW);
  const portSigma = Math.sqrt(Math.max(0, portVariance));

  if (portSigma === 0) {
    return weights.map((_, i) => ({
      index: i,
      marginalVaR: 0,
      componentVaR: 0,
      pctContribution: 0,
    }));
  }

  // Scale factor: portfolioVaR = z * sigma * value, so z*value = portfolioVaR/sigma
  const scaleFactor = portfolioVaR / portSigma;

  return weights.map((w, i) => {
    const mVaR = (covW[i] / portSigma) * scaleFactor;
    const cVaR = w * mVaR;
    return {
      index: i,
      marginalVaR: mVaR,
      componentVaR: cVaR,
      pctContribution: portfolioVaR === 0 ? 0 : cVaR / portfolioVaR,
    };
  });
}

/**
 * Incremental VaR: change in portfolio VaR from adding/removing each position.
 */
export function incrementalVaR(
  weights: number[],
  covMatrix: number[][],
  confidenceLevel: number = 0.95
): IncrementalVaREntry[] {
  const z = zScoreForConfidence(confidenceLevel);

  // Full portfolio VaR
  const covW = matVecMultiply(covMatrix, weights);
  const fullVariance = vecDot(weights, covW);
  const fullVaR = z * Math.sqrt(Math.max(0, fullVariance));

  return weights.map((_, i) => {
    // Portfolio without asset i
    const reducedWeights = weights.map((w, j) => j === i ? 0 : w);
    const reducedCovW = matVecMultiply(covMatrix, reducedWeights);
    const reducedVariance = vecDot(reducedWeights, reducedCovW);
    const reducedVaR = z * Math.sqrt(Math.max(0, reducedVariance));

    const incVaR = fullVaR - reducedVaR;
    // Standalone VaR of position i
    const standaloneVaR = z * Math.abs(weights[i]) * Math.sqrt(Math.max(0, covMatrix[i][i]));

    return {
      index: i,
      incrementalVaR: incVaR,
      diversificationBenefit: standaloneVaR - incVaR,
    };
  });
}

/**
 * Component VaR: decompose portfolio VaR into per-asset contributions that sum to total.
 */
export function componentVaR(
  weights: number[],
  covMatrix: number[][],
  confidenceLevel: number = 0.95
): ComponentVaRResult {
  const z = zScoreForConfidence(confidenceLevel);
  const covW = matVecMultiply(covMatrix, weights);
  const portVariance = vecDot(weights, covW);
  const portSigma = Math.sqrt(Math.max(0, portVariance));
  const portfolioVaRVal = z * portSigma;

  if (portSigma === 0) {
    return {
      portfolioVaR: 0,
      components: weights.map((_, i) => ({
        index: i,
        componentVaR: 0,
        pctContribution: 0,
      })),
    };
  }

  const components = weights.map((w, i) => {
    const cVaR = z * w * covW[i] / portSigma;
    return {
      index: i,
      componentVaR: cVaR,
      pctContribution: portfolioVaRVal === 0 ? 0 : cVaR / portfolioVaRVal,
    };
  });

  return { portfolioVaR: portfolioVaRVal, components };
}

/**
 * Full risk decomposition: total, systematic, idiosyncratic, diversification ratio.
 */
export function riskDecomposition(
  weights: number[],
  covMatrix: number[][]
): RiskDecompositionResult {
  const n = weights.length;
  const covW = matVecMultiply(covMatrix, weights);
  const portVariance = vecDot(weights, covW);
  const totalRisk = Math.sqrt(Math.max(0, portVariance));

  // Individual asset volatilities
  const assetVols = covMatrix.map((row, i) => Math.sqrt(Math.max(0, row[i])));

  // Weighted sum of individual volatilities (undiversified risk)
  const undiversifiedRisk = weights.reduce((s, w, i) => s + Math.abs(w) * assetVols[i], 0);

  // Diversification ratio
  const diversificationRatio = totalRisk === 0 ? 1 : undiversifiedRisk / totalRisk;

  // Risk contributions: w_i * (Sigma * w)_i / sigma_p
  const riskContributions: number[] = weights.map((w, i) =>
    totalRisk === 0 ? 0 : w * covW[i] / totalRisk
  );

  // Marginal risk contributions: (Sigma * w)_i / sigma_p
  const marginalRiskContributions: number[] = covW.map(c =>
    totalRisk === 0 ? 0 : c / totalRisk
  );

  // Systematic risk: from cross-asset covariances
  // Idiosyncratic risk: from diagonal-only variance
  let diagonalVariance = 0;
  for (let i = 0; i < n; i++) {
    diagonalVariance += weights[i] * weights[i] * covMatrix[i][i];
  }
  const idiosyncraticRisk = Math.sqrt(Math.max(0, diagonalVariance));
  const systematicRisk = Math.sqrt(Math.max(0, portVariance - diagonalVariance));

  return {
    totalRisk,
    systematicRisk,
    idiosyncraticRisk,
    diversificationRatio,
    riskContributions,
    marginalRiskContributions,
  };
}

/**
 * Robust covariance estimation: sample, Ledoit-Wolf shrinkage, or exponential weighting.
 */
export function covarianceMatrix(
  returnsSeries: Record<string, number[]>,
  method: 'sample' | 'shrinkage' | 'exponential' = 'sample',
  params?: { shrinkageTarget?: 'identity' | 'constant_correlation'; halfLife?: number }
): CovarianceMatrixResult {
  const symbols = Object.keys(returnsSeries);
  const p = symbols.length;
  if (p === 0) return { matrix: [], symbols: [], method };

  const series = symbols.map(s => returnsSeries[s]);
  const n = Math.min(...series.map(s => s.length));
  if (n < 2) {
    return {
      matrix: Array.from({ length: p }, () => Array(p).fill(0)),
      symbols,
      method,
    };
  }

  // Center data
  const centered: number[][] = series.map(s => {
    const slice = s.slice(0, n);
    const m = mean(slice);
    return slice.map(v => v - m);
  });

  if (method === 'exponential') {
    const halfLife = params?.halfLife ?? 30;
    const lambda = Math.log(2) / halfLife;
    // Exponentially weighted covariance
    let totalWeight = 0;
    const cov: number[][] = Array.from({ length: p }, () => Array(p).fill(0));

    for (let t = 0; t < n; t++) {
      const w = Math.exp(-lambda * (n - 1 - t));
      totalWeight += w;
      for (let i = 0; i < p; i++) {
        for (let j = i; j < p; j++) {
          cov[i][j] += w * centered[i][t] * centered[j][t];
        }
      }
    }

    for (let i = 0; i < p; i++) {
      for (let j = i; j < p; j++) {
        const val = totalWeight > 0 ? cov[i][j] / totalWeight : 0;
        cov[i][j] = val;
        cov[j][i] = val;
      }
    }

    return { matrix: cov, symbols, method: 'exponential' };
  }

  // Sample covariance
  const S = sampleCov(centered, n);

  if (method === 'sample') {
    return { matrix: S, symbols, method: 'sample' };
  }

  // Ledoit-Wolf shrinkage
  const target = params?.shrinkageTarget ?? 'identity';
  let F: number[][];

  if (target === 'identity') {
    // Target = average variance * identity
    const avgVar = S.reduce((s, row, i) => s + row[i], 0) / p;
    F = Array.from({ length: p }, (_, i) => {
      const row = Array(p).fill(0);
      row[i] = avgVar;
      return row;
    });
  } else {
    // Constant correlation target
    const variances = S.map((row, i) => row[i]);
    let sumCorr = 0;
    let countCorr = 0;
    for (let i = 0; i < p; i++) {
      for (let j = i + 1; j < p; j++) {
        const si = Math.sqrt(variances[i]);
        const sj = Math.sqrt(variances[j]);
        if (si > 0 && sj > 0) {
          sumCorr += S[i][j] / (si * sj);
          countCorr++;
        }
      }
    }
    const avgCorr = countCorr > 0 ? sumCorr / countCorr : 0;
    F = Array.from({ length: p }, (_, i) => {
      return Array.from({ length: p }, (_, j) => {
        if (i === j) return variances[i];
        return avgCorr * Math.sqrt(variances[i]) * Math.sqrt(variances[j]);
      });
    });
  }

  // Compute optimal shrinkage intensity (Ledoit-Wolf formula)
  // Simplified: use Frobenius norm approach
  let sumPi = 0; // sum of asymptotic variances of s_ij scaled by n
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      let piij = 0;
      for (let t = 0; t < n; t++) {
        piij += (centered[i][t] * centered[j][t] - S[i][j]) ** 2;
      }
      piij /= n;
      sumPi += piij;
    }
  }

  let sumGamma = 0;
  for (let i = 0; i < p; i++) {
    for (let j = 0; j < p; j++) {
      sumGamma += (F[i][j] - S[i][j]) ** 2;
    }
  }

  const shrinkageIntensity = sumGamma === 0 ? 0 : Math.max(0, Math.min(1, sumPi / (n * sumGamma)));

  // Shrunk matrix = delta * F + (1 - delta) * S
  const matrix: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) =>
      shrinkageIntensity * F[i][j] + (1 - shrinkageIntensity) * S[i][j]
    )
  );

  return { matrix, symbols, method: `shrinkage(${target}, intensity=${shrinkageIntensity.toFixed(4)})` };
}
