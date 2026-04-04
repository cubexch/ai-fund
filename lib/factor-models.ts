/**
 * Crypto and equity multi-factor models, sector exposure, cross-sectional momentum.
 * Pure functions only — no async, no exchange clients, no MCP.
 */

import { mean, standardDeviation } from './math.js';
import { olsRegression } from './matrix.js';

// ── Types ────────────────────────────────────────────────

export interface CryptoFactorEntry {
  btcBeta: number;
  ethBeta: number;
  alpha: number;
  rSquared: number;
  idiosyncraticVol: number;
}

export interface SectorEntry {
  sector: string;
  weight: number;
  contribution: number;
}

export interface SectorExposureResult {
  sectors: SectorEntry[];
  concentration: number;
  herfindahl: number;
}

export interface EquityFactorEntry {
  marketBeta: number;
  smbBeta?: number;
  hmlBeta?: number;
  momentumBeta?: number;
  qualityBeta?: number;
  investmentBeta?: number;
  alpha: number;
  rSquared: number;
  idiosyncraticVol: number;
  significantFactors: string[];
}

export interface MomentumScore {
  cumulativeReturn: number;
  rank: number;
  quintile: 1 | 2 | 3 | 4 | 5;
  zScore: number;
}

export interface CrossSectionalMomentumResult {
  scores: Record<string, MomentumScore>;
  longPortfolio: string[];
  shortPortfolio: string[];
  spread: number;
}

// ── Public Functions ─────────────────────────────────────

/**
 * Crypto-specific two-factor model: BTC beta, orthogonalized ETH beta, and idiosyncratic.
 */
export function cryptoFactorModel(
  returns: Record<string, number[]>,
  benchmarks: { btc: number[]; eth: number[] }
): Record<string, CryptoFactorEntry> {
  const result: Record<string, CryptoFactorEntry> = {};

  // Orthogonalize ETH against BTC
  const n0 = Math.min(benchmarks.btc.length, benchmarks.eth.length);
  const btc = benchmarks.btc.slice(0, n0);
  const eth = benchmarks.eth.slice(0, n0);

  // Regress ETH on BTC to get residual (orthogonalized ETH factor)
  const ethOnBtc = olsRegression(eth, btc.map(b => [b]));
  const ethOrtho = ethOnBtc.residuals;

  for (const [symbol, assetRet] of Object.entries(returns)) {
    const n = Math.min(assetRet.length, btc.length, ethOrtho.length);
    if (n < 3) {
      result[symbol] = { btcBeta: 0, ethBeta: 0, alpha: 0, rSquared: 0, idiosyncraticVol: 0 };
      continue;
    }

    const y = assetRet.slice(0, n);
    const X: number[][] = Array.from({ length: n }, (_, i) => [btc[i], ethOrtho[i]]);
    const reg = olsRegression(y, X);

    result[symbol] = {
      btcBeta: reg.betas[0],
      ethBeta: reg.betas[1],
      alpha: reg.alpha,
      rSquared: Math.max(0, Math.min(1, reg.rSquared)),
      idiosyncraticVol: standardDeviation(reg.residuals),
    };
  }

  return result;
}

/**
 * Sector-level exposure and attribution.
 */
export function sectorExposure(
  holdings: Array<{ symbol: string; weight: number; sector: string }>,
  sectorReturns: Record<string, number[]>
): SectorExposureResult {
  // Aggregate weights by sector
  const sectorWeights: Record<string, number> = {};
  for (const h of holdings) {
    sectorWeights[h.sector] = (sectorWeights[h.sector] ?? 0) + h.weight;
  }

  const sectors: SectorEntry[] = Object.entries(sectorWeights).map(([sector, weight]) => {
    const rets = sectorReturns[sector];
    const contribution = rets && rets.length > 0
      ? weight * rets.reduce((s, r) => s + r, 0)
      : 0;
    return { sector, weight, contribution };
  });

  // Concentration: weight of the largest sector
  const concentration = sectors.length > 0
    ? Math.max(...sectors.map(s => Math.abs(s.weight)))
    : 0;

  // Herfindahl-Hirschman index
  const herfindahl = sectors.reduce((s, sec) => s + sec.weight * sec.weight, 0);

  return { sectors, concentration, herfindahl };
}

/**
 * Fama-French style multi-factor model for equities.
 * Regresses each asset's returns against provided factor returns.
 * Market factor is required; smb, hml, momentum, quality, investment are optional.
 */
