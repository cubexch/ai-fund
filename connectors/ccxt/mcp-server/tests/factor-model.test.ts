import { describe, it, expect } from 'vitest';
import {
  pcaFactors,
  factorExposure,
  factorAttribution,
  marginalVaR,
  componentVaR,
  cryptoFactorModel,
  sectorExposure,
  riskDecomposition,
  covarianceMatrix,
  equityFactorModel,
  crossSectionalMomentum,
  computeFactorReturns,
  styleAnalysis,
  incrementalVaR,
} from '@ai-fund/lib/factor-model';

// ── Helper: generate correlated return series ─────────────

function generateReturns(n: number, drift: number = 0, vol: number = 0.01, seed: number = 42): number[] {
  // Simple LCG for deterministic pseudo-random
  let state = seed;
  const next = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return (state / 0x7fffffff - 0.5) * 2; };
  return Array.from({ length: n }, () => drift + vol * next());
}

// ── pcaFactors ────────────────────────────────────────────

describe('pcaFactors', () => {
  it('first factor explains most variance', () => {
    const n = 100;
    const market = generateReturns(n, 0, 0.02, 1);
    const result = pcaFactors({
      A: market.map((r, i) => r + generateReturns(n, 0, 0.005, 10)[i]),
      B: market.map((r, i) => r + generateReturns(n, 0, 0.005, 20)[i]),
      C: market.map((r, i) => r + generateReturns(n, 0, 0.005, 30)[i]),
    }, 3);
    expect(result.factors.length).toBeGreaterThanOrEqual(1);
    if (result.factors.length >= 2) {
      expect(result.factors[0].varianceExplained).toBeGreaterThan(result.factors[1].varianceExplained);
    }
  });

  it('empty input returns empty result', () => {
    const result = pcaFactors({});
    expect(result.factors).toHaveLength(0);
    expect(result.totalVarianceExplained).toBe(0);
  });

  it('single series returns one factor', () => {
    const result = pcaFactors({ A: generateReturns(50, 0, 0.01, 1) }, 1);
    expect(result.factors).toHaveLength(1);
    expect(result.factors[0].varianceExplained).toBeCloseTo(1, 0);
  });

  it('totalVarianceExplained is in [0, 1]', () => {
    const result = pcaFactors({
      A: generateReturns(50, 0, 0.02, 1),
      B: generateReturns(50, 0, 0.02, 2),
    }, 2);
    expect(result.totalVarianceExplained).toBeGreaterThanOrEqual(0);
    expect(result.totalVarianceExplained).toBeLessThanOrEqual(1.01); // tiny numerical tolerance
  });

  it('residual variance keys match input symbols', () => {
    const result = pcaFactors({
      X: generateReturns(30, 0, 0.01, 1),
      Y: generateReturns(30, 0, 0.01, 2),
    });
    expect(result.residualVariance).toHaveProperty('X');
    expect(result.residualVariance).toHaveProperty('Y');
  });
});

// ── factorExposure ────────────────────────────────────────

describe('factorExposure', () => {
  it('asset that IS the factor has beta ~1 and R^2 ~1', () => {
    const factor = generateReturns(100, 0, 0.02, 1);
    const result = factorExposure(factor, [factor]);
    expect(result.betas[0]).toBeCloseTo(1, 1);
    expect(result.rSquared).toBeCloseTo(1, 1);
    expect(result.alpha).toBeCloseTo(0, 3);
  });

  it('uncorrelated asset has low R^2', () => {
    const factor = generateReturns(100, 0, 0.02, 1);
    const unrelated = generateReturns(100, 0, 0.02, 999);
    const result = factorExposure(unrelated, [factor]);
    expect(result.rSquared).toBeLessThan(0.3);
  });

  it('empty inputs return defaults', () => {
    const result = factorExposure([], []);
    expect(result.betas).toHaveLength(0);
    expect(result.rSquared).toBe(0);
  });

  it('residualVol is non-negative', () => {
    const factor = generateReturns(50, 0, 0.02, 1);
    const asset = factor.map((r, i) => r * 0.8 + generateReturns(50, 0, 0.005, 5)[i]);
    const result = factorExposure(asset, [factor]);
    expect(result.residualVol).toBeGreaterThanOrEqual(0);
  });
});

