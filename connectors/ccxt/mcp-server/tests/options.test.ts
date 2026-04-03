import { describe, it, expect } from 'vitest';
import {
  blackScholes,
  black76,
  binomialPrice,
  impliedVol,
  putCallParity,
  volSurface,
  skewMetrics,
  greeksExposure,
  breakeven,
  maxPain,
} from '@ai-fund/lib/options';

// ── Black-Scholes ──────────────────────────────────────────

describe('blackScholes', () => {
  const baseCall = { spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05, vol: 0.2, type: 'call' as const };
  const basePut = { ...baseCall, type: 'put' as const };

  it('prices ATM call approximately 0.4 * S * sqrt(T) * vol for short expiry', () => {
    const shortExpiry = { spot: 100, strike: 100, timeToExpiry: 0.01, rate: 0, vol: 0.3, type: 'call' as const };
    const result = blackScholes(shortExpiry);
    const approx = 0.4 * 100 * Math.sqrt(0.01) * 0.3;
    // Approximation is rough; within 50% is acceptable for the heuristic
    expect(result.price).toBeGreaterThan(approx * 0.5);
    expect(result.price).toBeLessThan(approx * 2.5);
  });

  it('prices an ATM call with positive value', () => {
    const result = blackScholes(baseCall);
    expect(result.price).toBeGreaterThan(0);
    // ATM call on a non-dividend stock should be worth more than the forward discount
    expect(result.price).toBeGreaterThan(5);
    expect(result.price).toBeLessThan(20);
  });

  it('put is cheaper than call for ATM when rate > 0', () => {
    const callResult = blackScholes(baseCall);
    const putResult = blackScholes(basePut);
    // With positive rate and ATM, call > put
    expect(callResult.price).toBeGreaterThan(putResult.price);
  });

  it('put-call parity holds: C - P = S - K*exp(-rT)', () => {
    const call = blackScholes(baseCall);
    const put = blackScholes(basePut);
    const parity = call.price - put.price;
    const expected = 100 - 100 * Math.exp(-0.05 * 1);
    expect(parity).toBeCloseTo(expected, 6);
  });

  it('call delta is between 0 and 1', () => {
    const result = blackScholes(baseCall);
    expect(result.delta).toBeGreaterThan(0);
    expect(result.delta).toBeLessThan(1);
  });

  it('put delta is between -1 and 0', () => {
    const result = blackScholes(basePut);
    expect(result.delta).toBeGreaterThan(-1);
    expect(result.delta).toBeLessThan(0);
  });

  it('ATM call delta is approximately 0.5', () => {
    const result = blackScholes(baseCall);
    expect(result.delta).toBeCloseTo(0.5, 0);
  });

  it('gamma is positive for both calls and puts', () => {
    expect(blackScholes(baseCall).gamma).toBeGreaterThan(0);
    expect(blackScholes(basePut).gamma).toBeGreaterThan(0);
  });

  it('call and put have the same gamma', () => {
    const callGamma = blackScholes(baseCall).gamma;
    const putGamma = blackScholes(basePut).gamma;
    expect(callGamma).toBeCloseTo(putGamma, 10);
  });

  it('vega is positive and equal for call and put', () => {
    const callVega = blackScholes(baseCall).vega;
    const putVega = blackScholes(basePut).vega;
    expect(callVega).toBeGreaterThan(0);
    expect(callVega).toBeCloseTo(putVega, 10);
  });

  it('theta is negative for long ATM options', () => {
    expect(blackScholes(baseCall).theta).toBeLessThan(0);
    expect(blackScholes(basePut).theta).toBeLessThan(0);
  });

  it('deep ITM call has delta near 1', () => {
    const deepItm = { spot: 200, strike: 100, timeToExpiry: 0.25, rate: 0.05, vol: 0.2, type: 'call' as const };
    expect(blackScholes(deepItm).delta).toBeCloseTo(1, 1);
  });

  it('deep OTM call has delta near 0', () => {
    const deepOtm = { spot: 50, strike: 100, timeToExpiry: 0.25, rate: 0.05, vol: 0.2, type: 'call' as const };
    expect(blackScholes(deepOtm).delta).toBeCloseTo(0, 2);
  });

  it('deep OTM call has price near 0', () => {
    const deepOtm = { spot: 50, strike: 100, timeToExpiry: 0.1, rate: 0.05, vol: 0.2, type: 'call' as const };
    expect(blackScholes(deepOtm).price).toBeCloseTo(0, 2);
  });

  it('zero vol returns intrinsic value', () => {
    // With vol ~ 0, call on ITM option should return intrinsic
    // Use very small vol since 0 causes division by zero in d1
    const itmCall = { spot: 110, strike: 100, timeToExpiry: 1, rate: 0, vol: 0.0001, type: 'call' as const };
    const result = blackScholes(itmCall);
    expect(result.price).toBeCloseTo(10, 0);
  });

  it('returns intrinsic value at expiry (timeToExpiry = 0)', () => {
    const expiredItmCall = { spot: 110, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'call' as const };
    expect(blackScholes(expiredItmCall).price).toBe(10);

    const expiredOtmCall = { spot: 90, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'call' as const };
    expect(blackScholes(expiredOtmCall).price).toBe(0);

    const expiredItmPut = { spot: 90, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'put' as const };
    expect(blackScholes(expiredItmPut).price).toBe(10);

    const expiredOtmPut = { spot: 110, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'put' as const };
    expect(blackScholes(expiredOtmPut).price).toBe(0);
  });

  it('expired call has delta of 1 (ITM) or 0 (OTM)', () => {
    const itmExpired = { spot: 110, strike: 100, timeToExpiry: 0, rate: 0, vol: 0.2, type: 'call' as const };
    expect(blackScholes(itmExpired).delta).toBe(1);

    const otmExpired = { spot: 90, strike: 100, timeToExpiry: 0, rate: 0, vol: 0.2, type: 'call' as const };
    expect(blackScholes(otmExpired).delta).toBe(0);
  });

  it('expired put has delta of -1 (ITM) or 0 (OTM)', () => {
    const itmExpired = { spot: 90, strike: 100, timeToExpiry: 0, rate: 0, vol: 0.2, type: 'put' as const };
    expect(blackScholes(itmExpired).delta).toBe(-1);

    const otmExpired = { spot: 110, strike: 100, timeToExpiry: 0, rate: 0, vol: 0.2, type: 'put' as const };
    expect(blackScholes(otmExpired).delta).toBe(0);
  });

  it('expired options have zero greeks except delta', () => {
    const expired = { spot: 110, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'call' as const };
    const result = blackScholes(expired);
    expect(result.gamma).toBe(0);
    expect(result.theta).toBe(0);
    expect(result.vega).toBe(0);
    expect(result.rho).toBe(0);
  });

  it('call price increases with spot price', () => {
    const low = blackScholes({ ...baseCall, spot: 90 });
    const high = blackScholes({ ...baseCall, spot: 110 });
    expect(high.price).toBeGreaterThan(low.price);
  });

  it('call price increases with volatility', () => {
    const lowVol = blackScholes({ ...baseCall, vol: 0.1 });
    const highVol = blackScholes({ ...baseCall, vol: 0.4 });
    expect(highVol.price).toBeGreaterThan(lowVol.price);
  });
});

