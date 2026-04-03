import { describe, it, expect } from 'vitest';
import {
  predictFunding,
  fundingAnnualized,
  basisCurve,
  carryTrade,
  fundingArbitrage,
  fundingSentiment,
  cashAndCarry,
  fundingRateStats,
  rollYield,
  fundingHedgeCost,
} from '@ai-fund/lib/funding';

// ── predictFunding ──────────────────────────────────────────

describe('predictFunding', () => {
  it('returns zeros for empty rates', () => {
    const result = predictFunding([]);
    expect(result.predicted).toBe(0);
    expect(result.confidence).toBe(0);
    expect(result.upperBound).toBe(0);
    expect(result.lowerBound).toBe(0);
  });

  it('predicts using mean method', () => {
    const rates = [0.0001, 0.0002, 0.0003, 0.0004, 0.0005];
    const result = predictFunding(rates, { method: 'mean' });
    expect(result.method).toBe('mean');
    expect(result.predicted).toBeCloseTo(0.0003);
  });

  it('predicts using median method', () => {
    const rates = [0.0001, 0.0002, 0.0003, 0.0004, 0.0010];
    const result = predictFunding(rates, { method: 'median' });
    expect(result.method).toBe('median');
    expect(result.predicted).toBeCloseTo(0.0003);
  });

  it('defaults to ewma method', () => {
    const rates = [0.0001, 0.0002, 0.0003];
    const result = predictFunding(rates);
    expect(result.method).toBe('ewma');
    // EWMA weights recent values more, so predicted should be closer to 0.0003 than the mean
    expect(result.predicted).toBeGreaterThan(0.0002);
  });

  it('bounds contain predicted value', () => {
    const rates = [0.0001, 0.0002, 0.0003, 0.0002, 0.0001, 0.0003, 0.0002];
    const result = predictFunding(rates, { method: 'mean' });
    expect(result.predicted).toBeGreaterThanOrEqual(result.lowerBound);
    expect(result.predicted).toBeLessThanOrEqual(result.upperBound);
  });

  it('constant rates give confidence 1 and tight bounds', () => {
    const rates = [0.0001, 0.0001, 0.0001, 0.0001, 0.0001];
    const result = predictFunding(rates, { method: 'mean' });
    expect(result.predicted).toBeCloseTo(0.0001);
    expect(result.confidence).toBe(1);
    expect(result.upperBound).toBeCloseTo(0.0001);
    expect(result.lowerBound).toBeCloseTo(0.0001);
  });

  it('trending rates: ewma biases toward recent', () => {
    // Strongly trending upward
    const rates = [0.0001, 0.0001, 0.0001, 0.0005, 0.0005, 0.0005];
    const ewmaResult = predictFunding(rates, { method: 'ewma', halfLife: 2 });
    const meanResult = predictFunding(rates, { method: 'mean' });
    // EWMA with short half-life should be closer to the recent 0.0005 values
    expect(ewmaResult.predicted).toBeGreaterThan(meanResult.predicted);
  });

  it('lookback limits the window', () => {
    const rates = [0.001, 0.001, 0.001, 0.0001, 0.0001, 0.0001];
    const fullResult = predictFunding(rates, { method: 'mean' });
    const recentResult = predictFunding(rates, { method: 'mean', lookback: 3 });
    expect(recentResult.predicted).toBeCloseTo(0.0001);
    expect(fullResult.predicted).toBeGreaterThan(recentResult.predicted);
  });
});

// ── fundingAnnualized ───────────────────────────────────────