// ── factorAttribution ─────────────────────────────────────

describe('factorAttribution', () => {
  it('contributions + specificReturn approximately equals totalReturn', () => {
    const n = 100;
    const market = generateReturns(n, 0.001, 0.02, 1);
    const portfolio = market.map((r, i) => r * 1.2 + generateReturns(n, 0.0005, 0.005, 5)[i]);
    const result = factorAttribution(portfolio, [market], ['market']);

    const factorTotal = result.factorContributions.reduce((s, fc) => s + fc.contribution, 0);
    expect(factorTotal + result.specificReturn).toBeCloseTo(result.totalReturn, 1);
  });

  it('factor names are preserved', () => {
    const n = 50;
    const f1 = generateReturns(n, 0, 0.01, 1);
    const f2 = generateReturns(n, 0, 0.01, 2);
    const port = f1.map((r, i) => r + f2[i]);
    const result = factorAttribution(port, [f1, f2], ['momentum', 'value']);
    expect(result.factorContributions.map(fc => fc.factor)).toEqual(['momentum', 'value']);
  });
});

// ── marginalVaR ───────────────────────────────────────────

describe('marginalVaR', () => {
  it('component VaRs sum to portfolio VaR', () => {
    const weights = [0.6, 0.4];
    const cov = [
      [0.04, 0.01],
      [0.01, 0.09],
    ];
    const portVaR = 100;
    const entries = marginalVaR(weights, cov, portVaR);
    const sumComponentVaR = entries.reduce((s, e) => s + e.componentVaR, 0);
    expect(sumComponentVaR).toBeCloseTo(portVaR, 1);
  });

  it('pctContribution sums to 1', () => {
    const weights = [0.5, 0.3, 0.2];
    const cov = [
      [0.04, 0.01, 0.005],
      [0.01, 0.09, 0.01],
      [0.005, 0.01, 0.16],
    ];
    const entries = marginalVaR(weights, cov, 50);
    const sumPct = entries.reduce((s, e) => s + e.pctContribution, 0);
    expect(sumPct).toBeCloseTo(1, 2);
  });

  it('zero weights give zero marginal VaR', () => {
    const weights = [0, 0];
    const cov = [[0.04, 0.01], [0.01, 0.09]];
    const entries = marginalVaR(weights, cov, 0);
    for (const e of entries) {
      expect(e.componentVaR).toBe(0);
    }
  });
});

// ── componentVaR ──────────────────────────────────────────

describe('componentVaR', () => {
  it('components sum to portfolioVaR', () => {
    const weights = [0.5, 0.3, 0.2];
    const cov = [
      [0.04, 0.01, 0.005],
      [0.01, 0.09, 0.01],
      [0.005, 0.01, 0.16],
    ];
    const result = componentVaR(weights, cov, 0.95);
    const sumComp = result.components.reduce((s, c) => s + c.componentVaR, 0);
    expect(sumComp).toBeCloseTo(result.portfolioVaR, 4);
  });

  it('pctContributions sum to 1', () => {
    const weights = [0.6, 0.4];
    const cov = [[0.04, 0.02], [0.02, 0.09]];
    const result = componentVaR(weights, cov);
    const sumPct = result.components.reduce((s, c) => s + c.pctContribution, 0);
    expect(sumPct).toBeCloseTo(1, 4);
  });

  it('zero covariance gives zero VaR', () => {
    const result = componentVaR([0.5, 0.5], [[0, 0], [0, 0]]);
    expect(result.portfolioVaR).toBe(0);
    for (const c of result.components) {
      expect(c.componentVaR).toBe(0);
    }
  });
});