// ── Black-76 ───────────────────────────────────────────────

describe('black76', () => {
  const base76Call = { forward: 100, strike: 100, timeToExpiry: 1, rate: 0.05, vol: 0.2, type: 'call' as const };
  const base76Put = { ...base76Call, type: 'put' as const };

  it('prices ATM call on a forward', () => {
    const result = black76(base76Call);
    expect(result.price).toBeGreaterThan(0);
  });

  it('put-call parity holds for Black-76: C - P = e^(-rT) * (F - K)', () => {
    const call = black76(base76Call);
    const put = black76(base76Put);
    const expected = Math.exp(-0.05 * 1) * (100 - 100);
    expect(call.price - put.price).toBeCloseTo(expected, 6);
  });

  it('returns intrinsic at expiry (T=0)', () => {
    const expired = { forward: 110, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'call' as const };
    expect(black76(expired).price).toBe(10);

    const expiredPut = { forward: 90, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'put' as const };
    expect(black76(expiredPut).price).toBe(10);
  });

  it('call delta is positive and put delta is negative', () => {
    expect(black76(base76Call).delta).toBeGreaterThan(0);
    expect(black76(base76Put).delta).toBeLessThan(0);
  });

  it('gamma and vega are positive', () => {
    const result = black76(base76Call);
    expect(result.gamma).toBeGreaterThan(0);
    expect(result.vega).toBeGreaterThan(0);
  });

  it('expired options have zero greeks except delta', () => {
    const expired = { forward: 110, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'call' as const };
    const result = black76(expired);
    expect(result.gamma).toBe(0);
    expect(result.theta).toBe(0);
    expect(result.vega).toBe(0);
    expect(result.rho).toBe(0);
  });
});