describe('fundingAnnualized', () => {
  it('annualizes 0.01% per 8h to ~10.95%', () => {
    const result = fundingAnnualized(0.0001); // 0.01% per period, 3 periods/day
    // daily = 0.0001 * 3 = 0.0003, annual = 0.0003 * 365 = 0.1095
    expect(result.annualizedRate).toBeCloseTo(0.1095);
    expect(result.dailyRate).toBeCloseTo(0.0003);
    expect(result.monthlyRate).toBeCloseTo(0.009);
  });

  it('handles custom periodsPerDay', () => {
    const result = fundingAnnualized(0.0001, 1); // 1 period per day
    expect(result.dailyRate).toBeCloseTo(0.0001);
    expect(result.annualizedRate).toBeCloseTo(0.0001 * 365);
  });

  it('zero rate gives all zeros', () => {
    const result = fundingAnnualized(0);
    expect(result.annualizedRate).toBe(0);
    expect(result.dailyRate).toBe(0);
    expect(result.monthlyRate).toBe(0);
  });

  it('negative rate annualizes correctly', () => {
    const result = fundingAnnualized(-0.0001);
    expect(result.annualizedRate).toBeCloseTo(-0.1095);
    expect(result.dailyRate).toBeLessThan(0);
  });
});

// ── basisCurve ──────────────────────────────────────────────

describe('basisCurve', () => {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  it('detects contango (futures above spot)', () => {
    const futures = [
      { symbol: 'BTC-0630', expiry: now + 30 * MS_PER_DAY, price: 101000 },
      { symbol: 'BTC-0930', expiry: now + 90 * MS_PER_DAY, price: 103000 },
    ];
    const result = basisCurve(futures, 100000);
    expect(result.contango).toBe(true);
    expect(result.backwardation).toBe(false);
    expect(result.curve).toHaveLength(2);
    expect(result.curve[0].basis).toBe(1000);
    expect(result.curve[1].basis).toBe(3000);
    expect(result.maxBasis).toBe(3000);
  });

  it('detects backwardation (futures below spot)', () => {
    const futures = [
      { symbol: 'BTC-0630', expiry: now + 30 * MS_PER_DAY, price: 99000 },
      { symbol: 'BTC-0930', expiry: now + 90 * MS_PER_DAY, price: 97000 },
    ];
    const result = basisCurve(futures, 100000);
    expect(result.contango).toBe(false);
    expect(result.backwardation).toBe(true);
    expect(result.curve[0].basis).toBe(-1000);
    expect(result.curve[1].basis).toBe(-3000);
  });

  it('single future works', () => {
    const futures = [
      { symbol: 'BTC-0630', expiry: now + 30 * MS_PER_DAY, price: 101000 },
    ];
    const result = basisCurve(futures, 100000);
    expect(result.curve).toHaveLength(1);
    expect(result.contango).toBe(true);
    expect(result.curve[0].basisPct).toBeCloseTo(0.01);
  });

  it('calculates annualized basis correctly', () => {
    const daysToExpiry = 30;
    const futures = [
      { symbol: 'BTC-0630', expiry: now + daysToExpiry * MS_PER_DAY, price: 101000 },
    ];
    const result = basisCurve(futures, 100000);
    const expectedBasisPct = 1000 / 100000;
    const expectedAnnualized = expectedBasisPct * (365 / daysToExpiry);
    expect(result.curve[0].annualizedBasis).toBeCloseTo(expectedAnnualized, 1);
  });

  it('sorts curve by expiry', () => {
    const futures = [
      { symbol: 'BTC-0930', expiry: now + 90 * MS_PER_DAY, price: 103000 },
      { symbol: 'BTC-0630', expiry: now + 30 * MS_PER_DAY, price: 101000 },
    ];
    const result = basisCurve(futures, 100000);
    expect(result.curve[0].symbol).toBe('BTC-0630');
    expect(result.curve[1].symbol).toBe('BTC-0930');
  });

  it('empty futures array gives no contango/backwardation', () => {
    const result = basisCurve([], 100000);
    expect(result.curve).toHaveLength(0);
    expect(result.contango).toBe(false);
    expect(result.backwardation).toBe(false);
    expect(result.maxBasis).toBe(0);
  });
});

// ── carryTrade ──────────────────────────────────────────────

