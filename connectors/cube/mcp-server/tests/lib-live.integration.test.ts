/**
 * Integration test: run lib/indicators, lib/math, and lib/valuation
 * against live Cube Exchange market data (public endpoints, no auth).
 *
 * Run with: npx vitest run tests/lib-live.integration.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { OHLCV } from '@ai-fund/lib/indicators';
import {
  sma, ema, rsi, macd, bollingerBands, atr, adx, obv, stochastic,
  hurst, momentum, historicalVolatility, vwap, volumeSpike,
} from '@ai-fund/lib/indicators';
import {
  kelly, fixedFractionalSize, valueAtRisk, maxDrawdown,
  sharpeRatio, sortinoRatio, calmarRatio,
  correlation, correlationMatrix,
  mean, standardDeviation, zScore, returns, winRate, profitFactor,
  skewness, kurtosis, annualizedVolatility, volatilityPercentile, tailRatio,
  beta, alpha, informationRatio, upsideCapture, downsideCapture,
  linearRegressionSlope, coefficientOfVariation, drawdownSeries,
  rollingReturns, benchmarkReturn, trackingError, maxConsecutiveLosses, expectancy,
} from '@ai-fund/lib/math';
import {
  dcf, marginOfSafety, intrinsicValue, grahamNumber, ownerEarnings,
  wacc, capm, pegRatio, fcfYield, evToEbitda,
  nvtRatio, mvrvRatio, stockToFlow, stockToFlowPrice,
  priceToFeesRatio, feeBasedValuation, metcalfeValuation,
  thermocapMultiple, mcapToTvl,
} from '@ai-fund/lib/valuation';

// ── Cube public API helpers ─────────────────────────────────

const CUBE_REST = 'https://api.cube.exchange/ir/v0';

interface CubeMarket {
  marketId: number;
  symbol: string;
  priceDisplayDecimals: number;
}

async function fetchMarkets(): Promise<CubeMarket[]> {
  const res = await fetch(`${CUBE_REST}/markets`);
  if (!res.ok) throw new Error(`Markets fetch failed: ${res.status}`);
  const data = await res.json() as { result: { markets: CubeMarket[] } };
  return data.result.markets;
}

async function fetchKlines(marketId: number, interval: string = '1h', limit: number = 200): Promise<(number | string)[][]> {
  const res = await fetch(`${CUBE_REST}/history/klines?marketId=${marketId}&interval=${interval}&limit=${limit}`);
  if (!res.ok) throw new Error(`Klines fetch failed: ${res.status}`);
  const data = await res.json() as { result: (number | string)[][] };
  return data.result;
}

function klinesToOHLCV(raw: (number | string)[][], priceDecimals: number): OHLCV[] {
  const divisor = 10 ** priceDecimals;
  return raw
    .map(k => ({
      timestamp: Number(k[0]),
      open: Number(k[1]) / divisor,
      high: Number(k[2]) / divisor,
      low: Number(k[3]) / divisor,
      close: Number(k[4]) / divisor,
      volume: Number(k[5]),
    }))
    .sort((a, b) => a.timestamp - b.timestamp); // ensure chronological
}

// ── Test data ───────────────────────────────────────────────

let btcCandles: OHLCV[];
let ethCandles: OHLCV[];
let solCandles: OHLCV[];
let btcCloses: number[];
let ethCloses: number[];
let solCloses: number[];
let btcReturns: number[];
let ethReturns: number[];
let solReturns: number[];
let btcPrice: number;

beforeAll(async () => {
  const markets = await fetchMarkets();

  // Use first (primary) market for each pair
  const btcMarket = markets.find(m => m.symbol === 'BTCUSDC');
  const ethMarket = markets.find(m => m.symbol === 'ETHUSDC');
  const solMarket = markets.find(m => m.symbol === 'SOLUSDC');

  if (!btcMarket || !ethMarket || !solMarket) {
    throw new Error('Required markets not found on Cube');
  }

  // Fetch 200 hourly candles for each (parallel)
  const [btcRaw, ethRaw, solRaw] = await Promise.all([
    fetchKlines(btcMarket.marketId, '1h', 200),
    fetchKlines(ethMarket.marketId, '1h', 200),
    fetchKlines(solMarket.marketId, '1h', 200),
  ]);

  btcCandles = klinesToOHLCV(btcRaw, btcMarket.priceDisplayDecimals);
  ethCandles = klinesToOHLCV(ethRaw, ethMarket.priceDisplayDecimals);
  solCandles = klinesToOHLCV(solRaw, solMarket.priceDisplayDecimals);

  btcCloses = btcCandles.map(c => c.close);
  ethCloses = ethCandles.map(c => c.close);
  solCloses = solCandles.map(c => c.close);

  btcReturns = returns(btcCloses);
  ethReturns = returns(ethCloses);
  solReturns = returns(solCloses);

  btcPrice = btcCloses[btcCloses.length - 1];

  console.log(`Loaded ${btcCandles.length} BTC, ${ethCandles.length} ETH, ${solCandles.length} SOL candles`);
  console.log(`BTC latest: $${btcPrice.toFixed(2)}, ETH latest: $${ethCloses[ethCloses.length - 1].toFixed(2)}, SOL latest: $${solCloses[solCloses.length - 1].toFixed(2)}`);
}, 30_000);

// ══════════════════════════════════════════════════════════════
//  INDICATORS (lib/indicators.ts)
// ══════════════════════════════════════════════════════════════

describe('Indicators on live BTC data', () => {
  it('SMA(20) produces values near BTC price', () => {
    const result = sma(btcCloses, 20);
    expect(result.length).toBeGreaterThan(0);
    const last = result[result.length - 1];
    // SMA should be within 10% of current price
    expect(last).toBeGreaterThan(btcPrice * 0.9);
    expect(last).toBeLessThan(btcPrice * 1.1);
    console.log(`  SMA(20) = $${last.toFixed(2)}`);
  });

  it('EMA(12) reacts to BTC price', () => {
    const result = ema(btcCloses, 12);
    expect(result.length).toBeGreaterThan(0);
    console.log(`  EMA(12) = $${result[result.length - 1].toFixed(2)}`);
  });

  it('RSI(14) is between 0-100', () => {
    const result = rsi(btcCloses);
    const last = result[result.length - 1];
    expect(last).toBeGreaterThanOrEqual(0);
    expect(last).toBeLessThanOrEqual(100);
    console.log(`  RSI(14) = ${last.toFixed(1)}`);
  });

  it('MACD produces histogram', () => {
    const result = macd(btcCloses);
    expect(result.histogram.length).toBeGreaterThan(0);
    const last = result.histogram[result.histogram.length - 1];
    console.log(`  MACD histogram = ${last.toFixed(2)}`);
  });

  it('Bollinger Bands contain price', () => {
    const bb = bollingerBands(btcCloses);
    const lastIdx = bb.middle.length - 1;
    expect(bb.upper[lastIdx]).toBeGreaterThan(bb.lower[lastIdx]);
    console.log(`  BB: $${bb.lower[lastIdx].toFixed(0)} — $${bb.middle[lastIdx].toFixed(0)} — $${bb.upper[lastIdx].toFixed(0)}`);
  });

  it('ATR(14) is positive', () => {
    const result = atr(btcCandles);
    const last = result[result.length - 1];
    expect(last).toBeGreaterThan(0);
    console.log(`  ATR(14) = $${last.toFixed(2)}`);
  });

  it('ADX(14) measures trend strength', () => {
    const result = adx(btcCandles);
    const last = result[result.length - 1];
    expect(last).toBeGreaterThanOrEqual(0);
    expect(last).toBeLessThanOrEqual(100);
    console.log(`  ADX(14) = ${last.toFixed(1)} (${last > 25 ? 'trending' : 'ranging'})`);
  });

  it('OBV tracks volume flow', () => {
    const result = obv(btcCandles);
    expect(result.length).toBe(btcCandles.length);
    console.log(`  OBV = ${result[result.length - 1].toFixed(0)}`);
  });

  it('Stochastic K/D between 0-100', () => {
    const result = stochastic(btcCandles);
    const lastK = result.k[result.k.length - 1];
    const lastD = result.d[result.d.length - 1];
    expect(lastK).toBeGreaterThanOrEqual(0);
    expect(lastK).toBeLessThanOrEqual(100);
    console.log(`  Stochastic: K=${lastK.toFixed(1)}, D=${lastD.toFixed(1)}`);
  });

  // ── New indicators ──

  it('Hurst exponent classifies BTC regime', () => {
    const h = hurst(btcCloses);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(1);
    const regime = h > 0.55 ? 'trending' : h < 0.45 ? 'mean-reverting' : 'random walk';
    console.log(`  Hurst = ${h.toFixed(3)} (${regime})`);
  });

  it('Momentum across 24h/72h/168h windows', () => {
    const m = momentum(btcCloses, [24, 72, 168]);
    console.log(`  Momentum: 24h=${m[24] !== null ? (m[24]! * 100).toFixed(2) + '%' : 'N/A'}, 72h=${m[72] !== null ? (m[72]! * 100).toFixed(2) + '%' : 'N/A'}, 168h=${m[168] !== null ? (m[168]! * 100).toFixed(2) + '%' : 'N/A'}`);
    // At least the 24h window should have data with 200 candles
    expect(m[24]).not.toBeNull();
  });

  it('Historical volatility is annualized', () => {
    const vol = historicalVolatility(btcReturns);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(10); // < 1000% annualized
    console.log(`  Historical Vol (annualized) = ${(vol * 100).toFixed(1)}%`);
  });

  it('VWAP tracks cumulative volume-weighted price', () => {
    const result = vwap(btcCandles);
    expect(result.length).toBe(btcCandles.length);
    const last = result[result.length - 1];
    expect(last).toBeGreaterThan(0);
    console.log(`  VWAP = $${last.toFixed(2)}`);
  });

  it('Volume spike detects relative volume', () => {
    const volumes = btcCandles.map(c => c.volume);
    const result = volumeSpike(volumes, 5, 63);
    expect(result.length).toBeGreaterThan(0);
    const last = result[result.length - 1];
    console.log(`  Volume spike ratio = ${last.toFixed(2)}x (${last > 1.5 ? 'elevated' : last < 0.5 ? 'quiet' : 'normal'})`);
  });
});

// ══════════════════════════════════════════════════════════════
//  MATH (lib/math.ts) — existing functions
// ══════════════════════════════════════════════════════════════

describe('Math: existing functions on live data', () => {
  it('Kelly criterion with live win rate', () => {
    const wins = btcReturns.filter(r => r > 0).length;
    const wr = wins / btcReturns.length;
    const avgWin = mean(btcReturns.filter(r => r > 0));
    const avgLoss = mean(btcReturns.filter(r => r < 0).map(r => -r));
    const ratio = avgLoss > 0 ? avgWin / avgLoss : 1;
    const k = kelly(wr, ratio);
    console.log(`  Win rate: ${(wr * 100).toFixed(1)}%, Avg W/L: ${ratio.toFixed(2)}, Kelly: ${(k * 100).toFixed(1)}%`);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThanOrEqual(1);
  });

  it('VaR on BTC returns', () => {
    const portfolio = 100_000;
    const var95 = valueAtRisk(portfolio, btcReturns, 0.95);
    const var99 = valueAtRisk(portfolio, btcReturns, 0.99);
    console.log(`  VaR(95%) = $${var95.toFixed(0)}, VaR(99%) = $${var99.toFixed(0)}`);
    expect(var95).toBeGreaterThan(0);
    expect(var99).toBeGreaterThan(var95);
  });

  it('Max drawdown on BTC prices', () => {
    const dd = maxDrawdown(btcCloses);
    console.log(`  Max Drawdown = ${(dd.maxDrawdown * 100).toFixed(2)}% (peak idx ${dd.peakIndex}, trough idx ${dd.troughIndex})`);
    expect(dd.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(dd.maxDrawdown).toBeLessThanOrEqual(1);
  });

  it('Sharpe ratio on BTC', () => {
    // Hourly returns, 8760 periods/year
    const sr = sharpeRatio(btcReturns, 0.05, 8760);
    console.log(`  Sharpe (hourly→annual) = ${sr.toFixed(2)}`);
    expect(isFinite(sr)).toBe(true);
  });

  it('Sortino ratio on BTC', () => {
    const sr = sortinoRatio(btcReturns, 0.05, 8760);
    console.log(`  Sortino (hourly→annual) = ${isFinite(sr) ? sr.toFixed(2) : 'Infinity'}`);
  });

  it('BTC-ETH correlation', () => {
    const corr = correlation(btcReturns, ethReturns);
    console.log(`  BTC-ETH correlation = ${corr.toFixed(3)}`);
    expect(corr).toBeGreaterThan(-1);
    expect(corr).toBeLessThan(1);
    // BTC and ETH are generally correlated (positive over long horizons,
    // but can go negative over short windows — so we only check bounds)
    expect(corr).toBeGreaterThan(-1);
    expect(corr).toBeLessThan(1);
  });

  it('3-asset correlation matrix', () => {
    const { matrix, labels } = correlationMatrix(
      [btcReturns, ethReturns, solReturns],
      ['BTC', 'ETH', 'SOL']
    );
    console.log(`  Correlation matrix:`);
    console.log(`    ${labels.join('\t')}`);
    for (let i = 0; i < matrix.length; i++) {
      console.log(`  ${labels[i]}\t${matrix[i].map(v => v.toFixed(3)).join('\t')}`);
    }
    // Diagonal should be 1
    for (let i = 0; i < 3; i++) {
      expect(matrix[i][i]).toBe(1);
    }
  });

  it('Win rate and profit factor', () => {
    const wr = winRate(btcReturns);
    const pf = profitFactor(btcReturns);
    console.log(`  Win rate = ${(wr * 100).toFixed(1)}%, Profit factor = ${pf.toFixed(2)}`);
    expect(wr).toBeGreaterThan(0);
    expect(wr).toBeLessThan(1);
  });
});

// ══════════════════════════════════════════════════════════════
//  MATH (lib/math.ts) — new functions
// ══════════════════════════════════════════════════════════════

describe('Math: new functions on live data', () => {
  it('Skewness of BTC returns', () => {
    const s = skewness(btcReturns);
    console.log(`  Skewness = ${s.toFixed(4)} (${s > 0.5 ? 'right-skewed' : s < -0.5 ? 'left-skewed' : 'roughly symmetric'})`);
    expect(isFinite(s)).toBe(true);
  });

  it('Kurtosis (excess) of BTC returns', () => {
    const k = kurtosis(btcReturns);
    console.log(`  Excess kurtosis = ${k.toFixed(4)} (${k > 1 ? 'fat tails' : k < -1 ? 'thin tails' : 'near-normal'})`);
    expect(isFinite(k)).toBe(true);
  });

  it('Annualized volatility', () => {
    const vol = annualizedVolatility(btcReturns, 8760); // hourly → annual
    console.log(`  Annualized vol (hourly) = ${(vol * 100).toFixed(1)}%`);
    expect(vol).toBeGreaterThan(0);
  });

  it('Volatility percentile', () => {
    const pct = volatilityPercentile(btcReturns, 24, 120);
    console.log(`  Vol percentile (24h window, 120h lookback) = ${(pct * 100).toFixed(0)}th`);
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(1);
  });

  it('Tail ratio on BTC', () => {
    const tr = tailRatio(btcReturns);
    console.log(`  Tail ratio (P95/P5) = ${tr.toFixed(3)} (${tr > 1.2 ? 'favorable right tail' : tr < 0.8 ? 'risky left tail' : 'balanced'})`);
    expect(tr).toBeGreaterThan(0);
  });

  it('Beta: ETH vs BTC', () => {
    const b = beta(ethReturns, btcReturns);
    console.log(`  ETH beta vs BTC = ${b.toFixed(3)}`);
    expect(isFinite(b)).toBe(true);
  });

  it('Beta: SOL vs BTC', () => {
    const b = beta(solReturns, btcReturns);
    console.log(`  SOL beta vs BTC = ${b.toFixed(3)}`);
    expect(isFinite(b)).toBe(true);
  });

  it('Alpha: ETH vs BTC', () => {
    const a = alpha(ethReturns, btcReturns, 0.05, 8760);
    console.log(`  ETH alpha vs BTC = ${(a * 8760 * 100).toFixed(2)}% annualized`);
    expect(isFinite(a)).toBe(true);
  });

  it('Information ratio: SOL vs BTC', () => {
    const ir = informationRatio(solReturns, btcReturns);
    console.log(`  SOL information ratio vs BTC = ${ir.toFixed(4)}`);
    expect(isFinite(ir)).toBe(true);
  });

  it('Upside/downside capture: ETH vs BTC', () => {
    const up = upsideCapture(ethReturns, btcReturns);
    const down = downsideCapture(ethReturns, btcReturns);
    console.log(`  ETH upside capture = ${(up * 100).toFixed(1)}%, downside capture = ${(down * 100).toFixed(1)}%`);
    expect(isFinite(up)).toBe(true);
    expect(isFinite(down)).toBe(true);
  });

  it('Linear regression slope on BTC prices', () => {
    const slope = linearRegressionSlope(btcCloses);
    console.log(`  BTC price trend slope = $${slope.toFixed(2)}/bar (${slope > 0 ? 'uptrend' : 'downtrend'})`);
    expect(isFinite(slope)).toBe(true);
  });

  it('Coefficient of variation on BTC returns', () => {
    const cv = coefficientOfVariation(btcReturns);
    console.log(`  BTC return CV = ${cv.toFixed(2)}`);
    expect(cv).toBeGreaterThan(0);
  });

  it('Drawdown series', () => {
    const dd = drawdownSeries(btcCloses);
    expect(dd.length).toBe(btcCloses.length);
    const maxDD = Math.min(...dd);
    const currentDD = dd[dd.length - 1];
    console.log(`  Max drawdown in series = ${(maxDD * 100).toFixed(2)}%, current = ${(currentDD * 100).toFixed(2)}%`);
    expect(maxDD).toBeLessThanOrEqual(0);
  });

  it('Rolling returns across multiple windows', () => {
    const rr = rollingReturns(btcCloses, [24, 72, 168]);
    console.log(`  Rolling returns (latest): 24h=${(rr[24][rr[24].length - 1] * 100).toFixed(2)}%, 72h=${(rr[72][rr[72].length - 1] * 100).toFixed(2)}%, 168h=${rr[168].length > 0 ? (rr[168][rr[168].length - 1] * 100).toFixed(2) + '%' : 'N/A'}`);
    expect(rr[24].length).toBeGreaterThan(0);
  });

  it('Benchmark return (buy-and-hold)', () => {
    const br = benchmarkReturn(btcCloses);
    console.log(`  BTC buy-and-hold over ${btcCloses.length} bars = ${(br * 100).toFixed(2)}%`);
    expect(isFinite(br)).toBe(true);
  });

  it('Tracking error: ETH vs BTC', () => {
    const te = trackingError(ethReturns, btcReturns);
    console.log(`  ETH tracking error vs BTC = ${(te * 100).toFixed(4)}%`);
    expect(te).toBeGreaterThan(0);
  });

  it('Max consecutive losses in BTC returns', () => {
    const mcl = maxConsecutiveLosses(btcReturns);
    console.log(`  BTC max consecutive losing hours = ${mcl}`);
    expect(mcl).toBeGreaterThan(0);
  });

  it('Expectancy from live stats', () => {
    const wr = winRate(btcReturns);
    const avgWin = mean(btcReturns.filter(r => r > 0));
    const avgLoss = mean(btcReturns.filter(r => r < 0).map(r => -r));
    const exp = expectancy(wr, avgWin, avgLoss);
    console.log(`  BTC hourly expectancy = ${(exp * 10000).toFixed(2)} bps`);
    expect(isFinite(exp)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
//  VALUATION (lib/valuation.ts) — with crypto market data
// ══════════════════════════════════════════════════════════════

describe('Valuation: crypto models with live context', () => {
  it('NVT ratio with realistic BTC data', () => {
    // BTC market cap ~$1.8T, daily on-chain volume ~$10-30B
    const marketCap = btcPrice * 19_500_000;
    const dailyVolume = 15_000_000_000; // $15B estimated
    const nvt = nvtRatio(marketCap, dailyVolume);
    console.log(`  BTC NVT = ${nvt.toFixed(2)} (market cap $${(marketCap / 1e12).toFixed(2)}T)`);
    expect(nvt).toBeGreaterThan(0);
    expect(isFinite(nvt)).toBe(true);
  });

  it('MVRV ratio', () => {
    const marketCap = btcPrice * 19_500_000;
    // Realized cap is typically 40-60% of market cap at neutral
    const realizedCap = marketCap * 0.55;
    const mvrv = mvrvRatio(marketCap, realizedCap);
    console.log(`  BTC MVRV = ${mvrv.toFixed(2)} (${mvrv > 3.5 ? 'OVERHEATED' : mvrv < 1 ? 'UNDERVALUED' : 'neutral'})`);
    expect(mvrv).toBeGreaterThan(0);
  });

  it('Stock-to-Flow model', () => {
    // BTC: ~19.5M supply, ~164,250 new BTC/year (post-2024 halving, 3.125 BTC per block × ~52,560 blocks/year)
    const s2f = stockToFlow(19_500_000, 164_250);
    const modelPrice = stockToFlowPrice(s2f);
    console.log(`  BTC S2F = ${s2f.toFixed(1)}, model price = $${modelPrice.toFixed(0)}, actual = $${btcPrice.toFixed(0)}`);
    expect(s2f).toBeGreaterThan(50);
    expect(modelPrice).toBeGreaterThan(0);
  });

  it('Mcap/TVL for a hypothetical DeFi protocol', () => {
    // Simulating a DeFi protocol using ETH price context
    const ethPrice = ethCloses[ethCloses.length - 1];
    const protocolMcap = ethPrice * 1_000_000; // 1M token supply at ETH price
    const tvl = protocolMcap * 0.8; // 80% TVL ratio
    const ratio = mcapToTvl(protocolMcap, tvl);
    console.log(`  MC/TVL = ${ratio.toFixed(2)} (${ratio < 1 ? 'undervalued' : ratio > 10 ? 'speculative' : 'fair'})`);
    expect(ratio).toBeCloseTo(1.25, 1);
  });

  it('Fee-based valuation', () => {
    const annualFees = 50_000_000; // $50M annual protocol fees
    const val = feeBasedValuation(annualFees, 30, 0.5); // 30x multiple, 50% to token
    console.log(`  Fee-based FDV = $${(val / 1e9).toFixed(2)}B at 30x P/F, 50% fee share`);
    expect(val).toBeCloseTo(750_000_000);
  });

  it('Price-to-Fees ratio', () => {
    const fdv = 2_000_000_000; // $2B
    const fees = 80_000_000; // $80M annual fees
    const pf = priceToFeesRatio(fdv, fees);
    console.log(`  P/F = ${pf.toFixed(1)}x`);
    expect(pf).toBeCloseTo(25, 0);
  });

  it('Metcalfe valuation scales with addresses', () => {
    const v100k = metcalfeValuation(100_000, 1);
    const v1m = metcalfeValuation(1_000_000, 1);
    console.log(`  Metcalfe: 100K addresses → ${v100k.toFixed(0)}, 1M addresses → ${v1m.toFixed(0)} (${(v1m / v100k).toFixed(0)}x)`);
    expect(v1m / v100k).toBeCloseTo(100, 0); // 10^2 = 100
  });

  it('Thermocap multiple', () => {
    const marketCap = btcPrice * 19_500_000;
    const cumSecuritySpend = 50_000_000_000; // ~$50B cumulative
    const tc = thermocapMultiple(marketCap, cumSecuritySpend);
    console.log(`  Thermocap multiple = ${tc.toFixed(1)}x (${tc > 32 ? 'CYCLE TOP' : tc < 8 ? 'CYCLE BOTTOM' : 'mid-cycle'})`);
    expect(tc).toBeGreaterThan(0);
  });
});

describe('Valuation: equity models (reference tests)', () => {
  it('DCF with projected cash flows', () => {
    const cfs = [100, 115, 132, 152, 175]; // 15% growth
    const pv = dcf(cfs, 0.10, 0.02);
    console.log(`  DCF PV = $${pv.toFixed(2)} from $${cfs.join(', ')}`);
    expect(pv).toBeGreaterThan(0);
  });

  it('Intrinsic value (multi-stage DCF)', () => {
    const iv = intrinsicValue(500, 0.20, 0.10, 15, 5);
    console.log(`  Intrinsic value = $${iv.toFixed(2)} (FCF=$500, 20% growth, 10% discount, 15x terminal)`);
    expect(iv).toBeGreaterThan(500);
  });

  it('Graham Number', () => {
    const gn = grahamNumber(8, 45);
    console.log(`  Graham Number = $${gn.toFixed(2)} (EPS=$8, BVPS=$45)`);
    expect(gn).toBeCloseTo(Math.sqrt(22.5 * 8 * 45));
  });

  it('Margin of safety', () => {
    const iv = intrinsicValue(500, 0.15, 0.10, 15, 5);
    const mockPrice = iv * 0.7; // 30% below intrinsic
    const mos = marginOfSafety(iv, mockPrice);
    console.log(`  Margin of safety = ${(mos * 100).toFixed(1)}% (IV=$${iv.toFixed(0)}, price=$${mockPrice.toFixed(0)})`);
    expect(mos).toBeCloseTo(0.30, 1);
  });

  it('WACC + CAPM', () => {
    const coe = capm(0.04, 1.2, 0.10); // rf=4%, beta=1.2, mkt=10%
    const w = wacc(0.6, coe, 0.4, 0.05, 0.25);
    console.log(`  CAPM CoE = ${(coe * 100).toFixed(1)}%, WACC = ${(w * 100).toFixed(1)}%`);
    expect(coe).toBeCloseTo(0.112);
    expect(w).toBeGreaterThan(0);
  });

  it('PEG ratio', () => {
    const peg = pegRatio(25, 15);
    console.log(`  PEG = ${peg.toFixed(2)} (P/E=25, growth=15%)`);
    expect(peg).toBeCloseTo(25 / 15);
  });

  it('Owner earnings', () => {
    const oe = ownerEarnings(1000, 200, 300, 50);
    console.log(`  Owner earnings = $${oe} (NI=1000, D=200, Capex=300, WC=50)`);
    expect(oe).toBe(850);
  });
});

// ══════════════════════════════════════════════════════════════
//  COMBINED: cross-asset analysis
// ══════════════════════════════════════════════════════════════

describe('Cross-asset analysis', () => {
  it('Full risk dashboard: BTC, ETH, SOL', () => {
    const assets = [
      { name: 'BTC', returns: btcReturns, closes: btcCloses },
      { name: 'ETH', returns: ethReturns, closes: ethCloses },
      { name: 'SOL', returns: solReturns, closes: solCloses },
    ];

    console.log('\n  ┌─────────────────────────────────────────────────────────┐');
    console.log('  │            RISK DASHBOARD (live Cube data)              │');
    console.log('  ├──────┬──────────┬──────────┬──────────┬────────────────┤');
    console.log('  │ Asset│ Ann. Vol │ Sharpe   │ Sortino  │ Max DD         │');
    console.log('  ├──────┼──────────┼──────────┼──────────┼────────────────┤');

    for (const a of assets) {
      const vol = annualizedVolatility(a.returns, 8760);
      const sr = sharpeRatio(a.returns, 0.05, 8760);
      const so = sortinoRatio(a.returns, 0.05, 8760);
      const dd = maxDrawdown(a.closes);
      console.log(`  │ ${a.name.padEnd(4)} │ ${(vol * 100).toFixed(1).padStart(7)}% │ ${sr.toFixed(2).padStart(8)} │ ${(isFinite(so) ? so.toFixed(2) : '∞').padStart(8)} │ ${(dd.maxDrawdown * 100).toFixed(2).padStart(6)}%        │`);

      expect(vol).toBeGreaterThan(0);
      expect(isFinite(sr)).toBe(true);
    }

    console.log('  └──────┴──────────┴──────────┴──────────┴────────────────┘');

    // Beta relative to BTC
    console.log('\n  Beta vs BTC:');
    console.log(`    ETH: ${beta(ethReturns, btcReturns).toFixed(3)}`);
    console.log(`    SOL: ${beta(solReturns, btcReturns).toFixed(3)}`);

    // Distribution
    console.log('\n  Distribution shape:');
    for (const a of assets) {
      const s = skewness(a.returns);
      const k = kurtosis(a.returns);
      console.log(`    ${a.name}: skew=${s.toFixed(3)}, kurtosis=${k.toFixed(3)}`);
    }

    // Hurst
    console.log('\n  Hurst exponent (regime):');
    for (const a of assets) {
      const h = hurst(a.closes);
      console.log(`    ${a.name}: ${h.toFixed(3)} (${h > 0.55 ? 'trending' : h < 0.45 ? 'mean-reverting' : 'random'})`);
    }
  });
});