// ── cryptoFactorModel ─────────────────────────────────────

describe('cryptoFactorModel', () => {
  it('BTC regressed on itself has btcBeta ~1', () => {
    const btc = generateReturns(100, 0, 0.03, 1);
    const eth = generateReturns(100, 0, 0.04, 2);
    const result = cryptoFactorModel(
      { BTC: btc },
      { btc, eth },
    );
    expect(result['BTC'].btcBeta).toBeCloseTo(1, 0);
    expect(result['BTC'].rSquared).toBeGreaterThan(0.8);
  });

  it('uncorrelated asset has low R^2', () => {
    const btc = generateReturns(100, 0, 0.03, 1);
    const eth = generateReturns(100, 0, 0.04, 2);
    const random = generateReturns(100, 0, 0.02, 999);
    const result = cryptoFactorModel(
      { RANDOM: random },
      { btc, eth },
    );
    expect(result['RANDOM'].rSquared).toBeLessThan(0.3);
  });

  it('handles multiple assets', () => {
    const btc = generateReturns(50, 0, 0.03, 1);
    const eth = generateReturns(50, 0, 0.04, 2);
    const result = cryptoFactorModel(
      {
        ALT1: btc.map((r, i) => r * 1.5 + generateReturns(50, 0, 0.01, 10)[i]),
        ALT2: eth.map((r, i) => r * 0.5 + generateReturns(50, 0, 0.01, 20)[i]),
      },
      { btc, eth },
    );
    expect(result).toHaveProperty('ALT1');
    expect(result).toHaveProperty('ALT2');
  });
});

// ── sectorExposure ────────────────────────────────────────

describe('sectorExposure', () => {
  it('herfindahl of equal sectors = 1/n', () => {
    const holdings = [
      { symbol: 'A', weight: 0.25, sector: 'Tech' },
      { symbol: 'B', weight: 0.25, sector: 'Finance' },
      { symbol: 'C', weight: 0.25, sector: 'Health' },
      { symbol: 'D', weight: 0.25, sector: 'Energy' },
    ];
    const result = sectorExposure(holdings, {});
    // HHI = 4 * (0.25^2) = 0.25 = 1/4
    expect(result.herfindahl).toBeCloseTo(0.25);
  });

  it('single sector has herfindahl = weight^2', () => {
    const holdings = [
      { symbol: 'A', weight: 0.5, sector: 'Tech' },
      { symbol: 'B', weight: 0.5, sector: 'Tech' },
    ];
    const result = sectorExposure(holdings, {});
    // total weight for Tech = 1.0, HHI = 1.0^2 = 1.0
    expect(result.herfindahl).toBeCloseTo(1.0);
    expect(result.concentration).toBeCloseTo(1.0);
  });

  it('sector contributions use returns', () => {
    const holdings = [
      { symbol: 'A', weight: 0.5, sector: 'Tech' },
      { symbol: 'B', weight: 0.5, sector: 'Finance' },
    ];
    const result = sectorExposure(holdings, {
      Tech: [0.01, 0.02, 0.03],
      Finance: [-0.01, -0.02, 0.01],
    });
    const techSector = result.sectors.find(s => s.sector === 'Tech')!;
    expect(techSector.contribution).toBeCloseTo(0.5 * (0.01 + 0.02 + 0.03));
  });
});

// ── riskDecomposition ─────────────────────────────────────