describe('carryTrade', () => {
  it('positive carry: short futures above spot + positive funding', () => {
    const result = carryTrade({
      spotPrice: 100,
      futuresPrice: 102,
      fundingRate: 0.0001,
      daysToExpiry: 30,
      positionSize: 10,
    });
    // Basis = (102-100)*10 = 20
    expect(result.basisComponent).toBeCloseTo(20);
    // Funding = 0.0001 * 3 * 30 * 10 * 100 = 9
    expect(result.fundingComponent).toBeCloseTo(9);
    expect(result.expectedPnl).toBeGreaterThan(0);
    expect(result.annualizedReturn).toBeGreaterThan(0);
  });

  it('negative carry scenario', () => {
    const result = carryTrade({
      spotPrice: 100,
      futuresPrice: 98,
      fundingRate: -0.0001,
      daysToExpiry: 30,
      positionSize: 10,
    });
    // Basis component is negative (futures below spot)
    expect(result.basisComponent).toBeLessThan(0);
    expect(result.fundingComponent).toBeLessThan(0);
    expect(result.expectedPnl).toBeLessThan(0);
  });

  it('zero funding isolates basis component', () => {
    const result = carryTrade({
      spotPrice: 100,
      futuresPrice: 105,
      fundingRate: 0,
      daysToExpiry: 30,
      positionSize: 10,
    });
    expect(result.fundingComponent).toBe(0);
    expect(result.basisComponent).toBeCloseTo(50);
    expect(result.expectedPnl).toBeCloseTo(50);
  });

  it('accounts for borrow rate', () => {
    const noBorrow = carryTrade({
      spotPrice: 100,
      futuresPrice: 105,
      fundingRate: 0.0001,
      daysToExpiry: 30,
      borrowRate: 0,
      positionSize: 10,
    });
    const withBorrow = carryTrade({
      spotPrice: 100,
      futuresPrice: 105,
      fundingRate: 0.0001,
      daysToExpiry: 30,
      borrowRate: 0.05,
      positionSize: 10,
    });
    expect(withBorrow.costOfCarry).toBeGreaterThan(0);
    expect(withBorrow.expectedPnl).toBeLessThan(noBorrow.expectedPnl);
  });
});

// ── fundingArbitrage ────────────────────────────────────────

describe('fundingArbitrage', () => {
  it('finds opportunity with opposite rates', () => {
    const venues = [
      { venue: 'exchange_a', fundingRate: -0.001, nextFundingTime: 0, price: 100, fees: { maker: 0.0001, taker: 0.0002 } },
      { venue: 'exchange_b', fundingRate: 0.001, nextFundingTime: 0, price: 100, fees: { maker: 0.0001, taker: 0.0002 } },
    ];
    const result = fundingArbitrage(venues);
    expect(result.opportunities.length).toBeGreaterThan(0);
    expect(result.bestOpportunity).not.toBeNull();
    // Long on exchange_a (negative funding = receive payment), short on exchange_b (positive = receive)
    expect(result.bestOpportunity!.longVenue).toBe('exchange_a');
    expect(result.bestOpportunity!.shortVenue).toBe('exchange_b');
    expect(result.bestOpportunity!.spread).toBeCloseTo(0.002);
  });

  it('same rates produce no opportunities', () => {
    const venues = [
      { venue: 'exchange_a', fundingRate: 0.0001, nextFundingTime: 0, price: 100, fees: { maker: 0, taker: 0 } },
      { venue: 'exchange_b', fundingRate: 0.0001, nextFundingTime: 0, price: 100, fees: { maker: 0, taker: 0 } },
    ];
    const result = fundingArbitrage(venues);
    expect(result.opportunities).toHaveLength(0);
    expect(result.bestOpportunity).toBeNull();
  });

  it('net after fees accounts for taker fees', () => {
    const venues = [
      { venue: 'a', fundingRate: -0.001, nextFundingTime: 0, price: 100, fees: { maker: 0, taker: 0.0005 } },
      { venue: 'b', fundingRate: 0.001, nextFundingTime: 0, price: 100, fees: { maker: 0, taker: 0.0003 } },
    ];
    const result = fundingArbitrage(venues);
    const best = result.bestOpportunity!;
    // spread = 0.002, totalFees = 0.0005 + 0.0003 = 0.0008, net = 0.0012
    expect(best.netAfterFees).toBeCloseTo(0.002 - 0.0008);
  });

  it('single venue returns no opportunities', () => {
    const venues = [
      { venue: 'a', fundingRate: 0.001, nextFundingTime: 0, price: 100, fees: { maker: 0, taker: 0 } },
    ];
    const result = fundingArbitrage(venues);
    expect(result.opportunities).toHaveLength(0);
    expect(result.bestOpportunity).toBeNull();
  });

  it('annualized spread calculation', () => {
    const venues = [
      { venue: 'a', fundingRate: -0.0005, nextFundingTime: 0, price: 100, fees: { maker: 0, taker: 0 } },
      { venue: 'b', fundingRate: 0.0005, nextFundingTime: 0, price: 100, fees: { maker: 0, taker: 0 } },
    ];
    const result = fundingArbitrage(venues);
    const best = result.bestOpportunity!;
    // annualized = spread * 3 * 365
    expect(best.annualizedSpread).toBeCloseTo(0.001 * 3 * 365);
  });
});

