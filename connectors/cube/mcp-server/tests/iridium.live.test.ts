import { describe, it, expect, beforeAll } from 'vitest';
import { IridiumClient } from '../src/client/iridium';
import type { Ticker, Market, Kline, ParsedOrderBook, ParsedRecentTrades } from '../src/client/iridium';

/**
 * Live tests for the Cube Exchange Iridium client.
 * These hit the real production API (public endpoints only).
 * They are opt-in and do not run in the default unit/integration path.
 */

let client: IridiumClient;

beforeAll(() => {
  // Public endpoints don't need auth
  process.env.CUBE_ENV = 'production';
  client = new IridiumClient();
});

describe('Markets (GET /markets)', () => {
  let markets: Market[];

  it('fetches markets successfully', async () => {
    markets = await client.getMarkets();
    expect(markets).toBeDefined();
    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBeGreaterThan(0);
  });

  it('returns markets with required fields', async () => {
    markets = markets || await client.getMarkets();
    const market = markets[0];
    expect(market).toHaveProperty('marketId');
    expect(market).toHaveProperty('symbol');
    expect(market).toHaveProperty('baseAssetId');
    expect(market).toHaveProperty('quoteAssetId');
    expect(market).toHaveProperty('status');
  });

  it('includes BTCUSDC market', async () => {
    markets = markets || await client.getMarkets();
    const btc = markets.find(m => m.symbol === 'BTCUSDC');
    expect(btc).toBeDefined();
    expect(btc!.marketId).toBe(100004);
  });
});

describe('Tickers (GET /md/parsed/tickers)', () => {
  let tickers: Ticker[];

  it('fetches tickers successfully', async () => {
    tickers = await client.getTickers();
    expect(tickers).toBeDefined();
    expect(Array.isArray(tickers)).toBe(true);
    expect(tickers.length).toBeGreaterThan(0);
  });

  it('returns tickers with parsed human-readable prices', async () => {
    tickers = tickers || await client.getTickers();
    const btc = tickers.find(t => t.symbol === 'BTCUSDC');
    expect(btc).toBeDefined();
    expect(btc!.baseAsset).toBe('BTC');
    expect(btc!.quoteAsset).toBe('USDC');
    // BTC price should be a reasonable number (not raw lots)
    if (btc!.lastPrice !== null) {
      expect(btc!.lastPrice).toBeGreaterThan(1000);
      expect(btc!.lastPrice).toBeLessThan(1_000_000);
    }
  });

  it('includes bid/ask prices', async () => {
    tickers = tickers || await client.getTickers();
    const btc = tickers.find(t => t.symbol === 'BTCUSDC');
    expect(btc).toBeDefined();
    // Bid/ask may be null if no orders, but type should be correct
    if (btc!.bidPrice !== null) {
      expect(typeof btc!.bidPrice).toBe('number');
      expect(btc!.bidPrice).toBeGreaterThan(0);
    }
  });

  it('computes 24h change percentage', async () => {
    tickers = tickers || await client.getTickers();
    const btc = tickers.find(t => t.symbol === 'BTCUSDC');
    if (btc!.change24h !== null) {
      expect(typeof btc!.change24h).toBe('number');
      // Change should be a reasonable percentage
      expect(Math.abs(btc!.change24h)).toBeLessThan(100);
    }
  });

  it('includes volume data', async () => {
    tickers = tickers || await client.getTickers();
    const btc = tickers.find(t => t.symbol === 'BTCUSDC');
    expect(btc).toBeDefined();
    expect(typeof btc!.baseVolume24h).toBe('number');
    expect(typeof btc!.quoteVolume24h).toBe('number');
  });
});

describe('Order Book (GET /md/parsed/book/{symbol}/snapshot)', () => {
  it('fetches BTCUSDC order book', async () => {
    const book: ParsedOrderBook = await client.getOrderBook('BTCUSDC');
    expect(book).toBeDefined();
    expect(book.ticker_id).toBe('BTCUSDC');
    expect(Array.isArray(book.bids)).toBe(true);
    expect(Array.isArray(book.asks)).toBe(true);
  });

  it('returns price/quantity tuples', async () => {
    const book = await client.getOrderBook('BTCUSDC');
    if (book.bids.length > 0) {
      const [price, qty] = book.bids[0];
      expect(typeof price).toBe('number');
      expect(typeof qty).toBe('number');
      expect(price).toBeGreaterThan(1000); // BTC price, not raw lots
    }
  });

  it('bids are sorted descending by price', async () => {
    const book = await client.getOrderBook('BTCUSDC');
    for (let i = 1; i < book.bids.length; i++) {
      expect(book.bids[i - 1][0]).toBeGreaterThanOrEqual(book.bids[i][0]);
    }
  });

  it('asks are sorted ascending by price', async () => {
    const book = await client.getOrderBook('BTCUSDC');
    for (let i = 1; i < book.asks.length; i++) {
      expect(book.asks[i - 1][0]).toBeLessThanOrEqual(book.asks[i][0]);
    }
  });
});

describe('Recent Trades (GET /md/parsed/book/{symbol}/recent-trades)', () => {
  it('fetches recent trades for BTCUSDC', async () => {
    const trades: ParsedRecentTrades = await client.getRecentTrades('BTCUSDC');
    expect(trades).toBeDefined();
    expect(trades.ticker_id).toBe('BTCUSDC');
    expect(Array.isArray(trades.trades)).toBe(true);
  });

  it('trades have expected fields', async () => {
    const trades = await client.getRecentTrades('BTCUSDC');
    if (trades.trades.length > 0) {
      const trade = trades.trades[0];
      // API returns short field names: id, p, q, qq, ts, s
      expect(trade).toHaveProperty('id');
      expect(trade).toHaveProperty('p');
      expect(typeof (trade as any).p).toBe('number');
    }
  });
});

describe('Price History (GET /history/klines)', () => {
  it('fetches klines for BTCUSDC', async () => {
    const klines: Kline[] = await client.getPriceHistory(100004, '1h', 10);
    expect(klines).toBeDefined();
    expect(Array.isArray(klines)).toBe(true);
    expect(klines.length).toBeGreaterThan(0);
    expect(klines.length).toBeLessThanOrEqual(10);
  });

  it('klines have OHLCV fields', async () => {
    const klines = await client.getPriceHistory(100004, '1h', 5);
    const k = klines[0];
    expect(k).toHaveProperty('open');
    expect(k).toHaveProperty('high');
    expect(k).toHaveProperty('low');
    expect(k).toHaveProperty('close');
    expect(k).toHaveProperty('volume');
    expect(k).toHaveProperty('startTime');
    expect(k).toHaveProperty('interval');
    expect(k.interval).toBe('1h');
  });

  it('klines are ordered by time (descending from API)', async () => {
    const klines = await client.getPriceHistory(100004, '1h', 10);
    // API returns most recent first
    for (let i = 1; i < klines.length; i++) {
      expect(klines[i].startTime).toBeLessThanOrEqual(klines[i - 1].startTime);
    }
  });
});

describe('Error handling', () => {
  it('throws on invalid market symbol for order book', async () => {
    await expect(client.getOrderBook('INVALIDXYZ')).rejects.toThrow();
  });

  it('throws on invalid market ID for klines', async () => {
    await expect(client.getPriceHistory(999999999, '1h', 1)).rejects.toThrow();
  });
});