describe('riskDecomposition', () => {
  it('diversification ratio >= 1', () => {
    const weights = [0.5, 0.5];
    const cov = [
      [0.04, 0.01],
      [0.01, 0.09],
    ];
    const result = riskDecomposition(weights, cov);
    expect(result.diversificationRatio).toBeGreaterThanOrEqual(1);
  });

  it('risk contributions sum to total risk', () => {
    const weights = [0.4, 0.3, 0.3];
    const cov = [
      [0.04, 0.01, 0.005],
      [0.01, 0.09, 0.02],
      [0.005, 0.02, 0.16],
    ];
    const result = riskDecomposition(weights, cov);
    const sumRC = result.riskContributions.reduce((s, r) => s + r, 0);
    expect(sumRC).toBeCloseTo(result.totalRisk, 6);
  });

  it('total risk is non-negative', () => {
    const result = riskDecomposition([0.5, 0.5], [[0.04, 0.02], [0.02, 0.09]]);
    expect(result.totalRisk).toBeGreaterThanOrEqual(0);
    expect(result.systematicRisk).toBeGreaterThanOrEqual(0);
    expect(result.idiosyncraticRisk).toBeGreaterThanOrEqual(0);
  });

  it('single asset: diversification ratio = 1', () => {
    const result = riskDecomposition([1.0], [[0.04]]);
    expect(result.diversificationRatio).toBeCloseTo(1);
    expect(result.totalRisk).toBeCloseTo(0.2); // sqrt(0.04)
  });
});

// ── covarianceMatrix ──────────────────────────────────────

describe('covarianceMatrix', () => {
  const series = {
    A: generateReturns(100, 0, 0.02, 1),
    B: generateReturns(100, 0, 0.03, 2),
  };

  it('sample method produces symmetric matrix', () => {
    const result = covarianceMatrix(series, 'sample');
    expect(result.method).toBe('sample');
    expect(result.matrix[0][1]).toBeCloseTo(result.matrix[1][0]);
  });

  it('shrinkage method produces valid matrix', () => {
    const result = covarianceMatrix(series, 'shrinkage');
    expect(result.method).toContain('shrinkage');
    expect(result.matrix).toHaveLength(2);
    // Diagonal should be positive
    expect(result.matrix[0][0]).toBeGreaterThan(0);
    expect(result.matrix[1][1]).toBeGreaterThan(0);
    // Symmetric
    expect(result.matrix[0][1]).toBeCloseTo(result.matrix[1][0]);
  });

  it('exponential method produces valid matrix', () => {
    const result = covarianceMatrix(series, 'exponential');
    expect(result.method).toBe('exponential');
    expect(result.matrix[0][0]).toBeGreaterThan(0);
    expect(result.matrix[0][1]).toBeCloseTo(result.matrix[1][0]);
  });

  it('empty input returns empty matrix', () => {
    const result = covarianceMatrix({});
    expect(result.matrix).toHaveLength(0);
    expect(result.symbols).toHaveLength(0);
  });

  it('symbols match input keys', () => {
    const result = covarianceMatrix(series);
    expect(result.symbols).toEqual(['A', 'B']);
  });

  it('diagonal entries are non-negative (variances)', () => {
    const result = covarianceMatrix({
      X: generateReturns(50, 0, 0.01, 10),
      Y: generateReturns(50, 0, 0.02, 20),
      Z: generateReturns(50, 0, 0.03, 30),
    }, 'sample');
    for (let i = 0; i < result.matrix.length; i++) {
      expect(result.matrix[i][i]).toBeGreaterThanOrEqual(0);
    }
  });
});

// ── equityFactorModel ─────────────────────────────────────

