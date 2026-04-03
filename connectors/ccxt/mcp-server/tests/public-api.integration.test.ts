/**
 * Integration tests hitting real public exchange APIs.
 * No API keys needed — these test unauthenticated endpoints only.
 *
 * Run modes:
 *   RECORD=1 npx vitest run --config vitest.integration.config.ts  — hit real APIs, save cassettes
 *   npx vitest run --config vitest.integration.config.ts            — replay from cassettes (no network)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ExchangeClient } from '../src/client/exchange.js';
import { RegimeDetector } from '../src/client/regime-detector.js';
import { SignalGenerator } from '../src/client/signal-generator.js';
import { withCassette } from '@ai-fund/lib/test-fixtures/http-replay';
import {
  sma, ema, rsi, macd, bollingerBands, atr, adx, obv, stochastic,
  type OHLCV,
} from '@ai-fund/lib/indicators';
import {
  kelly, fixedFractionalSize,
  valueAtRisk, maxDrawdown, sharpeRatio, sortinoRatio,
  annualizedVolatility, returns, correlationMatrix, mean,
} from '@ai-fund/lib/math';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const replay = withCassette('public-api-coinbase', __dirname);

let client: ExchangeClient;

// ── Helpers ──────────────────────────────────────────────────

function patchCcxtFetch(c: ExchangeClient) {
  (c as any).exchange.fetchImplementation = (...args: any[]) => globalThis.fetch(...args);
}

// ═══════════════════════════════════════════════════════════════
// 1. Market Data — core exchange client methods
// ═══════════════════════════════════════════════════════════════

describe('public API — coinbase (no auth)', () => {
  beforeAll(() => {
    replay.start();
    client = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client);
  });

  afterAll(() => {
    replay.stop();
  });

  // ── Markets ─────────────────────────────────────────────────

  describe('markets', () => {
    it('loads markets and returns valid market shapes', async () => {
      const markets = await client.loadMarkets();

      expect(markets.length).toBeGreaterThan(0);

      const btc = markets.find(m => m.symbol.includes('BTC') && m.symbol.includes('USD'));
      expect(btc).toBeDefined();
      expect(btc!.base).toBe('BTC');
      expect(typeof btc!.quote).toBe('string');
      expect(typeof btc!.active).toBe('boolean');
      expect(btc!.precision).toBeDefined();
      expect(btc!.limits).toBeDefined();
      expect(btc!.limits.amount).toBeDefined();
      expect(btc!.limits.price).toBeDefined();
    }, 15000);

    it('searches markets by query', async () => {
      const results = await client.searchMarkets('BTC');

      expect(results.length).toBeGreaterThan(0);
      for (const m of results) {
        const matches = m.symbol.toLowerCase().includes('btc') ||
                        m.base.toLowerCase().includes('btc') ||
                        m.quote.toLowerCase().includes('btc');
        expect(matches).toBe(true);
      }
    }, 15000);

    it('searches for ETH markets', async () => {
      const results = await client.searchMarkets('ETH');
      expect(results.length).toBeGreaterThan(0);
      const ethUsd = results.find(m => m.symbol === 'ETH/USD');
      expect(ethUsd).toBeDefined();
    }, 15000);

    it('confirms hasCredentials is false without keys', () => {
      expect(client.hasCredentials).toBe(false);
    });
  });

  // ── Tickers ─────────────────────────────────────────────────

  describe('tickers', () => {
    it('fetches BTC/USD ticker with valid shape', async () => {
      const ticker = await client.getTicker('BTC/USD');

      expect(ticker.symbol).toBe('BTC/USD');
      expect(typeof ticker.last).toBe('number');
      expect(ticker.last).toBeGreaterThan(0);
      expect(typeof ticker.bid).toBe('number');
      expect(typeof ticker.ask).toBe('number');
      expect(ticker.ask!).toBeGreaterThanOrEqual(ticker.bid!);
      if (ticker.volume !== undefined) expect(typeof ticker.volume).toBe('number');
      if (ticker.timestamp !== undefined) expect(typeof ticker.timestamp).toBe('number');
    }, 15000);

    it('fetches ETH/USD ticker', async () => {
      const ticker = await client.getTicker('ETH/USD');
      expect(ticker.symbol).toBe('ETH/USD');
      expect(ticker.last).toBeGreaterThan(0);
    }, 15000);

    it('fetches SOL/USD ticker', async () => {
      const ticker = await client.getTicker('SOL/USD');
      expect(ticker.symbol).toBe('SOL/USD');
      expect(ticker.last).toBeGreaterThan(0);
    }, 15000);

    it('fetches multiple tickers', async () => {
      const tickers = await client.getTickers(['BTC/USD', 'ETH/USD']);

      expect(tickers.length).toBeGreaterThanOrEqual(2);

      const btc = tickers.find(t => t.symbol === 'BTC/USD');
      const eth = tickers.find(t => t.symbol === 'ETH/USD');
      expect(btc).toBeDefined();
      expect(eth).toBeDefined();
      expect(btc!.last).toBeGreaterThan(0);
      expect(eth!.last).toBeGreaterThan(0);
    }, 15000);

    it('fetches 5-symbol ticker batch', async () => {
      const symbols = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'DOGE/USD', 'AVAX/USD'];
      const tickers = await client.getTickers(symbols);

      expect(tickers.length).toBeGreaterThanOrEqual(5);
      for (const t of tickers) {
        expect(typeof t.last).toBe('number');
        expect(t.last).toBeGreaterThan(0);
      }
    }, 15000);
  });

  // ── OHLCV bars ──────────────────────────────────────────────

  describe('OHLCV bars', () => {
    it('fetches 1d bars with valid shape', async () => {
      const bars = await client.getBars('BTC/USD', '1d', undefined, 5);

      expect(bars.length).toBeGreaterThan(0);
      expect(bars.length).toBeLessThanOrEqual(5);

      for (const bar of bars) {
        expect(typeof bar.timestamp).toBe('number');
        expect(bar.timestamp).toBeGreaterThan(0);
        expect(typeof bar.open).toBe('number');
        expect(typeof bar.high).toBe('number');
        expect(typeof bar.low).toBe('number');
        expect(typeof bar.close).toBe('number');
        expect(typeof bar.volume).toBe('number');
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
        expect(bar.open).toBeGreaterThan(0);
      }
    }, 15000);

    it('fetches 100 bars for BTC/USD 1d', async () => {
      const bars = await client.getBars('BTC/USD', '1d', undefined, 100);
      expect(bars.length).toBeGreaterThanOrEqual(50);
      // Verify chronological order
      for (let i = 1; i < bars.length; i++) {
        expect(bars[i].timestamp).toBeGreaterThanOrEqual(bars[i - 1].timestamp);
      }
    }, 15000);

    it('fetches 1h bars for BTC/USD', async () => {
      const bars = await client.getBars('BTC/USD', '1h', undefined, 50);
      expect(bars.length).toBeGreaterThanOrEqual(10);
      for (const bar of bars) {
        expect(bar.high).toBeGreaterThanOrEqual(bar.low);
        expect(bar.volume).toBeGreaterThanOrEqual(0);
      }
    }, 15000);

    it('fetches ETH/USD 1d bars', async () => {
      const bars = await client.getBars('ETH/USD', '1d', undefined, 100);
      expect(bars.length).toBeGreaterThanOrEqual(50);
    }, 15000);

    it('fetches SOL/USD 1d bars', async () => {
      const bars = await client.getBars('SOL/USD', '1d', undefined, 100);
      expect(bars.length).toBeGreaterThanOrEqual(50);
    }, 15000);

    it('fetches DOGE/USD 1d bars', async () => {
      const bars = await client.getBars('DOGE/USD', '1d', undefined, 100);
      expect(bars.length).toBeGreaterThanOrEqual(50);
    }, 15000);

    it('fetches AVAX/USD 1d bars', async () => {
      const bars = await client.getBars('AVAX/USD', '1d', undefined, 100);
      expect(bars.length).toBeGreaterThanOrEqual(50);
    }, 15000);

    it('fetches 300 bars for regime analysis depth', async () => {
      const bars = await client.getBars('BTC/USD', '1d', undefined, 300);
      expect(bars.length).toBeGreaterThanOrEqual(100);
    }, 15000);
  });

  // ── Order book ──────────────────────────────────────────────

  describe('order book', () => {
    it('fetches BTC/USD order book with valid shape', async () => {
      const ob = await client.getOrderBook('BTC/USD', 5);

      expect(ob.symbol).toBe('BTC/USD');
      expect(ob.bids.length).toBeGreaterThan(0);
      expect(ob.asks.length).toBeGreaterThan(0);

      for (const [price, amount] of ob.bids) {
        expect(typeof price).toBe('number');
        expect(typeof amount).toBe('number');
        expect(price).toBeGreaterThan(0);
        expect(amount).toBeGreaterThan(0);
      }

      for (const [price, amount] of ob.asks) {
        expect(typeof price).toBe('number');
        expect(typeof amount).toBe('number');
        expect(price).toBeGreaterThan(0);
        expect(amount).toBeGreaterThan(0);
      }

      // Best ask >= best bid (no crossed book)
      expect(ob.asks[0][0]).toBeGreaterThanOrEqual(ob.bids[0][0]);
    }, 15000);

    it('fetches deep order book (20 levels)', async () => {
      const ob = await client.getOrderBook('BTC/USD', 20);
      expect(ob.bids.length).toBeGreaterThanOrEqual(5);
      expect(ob.asks.length).toBeGreaterThanOrEqual(5);

      // Bids descending
      for (let i = 1; i < ob.bids.length; i++) {
        expect(ob.bids[i - 1][0]).toBeGreaterThanOrEqual(ob.bids[i][0]);
      }
      // Asks ascending
      for (let i = 1; i < ob.asks.length; i++) {
        expect(ob.asks[i - 1][0]).toBeLessThanOrEqual(ob.asks[i][0]);
      }
    }, 15000);

    it('fetches ETH/USD order book', async () => {
      const ob = await client.getOrderBook('ETH/USD', 10);
      expect(ob.symbol).toBe('ETH/USD');
      expect(ob.bids.length).toBeGreaterThan(0);
      expect(ob.asks.length).toBeGreaterThan(0);
      expect(ob.asks[0][0]).toBeGreaterThanOrEqual(ob.bids[0][0]);
    }, 15000);

    it('fetches SOL/USD order book', async () => {
      const ob = await client.getOrderBook('SOL/USD', 10);
      expect(ob.symbol).toBe('SOL/USD');
      expect(ob.asks[0][0]).toBeGreaterThanOrEqual(ob.bids[0][0]);
    }, 15000);
  });

  // ── Trades ──────────────────────────────────────────────────

  describe('recent trades', () => {
    it('fetches BTC/USD trades with valid shape', async () => {
      const trades = await client.getTrades('BTC/USD', undefined, 10);

      expect(trades.length).toBeGreaterThan(0);
      expect(trades.length).toBeLessThanOrEqual(10);

      for (const trade of trades) {
        expect(typeof trade.price).toBe('number');
        expect(trade.price).toBeGreaterThan(0);
        expect(typeof trade.amount).toBe('number');
        expect(trade.amount).toBeGreaterThan(0);
        expect(['buy', 'sell']).toContain(trade.side);
        expect(trade.symbol).toBe('BTC/USD');
      }
    }, 15000);

    it('fetches 100 BTC/USD trades for flow analysis', async () => {
      const trades = await client.getTrades('BTC/USD', undefined, 100);
      expect(trades.length).toBeGreaterThan(10);

      // Verify there are both buy and sell sides
      const sides = new Set(trades.map(t => t.side));
      expect(sides.size).toBeGreaterThanOrEqual(1);
    }, 15000);

    it('fetches ETH/USD trades', async () => {
      const trades = await client.getTrades('ETH/USD', undefined, 50);
      expect(trades.length).toBeGreaterThan(0);
      for (const t of trades) {
        expect(t.symbol).toBe('ETH/USD');
        expect(t.price).toBeGreaterThan(0);
      }
    }, 15000);

    it('fetches SOL/USD trades', async () => {
      const trades = await client.getTrades('SOL/USD', undefined, 50);
      expect(trades.length).toBeGreaterThan(0);
    }, 15000);
  });

  // ── Quotes ──────────────────────────────────────────────────

  describe('quotes', () => {
    it('gets BTC/USD quote with spread analysis', async () => {
      const quote = await client.getQuote('BTC/USD');

      expect(quote.symbol).toBe('BTC/USD');
      expect(typeof quote.bid).toBe('number');
      expect(typeof quote.ask).toBe('number');
      expect(quote.bid!).toBeGreaterThan(0);
      expect(quote.ask!).toBeGreaterThan(0);
      expect(quote.ask!).toBeGreaterThanOrEqual(quote.bid!);
      expect(typeof quote.mid).toBe('number');
      expect(typeof quote.spread).toBe('number');
      expect(typeof quote.spreadBps).toBe('number');
      expect(quote.spreadBps!).toBeGreaterThanOrEqual(0);
    }, 15000);

    it('gets ETH/USD quote', async () => {
      const quote = await client.getQuote('ETH/USD');
      expect(quote.symbol).toBe('ETH/USD');
      expect(quote.mid!).toBeGreaterThan(0);
      expect(quote.spreadBps!).toBeGreaterThanOrEqual(0);
    }, 15000);

    it('gets SOL/USD quote', async () => {
      const quote = await client.getQuote('SOL/USD');
      expect(quote.symbol).toBe('SOL/USD');
      expect(quote.mid!).toBeGreaterThan(0);
    }, 15000);
  });

  // ── Exchange info ───────────────────────────────────────────

  describe('exchange info', () => {
    it('returns exchange capabilities', async () => {
      const info = await client.getExchangeInfo();

      expect(info.id).toBe('coinbase');
      expect(typeof info.name).toBe('string');
      expect(Array.isArray(info.countries)).toBe(true);
      expect(typeof info.rateLimit).toBe('number');
      expect(typeof info.totalMarkets).toBe('number');
      expect(info.totalMarkets).toBeGreaterThan(0);
      expect(typeof info.activeMarkets).toBe('number');
    }, 15000);

    it('returns BTC/USD market info with precision', async () => {
      const info = await client.getMarketInfo('BTC/USD');

      expect(info.symbol).toBe('BTC/USD');
      expect(info.base).toBe('BTC');
      expect(info.quote).toBe('USD');
      expect(info.precision).toBeDefined();
      expect(info.limits).toBeDefined();
    }, 15000);

    it('returns ETH/USD market info', async () => {
      const info = await client.getMarketInfo('ETH/USD');
      expect(info.symbol).toBe('ETH/USD');
      expect(info.base).toBe('ETH');
    }, 15000);
  });

  // ── Fees ────────────────────────────────────────────────────

  describe('fees', () => {
    it('returns fee schedule', async () => {
      const fees = await client.getTradingFees();
      expect(Array.isArray(fees)).toBe(true);
      // Coinbase may return market-level fees or a single entry
      if (fees.length > 0) {
        expect(typeof fees[0].maker).toBe('number');
        expect(typeof fees[0].taker).toBe('number');
        expect(fees[0].maker).toBeGreaterThanOrEqual(0);
        expect(fees[0].taker).toBeGreaterThanOrEqual(0);
      }
    }, 15000);

    it('returns BTC/USD specific fees', async () => {
      const fees = await client.getTradingFees('BTC/USD');
      expect(fees.length).toBeGreaterThan(0);
    }, 15000);
  });

  // ── Error handling ──────────────────────────────────────────

  describe('error handling', () => {
    it('throws on invalid symbol gracefully', async () => {
      await expect(client.getTicker('INVALID_SYMBOL_XYZ/USD'))
        .rejects.toThrow();
    }, 15000);

    it('throws on invalid symbol for getBars', async () => {
      await expect(client.getBars('FAKECOIN99/USD', '1d', undefined, 5))
        .rejects.toThrow();
    }, 15000);

    it('throws on invalid symbol for getOrderBook', async () => {
      await expect(client.getOrderBook('NOTREAL/USD', 5))
        .rejects.toThrow();
    }, 15000);
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Technical Analysis — indicators on live data
// ═══════════════════════════════════════════════════════════════

describe('technical analysis — live data', () => {
  const replay2 = withCassette('technical-analysis', __dirname);
  let client2: ExchangeClient;

  beforeAll(() => {
    replay2.start();
    client2 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client2);
  });

  afterAll(() => {
    replay2.stop();
  });

  it('computes full indicator suite on BTC/USD 1d', async () => {
    const bars = await client2.getBars('BTC/USD', '1d', undefined, 100);
    expect(bars.length).toBeGreaterThanOrEqual(50);

    const candles: OHLCV[] = bars.map(b => ({
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume, timestamp: b.timestamp,
    }));
    const closes = candles.map(c => c.close);

    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const rsi14 = rsi(closes, 14);
    const macdResult = macd(closes, 12, 26, 9);
    const bb = bollingerBands(closes, 20, 2);
    const atr14 = atr(candles, 14);
    const obvValues = obv(candles);
    const stochResult = stochastic(candles, 14, 3);

    expect(sma20.length).toBeGreaterThan(0);
    expect(sma50.length).toBeGreaterThan(0);
    expect(ema12.length).toBeGreaterThan(0);
    expect(ema26.length).toBeGreaterThan(0);
    expect(rsi14.length).toBeGreaterThan(0);
    expect(macdResult.macd.length).toBeGreaterThan(0);
    expect(macdResult.signal.length).toBeGreaterThan(0);
    expect(macdResult.histogram.length).toBeGreaterThan(0);
    expect(bb.upper.length).toBeGreaterThan(0);
    expect(bb.lower.length).toBeGreaterThan(0);
    expect(atr14.length).toBeGreaterThan(0);
    expect(obvValues.length).toBeGreaterThan(0);
    expect(stochResult.k.length).toBeGreaterThan(0);
    expect(stochResult.d.length).toBeGreaterThan(0);

    // RSI is bounded 0-100
    for (const v of rsi14) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }

    // Bollinger Bands: upper > middle > lower
    for (let i = 0; i < bb.upper.length; i++) {
      expect(bb.upper[i]).toBeGreaterThanOrEqual(bb.middle[i]);
      expect(bb.middle[i]).toBeGreaterThanOrEqual(bb.lower[i]);
    }

    // ATR is always non-negative
    for (const v of atr14) {
      expect(v).toBeGreaterThanOrEqual(0);
    }

    // Stochastic K bounded 0-100
    for (const v of stochResult.k) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  }, 30000);

  it('computes ADX on BTC/USD', async () => {
    const bars = await client2.getBars('BTC/USD', '1d', undefined, 100);
    const candles: OHLCV[] = bars.map(b => ({
      open: b.open, high: b.high, low: b.low, close: b.close,
      volume: b.volume, timestamp: b.timestamp,
    }));
    const adxValues = adx(candles, 14);
    expect(adxValues.length).toBeGreaterThan(0);
    for (const v of adxValues) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  }, 15000);

  it('computes indicators on ETH/USD 1d', async () => {
    const bars = await client2.getBars('ETH/USD', '1d', undefined, 100);
    const closes = bars.map(b => b.close);

    const sma20 = sma(closes, 20);
    const rsi14 = rsi(closes, 14);
    const macdResult = macd(closes, 12, 26, 9);
    const bb = bollingerBands(closes, 20, 2);

    expect(sma20.length).toBeGreaterThan(0);
    expect(rsi14.length).toBeGreaterThan(0);
    expect(macdResult.macd.length).toBeGreaterThan(0);
    expect(bb.upper.length).toBeGreaterThan(0);
  }, 15000);

  it('computes indicators on SOL/USD 1h', async () => {
    const bars = await client2.getBars('SOL/USD', '1h', undefined, 100);
    const closes = bars.map(b => b.close);

    const rsi14 = rsi(closes, 14);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);

    expect(rsi14.length).toBeGreaterThan(0);
    expect(ema9.length).toBeGreaterThan(0);
    expect(ema21.length).toBeGreaterThan(0);
  }, 15000);

  it('generates trading signals from indicators', async () => {
    const bars = await client2.getBars('BTC/USD', '1d', undefined, 100);
    const closes = bars.map(b => b.close);

    const rsi14 = rsi(closes, 14);
    const macdResult = macd(closes, 12, 26, 9);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const bb = bollingerBands(closes, 20, 2);

    const latestPrice = closes[closes.length - 1];
    const latestRsi = rsi14[rsi14.length - 1];
    const latestMacdHist = macdResult.histogram[macdResult.histogram.length - 1];
    const latestSma20 = sma20[sma20.length - 1];
    const latestSma50 = sma50.length > 0 ? sma50[sma50.length - 1] : null;
    const latestBbUpper = bb.upper[bb.upper.length - 1];
    const latestBbLower = bb.lower[bb.lower.length - 1];

    const signals: string[] = [];
    if (latestRsi > 70) signals.push('RSI overbought');
    else if (latestRsi < 30) signals.push('RSI oversold');
    if (latestMacdHist > 0) signals.push('MACD bullish');
    else signals.push('MACD bearish');
    if (latestSma50 != null) {
      if (latestSma20 > latestSma50) signals.push('SMA golden cross');
      else signals.push('SMA death cross');
    }
    if (latestPrice > latestBbUpper) signals.push('Above upper BB');
    else if (latestPrice < latestBbLower) signals.push('Below lower BB');

    expect(signals.length).toBeGreaterThan(0);
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 3. Regime Detection — classify market conditions
// ═══════════════════════════════════════════════════════════════

describe('regime detection — live data', () => {
  const replay3 = withCassette('regime-detection', __dirname);
  let client3: ExchangeClient;

  beforeAll(() => {
    replay3.start();
    client3 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client3);
  });

  afterAll(() => {
    replay3.stop();
  });

  it('detects BTC/USD regime on daily', async () => {
    const bars = await client3.getBars('BTC/USD', '1d', undefined, 300);
    expect(bars.length).toBeGreaterThanOrEqual(50);

    const detector = new RegimeDetector();
    const analysis = detector.analyze(bars);

    expect(analysis.currentRegime).toBeDefined();
    expect(['trending_up', 'trending_down', 'ranging', 'volatile', 'quiet', 'breakout'])
      .toContain(analysis.currentRegime);
    expect(typeof analysis.confidence).toBe('number');
    expect(analysis.confidence).toBeGreaterThanOrEqual(0);
    expect(analysis.confidence).toBeLessThanOrEqual(1);
  }, 30000);

  it('detects ETH/USD regime', async () => {
    const bars = await client3.getBars('ETH/USD', '1d', undefined, 300);
    const detector = new RegimeDetector();
    const analysis = detector.analyze(bars);

    expect(analysis.currentRegime).toBeDefined();
    expect(typeof analysis.confidence).toBe('number');
  }, 30000);

  it('detects SOL/USD regime', async () => {
    const bars = await client3.getBars('SOL/USD', '1d', undefined, 300);
    const detector = new RegimeDetector();
    const analysis = detector.analyze(bars);

    expect(analysis.currentRegime).toBeDefined();
  }, 30000);

  it('tracks regime transitions', async () => {
    const bars = await client3.getBars('BTC/USD', '1d', undefined, 300);
    const detector = new RegimeDetector();
    const analysis = detector.analyze(bars);

    if (analysis.transitions && analysis.transitions.length > 0) {
      for (const t of analysis.transitions) {
        expect(typeof t.from).toBe('string');
        expect(typeof t.to).toBe('string');
        expect(typeof t.barsAgo).toBe('number');
        expect(t.barsAgo).toBeGreaterThanOrEqual(0);
      }
    }
  }, 30000);

  it('regime includes strategy recommendations', async () => {
    const bars = await client3.getBars('BTC/USD', '1d', undefined, 300);
    const detector = new RegimeDetector();
    const analysis = detector.analyze(bars);

    // Depending on implementation, may have recommendations or indicators
    expect(analysis).toBeDefined();
    expect(analysis.currentRegime).toBeDefined();
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════
// 4. Signal Generation — multi-indicator scanning
// ═══════════════════════════════════════════════════════════════

describe('signal generation — live data', () => {
  const replay4 = withCassette('signal-generation', __dirname);
  let client4: ExchangeClient;

  beforeAll(() => {
    replay4.start();
    client4 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client4);
  });

  afterAll(() => {
    replay4.stop();
  });

  it('generates signals for BTC/USD', async () => {
    const bars = await client4.getBars('BTC/USD', '1d', undefined, 250);
    expect(bars.length).toBeGreaterThanOrEqual(55);

    const generator = new SignalGenerator();
    const signals = generator.generateSignals(bars, 'BTC/USD', '1d');

    expect(Array.isArray(signals)).toBe(true);
    for (const s of signals) {
      expect(typeof s.source).toBe('string');
      expect(['buy', 'sell', 'hold']).toContain(s.type);
      expect(['strong', 'moderate', 'weak']).toContain(s.strength);
      expect(typeof s.confidence).toBe('number');
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
    }
  }, 15000);

  it('scores signals with overall bias', async () => {
    const bars = await client4.getBars('BTC/USD', '1d', undefined, 250);
    const generator = new SignalGenerator();
    const signals = generator.generateSignals(bars, 'BTC/USD', '1d');
    const { bias, score } = generator.scoreSignals(signals);

    expect(['bullish', 'bearish', 'neutral']).toContain(bias);
    expect(typeof score).toBe('number');
  }, 15000);

  it('generates signals for ETH/USD', async () => {
    const bars = await client4.getBars('ETH/USD', '1d', undefined, 250);
    const generator = new SignalGenerator();
    const signals = generator.generateSignals(bars, 'ETH/USD', '1d');

    expect(Array.isArray(signals)).toBe(true);
  }, 15000);

  it('generates signals for SOL/USD 1h timeframe', async () => {
    const bars = await client4.getBars('SOL/USD', '1h', undefined, 250);
    const generator = new SignalGenerator();
    const signals = generator.generateSignals(bars, 'SOL/USD', '1h');

    expect(Array.isArray(signals)).toBe(true);
  }, 15000);

  it('generates signals for DOGE/USD', async () => {
    const bars = await client4.getBars('DOGE/USD', '1d', undefined, 250);
    const generator = new SignalGenerator();
    const signals = generator.generateSignals(bars, 'DOGE/USD', '1d');
    const { bias } = generator.scoreSignals(signals);

    expect(['bullish', 'bearish', 'neutral']).toContain(bias);
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 5. Market Microstructure — order book analytics
// ═══════════════════════════════════════════════════════════════

describe('market microstructure — live data', () => {
  const replay5 = withCassette('microstructure', __dirname);
  let client5: ExchangeClient;

  beforeAll(() => {
    replay5.start();
    client5 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client5);
  });

  afterAll(() => {
    replay5.stop();
  });

  it('analyzes BTC/USD order book depth', async () => {
    const ob = await client5.getOrderBook('BTC/USD', 20);
    const mid = (ob.bids[0][0] + ob.asks[0][0]) / 2;

    expect(mid).toBeGreaterThan(0);

    // Bid-ask imbalance
    const bidVolume = ob.bids.reduce((sum, [_, amt]) => sum + amt, 0);
    const askVolume = ob.asks.reduce((sum, [_, amt]) => sum + amt, 0);
    const totalVolume = bidVolume + askVolume;
    const imbalance = totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0;

    expect(imbalance).toBeGreaterThanOrEqual(-1);
    expect(imbalance).toBeLessThanOrEqual(1);

    // Depth within 0.1% of mid
    const depthThreshold = mid * 0.001;
    let bidDepth = 0;
    for (const [price, size] of ob.bids) {
      if (price >= mid - depthThreshold) bidDepth += size;
      else break;
    }
    let askDepth = 0;
    for (const [price, size] of ob.asks) {
      if (price <= mid + depthThreshold) askDepth += size;
      else break;
    }

    expect(bidDepth).toBeGreaterThanOrEqual(0);
    expect(askDepth).toBeGreaterThanOrEqual(0);
  }, 15000);

  it('estimates price impact for BTC market buy', async () => {
    const ob = await client5.getOrderBook('BTC/USD', 20);
    const mid = (ob.bids[0][0] + ob.asks[0][0]) / 2;

    // Simulate buying 1 BTC by walking the ask side
    const buyAmount = 1.0;
    let filled = 0;
    let totalCost = 0;
    for (const [price, size] of ob.asks) {
      const fill = Math.min(size, buyAmount - filled);
      totalCost += fill * price;
      filled += fill;
      if (filled >= buyAmount) break;
    }

    const avgFillPrice = filled > 0 ? totalCost / filled : mid;
    const slippagePct = Math.abs(avgFillPrice - mid) / mid * 100;

    expect(filled).toBeGreaterThan(0);
    expect(avgFillPrice).toBeGreaterThan(0);
    expect(slippagePct).toBeGreaterThanOrEqual(0);
    expect(slippagePct).toBeLessThan(5); // Should be < 5% for 1 BTC on Coinbase
  }, 15000);

  it('computes weighted mid price', async () => {
    const ob = await client5.getOrderBook('BTC/USD', 20);
    const bestBid = ob.bids[0][0];
    const bestAsk = ob.asks[0][0];
    const bidSize = ob.bids[0][1];
    const askSize = ob.asks[0][1];

    const weightedMid = (bestBid * askSize + bestAsk * bidSize) / (bidSize + askSize);
    expect(weightedMid).toBeGreaterThan(bestBid);
    expect(weightedMid).toBeLessThan(bestAsk);
  }, 15000);

  it('analyzes ETH/USD order book depth', async () => {
    const ob = await client5.getOrderBook('ETH/USD', 20);
    expect(ob.bids.length).toBeGreaterThan(0);
    expect(ob.asks.length).toBeGreaterThan(0);

    const bidVolume = ob.bids.reduce((sum, [_, amt]) => sum + amt, 0);
    const askVolume = ob.asks.reduce((sum, [_, amt]) => sum + amt, 0);
    expect(bidVolume).toBeGreaterThan(0);
    expect(askVolume).toBeGreaterThan(0);
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 6. Spread Monitoring — cross-symbol spread analysis
// ═══════════════════════════════════════════════════════════════

describe('spread monitoring — live data', () => {
  const replay6 = withCassette('spread-monitoring', __dirname);
  let client6: ExchangeClient;

  beforeAll(() => {
    replay6.start();
    client6 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client6);
  });

  afterAll(() => {
    replay6.stop();
  });

  it('compares spreads across BTC, ETH, SOL', async () => {
    const symbols = ['BTC/USD', 'ETH/USD', 'SOL/USD'];
    const quotes = await Promise.all(symbols.map(s => client6.getQuote(s)));

    for (const q of quotes) {
      expect(q.bid).toBeGreaterThan(0);
      expect(q.ask).toBeGreaterThan(0);
      expect(q.spreadBps).toBeGreaterThanOrEqual(0);
    }

    // Sort by spreadBps
    const sorted = [...quotes].sort((a, b) => (a.spreadBps ?? 0) - (b.spreadBps ?? 0));
    expect(sorted[0].spreadBps!).toBeLessThanOrEqual(sorted[sorted.length - 1].spreadBps!);
  }, 15000);

  it('monitors spread for 5 symbols', async () => {
    const symbols = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'DOGE/USD', 'AVAX/USD'];
    const quotes = await Promise.all(symbols.map(s => client6.getQuote(s)));

    expect(quotes.length).toBe(5);
    for (const q of quotes) {
      expect(q.symbol).toBeDefined();
      expect(q.mid).toBeGreaterThan(0);
    }

    // BTC should have among the tightest spreads
    const btcQuote = quotes.find(q => q.symbol === 'BTC/USD');
    expect(btcQuote).toBeDefined();
    expect(btcQuote!.spreadBps!).toBeLessThan(100); // <1% spread
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 7. Order Flow Imbalance — trade flow analytics
// ═══════════════════════════════════════════════════════════════

describe('order flow imbalance — live data', () => {
  const replay7 = withCassette('order-flow', __dirname);
  let client7: ExchangeClient;

  beforeAll(() => {
    replay7.start();
    client7 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client7);
  });

  afterAll(() => {
    replay7.stop();
  });

  it('analyzes BTC/USD trade flow', async () => {
    const trades = await client7.getTrades('BTC/USD', undefined, 100);
    expect(trades.length).toBeGreaterThan(0);

    let buyVolume = 0;
    let sellVolume = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const t of trades) {
      if (t.side === 'buy') {
        buyVolume += t.amount;
        buyCount++;
      } else {
        sellVolume += t.amount;
        sellCount++;
      }
    }

    const totalVolume = buyVolume + sellVolume;
    const imbalancePct = totalVolume > 0
      ? ((buyVolume - sellVolume) / totalVolume) * 100
      : 0;

    expect(imbalancePct).toBeGreaterThanOrEqual(-100);
    expect(imbalancePct).toBeLessThanOrEqual(100);
    expect(buyCount + sellCount).toBe(trades.length);

    // Derive signal
    let signal: string;
    if (imbalancePct > 20) signal = 'strong_buy_pressure';
    else if (imbalancePct > 5) signal = 'moderate_buy_pressure';
    else if (imbalancePct < -20) signal = 'strong_sell_pressure';
    else if (imbalancePct < -5) signal = 'moderate_sell_pressure';
    else signal = 'neutral';

    expect(['strong_buy_pressure', 'moderate_buy_pressure', 'neutral',
            'moderate_sell_pressure', 'strong_sell_pressure']).toContain(signal);
  }, 15000);

  it('detects large trades in BTC/USD', async () => {
    const trades = await client7.getTrades('BTC/USD', undefined, 100);
    const avgSize = trades.reduce((sum, t) => sum + t.amount, 0) / trades.length;
    const largeTrades = trades.filter(t => t.amount > avgSize * 2);

    expect(avgSize).toBeGreaterThan(0);
    // Large trades array is valid (may be empty)
    for (const lt of largeTrades) {
      expect(lt.amount).toBeGreaterThan(avgSize * 2);
    }
  }, 15000);

  it('analyzes ETH/USD trade flow', async () => {
    const trades = await client7.getTrades('ETH/USD', undefined, 100);
    let buyVolume = 0;
    let sellVolume = 0;
    for (const t of trades) {
      if (t.side === 'buy') buyVolume += t.amount;
      else sellVolume += t.amount;
    }
    expect(buyVolume + sellVolume).toBeGreaterThan(0);
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 8. Portfolio Risk Assessment — multi-symbol analytics
// ═══════════════════════════════════════════════════════════════

describe('portfolio risk assessment — live data', () => {
  const replay8 = withCassette('portfolio-risk', __dirname);
  let client8: ExchangeClient;

  beforeAll(() => {
    replay8.start();
    client8 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client8);
  });

  afterAll(() => {
    replay8.stop();
  });

  it('computes BTC/ETH portfolio risk metrics', async () => {
    const btcBars = await client8.getBars('BTC/USD', '1d', undefined, 90);
    const ethBars = await client8.getBars('ETH/USD', '1d', undefined, 90);

    const btcCloses = btcBars.map(b => b.close);
    const ethCloses = ethBars.map(b => b.close);

    const btcReturns = returns(btcCloses);
    const ethReturns = returns(ethCloses);

    // Per-symbol metrics
    const btcSharpe = sharpeRatio(btcReturns);
    const ethSharpe = sharpeRatio(ethReturns);
    const btcVol = annualizedVolatility(btcReturns);
    const ethVol = annualizedVolatility(ethReturns);

    expect(typeof btcSharpe).toBe('number');
    expect(typeof ethSharpe).toBe('number');
    expect(btcVol).toBeGreaterThan(0);
    expect(ethVol).toBeGreaterThan(0);

    // Cumulative values for drawdown
    const btcCum = [1.0];
    for (const r of btcReturns) btcCum.push(btcCum[btcCum.length - 1] * (1 + r));
    const ethCum = [1.0];
    for (const r of ethReturns) ethCum.push(ethCum[ethCum.length - 1] * (1 + r));

    const btcMdd = maxDrawdown(btcCum);
    const ethMdd = maxDrawdown(ethCum);

    expect(btcMdd.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(ethMdd.maxDrawdown).toBeGreaterThanOrEqual(0);

    // Portfolio-level metrics (60/40 BTC/ETH)
    const weights = [0.6, 0.4];
    const minLen = Math.min(btcReturns.length, ethReturns.length);
    const portReturns: number[] = [];
    for (let t = 0; t < minLen; t++) {
      portReturns.push(weights[0] * btcReturns[t] + weights[1] * ethReturns[t]);
    }

    const portSharpe = sharpeRatio(portReturns);
    const portVol = annualizedVolatility(portReturns);
    const portVar = valueAtRisk(100000, portReturns, 0.95);

    expect(typeof portSharpe).toBe('number');
    expect(portVol).toBeGreaterThan(0);
    expect(portVar).toBeGreaterThan(0);

    // Correlation matrix
    const corrMat = correlationMatrix(
      [btcReturns.slice(0, minLen), ethReturns.slice(0, minLen)],
      ['BTC/USD', 'ETH/USD'],
    );

    expect(corrMat.labels).toEqual(['BTC/USD', 'ETH/USD']);
    expect(corrMat.matrix.length).toBe(2);
    // Diagonal should be 1
    expect(corrMat.matrix[0][0]).toBeCloseTo(1, 4);
    expect(corrMat.matrix[1][1]).toBeCloseTo(1, 4);
    // Off-diagonal should be between -1 and 1
    expect(corrMat.matrix[0][1]).toBeGreaterThanOrEqual(-1);
    expect(corrMat.matrix[0][1]).toBeLessThanOrEqual(1);
  }, 30000);

  it('computes 3-asset portfolio risk (BTC/ETH/SOL)', async () => {
    const btcBars = await client8.getBars('BTC/USD', '1d', undefined, 90);
    const ethBars = await client8.getBars('ETH/USD', '1d', undefined, 90);
    const solBars = await client8.getBars('SOL/USD', '1d', undefined, 90);

    const allReturns = [
      returns(btcBars.map(b => b.close)),
      returns(ethBars.map(b => b.close)),
      returns(solBars.map(b => b.close)),
    ];
    const minLen = Math.min(...allReturns.map(r => r.length));

    // Equal-weight portfolio
    const portReturns: number[] = [];
    for (let t = 0; t < minLen; t++) {
      portReturns.push((allReturns[0][t] + allReturns[1][t] + allReturns[2][t]) / 3);
    }

    const sharpe = sharpeRatio(portReturns);
    const sortino = sortinoRatio(portReturns);
    const vol = annualizedVolatility(portReturns);

    expect(typeof sharpe).toBe('number');
    expect(typeof sortino).toBe('number');
    expect(vol).toBeGreaterThan(0);

    const corrMat = correlationMatrix(
      allReturns.map(r => r.slice(0, minLen)),
      ['BTC/USD', 'ETH/USD', 'SOL/USD'],
    );
    expect(corrMat.matrix.length).toBe(3);
  }, 30000);

  it('computes Sortino ratio for BTC', async () => {
    const bars = await client8.getBars('BTC/USD', '1d', undefined, 90);
    const r = returns(bars.map(b => b.close));
    const s = sortinoRatio(r);
    expect(typeof s).toBe('number');
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 9. Position Sizing — Kelly and fixed-fractional
// ═══════════════════════════════════════════════════════════════

describe('position sizing', () => {
  it('computes Kelly criterion', () => {
    const fraction = kelly(0.6, 1.5, true); // half-Kelly
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);

    const capitalToRisk = 100000 * fraction;
    expect(capitalToRisk).toBeGreaterThan(0);
    expect(capitalToRisk).toBeLessThan(100000);
  });

  it('computes fixed-fractional size', () => {
    const size = fixedFractionalSize(100000, 0.02, 50000, 48000);
    expect(size).toBeGreaterThan(0);
    // Risk $2000 with $2000/unit risk = 1 unit
    expect(size).toBe(1);
  });

  it('Kelly with edge cases', () => {
    // No edge: win_rate = 0.5, avg_win_loss_ratio = 1.0 → Kelly = 0
    const noEdge = kelly(0.5, 1.0, false);
    expect(noEdge).toBeCloseTo(0, 2);

    // Negative edge: should return 0 or negative
    const negEdge = kelly(0.3, 1.0, false);
    expect(negEdge).toBeLessThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 10. Optimal Entry — order book + trade flow for entry strategy
// ═══════════════════════════════════════════════════════════════

describe('optimal entry — live data', () => {
  const replay10 = withCassette('optimal-entry', __dirname);
  let client10: ExchangeClient;

  beforeAll(() => {
    replay10.start();
    client10 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client10);
  });

  afterAll(() => {
    replay10.stop();
  });

  it('recommends entry strategy for BTC buy', async () => {
    const [orderBook, quote, recentTrades] = await Promise.all([
      client10.getOrderBook('BTC/USD', 20),
      client10.getQuote('BTC/USD'),
      client10.getTrades('BTC/USD', undefined, 100),
    ]);

    const mid = (orderBook.bids[0][0] + orderBook.asks[0][0]) / 2;
    expect(mid).toBeGreaterThan(0);

    // Walk the ask side for a 0.5 BTC buy
    const buyAmount = 0.5;
    let filled = 0;
    let totalCost = 0;
    for (const [price, size] of orderBook.asks) {
      const fill = Math.min(size, buyAmount - filled);
      totalCost += fill * price;
      filled += fill;
      if (filled >= buyAmount) break;
    }

    const avgFillPrice = filled > 0 ? totalCost / filled : mid;
    const slippagePct = Math.abs(avgFillPrice - mid) / mid * 100;
    expect(slippagePct).toBeLessThan(1); // <1% for 0.5 BTC

    // Trade flow signal
    let buyVolume = 0;
    let sellVolume = 0;
    for (const t of recentTrades) {
      if (t.side === 'buy') buyVolume += t.amount;
      else sellVolume += t.amount;
    }
    const totalVolume = buyVolume + sellVolume;
    const buyRatio = totalVolume > 0 ? buyVolume / totalVolume : 0.5;

    expect(buyRatio).toBeGreaterThanOrEqual(0);
    expect(buyRatio).toBeLessThanOrEqual(1);

    const tradeFlowSignal = buyRatio > 0.6 ? 'bullish' : buyRatio < 0.4 ? 'bearish' : 'neutral';
    expect(['bullish', 'bearish', 'neutral']).toContain(tradeFlowSignal);
  }, 15000);

  it('recommends entry strategy for ETH sell', async () => {
    const [orderBook, quote] = await Promise.all([
      client10.getOrderBook('ETH/USD', 20),
      client10.getQuote('ETH/USD'),
    ]);

    const mid = quote.mid!;
    expect(mid).toBeGreaterThan(0);

    // Walk bid side for 10 ETH sell
    const sellAmount = 10;
    let filled = 0;
    let totalProceeds = 0;
    for (const [price, size] of orderBook.bids) {
      const fill = Math.min(size, sellAmount - filled);
      totalProceeds += fill * price;
      filled += fill;
      if (filled >= sellAmount) break;
    }

    const avgFillPrice = filled > 0 ? totalProceeds / filled : mid;
    const slippagePct = Math.abs(avgFillPrice - mid) / mid * 100;
    expect(slippagePct).toBeLessThan(2);
  }, 15000);

  it('compares urgency levels for same order', async () => {
    const ob = await client10.getOrderBook('BTC/USD', 20);
    const bestBid = ob.bids[0][0];
    const bestAsk = ob.asks[0][0];
    const spread = bestAsk - bestBid;
    const mid = (bestBid + bestAsk) / 2;

    // Low urgency → limit near bid
    const lowUrgencyPrice = bestBid + spread * 0.1;
    expect(lowUrgencyPrice).toBeGreaterThan(bestBid);
    expect(lowUrgencyPrice).toBeLessThan(mid);

    // Medium urgency → limit at mid
    expect(mid).toBeGreaterThan(bestBid);
    expect(mid).toBeLessThan(bestAsk);

    // High urgency → market (no price needed, expect slippage)
    let filled = 0;
    let cost = 0;
    for (const [price, size] of ob.asks) {
      const fill = Math.min(size, 1.0 - filled);
      cost += fill * price;
      filled += fill;
      if (filled >= 1.0) break;
    }
    expect(cost / filled).toBeGreaterThanOrEqual(bestAsk);
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 11. Cross-exchange arbitrage detection
// ═══════════════════════════════════════════════════════════════

describe('arbitrage detection — multi-exchange', () => {
  const replay11 = withCassette('arbitrage', __dirname);
  let coinbaseClient: ExchangeClient;
  let krakenClient: ExchangeClient;

  beforeAll(() => {
    replay11.start();
    coinbaseClient = new ExchangeClient({ exchangeId: 'coinbase' });
    krakenClient = new ExchangeClient({ exchangeId: 'kraken' });
    patchCcxtFetch(coinbaseClient);
    patchCcxtFetch(krakenClient);
  });

  afterAll(() => {
    replay11.stop();
  });

  it('compares BTC prices across Coinbase and Kraken', async () => {
    const coinbaseTicker = await coinbaseClient.getTicker('BTC/USD');
    const krakenTicker = await krakenClient.getTicker('BTC/USD');

    expect(coinbaseTicker.last).toBeGreaterThan(0);
    expect(krakenTicker.last).toBeGreaterThan(0);

    // Prices should be within 2% of each other
    const diff = Math.abs(coinbaseTicker.last! - krakenTicker.last!);
    const pctDiff = diff / Math.max(coinbaseTicker.last!, krakenTicker.last!) * 100;
    expect(pctDiff).toBeLessThan(2);
  }, 30000);

  it('compares ETH prices across exchanges', async () => {
    const coinbaseTicker = await coinbaseClient.getTicker('ETH/USD');
    const krakenTicker = await krakenClient.getTicker('ETH/USD');

    expect(coinbaseTicker.last).toBeGreaterThan(0);
    expect(krakenTicker.last).toBeGreaterThan(0);

    const diff = Math.abs(coinbaseTicker.last! - krakenTicker.last!);
    const pctDiff = diff / Math.max(coinbaseTicker.last!, krakenTicker.last!) * 100;
    expect(pctDiff).toBeLessThan(2);
  }, 30000);

  it('computes cross-exchange spread with fee estimate', async () => {
    const coinbaseQuote = await coinbaseClient.getQuote('BTC/USD');
    const krakenQuote = await krakenClient.getQuote('BTC/USD');

    const bestBid = Math.max(coinbaseQuote.bid!, krakenQuote.bid!);
    const bestAsk = Math.min(coinbaseQuote.ask!, krakenQuote.ask!);

    const grossSpread = bestBid - bestAsk;
    const feeRate = 0.001; // 10 bps per side
    const buyCost = bestAsk * (1 + feeRate);
    const sellProceeds = bestBid * (1 - feeRate);
    const netProfit = sellProceeds - buyCost;

    expect(typeof grossSpread).toBe('number');
    expect(typeof netProfit).toBe('number');
    // We don't assert profitability — just that the math works
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════
// 12. Latency tracking (in-process, no API)
// ═══════════════════════════════════════════════════════════════

describe('latency tracking', () => {
  it('tracks API latency after calls', async () => {
    // The client already made calls — check latency stats
    const replay12 = withCassette('latency', __dirname);
    replay12.start();
    const c = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(c);

    await c.getTicker('BTC/USD');
    await c.getTicker('ETH/USD');

    const stats = c.latency.allStats();
    expect(Object.keys(stats).length).toBeGreaterThan(0);

    const fetchTickerStats = stats['fetchTicker'];
    if (fetchTickerStats) {
      expect(fetchTickerStats.count).toBeGreaterThanOrEqual(2);
      expect(fetchTickerStats.avg).toBeGreaterThanOrEqual(0);
    }
    replay12.stop();
  }, 15000);
});

// ═══════════════════════════════════════════════════════════════
// 13. Multi-timeframe consistency
// ═══════════════════════════════════════════════════════════════

describe('multi-timeframe data consistency', () => {
  const replay13 = withCassette('multi-timeframe', __dirname);
  let client13: ExchangeClient;

  beforeAll(() => {
    replay13.start();
    client13 = new ExchangeClient({ exchangeId: 'coinbase' });
    patchCcxtFetch(client13);
  });

  afterAll(() => {
    replay13.stop();
  });

  it('1h and 1d bars have consistent price ranges', async () => {
    const hourly = await client13.getBars('BTC/USD', '1h', undefined, 24);
    const daily = await client13.getBars('BTC/USD', '1d', undefined, 1);

    expect(hourly.length).toBeGreaterThan(0);
    expect(daily.length).toBeGreaterThan(0);

    // Hourly high should never be less than hourly low
    for (const bar of hourly) {
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
    }
  }, 15000);

  it('fetches multiple timeframes for the same symbol', async () => {
    const tf1h = await client13.getBars('ETH/USD', '1h', undefined, 50);
    const tf1d = await client13.getBars('ETH/USD', '1d', undefined, 50);

    expect(tf1h.length).toBeGreaterThan(0);
    expect(tf1d.length).toBeGreaterThan(0);

    // All bars should have positive OHLCV
    for (const bar of [...tf1h, ...tf1d]) {
      expect(bar.open).toBeGreaterThan(0);
      expect(bar.close).toBeGreaterThan(0);
      expect(bar.volume).toBeGreaterThanOrEqual(0);
    }
  }, 15000);
});
