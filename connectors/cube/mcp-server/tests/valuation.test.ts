import { describe, it, expect } from 'vitest';
import {
  dcf, marginOfSafety, intrinsicValue, grahamNumber, ownerEarnings,
  wacc, capm, pegRatio, fcfYield, evToEbitda,
  nvtRatio, mvrvRatio, stockToFlow, stockToFlowPrice,
  priceToFeesRatio, feeBasedValuation, metcalfeValuation,
  thermocapMultiple, mcapToTvl,
} from '../../../../lib/valuation.js';

// ── Universal ────────────────────────────────────────────────

describe('dcf', () => {
  it('calculates present value of future cash flows', () => {
    const cf = [100, 110, 121]; // 10% growth
    const result = dcf(cf, 0.10, 0.02);
    expect(result).toBeGreaterThan(0);
    // First CF: 100/1.10 ≈ 90.91
    expect(result).toBeGreaterThan(90);
  });

  it('returns 0 for empty cash flows', () => {
    expect(dcf([], 0.10)).toBe(0);
  });

  it('returns 0 when discount rate <= terminal growth', () => {
    expect(dcf([100], 0.02, 0.05)).toBe(0);
  });

  it('higher discount rate → lower present value', () => {
    const cf = [100, 100, 100];
    const low = dcf(cf, 0.05);
    const high = dcf(cf, 0.15);
    expect(low).toBeGreaterThan(high);
  });
});

describe('marginOfSafety', () => {
  it('positive when price is below fair value', () => {
    expect(marginOfSafety(100, 75)).toBeCloseTo(0.25);
  });

  it('negative when price is above fair value', () => {
    expect(marginOfSafety(100, 120)).toBeCloseTo(-0.20);
  });

  it('zero when price equals fair value', () => {
    expect(marginOfSafety(100, 100)).toBe(0);
  });

  it('returns 0 when fair value is 0', () => {
    expect(marginOfSafety(0, 50)).toBe(0);
  });
});

// ── Crypto ───────────────────────────────────────────────────

describe('nvtRatio', () => {
  it('calculates network value to annualized transaction volume', () => {
    // $1B market cap, $10M daily volume → NVT = 1B / (10M * 365) ≈ 0.274
    const result = nvtRatio(1_000_000_000, 10_000_000);
    expect(result).toBeCloseTo(1_000_000_000 / (10_000_000 * 365), 2);
  });

  it('returns Infinity for zero transaction volume', () => {
    expect(nvtRatio(1_000_000, 0)).toBe(Infinity);
  });
});

describe('mvrvRatio', () => {
  it('calculates market cap to realized cap ratio', () => {
    expect(mvrvRatio(500, 250)).toBeCloseTo(2);
  });

  it('returns Infinity for zero realized cap', () => {
    expect(mvrvRatio(100, 0)).toBe(Infinity);
  });
});

describe('stockToFlow', () => {
  it('calculates scarcity ratio', () => {
    // BTC ~19.5M supply, ~328,500 new/year → S2F ≈ 59.4
    expect(stockToFlow(19_500_000, 328_500)).toBeCloseTo(59.36, 0);
  });

  it('returns Infinity for zero production', () => {
    expect(stockToFlow(21_000_000, 0)).toBe(Infinity);
  });
});

describe('stockToFlowPrice', () => {
  it('returns positive price for positive S2F', () => {
    const price = stockToFlowPrice(59);
    expect(price).toBeGreaterThan(0);
  });

  it('returns 0 for non-positive S2F', () => {
    expect(stockToFlowPrice(0)).toBe(0);
    expect(stockToFlowPrice(-1)).toBe(0);
  });
});

describe('priceToFeesRatio', () => {
  it('calculates FDV to annualized fees', () => {
    expect(priceToFeesRatio(1_000_000, 50_000)).toBeCloseTo(20);
  });

  it('returns Infinity for zero fees', () => {
    expect(priceToFeesRatio(1_000_000, 0)).toBe(Infinity);
  });
});

describe('feeBasedValuation', () => {
  it('values protocol from fee revenue', () => {
    // $10M fees, 25x multiple, 50% to token → $125M
    expect(feeBasedValuation(10_000_000, 25, 0.5)).toBeCloseTo(125_000_000);
  });

  it('defaults to 100% fee share', () => {
    expect(feeBasedValuation(10_000_000, 20)).toBeCloseTo(200_000_000);
  });
});

