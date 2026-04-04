import { describe, it, expect } from 'vitest';
import {
  resolvePrice,
  computePortfolioExposure,
  checkPreTrade,
  simulateStressTest,
  checkConfidenceRails,
  SAFETY_PROFILES,
} from '@ai-fund/lib/portfolio-analytics';

// ── Helpers ───────────────────────────────────────────────

const tickers = [
  { symbol: 'BTC/USDT', last: 60000 },
  { symbol: 'ETH/USDT', last: 3000 },
  { symbol: 'SOL/USDT', last: 150 },
];

const balances = [
  { currency: 'BTC', total: 1, free: 0.5, used: 0.5 },
  { currency: 'ETH', total: 10, free: 5, used: 5 },
  { currency: 'USDT', total: 10000, free: 10000, used: 0 },
];

// ── resolvePrice ──────────────────────────────────────────

describe('resolvePrice', () => {
  it('returns 1 for USDT', () => {
    expect(resolvePrice('USDT', tickers)).toBe(1);
  });

  it('returns 1 for USD', () => {
    expect(resolvePrice('USD', tickers)).toBe(1);
  });

  it('returns 1 for USDC', () => {
    expect(resolvePrice('USDC', tickers)).toBe(1);
  });

  it('resolves BTC price from tickers', () => {
    expect(resolvePrice('BTC', tickers)).toBe(60000);
  });

  it('returns 0 for unknown currency', () => {
    expect(resolvePrice('DOGE', tickers)).toBe(0);
  });

  it('returns 0 when ticker has undefined last', () => {
    expect(resolvePrice('BTC', [{ symbol: 'BTC/USDT', last: undefined }])).toBe(0);
  });
});

// ── computePortfolioExposure ──────────────────────────────

describe('computePortfolioExposure', () => {
  it('computes total portfolio value', () => {
    const exp = computePortfolioExposure(balances, tickers);
    // BTC: 60000, ETH: 30000, USDT: 10000 = 100000
    expect(exp.totalValue).toBeCloseTo(100000);
  });

  it('computes position weights', () => {
    const exp = computePortfolioExposure(balances, tickers);
    const btcPos = exp.positions.find(p => p.currency === 'BTC');
    expect(btcPos?.weight).toBeCloseTo(60); // 60000/100000 * 100
  });

  it('sorts positions by value descending', () => {
    const exp = computePortfolioExposure(balances, tickers);
    expect(exp.positions[0].currency).toBe('BTC');
    expect(exp.positions[1].currency).toBe('ETH');
  });

  it('reports all long exposure when no shorts', () => {
    const exp = computePortfolioExposure(balances, tickers);
    expect(exp.longExposure).toBe(exp.grossExposure);
    expect(exp.shortExposure).toBe(0);
    expect(exp.longShortRatio).toBeNull();
  });

  it('skips zero balances', () => {
    const bals = [
      { currency: 'BTC', total: 0, free: 0, used: 0 },
      { currency: 'ETH', total: 5, free: 5, used: 0 },
    ];
    const exp = computePortfolioExposure(bals, tickers);
    expect(exp.numPositions).toBe(1);
  });

  it('handles empty balances', () => {
    const exp = computePortfolioExposure([], tickers);
    expect(exp.totalValue).toBe(0);
    expect(exp.numPositions).toBe(0);
  });
});

// ── checkPreTrade ─────────────────────────────────────────

describe('checkPreTrade', () => {
  it('returns GO when within limits', () => {
    const result = checkPreTrade(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 1, price: 3000 },
      { maxPositionPct: 10 },
    );
    expect(result.decision).toBe('GO');
    expect(result.checks.every(c => c.passed)).toBe(true);
  });

  it('returns NO_GO when position too large', () => {
    const result = checkPreTrade(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 100, price: 3000 },
      { maxPositionPct: 5 },
    );
    expect(result.decision).toBe('NO_GO');
    expect(result.checks.find(c => c.name === 'position_size')?.passed).toBe(false);
  });

  it('checks sufficient balance for buys', () => {
    const result = checkPreTrade(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 100, price: 3000 },
      { maxPositionPct: 100 },
    );
    // Order value 300000, available USDT 10000 → insufficient
    expect(result.checks.find(c => c.name === 'sufficient_balance')?.passed).toBe(false);
  });

  it('does not check balance for sells', () => {
    const result = checkPreTrade(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'sell', amount: 1, price: 3000 },
      { maxPositionPct: 100 },
    );
    expect(result.checks.find(c => c.name === 'sufficient_balance')).toBeUndefined();
  });

  it('computes order percentage correctly', () => {
    const result = checkPreTrade(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 1, price: 3000 },
      { maxPositionPct: 100 },
    );
    // Order: $3000, Portfolio: $100000 → 3%
    expect(result.orderPct).toBeCloseTo(3);
  });
});

// ── simulateStressTest ────────────────────────────────────