// ── fundingSentiment ────────────────────────────────────────

describe('fundingSentiment', () => {
  it('extreme positive rates = crowded_long', () => {
    // Create a distribution where the last value is far above mean
    const rates = [0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.0001, 0.001];
    const result = fundingSentiment(rates);
    expect(result.sentiment).toBe('crowded_long');
    expect(result.zScore).toBeGreaterThan(1.5);
  });

  it('extreme negative rates = crowded_short', () => {
    const rates = [-0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.0001, -0.001];
    const result = fundingSentiment(rates);
    expect(result.sentiment).toBe('crowded_short');
    expect(result.zScore).toBeLessThan(-1.5);
  });

  it('neutral range for moderate rates', () => {
    const rates = [0.0001, 0.0002, 0.0001, 0.0002, 0.0001, 0.0002, 0.0001, 0.0002, 0.0001, 0.00015];
    const result = fundingSentiment(rates);
    expect(result.sentiment).toBe('neutral');
  });

  it('empty rates returns neutral defaults', () => {
    const result = fundingSentiment([]);
    expect(result.sentiment).toBe('neutral');
    expect(result.extremeLevel).toBe(0);
    expect(result.percentile).toBe(0.5);
    expect(result.zScore).toBe(0);
    expect(result.meanRevertSignal).toBe(false);
  });

  it('mean revert signal triggers at z > 2', () => {
    // Very extreme last value
    const rates = Array(20).fill(0.0001);
    rates.push(0.005); // huge spike
    const result = fundingSentiment(rates);
    expect(result.meanRevertSignal).toBe(true);
  });

  it('lookback limits the window', () => {
    // Old rates are extreme, recent rates are mild
    const oldRates = Array(20).fill(0.005);
    const recentRates = [0.0001, 0.0001, 0.0001, 0.0001, 0.0001];
    const rates = [...oldRates, ...recentRates];
    const result = fundingSentiment(rates, { lookback: 5 });
    // With only recent mild rates, last value should be neutral
    expect(result.sentiment).toBe('neutral');
  });
});

// ── cashAndCarry ────────────────────────────────────────────