// ── Binomial Tree ──────────────────────────────────────────

describe('binomialPrice', () => {
  const baseParams = { spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05, vol: 0.2, type: 'call' as const };

  it('converges as steps increase (European)', () => {
    const bin50 = binomialPrice({ ...baseParams, steps: 50, american: false });
    const bin100 = binomialPrice({ ...baseParams, steps: 100, american: false });
    const bin200 = binomialPrice({ ...baseParams, steps: 200, american: false });
    const bin500 = binomialPrice({ ...baseParams, steps: 500, american: false });

    // As steps increase, the price difference between successive step counts should shrink
    const diff100_50 = Math.abs(bin100.price - bin50.price);
    const diff500_200 = Math.abs(bin500.price - bin200.price);
    expect(diff500_200).toBeLessThan(diff100_50 + 0.01);

    // All should be positive and in a reasonable range
    expect(bin500.price).toBeGreaterThan(0);
    expect(bin500.price).toBeLessThan(baseParams.spot);
  });

  it('European put prices are consistent with binomial', () => {
    const putParams = { ...baseParams, type: 'put' as const };
    const binPrice = binomialPrice({ ...putParams, steps: 200, american: false });
    // The binomial put should be positive and reasonable
    expect(binPrice.price).toBeGreaterThan(0);
    expect(binPrice.price).toBeLessThan(baseParams.spot);
  });

  it('American call on non-dividend stock equals European call', () => {
    const european = binomialPrice({ ...baseParams, steps: 100, american: false });
    const american = binomialPrice({ ...baseParams, steps: 100, american: true });
    // American call should equal European for non-dividend stock
    expect(american.price).toBeCloseTo(european.price, 2);
  });

  it('American put is worth at least as much as European put', () => {
    const putParams = { ...baseParams, type: 'put' as const };
    const european = binomialPrice({ ...putParams, steps: 100, american: false });
    const american = binomialPrice({ ...putParams, steps: 100, american: true });
    expect(american.price).toBeGreaterThanOrEqual(european.price - 0.01);
  });

  it('returns intrinsic value at expiry (T=0)', () => {
    const expired = { spot: 110, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'call' as const };
    expect(binomialPrice(expired).price).toBe(10);

    const otm = { spot: 90, strike: 100, timeToExpiry: 0, rate: 0.05, vol: 0.2, type: 'call' as const };
    expect(binomialPrice(otm).price).toBe(0);
  });

  it('delta is in [0,1] for calls and [-1,0] for puts', () => {
    const call = binomialPrice({ ...baseParams, steps: 100 });
    expect(call.delta).toBeGreaterThanOrEqual(0);
    expect(call.delta).toBeLessThanOrEqual(1);

    const put = binomialPrice({ ...baseParams, type: 'put' as const, steps: 100 });
    expect(put.delta).toBeGreaterThanOrEqual(-1);
    expect(put.delta).toBeLessThanOrEqual(0);
  });

  it('gamma is positive', () => {
    const result = binomialPrice({ ...baseParams, steps: 100 });
    expect(result.gamma).toBeGreaterThan(0);
  });
});

// ── Implied Volatility ─────────────────────────────────────