export function equityFactorModel(
  returns: Record<string, number[]>,
  factors: {
    market: number[];
    smb?: number[];
    hml?: number[];
    momentum?: number[];
    quality?: number[];
    investment?: number[];
  }
): Record<string, EquityFactorEntry> {
  const result: Record<string, EquityFactorEntry> = {};

  // Build factor matrix and names from provided factors
  const factorNames: string[] = ['market'];
  const factorSeries: number[][] = [factors.market];

  if (factors.smb) { factorNames.push('smb'); factorSeries.push(factors.smb); }
  if (factors.hml) { factorNames.push('hml'); factorSeries.push(factors.hml); }
  if (factors.momentum) { factorNames.push('momentum'); factorSeries.push(factors.momentum); }
  if (factors.quality) { factorNames.push('quality'); factorSeries.push(factors.quality); }
  if (factors.investment) { factorNames.push('investment'); factorSeries.push(factors.investment); }

  const betaKeyMap: Record<string, keyof EquityFactorEntry> = {
    market: 'marketBeta',
    smb: 'smbBeta',
    hml: 'hmlBeta',
    momentum: 'momentumBeta',
    quality: 'qualityBeta',
    investment: 'investmentBeta',
  };

  for (const [symbol, assetRet] of Object.entries(returns)) {
    const n = Math.min(assetRet.length, ...factorSeries.map(f => f.length));
    if (n < 3) {
      result[symbol] = {
        marketBeta: 0,
        alpha: 0,
        rSquared: 0,
        idiosyncraticVol: 0,
        significantFactors: [],
      };
      continue;
    }

    const y = assetRet.slice(0, n);
    const X: number[][] = Array.from({ length: n }, (_, i) =>
      factorSeries.map(f => f[i])
    );

    const reg = olsRegression(y, X);

    const entry: EquityFactorEntry = {
      marketBeta: reg.betas[0],
      alpha: reg.alpha,
      rSquared: Math.max(0, Math.min(1, reg.rSquared)),
      idiosyncraticVol: standardDeviation(reg.residuals),
      significantFactors: [],
    };

    // Assign optional betas and determine significance
    for (let i = 0; i < factorNames.length; i++) {
      const key = betaKeyMap[factorNames[i]];
      if (key && key !== 'marketBeta') {
        (entry as unknown as Record<string, unknown>)[key] = reg.betas[i];
      }
      if (Math.abs(reg.tStats[i]) > 2) {
        entry.significantFactors.push(factorNames[i]);
      }
    }

    result[symbol] = entry;
  }

  return result;
}

/**
 * Cross-sectional momentum scores.
 * Computes cumulative return over lookback period (skipping recent days to avoid reversal).
 * Ranks assets into quintiles; long top quintile, short bottom quintile.
 */
export function crossSectionalMomentum(
  returns: Record<string, number[]>,
  params?: { lookback?: number; holdingPeriod?: number; skipRecent?: number }
): CrossSectionalMomentumResult {
  const lookback = params?.lookback ?? 252;
  const skipRecent = params?.skipRecent ?? 21;

  const symbols = Object.keys(returns);
  if (symbols.length === 0) {
    return { scores: {}, longPortfolio: [], shortPortfolio: [], spread: 0 };
  }

  // Compute cumulative return for each asset over the lookback window (excluding skipRecent)
  const cumReturns: Record<string, number> = {};
  for (const sym of symbols) {
    const r = returns[sym];
    const end = r.length - skipRecent;
    const start = Math.max(0, end - lookback);
    if (end <= start || end <= 0) {
      cumReturns[sym] = 0;
    } else {
      let cumRet = 1;
      for (let i = start; i < end; i++) {
        cumRet *= (1 + r[i]);
      }
      cumReturns[sym] = cumRet - 1;
    }
  }

  // Rank by cumulative return (descending)
  const sorted = [...symbols].sort((a, b) => cumReturns[b] - cumReturns[a]);

  // Compute z-scores
  const cumValues = symbols.map(s => cumReturns[s]);
  const cumMean = mean(cumValues);
  const cumStd = standardDeviation(cumValues);

  const scores: Record<string, MomentumScore> = {};
  const n = sorted.length;

  for (let i = 0; i < n; i++) {
    const sym = sorted[i];
    const rank = i + 1;
    const quintile = Math.min(5, Math.floor((i / n) * 5) + 1) as 1 | 2 | 3 | 4 | 5;
    const zScore = cumStd === 0 ? 0 : (cumReturns[sym] - cumMean) / cumStd;

    scores[sym] = {
      cumulativeReturn: cumReturns[sym],
      rank,
      quintile,
      zScore,
    };
  }

  // Long top quintile (quintile 1), short bottom quintile (quintile 5)
  const longPortfolio = sorted.filter(s => scores[s].quintile === 1);
  const shortPortfolio = sorted.filter(s => scores[s].quintile === 5);

  // Spread: average long return - average short return
  const longAvg = longPortfolio.length > 0
    ? mean(longPortfolio.map(s => cumReturns[s]))
    : 0;
  const shortAvg = shortPortfolio.length > 0
    ? mean(shortPortfolio.map(s => cumReturns[s]))
    : 0;
  const spread = longAvg - shortAvg;

  return { scores, longPortfolio, shortPortfolio, spread };
}