describe('cashAndCarry', () => {
  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  it('gross profit = futures - spot times position size', () => {
    const result = cashAndCarry({
      spotPrice: 100,
      futuresPrice: 105,
      expiry: now + 30 * MS_PER_DAY,
      borrowRate: 0,
      positionSize: 10,
      spotFee: 0,
      futuresFee: 0,
    });
    expect(result.grossProfit).toBeCloseTo(50); // (105-100)*10
  });

  it('net accounts for fees', () => {
    const result = cashAndCarry({
      spotPrice: 100,
      futuresPrice: 105,
      expiry: now + 30 * MS_PER_DAY,
      borrowRate: 0,
      positionSize: 10,
      spotFee: 0.001,
      futuresFee: 0.001,
    });
    // spotFees = 100*10*0.001 = 1, futuresFees = 105*10*0.001 = 1.05
    expect(result.grossProfit).toBeCloseTo(50);
    expect(result.netProfit).toBeCloseTo(50 - 1 - 1.05);
  });

  it('borrow cost reduces net profit', () => {
    const noBarrow = cashAndCarry({
      spotPrice: 100,
      futuresPrice: 105,
      expiry: now + 365 * MS_PER_DAY,
      borrowRate: 0,
      positionSize: 10,
      spotFee: 0,
      futuresFee: 0,
    });
    const withBorrow = cashAndCarry({
      spotPrice: 100,
      futuresPrice: 105,
      expiry: now + 365 * MS_PER_DAY,
      borrowRate: 0.05,
      positionSize: 10,
      spotFee: 0,
      futuresFee: 0,
    });
    expect(withBorrow.netProfit).toBeLessThan(noBarrow.netProfit);
    // borrow cost = 100*10*0.05*1 = 50 for 1 year
    expect(noBarrow.netProfit - withBorrow.netProfit).toBeCloseTo(50, 0);
  });

  it('annualized return math', () => {
    const daysToExpiry = 30;
    const result = cashAndCarry({
      spotPrice: 100,
      futuresPrice: 105,
      expiry: now + daysToExpiry * MS_PER_DAY,
      borrowRate: 0,
      positionSize: 10,
      spotFee: 0,
      futuresFee: 0,
    });
    const notional = 100 * 10;
    const yearFraction = daysToExpiry / 365;
    const expectedAnnualized = (result.netProfit / notional) / yearFraction;
    expect(result.annualizedReturn).toBeCloseTo(expectedAnnualized, 1);
  });
});

// ── fundingRateStats ────────────────────────────────────────

describe('fundingRateStats', () => {
  it('empty array returns zeros', () => {
    const result = fundingRateStats([]);
    expect(result.mean).toBe(0);
    expect(result.median).toBe(0);
    expect(result.std).toBe(0);
    expect(result.positiveRatio).toBe(0);
    expect(result.streaks.longestPositive).toBe(0);
    expect(result.streaks.longestNegative).toBe(0);
  });

  it('mean matches manual calculation', () => {
    const rates = [0.0001, 0.0002, 0.0003, 0.0004, 0.0005];
    const result = fundingRateStats(rates);
    expect(result.mean).toBeCloseTo(0.0003);
  });

  it('positiveRatio correct', () => {
    const rates = [0.001, 0.001, -0.001, 0.001, -0.001];
    const result = fundingRateStats(rates);
    expect(result.positiveRatio).toBeCloseTo(0.6); // 3 positive out of 5
  });

  it('streaks calculation', () => {
    const rates = [0.001, 0.001, 0.001, -0.001, -0.001, 0.001];
    const result = fundingRateStats(rates);
    expect(result.streaks.longestPositive).toBe(3);
    expect(result.streaks.longestNegative).toBe(2);
    expect(result.streaks.current.direction).toBe('positive');
    expect(result.streaks.current.length).toBe(1);
  });

  it('min and max', () => {
    const rates = [-0.005, 0.001, 0.003, -0.002, 0.01];
    const result = fundingRateStats(rates);
    expect(result.min).toBe(-0.005);
    expect(result.max).toBe(0.01);
  });

  it('annualized mean uses 3 periods/day * 365', () => {
    const rates = [0.0001, 0.0001, 0.0001];
    const result = fundingRateStats(rates);
    expect(result.annualizedMean).toBeCloseTo(0.0001 * 3 * 365);
  });

  it('single element', () => {
    const result = fundingRateStats([0.0005]);
    expect(result.mean).toBeCloseTo(0.0005);
    expect(result.median).toBeCloseTo(0.0005);
    expect(result.positiveRatio).toBe(1);
    expect(result.streaks.longestPositive).toBe(1);
    expect(result.streaks.current.length).toBe(1);
  });
});