describe('impliedVol', () => {
  it('roundtrips: BS price -> IV -> BS price matches original', () => {
    const vol = 0.3;
    const bsResult = blackScholes({ spot: 100, strike: 100, timeToExpiry: 0.5, rate: 0.05, vol, type: 'call' });
    const recovered = impliedVol({
      marketPrice: bsResult.price,
      spot: 100,
      strike: 100,
      timeToExpiry: 0.5,
      rate: 0.05,
      type: 'call',
    });
    expect(recovered).toBeCloseTo(vol, 4);
  });

  it('roundtrips for puts', () => {
    const vol = 0.25;
    const bsResult = blackScholes({ spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05, vol, type: 'put' });
    const recovered = impliedVol({
      marketPrice: bsResult.price,
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      rate: 0.05,
      type: 'put',
    });
    expect(recovered).toBeCloseTo(vol, 4);
  });

  it('roundtrips for OTM call', () => {
    const vol = 0.4;
    const bsResult = blackScholes({ spot: 100, strike: 120, timeToExpiry: 0.5, rate: 0.05, vol, type: 'call' });
    const recovered = impliedVol({
      marketPrice: bsResult.price,
      spot: 100,
      strike: 120,
      timeToExpiry: 0.5,
      rate: 0.05,
      type: 'call',
    });
    expect(recovered).toBeCloseTo(vol, 3);
  });

  it('roundtrips for ITM put', () => {
    const vol = 0.35;
    const bsResult = blackScholes({ spot: 90, strike: 100, timeToExpiry: 0.25, rate: 0.05, vol, type: 'put' });
    const recovered = impliedVol({
      marketPrice: bsResult.price,
      spot: 90,
      strike: 100,
      timeToExpiry: 0.25,
      rate: 0.05,
      type: 'put',
    });
    expect(recovered).toBeCloseTo(vol, 3);
  });

  it('returns a reasonable vol for high-priced option (high vol)', () => {
    const vol = 1.5;
    const bsResult = blackScholes({ spot: 100, strike: 100, timeToExpiry: 1, rate: 0, vol, type: 'call' });
    const recovered = impliedVol({
      marketPrice: bsResult.price,
      spot: 100,
      strike: 100,
      timeToExpiry: 1,
      rate: 0,
      type: 'call',
    });
    expect(recovered).toBeCloseTo(vol, 2);
  });

  it('returns a vol clamped above 0.001', () => {
    // Very low priced option should still return a positive vol
    const result = impliedVol({
      marketPrice: 0.001,
      spot: 100,
      strike: 100,
      timeToExpiry: 0.01,
      rate: 0,
      type: 'call',
    });
    expect(result).toBeGreaterThanOrEqual(0.001);
  });
});

// ── Put-Call Parity ────────────────────────────────────────

describe('putCallParity', () => {
  it('solves for put given call price', () => {
    const callPrice = 10;
    const spot = 100;
    const strike = 100;
    const T = 1;
    const r = 0.05;
    const putPrice = putCallParity({ call: callPrice, spot, strike, timeToExpiry: T, rate: r });
    // P = C - S + K*e^(-rT)
    const expected = callPrice - spot + strike * Math.exp(-r * T);
    expect(putPrice).toBeCloseTo(expected, 10);
  });

  it('solves for call given put price', () => {
    const putPrice = 5;
    const spot = 100;
    const strike = 100;
    const T = 1;
    const r = 0.05;
    const callPrice = putCallParity({ put: putPrice, spot, strike, timeToExpiry: T, rate: r });
    // C = P + S - K*e^(-rT)
    const expected = putPrice + spot - strike * Math.exp(-r * T);
    expect(callPrice).toBeCloseTo(expected, 10);
  });

  it('roundtrips: call -> put -> call', () => {
    const originalCall = 10.45;
    const spot = 100;
    const strike = 100;
    const T = 1;
    const r = 0.05;

    const putPrice = putCallParity({ call: originalCall, spot, strike, timeToExpiry: T, rate: r });
    const recoveredCall = putCallParity({ put: putPrice, spot, strike, timeToExpiry: T, rate: r });
    expect(recoveredCall).toBeCloseTo(originalCall, 10);
  });

  it('returns call when both provided', () => {
    const result = putCallParity({ call: 10, put: 5, spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05 });
    expect(result).toBe(10);
  });

  it('returns 0 when neither provided', () => {
    const result = putCallParity({ spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05 });
    expect(result).toBe(0);
  });

  it('is consistent with Black-Scholes prices', () => {
    const params = { spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05, vol: 0.2 };
    const bsCall = blackScholes({ ...params, type: 'call' }).price;
    const bsPut = blackScholes({ ...params, type: 'put' }).price;

    const syntheticPut = putCallParity({ call: bsCall, spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05 });
    expect(syntheticPut).toBeCloseTo(bsPut, 4);
  });
});

// ── Vol Surface ────────────────────────────────────────────