describe('equityFactorModel', () => {
  it('market-only regression has marketBeta', () => {
    const market = generateReturns(100, 0.001, 0.02, 1);
    const stock = market.map((r, i) => r * 1.3 + generateReturns(100, 0, 0.005, 5)[i]);
    const result = equityFactorModel(
      { STOCK: stock },
      { market },
    );
    expect(result['STOCK'].marketBeta).toBeGreaterThan(0.5);
    expect(result['STOCK'].rSquared).toBeGreaterThan(0.3);
  });

  it('significantFactors is populated for strong relationships', () => {
    const market = generateReturns(200, 0, 0.02, 1);
    // Add tiny noise so regression is not degenerate but beta is clearly significant
    const stock = market.map((r, i) => r * 2 + generateReturns(200, 0, 0.001, 77)[i]);
    const result = equityFactorModel(
      { STOCK: stock },
      { market },
    );
    expect(result['STOCK'].marketBeta).toBeGreaterThan(1.5);
    expect(result['STOCK'].rSquared).toBeGreaterThan(0.9);
    expect(result['STOCK'].significantFactors).toContain('market');
  });

  it('multi-factor model includes optional betas', () => {
    const n = 100;
    const market = generateReturns(n, 0, 0.02, 1);
    const smb = generateReturns(n, 0, 0.01, 2);
    const hml = generateReturns(n, 0, 0.01, 3);
    const stock = market.map((r, i) => r + 0.5 * smb[i] + generateReturns(n, 0, 0.005, 5)[i]);
    const result = equityFactorModel(
      { STOCK: stock },
      { market, smb, hml },
    );
    expect(result['STOCK']).toHaveProperty('smbBeta');
    expect(result['STOCK']).toHaveProperty('hmlBeta');
  });

  it('handles insufficient data gracefully', () => {
    const result = equityFactorModel(
      { SHORT: [0.01, 0.02] },
      { market: [0.01, 0.02] },
    );
    expect(result['SHORT'].marketBeta).toBe(0);
    expect(result['SHORT'].rSquared).toBe(0);
  });
});

// ── crossSectionalMomentum ────────────────────────────────

describe('crossSectionalMomentum', () => {
  it('top quintile contains highest cumulative returns', () => {
    const returns: Record<string, number[]> = {};
    // Create 10 assets with different drifts; need enough data for lookback
    for (let i = 0; i < 10; i++) {
      returns[`A${i}`] = generateReturns(300, 0.001 * (i + 1), 0.01, i);
    }
    const result = crossSectionalMomentum(returns, { lookback: 252, skipRecent: 21 });

    // Top quintile (quintile 1) should have higher cumReturn than bottom (quintile 5)
    for (const sym of result.longPortfolio) {
      expect(result.scores[sym].quintile).toBe(1);
    }
    for (const sym of result.shortPortfolio) {
      expect(result.scores[sym].quintile).toBe(5);
    }
    expect(result.spread).toBeGreaterThan(0);
  });

  it('empty returns gives empty result', () => {
    const result = crossSectionalMomentum({});
    expect(result.longPortfolio).toHaveLength(0);
    expect(result.shortPortfolio).toHaveLength(0);
    expect(result.spread).toBe(0);
  });

  it('all scores have valid quintiles (1-5)', () => {
    const returns: Record<string, number[]> = {};
    for (let i = 0; i < 20; i++) {
      returns[`S${i}`] = generateReturns(300, 0, 0.01, i);
    }
    const result = crossSectionalMomentum(returns);
    for (const score of Object.values(result.scores)) {
      expect(score.quintile).toBeGreaterThanOrEqual(1);
      expect(score.quintile).toBeLessThanOrEqual(5);
    }
  });
});

// ── computeFactorReturns ──────────────────────────────────

