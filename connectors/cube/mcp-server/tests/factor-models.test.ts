import { describe, it, expect } from 'vitest';
import {
  cryptoFactorModel, sectorExposure,
  equityFactorModel, crossSectionalMomentum,
} from '@ai-fund/lib/factor-models';

// ── Crypto Factor Model ────────────────────────────────────

describe('cryptoFactorModel', () => {
  const btc = [0.02, -0.01, 0.03, -0.02, 0.01, 0.04, -0.03, 0.02, -0.01, 0.03];
  const eth = [0.03, -0.015, 0.04, -0.025, 0.015, 0.05, -0.04, 0.025, -0.015, 0.035];

  it('computes BTC and ETH betas for each asset', () => {
    const returns = {
      SOL: btc.map((b, i) => 1.5 * b + 0.5 * eth[i] + 0.001),
    };
    const result = cryptoFactorModel(returns, { btc, eth });
    expect(result.SOL).toBeDefined();
    expect(result.SOL.btcBeta).not.toBe(0);
    expect(typeof result.SOL.ethBeta).toBe('number');
    expect(result.SOL.rSquared).toBeGreaterThan(0);
    expect(result.SOL.rSquared).toBeLessThanOrEqual(1);
  });

  it('returns zeros for insufficient data', () => {
    const result = cryptoFactorModel({ X: [0.01, 0.02] }, { btc: [0.01, 0.02], eth: [0.01, 0.02] });
    expect(result.X.btcBeta).toBe(0);
    expect(result.X.rSquared).toBe(0);
  });

  it('handles multiple assets', () => {
    const returns = {
      SOL: btc.map(b => 1.2 * b + 0.001),
      AVAX: btc.map(b => 0.8 * b - 0.001),
    };
    const result = cryptoFactorModel(returns, { btc, eth });
    expect(Object.keys(result)).toHaveLength(2);
    expect(result.SOL.btcBeta).toBeGreaterThan(result.AVAX.btcBeta);
  });

  it('idiosyncratic vol is non-negative', () => {
    const returns = { ALT: btc.map(b => b * 2 + 0.005) };
    const result = cryptoFactorModel(returns, { btc, eth });
    expect(result.ALT.idiosyncraticVol).toBeGreaterThanOrEqual(0);
  });
});

// ── Sector Exposure ────────────────────────────────────────

describe('sectorExposure', () => {
  it('computes sector weights correctly', () => {
    const holdings = [
      { symbol: 'AAPL', weight: 0.3, sector: 'tech' },
      { symbol: 'MSFT', weight: 0.2, sector: 'tech' },
      { symbol: 'JPM', weight: 0.5, sector: 'finance' },
    ];
    const sectorReturns = {
      tech: [0.01, 0.02],
      finance: [-0.01, 0.01],
    };
    const result = sectorExposure(holdings, sectorReturns);
    expect(result.sectors).toHaveLength(2);
    const tech = result.sectors.find(s => s.sector === 'tech')!;
    const finance = result.sectors.find(s => s.sector === 'finance')!;
    expect(tech.weight).toBeCloseTo(0.5);
    expect(finance.weight).toBeCloseTo(0.5);
  });

  it('concentration is max sector weight', () => {
    const holdings = [
      { symbol: 'A', weight: 0.8, sector: 'tech' },
      { symbol: 'B', weight: 0.2, sector: 'health' },
    ];
    const result = sectorExposure(holdings, {});
    expect(result.concentration).toBeCloseTo(0.8);
  });

  it('herfindahl index for equal weights', () => {
    const holdings = [
      { symbol: 'A', weight: 0.5, sector: 'tech' },
      { symbol: 'B', weight: 0.5, sector: 'health' },
    ];
    const result = sectorExposure(holdings, {});
    // HHI = 0.5^2 + 0.5^2 = 0.5
    expect(result.herfindahl).toBeCloseTo(0.5);
  });

  it('handles empty holdings', () => {
    const result = sectorExposure([], {});
    expect(result.sectors).toHaveLength(0);
    expect(result.concentration).toBe(0);
    expect(result.herfindahl).toBe(0);
  });
});