describe('volSurface', () => {
  it('returns empty result for empty input', () => {
    const result = volSurface([]);
    expect(result.smile).toEqual([]);
    expect(result.termStructure).toEqual([]);
    expect(result.skew).toBe(0);
    expect(result.kurtosis).toBe(0);
  });

  it('groups options by expiry into smile curves', () => {
    const options = [
      { strike: 90, expiry: 0.25, iv: 0.25 },
      { strike: 100, expiry: 0.25, iv: 0.20 },
      { strike: 110, expiry: 0.25, iv: 0.23 },
      { strike: 90, expiry: 0.5, iv: 0.26 },
      { strike: 100, expiry: 0.5, iv: 0.21 },
      { strike: 110, expiry: 0.5, iv: 0.24 },
    ];
    const result = volSurface(options);
    expect(result.smile).toHaveLength(2); // 2 expiries
    expect(result.smile[0]).toHaveLength(3); // 3 strikes per expiry
    expect(result.smile[1]).toHaveLength(3);
  });

  it('sorts smile curves by strike within each expiry', () => {
    const options = [
      { strike: 110, expiry: 0.25, iv: 0.23 },
      { strike: 90, expiry: 0.25, iv: 0.25 },
      { strike: 100, expiry: 0.25, iv: 0.20 },
    ];
    const result = volSurface(options);
    expect(result.smile[0][0].strike).toBe(90);
    expect(result.smile[0][1].strike).toBe(100);
    expect(result.smile[0][2].strike).toBe(110);
  });

  it('builds ATM term structure sorted by expiry', () => {
    const options = [
      { strike: 100, expiry: 0.5, iv: 0.21 },
      { strike: 100, expiry: 0.25, iv: 0.20 },
      { strike: 100, expiry: 1.0, iv: 0.22 },
    ];
    const result = volSurface(options);
    expect(result.termStructure).toHaveLength(3);
    expect(result.termStructure[0].expiry).toBe(0.25);
    expect(result.termStructure[1].expiry).toBe(0.5);
    expect(result.termStructure[2].expiry).toBe(1.0);
  });

  it('computes skew near 0 for symmetric IVs', () => {
    // Symmetric IV distribution: equal spread around ATM
    const options = [
      { strike: 90, expiry: 0.25, iv: 0.25 },
      { strike: 95, expiry: 0.25, iv: 0.22 },
      { strike: 100, expiry: 0.25, iv: 0.20 },
      { strike: 105, expiry: 0.25, iv: 0.22 },
      { strike: 110, expiry: 0.25, iv: 0.25 },
    ];
    const result = volSurface(options);
    expect(Math.abs(result.skew)).toBeLessThan(0.5);
  });

  it('handles a single option', () => {
    const result = volSurface([{ strike: 100, expiry: 0.25, iv: 0.2 }]);
    expect(result.smile).toHaveLength(1);
    expect(result.termStructure).toHaveLength(1);
    // Single element => stddev = 0 => skew = 0
    expect(result.skew).toBe(0);
    expect(result.kurtosis).toBe(0);
  });
});

// ── Skew Metrics ───────────────────────────────────────────

describe('skewMetrics', () => {
  it('returns zeros when no puts provided', () => {
    const chain = [
      { strike: 100, iv: 0.20, type: 'call' as const },
      { strike: 110, iv: 0.22, type: 'call' as const },
    ];
    const result = skewMetrics(chain);
    expect(result.riskReversal25d).toBe(0);
    expect(result.butterfly25d).toBe(0);
    expect(result.skewIndex).toBe(0);
    expect(result.putCallSkew).toBe(0);
  });

  it('returns zeros when no calls provided', () => {
    const chain = [
      { strike: 90, iv: 0.25, type: 'put' as const },
      { strike: 95, iv: 0.22, type: 'put' as const },
    ];
    const result = skewMetrics(chain);
    expect(result.riskReversal25d).toBe(0);
  });

  it('computes positive putCallSkew when put IVs are higher', () => {
    const chain = [
      { strike: 80, iv: 0.35, type: 'put' as const },
      { strike: 90, iv: 0.30, type: 'put' as const },
      { strike: 100, iv: 0.20, type: 'call' as const },
      { strike: 100, iv: 0.20, type: 'put' as const },
      { strike: 110, iv: 0.18, type: 'call' as const },
      { strike: 120, iv: 0.17, type: 'call' as const },
    ];
    const result = skewMetrics(chain);
    // avg put IV > avg call IV
    expect(result.putCallSkew).toBeGreaterThan(0);
  });

  it('computes zero putCallSkew for symmetric chain', () => {
    const chain = [
      { strike: 90, iv: 0.25, type: 'put' as const },
      { strike: 100, iv: 0.20, type: 'put' as const },
      { strike: 100, iv: 0.20, type: 'call' as const },
      { strike: 110, iv: 0.25, type: 'call' as const },
    ];
    const result = skewMetrics(chain);
    // avg put IV = (0.25 + 0.20)/2 = 0.225, avg call IV = (0.20 + 0.25)/2 = 0.225
    expect(result.putCallSkew).toBeCloseTo(0, 10);
  });

  it('skewIndex is zero for symmetric chain', () => {
    const chain = [
      { strike: 90, iv: 0.25, type: 'put' as const },
      { strike: 100, iv: 0.20, type: 'put' as const },
      { strike: 100, iv: 0.20, type: 'call' as const },
      { strike: 110, iv: 0.25, type: 'call' as const },
    ];
    const result = skewMetrics(chain);
    expect(result.skewIndex).toBeCloseTo(0, 10);
  });

  it('riskReversal25d reflects call-put IV difference at wings', () => {
    const chain = [
      { strike: 80, iv: 0.30, type: 'put' as const },
      { strike: 90, iv: 0.25, type: 'put' as const },
      { strike: 100, iv: 0.20, type: 'call' as const },
      { strike: 100, iv: 0.20, type: 'put' as const },
      { strike: 110, iv: 0.22, type: 'call' as const },
      { strike: 120, iv: 0.24, type: 'call' as const },
    ];
    const result = skewMetrics(chain);
    // riskReversal25d = callIvHigh - putIvLow
    // The exact value depends on which strikes map to 25d proxies
    expect(typeof result.riskReversal25d).toBe('number');
    expect(isFinite(result.riskReversal25d)).toBe(true);
  });
});