describe('computeFactorReturns', () => {
  it('arrays are same length', () => {
    const returns: Record<string, number[]> = {
      A: generateReturns(50, 0, 0.01, 1),
      B: generateReturns(50, 0, 0.01, 2),
      C: generateReturns(50, 0, 0.01, 3),
      D: generateReturns(50, 0, 0.01, 4),
    };
    const chars: Record<string, { marketCap?: number; bookToMarket?: number }> = {
      A: { marketCap: 1e10, bookToMarket: 0.5 },
      B: { marketCap: 1e8, bookToMarket: 1.5 },
      C: { marketCap: 5e9, bookToMarket: 0.8 },
      D: { marketCap: 5e7, bookToMarket: 2.0 },
    };
    const market = generateReturns(50, 0.001, 0.02, 10);
    const result = computeFactorReturns(returns, chars, market);

    expect(result.market).toHaveLength(50);
    expect(result.smb).toHaveLength(50);
    expect(result.hml).toHaveLength(50);
    expect(result.rmw).toHaveLength(50);
    expect(result.cma).toHaveLength(50);
  });

  it('SMB and HML are populated (non-zero)', () => {
    const returns: Record<string, number[]> = {
      BIG: generateReturns(30, 0.002, 0.01, 1),
      SMALL: generateReturns(30, 0.005, 0.02, 2),
    };
    const chars = {
      BIG: { marketCap: 1e12, bookToMarket: 0.5 },
      SMALL: { marketCap: 1e6, bookToMarket: 2.0 },
    };
    const market = generateReturns(30, 0.001, 0.02, 10);
    const result = computeFactorReturns(returns, chars, market);

    // At least some non-zero entries
    const smbNonZero = result.smb.some(v => v !== 0);
    expect(smbNonZero).toBe(true);
    const hmlNonZero = result.hml.some(v => v !== 0);
    expect(hmlNonZero).toBe(true);
  });

  it('handles fewer than 2 assets gracefully', () => {
    const market = generateReturns(20, 0, 0.02, 1);
    const result = computeFactorReturns(
      { A: generateReturns(20, 0, 0.01, 1) },
      { A: { marketCap: 1e9 } },
      market,
    );
    // All factor series should be zeros
    expect(result.smb.every(v => v === 0)).toBe(true);
  });
});

// ── styleAnalysis ─────────────────────────────────────────

describe('styleAnalysis', () => {
  it('fund that IS a benchmark has high R^2 and dominant exposure', () => {
    const bench = generateReturns(200, 0.001, 0.02, 1);
    // Use unconstrained weights so the OLS regression picks up the exact match
    const result = styleAnalysis(bench, {
      Growth: bench,
      Value: generateReturns(200, 0, 0.02, 2),
    }, { constrainWeights: false });
    expect(result.rSquared).toBeGreaterThan(0.9);
    expect(result.dominantStyle).toBe('Growth');
    expect(result.exposures['Growth']).toBeGreaterThan(result.exposures['Value']);
  });

  it('empty inputs return defaults', () => {
    const result = styleAnalysis([], {});
    expect(result.rSquared).toBe(0);
    expect(result.dominantStyle).toBe('');
  });

  it('exposures are non-negative with constrained weights', () => {
    const fund = generateReturns(100, 0, 0.02, 1);
    const result = styleAnalysis(fund, {
      A: generateReturns(100, 0, 0.02, 2),
      B: generateReturns(100, 0, 0.02, 3),
    }, { constrainWeights: true });
    for (const v of Object.values(result.exposures)) {
      expect(v).toBeGreaterThanOrEqual(-0.001); // tiny tolerance
    }
  });

  it('tracking error is non-negative', () => {
    const fund = generateReturns(50, 0, 0.02, 1);
    const result = styleAnalysis(fund, {
      Bench: generateReturns(50, 0, 0.02, 2),
    });
    expect(result.trackingError).toBeGreaterThanOrEqual(0);
  });
});

// ── incrementalVaR ────────────────────────────────────────

describe('incrementalVaR', () => {
  it('diversification benefit is non-negative for correlated assets', () => {
    const cov = [
      [0.04, 0.01],
      [0.01, 0.09],
    ];
    const entries = incrementalVaR([0.5, 0.5], cov, 0.95);
    for (const e of entries) {
      expect(e.diversificationBenefit).toBeGreaterThanOrEqual(-0.001);
    }
  });

  it('incremental VaR reflects contribution to portfolio risk', () => {
    const cov = [
      [0.04, 0.0],
      [0.0, 0.09],
    ];
    const entries = incrementalVaR([0.5, 0.5], cov, 0.95);
    // Asset with higher variance should have higher incremental VaR
    expect(entries[1].incrementalVaR).toBeGreaterThan(entries[0].incrementalVaR);
  });
});
