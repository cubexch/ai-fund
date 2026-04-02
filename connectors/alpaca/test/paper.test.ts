/**
 * Alpaca paper connector integration tests.
 *
 * Run against real Alpaca paper API. Requires env vars:
 *   ALPACA_API_KEY, ALPACA_SECRET_KEY
 *
 * Skip with: SKIP_INTEGRATION=true npm test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { AlpacaConnector, createAlpacaConnector } from '../index.js';

const hasKeys = !!(process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY);
const describeIf = hasKeys ? describe : describe.skip;

describeIf('Alpaca paper connector', () => {
  let connector: AlpacaConnector;

  beforeAll(async () => {
    connector = await createAlpacaConnector({
      apiKey: process.env.ALPACA_API_KEY!,
      secretKey: process.env.ALPACA_SECRET_KEY!,
      paper: true,
    });
  });

  it('getAccount() returns buying power > 0', async () => {
    const account = await connector.getAccount();
    expect(account.buyingPower).toBeGreaterThan(0);
    expect(account.currency).toBe('USD');
    expect(account.id).toBeTruthy();
  });

  it('getAccount() returns isPaper = true', () => {
    expect(connector.isPaper()).toBe(true);
    expect(connector.meta.isPaper).toBe(true);
  });

  it('getBars("AAPL", "1Day", 10) returns exactly 10 bars', async () => {
    const bars = await connector.getBars('AAPL', '1Day', 10);
    expect(bars).toHaveLength(10);
  });

  it('getBars bars have valid OHLCV values', async () => {
    const bars = await connector.getBars('AAPL', '1Day', 5);
    for (const bar of bars) {
      expect(bar.open).toBeGreaterThan(0);
      expect(bar.high).toBeGreaterThanOrEqual(bar.low);
      expect(bar.close).toBeGreaterThan(0);
      expect(bar.volume).toBeGreaterThanOrEqual(0);
      expect(bar.timestamp).toBeGreaterThan(0);
    }
  });

  it('getQuote("MSFT") returns bid < ask', async () => {
    const quote = await connector.getQuote('MSFT');
    expect(quote.symbol).toBe('MSFT');
    expect(quote.bid).toBeGreaterThan(0);
    expect(quote.ask).toBeGreaterThan(0);
    expect(quote.bid).toBeLessThanOrEqual(quote.ask);
    expect(quote.timestamp).toBeGreaterThan(0);
  });

  it('isMarketOpen() returns boolean without throwing', async () => {
    const isOpen = await connector.isMarketOpen();
    expect(typeof isOpen).toBe('boolean');
  });

  it('placeOrder market buy 1 AAPL succeeds in paper', async () => {
    const order = await connector.placeOrder({
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      qty: 1,
      timeInForce: 'gtc',
    });
    expect(order.id).toBeTruthy();
    expect(order.symbol).toBe('AAPL');
    expect(order.side).toBe('buy');
    expect(order.qty).toBe(1);
  });

  it('getPositions() returns an array', async () => {
    const positions = await connector.getPositions();
    expect(Array.isArray(positions)).toBe(true);
  });

  it('cancelOrder() succeeds on an open limit order', async () => {
    // Place a far-off limit order that won't fill
    const order = await connector.placeOrder({
      symbol: 'AAPL',
      side: 'buy',
      type: 'limit',
      qty: 1,
      limitPrice: 1.00, // way below market
      timeInForce: 'gtc',
    });
    expect(order.id).toBeTruthy();

    await connector.cancelOrder(order.id);
    // If no throw, cancel succeeded
  });

  it('cancelAllOrders() leaves no open orders', async () => {
    await connector.cancelAllOrders();
    const orders = await connector.getOrders('open');
    expect(orders.length).toBe(0);
  });

  it('getPortfolioHistory() returns arrays of equal length', async () => {
    const history = await connector.getPortfolioHistory('1W');
    expect(history.timestamps.length).toBeGreaterThan(0);
    expect(history.timestamps.length).toBe(history.equity.length);
    expect(history.timestamps.length).toBe(history.profitLoss.length);
    expect(history.timestamps.length).toBe(history.profitLossPct.length);
  });

  it('getQuote with invalid symbol returns descriptive error', async () => {
    await expect(connector.getQuote('ZZZZZZNOTREAL')).rejects.toThrow(/symbol not found/i);
  });
});

describe('Alpaca safety guards', () => {
  it('placeOrder with ALPACA_PAPER_TRADE=false throws guard error', () => {
    const liveConnector = new AlpacaConnector({
      apiKey: 'fake',
      secretKey: 'fake',
      paper: false,
    });

    expect(liveConnector.placeOrder({
      symbol: 'AAPL',
      side: 'buy',
      type: 'market',
      qty: 1,
    })).rejects.toThrow(/live trading/i);
  });
});