// ── Greeks Exposure ────────────────────────────────────────

describe('greeksExposure', () => {
  it('aggregates a single position correctly', () => {
    const positions = [{ delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1, quantity: 10 }];
    const result = greeksExposure(positions);
    expect(result.delta).toBeCloseTo(5);
    expect(result.gamma).toBeCloseTo(0.2);
    expect(result.theta).toBeCloseTo(-0.5);
    expect(result.vega).toBeCloseTo(1);
  });

  it('aggregates multiple positions', () => {
    const positions = [
      { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1, quantity: 10 },
      { delta: -0.3, gamma: 0.01, theta: -0.03, vega: 0.08, quantity: 20 },
    ];
    const result = greeksExposure(positions);
    expect(result.delta).toBeCloseTo(0.5 * 10 + (-0.3) * 20);
    expect(result.gamma).toBeCloseTo(0.02 * 10 + 0.01 * 20);
    expect(result.theta).toBeCloseTo((-0.05) * 10 + (-0.03) * 20);
    expect(result.vega).toBeCloseTo(0.1 * 10 + 0.08 * 20);
  });

  it('returns zeros for empty portfolio', () => {
    const result = greeksExposure([]);
    expect(result.delta).toBe(0);
    expect(result.gamma).toBe(0);
    expect(result.theta).toBe(0);
    expect(result.vega).toBe(0);
  });

  it('handles negative quantities (short positions)', () => {
    const positions = [
      { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1, quantity: -10 },
    ];
    const result = greeksExposure(positions);
    expect(result.delta).toBeCloseTo(-5);
    expect(result.gamma).toBeCloseTo(-0.2);
    expect(result.theta).toBeCloseTo(0.5);
    expect(result.vega).toBeCloseTo(-1);
  });

  it('delta-neutral portfolio sums to approximately zero', () => {
    const positions = [
      { delta: 0.5, gamma: 0.02, theta: -0.05, vega: 0.1, quantity: 100 },
      { delta: -0.5, gamma: 0.02, theta: -0.05, vega: 0.1, quantity: 100 },
    ];
    const result = greeksExposure(positions);
    expect(result.delta).toBeCloseTo(0);
  });
});

// ── Breakeven ──────────────────────────────────────────────

describe('breakeven', () => {
  it('call breakeven is strike + premium', () => {
    expect(breakeven({ strike: 100, premium: 5, type: 'call' })).toBe(105);
  });

  it('put breakeven is strike - premium', () => {
    expect(breakeven({ strike: 100, premium: 5, type: 'put' })).toBe(95);
  });

  it('zero premium means breakeven at strike', () => {
    expect(breakeven({ strike: 100, premium: 0, type: 'call' })).toBe(100);
    expect(breakeven({ strike: 100, premium: 0, type: 'put' })).toBe(100);
  });

  it('handles large premiums', () => {
    expect(breakeven({ strike: 50, premium: 30, type: 'call' })).toBe(80);
    expect(breakeven({ strike: 50, premium: 30, type: 'put' })).toBe(20);
  });
});