// ── Equity Factor Model ────────────────────────────────────

describe('equityFactorModel', () => {
  const market = [0.01, -0.02, 0.03, -0.01, 0.02, -0.03, 0.01, 0.02, -0.01, 0.03];

  it('computes market beta', () => {
    const returns = {
      AAPL: market.map(m => 1.2 * m + 0.001),
    };
    const result = equityFactorModel(returns, { market });
    expect(result.AAPL.marketBeta).toBeCloseTo(1.2, 1);
    expect(result.AAPL.rSquared).toBeGreaterThan(0.9);
  });

  it('identifies significant factors', () => {
    const smb = [0.005, -0.005, 0.01, -0.01, 0.005, -0.005, 0.01, -0.01, 0.005, -0.01];
    const returns = {
      SMALL: market.map((m, i) => m + 2 * smb[i]),
    };
    const result = equityFactorModel(returns, { market, smb });
    // Market should be significant
    expect(result.SMALL.significantFactors).toContain('market');
  });

  it('handles insufficient data', () => {
    const result = equityFactorModel({ X: [0.01, 0.02] }, { market: [0.01, 0.02] });
    expect(result.X.marketBeta).toBe(0);
    expect(result.X.rSquared).toBe(0);
  });

  it('idiosyncratic vol is non-negative', () => {
    const returns = { SPY: market.map(m => m + 0.001) };
    const result = equityFactorModel(returns, { market });
    expect(result.SPY.idiosyncraticVol).toBeGreaterThanOrEqual(0);
  });
});

// ── Cross-Sectional Momentum ───────────────────────────────

describe('crossSectionalMomentum', () => {
  it('ranks assets by cumulative return', () => {
    const returns = {
      WINNER: Array(100).fill(0.01),  // +100% cumulative
      LOSER: Array(100).fill(-0.005), // -50% cumulative
      FLAT: Array(100).fill(0),       // 0%
    };
    const result = crossSectionalMomentum(returns, { lookback: 50, skipRecent: 5 });
    expect(result.scores.WINNER.rank).toBe(1);
    expect(result.scores.LOSER.rank).toBe(3);
  });

  it('long portfolio is top quintile, short is bottom', () => {
    // 10 assets with clear ranking
    const returns: Record<string, number[]> = {};
    for (let i = 0; i < 10; i++) {
      returns[`S${i}`] = Array(100).fill((i - 5) * 0.001);
    }
    const result = crossSectionalMomentum(returns, { lookback: 50, skipRecent: 5 });
    // Top quintile should include highest-return assets
    expect(result.longPortfolio.length).toBeGreaterThan(0);
    expect(result.shortPortfolio.length).toBeGreaterThan(0);
    expect(result.spread).toBeGreaterThan(0);
  });

  it('returns empty for empty input', () => {
    const result = crossSectionalMomentum({});
    expect(result.longPortfolio).toHaveLength(0);
    expect(result.shortPortfolio).toHaveLength(0);
    expect(result.spread).toBe(0);
  });

  it('quintiles range from 1 to 5', () => {
    const returns: Record<string, number[]> = {};
    for (let i = 0; i < 20; i++) {
      returns[`S${i}`] = Array(100).fill((i - 10) * 0.002);
    }
    const result = crossSectionalMomentum(returns, { lookback: 50, skipRecent: 5 });
    for (const score of Object.values(result.scores)) {
      expect(score.quintile).toBeGreaterThanOrEqual(1);
      expect(score.quintile).toBeLessThanOrEqual(5);
    }
  });

  it('z-scores have mean ~0 across assets', () => {
    const returns: Record<string, number[]> = {};
    for (let i = 0; i < 10; i++) {
      returns[`S${i}`] = Array(100).fill((i - 5) * 0.001);
    }
    const result = crossSectionalMomentum(returns, { lookback: 50, skipRecent: 5 });
    const zScores = Object.values(result.scores).map(s => s.zScore);
    const meanZ = zScores.reduce((a, b) => a + b, 0) / zScores.length;
    expect(meanZ).toBeCloseTo(0, 5);
  });
});