// ── rollYield ───────────────────────────────────────────────

describe('rollYield', () => {
  const MS_PER_DAY = 86_400_000;
  const now = Date.now();

  it('contango has positive roll yield', () => {
    const result = rollYield(100, 105, now, now + 90 * MS_PER_DAY);
    expect(result.direction).toBe('contango');
    expect(result.rollYield).toBeGreaterThan(0);
    expect(result.spread).toBe(5);
    expect(result.spreadPct).toBeCloseTo(0.05);
  });

  it('backwardation has negative roll yield', () => {
    const result = rollYield(105, 100, now, now + 90 * MS_PER_DAY);
    expect(result.direction).toBe('backwardation');
    expect(result.rollYield).toBeLessThan(0);
    expect(result.spread).toBe(-5);
  });

  it('annualized roll yield math', () => {
    const daysBetween = 90;
    const result = rollYield(100, 105, now, now + daysBetween * MS_PER_DAY);
    const expectedAnnualized = 0.05 * (365 / daysBetween);
    expect(result.annualizedRollYield).toBeCloseTo(expectedAnnualized);
  });

  it('zero spread gives contango with zero yield', () => {
    const result = rollYield(100, 100, now, now + 30 * MS_PER_DAY);
    expect(result.direction).toBe('contango');
    expect(result.rollYield).toBe(0);
    expect(result.spread).toBe(0);
  });

  it('zero front price gives zero spreadPct', () => {
    const result = rollYield(0, 100, now, now + 30 * MS_PER_DAY);
    expect(result.spreadPct).toBe(0);
    expect(result.rollYield).toBe(0);
  });
});

// ── fundingHedgeCost ────────────────────────────────────────

describe('fundingHedgeCost', () => {
  it('cost scales with position size', () => {
    const small = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 1000,
      leverage: 1,
      duration: 30,
    });
    const large = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 10000,
      leverage: 1,
      duration: 30,
    });
    expect(large.totalCost).toBeCloseTo(small.totalCost * 10);
  });

  it('cost scales with duration', () => {
    const short = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 1000,
      leverage: 1,
      duration: 10,
    });
    const long = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 1000,
      leverage: 1,
      duration: 30,
    });
    expect(long.totalCost).toBeCloseTo(short.totalCost * 3);
  });

  it('zero rate = zero cost', () => {
    const result = fundingHedgeCost({
      fundingRate: 0,
      positionSize: 10000,
      leverage: 2,
      duration: 30,
    });
    expect(result.totalCost).toBe(0);
    expect(result.dailyCost).toBe(0);
    expect(result.breakevenMove).toBe(0);
  });

  it('leverage multiplies notional', () => {
    const noLev = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 1000,
      leverage: 1,
      duration: 30,
    });
    const withLev = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 1000,
      leverage: 5,
      duration: 30,
    });
    expect(withLev.totalCost).toBeCloseTo(noLev.totalCost * 5);
  });

  it('daily cost matches total / duration', () => {
    const result = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 10000,
      leverage: 2,
      duration: 30,
    });
    expect(result.totalCost).toBeCloseTo(result.dailyCost * 30);
  });

  it('custom periodsPerDay', () => {
    const default3 = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 1000,
      leverage: 1,
      duration: 1,
    });
    const custom1 = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 1000,
      leverage: 1,
      duration: 1,
      periodsPerDay: 1,
    });
    expect(default3.totalCost).toBeCloseTo(custom1.totalCost * 3);
  });

  it('negative funding rate uses absolute value for cost', () => {
    const positive = fundingHedgeCost({
      fundingRate: 0.0001,
      positionSize: 1000,
      leverage: 1,
      duration: 30,
    });
    const negative = fundingHedgeCost({
      fundingRate: -0.0001,
      positionSize: 1000,
      leverage: 1,
      duration: 30,
    });
    expect(negative.totalCost).toBeCloseTo(positive.totalCost);
  });
});