describe('metcalfeValuation', () => {
  it('scales with address count squared by default', () => {
    const v1 = metcalfeValuation(1000, 1);
    const v2 = metcalfeValuation(2000, 1);
    expect(v2 / v1).toBeCloseTo(4, 0); // 2^2 = 4
  });

  it('returns 0 for zero addresses', () => {
    expect(metcalfeValuation(0, 1)).toBe(0);
  });

  it('supports custom exponent', () => {
    const classic = metcalfeValuation(1000, 1, 2);
    const conservative = metcalfeValuation(1000, 1, 1.5);
    expect(classic).toBeGreaterThan(conservative);
  });
});

describe('thermocapMultiple', () => {
  it('calculates market cap to cumulative security spend', () => {
    expect(thermocapMultiple(1_000_000, 50_000)).toBeCloseTo(20);
  });

  it('returns Infinity for zero security spend', () => {
    expect(thermocapMultiple(1_000_000, 0)).toBe(Infinity);
  });
});

describe('mcapToTvl', () => {
  it('calculates market cap to TVL ratio', () => {
    expect(mcapToTvl(500_000_000, 250_000_000)).toBeCloseTo(2);
  });

  it('returns Infinity for zero TVL', () => {
    expect(mcapToTvl(100, 0)).toBe(Infinity);
  });
});

// ── Equities ─────────────────────────────────────────────────

describe('intrinsicValue', () => {
  it('calculates multi-stage DCF', () => {
    // $100 FCF, 15% growth, 10% discount, 15x terminal, 5 years
    const result = intrinsicValue(100, 0.15, 0.10, 15, 5);
    expect(result).toBeGreaterThan(0);
    // Should be significantly above current FCF * terminal
    expect(result).toBeGreaterThan(100 * 15);
  });

  it('returns 0 for zero or negative discount rate', () => {
    expect(intrinsicValue(100, 0.15, 0, 15)).toBe(0);
    expect(intrinsicValue(100, 0.15, -0.05, 15)).toBe(0);
  });

  it('higher growth → higher value', () => {
    const low = intrinsicValue(100, 0.05, 0.10, 15);
    const high = intrinsicValue(100, 0.25, 0.10, 15);
    expect(high).toBeGreaterThan(low);
  });
});

describe('grahamNumber', () => {
  it('calculates sqrt(22.5 * EPS * BVPS)', () => {
    // EPS = 5, BVPS = 30 → sqrt(22.5 * 5 * 30) = sqrt(3375) ≈ 58.09
    expect(grahamNumber(5, 30)).toBeCloseTo(Math.sqrt(3375));
  });

  it('returns 0 for negative EPS', () => {
    expect(grahamNumber(-5, 30)).toBe(0);
  });

  it('returns 0 for negative book value', () => {
    expect(grahamNumber(5, -10)).toBe(0);
  });
});

describe('ownerEarnings', () => {
  it('calculates Buffett owner earnings', () => {
    // NI=100, Dep=20, Capex=30, WC=5 → 100 + 20 - 30 - 5 = 85
    expect(ownerEarnings(100, 20, 30, 5)).toBeCloseTo(85);
  });
});

describe('wacc', () => {
  it('calculates weighted average cost of capital', () => {
    // 60% equity at 12%, 40% debt at 5%, 25% tax
    // 0.6 * 0.12 + 0.4 * 0.05 * 0.75 = 0.072 + 0.015 = 0.087
    expect(wacc(0.6, 0.12, 0.4, 0.05, 0.25)).toBeCloseTo(0.087);
  });
});

describe('capm', () => {
  it('calculates cost of equity', () => {
    // rf=4%, beta=1.2, market=10% → 4% + 1.2*(10%-4%) = 11.2%
    expect(capm(0.04, 1.2, 0.10)).toBeCloseTo(0.112);
  });

  it('equals risk-free rate when beta is 0', () => {
    expect(capm(0.04, 0, 0.10)).toBeCloseTo(0.04);
  });
});

describe('pegRatio', () => {
  it('calculates P/E to growth ratio', () => {
    expect(pegRatio(30, 15)).toBeCloseTo(2);
  });

  it('returns Infinity for zero growth', () => {
    expect(pegRatio(20, 0)).toBe(Infinity);
  });
});

describe('fcfYield', () => {
  it('calculates FCF / market cap', () => {
    expect(fcfYield(50_000_000, 1_000_000_000)).toBeCloseTo(0.05);
  });

  it('returns 0 for zero market cap', () => {
    expect(fcfYield(100, 0)).toBe(0);
  });
});

describe('evToEbitda', () => {
  it('calculates EV/EBITDA multiple', () => {
    expect(evToEbitda(1_000_000, 100_000)).toBeCloseTo(10);
  });

  it('returns Infinity for zero EBITDA', () => {
    expect(evToEbitda(1_000_000, 0)).toBe(Infinity);
  });
});