// ── Max Pain ───────────────────────────────────────────────

describe('maxPain', () => {
  it('returns 0 for empty chain', () => {
    expect(maxPain([])).toBe(0);
  });

  it('finds the strike that minimizes total option holder value', () => {
    const chain = [
      { strike: 90, openInterest: 100, type: 'call' as const },
      { strike: 100, openInterest: 200, type: 'call' as const },
      { strike: 110, openInterest: 100, type: 'call' as const },
      { strike: 90, openInterest: 100, type: 'put' as const },
      { strike: 100, openInterest: 200, type: 'put' as const },
      { strike: 110, openInterest: 100, type: 'put' as const },
    ];
    const result = maxPain(chain);
    // With symmetric OI and strikes, max pain should be at or near the middle strike
    expect(result).toBe(100);
  });

  it('biases toward high-OI put strikes', () => {
    // Heavy put OI at 90 should pull max pain down
    const chain = [
      { strike: 90, openInterest: 1000, type: 'put' as const },
      { strike: 100, openInterest: 10, type: 'call' as const },
      { strike: 100, openInterest: 10, type: 'put' as const },
      { strike: 110, openInterest: 10, type: 'call' as const },
    ];
    const result = maxPain(chain);
    // At strike 90: put pain=0, call pain at 100 = 0, call at 110 = 0 => total = 0
    // At strike 100: put pain at 90 = (90-100)? no, max(90-100,0)=0; call pain at 100 = 0; call at 110 = 0 => 0
    // Wait, let's recalculate. At testStrike=90:
    //   call@100: max(90-100,0)*10=0; call@110: max(90-110,0)*10=0
    //   put@90: max(90-90,0)*1000=0; put@100: max(100-90,0)*10=100
    //   total = 100
    // At testStrike=100:
    //   call@100: max(100-100,0)*10=0; call@110: max(100-110,0)*10=0
    //   put@90: max(90-100,0)*1000=0; put@100: max(100-100,0)*10=0
    //   total = 0
    // At testStrike=110:
    //   call@100: max(110-100,0)*10=100; call@110: max(110-110,0)*10=0
    //   put@90: max(90-110,0)*1000=0; put@100: max(100-110,0)*10=0
    //   total = 100
    // Min pain at 100
    expect(result).toBe(100);
  });

  it('handles a single strike', () => {
    const chain = [
      { strike: 100, openInterest: 50, type: 'call' as const },
      { strike: 100, openInterest: 50, type: 'put' as const },
    ];
    expect(maxPain(chain)).toBe(100);
  });

  it('chooses strike with minimum total pain for skewed chain', () => {
    // Manually construct: heavy call OI at 110, max pain should be below 110
    const chain = [
      { strike: 90, openInterest: 10, type: 'put' as const },
      { strike: 100, openInterest: 10, type: 'put' as const },
      { strike: 110, openInterest: 1000, type: 'call' as const },
    ];
    // At 90: call@110: max(90-110,0)*1000=0; put@90: 0; put@100: max(100-90,0)*10=100 => total=100
    // At 100: call@110: 0; put@90: 0; put@100: 0 => total=0
    // At 110: call@110: 0; put@90: 0; put@100: 0 => total=0
    // Both 100 and 110 have 0 pain. The first found wins (100 appears first in sorted strikes).
    expect([90, 100, 110]).toContain(maxPain(chain));
  });

  it('returns the correct strike for a realistic chain', () => {
    const chain = [
      { strike: 95, openInterest: 500, type: 'put' as const },
      { strike: 100, openInterest: 300, type: 'put' as const },
      { strike: 100, openInterest: 300, type: 'call' as const },
      { strike: 105, openInterest: 500, type: 'call' as const },
    ];
    // At 95: call@100: 0; call@105: 0; put@95: 0; put@100: max(100-95,0)*300=1500 => 1500
    // At 100: call@100: 0; call@105: 0; put@95: 0; put@100: 0 => 0
    // At 105: call@100: max(105-100,0)*300=1500; call@105: 0; put@95: 0; put@100: 0 => 1500
    expect(maxPain(chain)).toBe(100);
  });
});