describe('simulateStressTest', () => {
  it('computes loss from crash scenario', () => {
    const result = simulateStressTest(
      balances,
      tickers,
      { BTC: -0.3, ETH: -0.4 }, // 30% BTC crash, 40% ETH crash
      25,
    );
    // BTC loss: 60000 * 0.3 = 18000, ETH loss: 30000 * 0.4 = 12000
    expect(result.totalLoss).toBeCloseTo(30000);
    expect(result.lossPct).toBeCloseTo(30);
  });

  it('marks survivable when loss within max drawdown', () => {
    const result = simulateStressTest(
      balances,
      tickers,
      { BTC: -0.05 },
      10,
    );
    expect(result.survivable).toBe(true);
  });

  it('marks not survivable when loss exceeds max drawdown', () => {
    const result = simulateStressTest(
      balances,
      tickers,
      { BTC: -0.5, ETH: -0.5 },
      10,
    );
    expect(result.survivable).toBe(false);
  });

  it('handles currencies not in changes (no impact)', () => {
    const result = simulateStressTest(
      balances,
      tickers,
      { BTC: -0.1 },
      50,
    );
    // Only BTC impacted, ETH and USDT unchanged
    expect(result.impacts).toHaveLength(1);
    expect(result.impacts[0].currency).toBe('BTC');
  });

  it('handles empty balances', () => {
    const result = simulateStressTest([], tickers, { BTC: -0.5 }, 10);
    expect(result.totalLoss).toBe(0);
    expect(result.survivable).toBe(true);
  });
});

// ── checkConfidenceRails ──────────────────────────────────

describe('checkConfidenceRails', () => {
  it('approves small order with safe profile', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 0.1, price: 3000 },
      'safe',
      { mode: 'paper' },
    );
    expect(result.decision).toBe('GO');
    expect(result.profile).toBe('safe');
  });

  it('blocks oversized position in safe mode', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 10, price: 3000 },
      'safe',
      { mode: 'paper' },
    );
    // 30000/100000 = 30%, safe max is 2%
    expect(result.decision).toBe('BLOCKED');
    const posRail = result.rails.find(r => r.name === 'position_size');
    expect(posRail?.passed).toBe(false);
    expect(posRail?.explanation).toContain('Reduce size');
  });

  it('blocks live trading in safe mode', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 0.01, price: 3000 },
      'safe',
      { mode: 'live' },
    );
    expect(result.decision).toBe('BLOCKED');
    const paperRail = result.rails.find(r => r.name === 'paper_mode');
    expect(paperRail?.passed).toBe(false);
  });

  it('allows live trading in moderate profile', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 0.1, price: 3000 },
      'moderate',
      { mode: 'live' },
    );
    // No paper_mode rail should appear for moderate profile
    expect(result.rails.find(r => r.name === 'paper_mode')).toBeUndefined();
  });

  it('blocks when daily loss limit exceeded', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 0.01, price: 3000 },
      'safe',
      { mode: 'paper', dailyPnlPct: -2 },
    );
    expect(result.decision).toBe('BLOCKED');
    const dailyRail = result.rails.find(r => r.name === 'daily_loss');
    expect(dailyRail?.passed).toBe(false);
    expect(dailyRail?.explanation).toContain('Stop trading');
  });

  it('warns on too many open orders', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 0.01, price: 3000 },
      'safe',
      { mode: 'paper', openOrderCount: 10 },
    );
    expect(result.decision).toBe('WARNING');
    const ordersRail = result.rails.find(r => r.name === 'open_orders');
    expect(ordersRail?.passed).toBe(false);
    expect(ordersRail?.severity).toBe('warn');
  });

  it('blocks excessive leverage', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 0.01, price: 3000 },
      'safe',
      { mode: 'paper', leverage: 5 },
    );
    expect(result.decision).toBe('BLOCKED');
    const levRail = result.rails.find(r => r.name === 'leverage');
    expect(levRail?.passed).toBe(false);
  });

  it('accepts custom safety profile', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'sell', amount: 5, price: 3000 },
      { maxPositionPct: 20, maxPortfolioDrawdownPct: 30, maxDailyLossPct: 10, requirePaperMode: false, maxOpenOrders: 100, maxLeverage: 20 },
      { mode: 'live' },
    );
    expect(result.profile).toBe('custom');
    expect(result.decision).toBe('GO');
  });

  it('provides human-readable explanations for all rails', () => {
    const result = checkConfidenceRails(
      balances,
      tickers,
      { symbol: 'ETH/USDT', side: 'buy', amount: 0.01, price: 3000 },
      'safe',
      { mode: 'paper', dailyPnlPct: 0.5, openOrderCount: 2, leverage: 1 },
    );
    for (const rail of result.rails) {
      expect(rail.explanation.length).toBeGreaterThan(10);
    }
  });

  it('safety profiles have correct defaults', () => {
    expect(SAFETY_PROFILES.safe.requirePaperMode).toBe(true);
    expect(SAFETY_PROFILES.safe.maxLeverage).toBe(1);
    expect(SAFETY_PROFILES.moderate.requirePaperMode).toBe(false);
    expect(SAFETY_PROFILES.aggressive.maxPositionPct).toBe(15);
  });
});
