/**
 * Integration tests hitting real public exchange APIs.
 * No API keys needed — these test unauthenticated endpoints only.
 *
 * These may be skipped in CI if network is unavailable.
 * Run manually: npx vitest run tests/public-api.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { ExchangeClient } from '../src/client/exchange.js';

// Use coinbase — well-known, public endpoints work without auth
const client = new ExchangeClient({ exchangeId: 'coinbase' });

describe('public API — coinbase (no auth)', () => {
  it('loads markets and returns valid market shapes', async () => {
    const markets = await client.loadMarkets();

    expect(markets.length).toBeGreaterThan(0);

    // Verify shape of each market
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

  it('fetches BTC/USD ticker with valid shape', async () => {
    const ticker = await client.getTicker('BTC/USD');

    expect(ticker.symbol).toBe('BTC/USD');
    expect(typeof ticker.last).toBe('number');
    expect(ticker.last).toBeGreaterThan(0);
    expect(typeof ticker.bid).toBe('number');
    expect(typeof ticker.ask).toBe('number');
    expect(ticker.ask!).toBeGreaterThanOrEqual(ticker.bid!);
    expect(typeof ticker.volume).toBe('number');
    expect(typeof ticker.timestamp).toBe('number');
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

  it('fetches OHLCV bars with valid shape', async () => {
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

  it('fetches order book with valid shape', async () => {
    const ob = await client.getOrderBook('BTC/USD', 5);

    expect(ob.symbol).toBe('BTC/USD');
    expect(ob.bids.length).toBeGreaterThan(0);
    expect(ob.asks.length).toBeGreaterThan(0);

    // Each level is [price, amount]
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

  it('fetches recent trades with valid shape', async () => {
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

  it('confirms hasCredentials is false without keys', () => {
    expect(client.hasCredentials).toBe(false);
  });

  it('throws on invalid symbol gracefully', async () => {
    await expect(client.getTicker('INVALID_SYMBOL_XYZ/USD'))
      .rejects.toThrow();
  }, 15000);
});
