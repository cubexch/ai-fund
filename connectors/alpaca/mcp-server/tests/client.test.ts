import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlpacaClient } from '../src/client/api';
import { mockFetch } from './helpers';

// ── Constructor / config ────────────────────────────────────

describe('AlpacaClient constructor', () => {
  it('defaults to paper trading', () => {
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: mockFetch([]) });
    expect(client.isPaper).toBe(true);
  });

  it('can be set to live', () => {
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', paper: false, fetchFn: mockFetch([]) });
    expect(client.isPaper).toBe(false);
  });

  it('reports hasCredentials correctly', () => {
    const withCreds = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: mockFetch([]) });
    expect(withCreds.hasCredentials).toBe(true);

    const noCreds = new AlpacaClient({ apiKey: '', apiSecret: '', fetchFn: mockFetch([]) });
    expect(noCreds.hasCredentials).toBe(false);
  });

  it('accepts custom base URLs', () => {
    const client = new AlpacaClient({
      apiKey: 'k', apiSecret: 's',
      tradingBaseUrl: 'https://custom.example.com',
      dataBaseUrl: 'https://custom-data.example.com',
      fetchFn: mockFetch([]),
    });
    expect(client.isPaper).toBe(false); // custom URL doesn't contain 'paper'
  });
});

// ── Account ─────────────────────────────────────────────────

describe('getAccount', () => {
  it('returns account data', async () => {
    const account = {
      id: 'acc-123',
      account_number: '123456',
      status: 'ACTIVE',
      currency: 'USD',
      buying_power: '100000.00',
      cash: '50000.00',
      portfolio_value: '75000.00',
      equity: '75000.00',
      last_equity: '74000.00',
      long_market_value: '25000.00',
      short_market_value: '0.00',
      pattern_day_trader: false,
      trading_blocked: false,
      transfers_blocked: false,
      account_blocked: false,
      daytrade_count: 0,
    };
    const fetch = mockFetch([{ body: account }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', paper: true, fetchFn: fetch });
    const result = await client.getAccount();

    expect(result.id).toBe('acc-123');
    expect(result.buying_power).toBe('100000.00');
    expect(fetch.calls[0].url).toContain('/v2/account');
    expect(fetch.calls[0].init?.headers).toHaveProperty('APCA-API-KEY-ID', 'k');
    expect(fetch.calls[0].init?.headers).toHaveProperty('APCA-API-SECRET-KEY', 's');
  });

  it('throws on API error', async () => {
    const fetch = mockFetch([{ status: 403, body: { message: 'forbidden' } }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await expect(client.getAccount()).rejects.toThrow('Alpaca API error (403): forbidden');
  });

  it('throws with raw text on non-JSON error', async () => {
    const fetch = mockFetch([{
      status: 500,
      body: 'Internal Server Error',
    }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await expect(client.getAccount()).rejects.toThrow('Alpaca API error (500)');
  });
});

// ── Positions ───────────────────────────────────────────────

describe('getPositions', () => {
  it('returns array of positions', async () => {
    const positions = [
      {
        asset_id: 'a1', symbol: 'AAPL', exchange: 'NASDAQ', asset_class: 'us_equity',
        avg_entry_price: '150.00', qty: '10', side: 'long',
        market_value: '1700.00', cost_basis: '1500.00',
        unrealized_pl: '200.00', unrealized_plpc: '0.1333',
        current_price: '170.00', lastday_price: '165.00', change_today: '0.0303',
      },
    ];
    const fetch = mockFetch([{ body: positions }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getPositions();

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('AAPL');
    expect(fetch.calls[0].url).toContain('/v2/positions');
  });
});

describe('getPosition', () => {
  it('returns a single position', async () => {
    const position = {
      asset_id: 'a1', symbol: 'AAPL', exchange: 'NASDAQ', asset_class: 'us_equity',
      avg_entry_price: '150.00', qty: '10', side: 'long',
      market_value: '1700.00', cost_basis: '1500.00',
      unrealized_pl: '200.00', unrealized_plpc: '0.1333',
      current_price: '170.00', lastday_price: '165.00', change_today: '0.0303',
    };
    const fetch = mockFetch([{ body: position }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getPosition('AAPL');

    expect(result.symbol).toBe('AAPL');
    expect(fetch.calls[0].url).toContain('/v2/positions/AAPL');
  });
});

describe('closePosition', () => {
  it('closes a full position', async () => {
    const order = { id: 'ord-1', symbol: 'AAPL', side: 'sell', type: 'market', qty: '10', status: 'pending' };
    const fetch = mockFetch([{ body: order }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.closePosition('AAPL');

    expect(result.id).toBe('ord-1');
    expect(fetch.calls[0].init?.method).toBe('DELETE');
    expect(fetch.calls[0].url).toContain('/v2/positions/AAPL');
    expect(fetch.calls[0].url).not.toContain('?');
  });

  it('closes partial position by qty', async () => {
    const order = { id: 'ord-2', symbol: 'AAPL', side: 'sell', type: 'market', qty: '5', status: 'pending' };
    const fetch = mockFetch([{ body: order }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.closePosition('AAPL', { qty: '5' });

    expect(fetch.calls[0].url).toContain('qty=5');
  });

  it('closes partial position by percentage', async () => {
    const order = { id: 'ord-3', symbol: 'AAPL', side: 'sell', type: 'market', qty: '5', status: 'pending' };
    const fetch = mockFetch([{ body: order }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.closePosition('AAPL', { percentage: '50' });

    expect(fetch.calls[0].url).toContain('percentage=50');
  });
});

describe('closeAllPositions', () => {
  it('closes all positions with cancel_orders', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.closeAllPositions(true);

    expect(fetch.calls[0].url).toContain('cancel_orders=true');
    expect(fetch.calls[0].init?.method).toBe('DELETE');
  });

  it('closes all positions without cancel_orders', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.closeAllPositions();

    expect(fetch.calls[0].url).not.toContain('cancel_orders');
  });
});

// ── Orders ──────────────────────────────────────────────────

describe('getOrders', () => {
  it('returns orders with default params', async () => {
    const orders = [{ id: 'ord-1', symbol: 'AAPL', status: 'filled' }];
    const fetch = mockFetch([{ body: orders }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getOrders();

    expect(result).toHaveLength(1);
    expect(fetch.calls[0].url).toContain('/v2/orders');
  });

  it('passes filter params', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getOrders({
      status: 'closed',
      limit: 10,
      direction: 'desc',
      symbols: ['AAPL', 'TSLA'],
    });

    const url = fetch.calls[0].url;
    expect(url).toContain('status=closed');
    expect(url).toContain('limit=10');
    expect(url).toContain('direction=desc');
    expect(url).toContain('symbols=AAPL%2CTSLA');
  });

  it('passes after and until params', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getOrders({ after: '2024-01-01', until: '2024-12-31' });

    const url = fetch.calls[0].url;
    expect(url).toContain('after=2024-01-01');
    expect(url).toContain('until=2024-12-31');
  });
});

describe('getOrder', () => {
  it('fetches a single order', async () => {
    const order = { id: 'ord-42', symbol: 'TSLA' };
    const fetch = mockFetch([{ body: order }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getOrder('ord-42');

    expect(result.id).toBe('ord-42');
    expect(fetch.calls[0].url).toContain('/v2/orders/ord-42');
  });
});

describe('placeOrder', () => {
  it('places a market order', async () => {
    const order = {
      id: 'ord-new', client_order_id: 'co-1', symbol: 'AAPL',
      side: 'buy', type: 'market', qty: '10', status: 'accepted',
      time_in_force: 'day', submitted_at: '2024-01-01T10:00:00Z',
    };
    const fetch = mockFetch([{ body: order }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.placeOrder({
      symbol: 'AAPL', side: 'buy', type: 'market', qty: '10', time_in_force: 'day',
    });

    expect(result.id).toBe('ord-new');
    expect(fetch.calls[0].init?.method).toBe('POST');
    const body = JSON.parse(fetch.calls[0].init?.body as string);
    expect(body.symbol).toBe('AAPL');
    expect(body.qty).toBe('10');
  });

  it('places a limit order with limit_price', async () => {
    const order = { id: 'ord-lmt', symbol: 'TSLA', type: 'limit', limit_price: '200.00' };
    const fetch = mockFetch([{ body: order }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.placeOrder({
      symbol: 'TSLA', side: 'buy', type: 'limit', qty: '5',
      time_in_force: 'gtc', limit_price: '200.00',
    });

    const body = JSON.parse(fetch.calls[0].init?.body as string);
    expect(body.limit_price).toBe('200.00');
    expect(body.time_in_force).toBe('gtc');
  });
});

describe('cancelOrder', () => {
  it('cancels an order (204 response)', async () => {
    const fetch = mockFetch([{ status: 204 }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await expect(client.cancelOrder('ord-1')).resolves.toBeUndefined();

    expect(fetch.calls[0].init?.method).toBe('DELETE');
    expect(fetch.calls[0].url).toContain('/v2/orders/ord-1');
  });
});

describe('cancelAllOrders', () => {
  it('cancels all orders', async () => {
    const results = [{ id: 'ord-1', status: 200, body: {} }];
    const fetch = mockFetch([{ body: results }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const res = await client.cancelAllOrders();

    expect(res).toHaveLength(1);
    expect(fetch.calls[0].init?.method).toBe('DELETE');
    expect(fetch.calls[0].url).toContain('/v2/orders');
    expect(fetch.calls[0].url).not.toContain('/v2/orders/');
  });
});

// ── Modify Order ────────────────────────────────────────────

describe('modifyOrder', () => {
  it('modifies an order', async () => {
    const order = { id: 'ord-1', symbol: 'AAPL', type: 'limit', limit_price: '155.00', qty: '10', status: 'accepted' };
    const fetch = mockFetch([{ body: order }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.modifyOrder('ord-1', { limit_price: '155.00' });

    expect(result.limit_price).toBe('155.00');
    expect(fetch.calls[0].init?.method).toBe('PATCH');
    expect(fetch.calls[0].url).toContain('/v2/orders/ord-1');
    const body = JSON.parse(fetch.calls[0].init?.body as string);
    expect(body.limit_price).toBe('155.00');
  });
});

// ── Activities (fills) ──────────────────────────────────────

describe('getActivities', () => {
  it('returns FILL activities', async () => {
    const activities = [{
      id: 'act-1', activity_type: 'FILL', symbol: 'AAPL', side: 'buy',
      qty: '10', price: '150.50', cum_qty: '10', leaves_qty: '0',
      order_id: 'ord-1', transaction_time: '2024-01-01T10:00:00Z', type: 'fill',
    }];
    const fetch = mockFetch([{ body: activities }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getActivities('FILL');

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('AAPL');
    expect(fetch.calls[0].url).toContain('/v2/account/activities/FILL');
  });

  it('returns all activities without type filter', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getActivities();

    expect(fetch.calls[0].url).toContain('/v2/account/activities');
    expect(fetch.calls[0].url).not.toContain('/v2/account/activities/');
  });

  it('passes filter params', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getActivities('FILL', {
      after: '2024-01-01',
      until: '2024-12-31',
      pageSize: 10,
      symbols: ['AAPL', 'TSLA'],
      direction: 'desc',
    });

    const url = fetch.calls[0].url;
    expect(url).toContain('after=2024-01-01');
    expect(url).toContain('until=2024-12-31');
    expect(url).toContain('page_size=10');
    expect(url).toContain('symbols=AAPL%2CTSLA');
    expect(url).toContain('direction=desc');
  });

  it('passes date param', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getActivities('FILL', { date: '2024-06-15' });

    expect(fetch.calls[0].url).toContain('date=2024-06-15');
  });
});

// ── Market Data ─────────────────────────────────────────────

describe('getTrades', () => {
  it('returns trades for a symbol', async () => {
    const tradesResp = {
      trades: [
        { t: '2024-01-01T10:00:00Z', x: 'N', p: 150.5, s: 100, c: ['@'], i: 1, z: 'A' },
        { t: '2024-01-01T10:00:01Z', x: 'Q', p: 150.6, s: 50, c: ['@'], i: 2, z: 'A' },
      ],
      next_page_token: null,
    };
    const fetch = mockFetch([{ body: tradesResp }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getTrades('AAPL', { limit: 10 });

    expect(result).toHaveLength(2);
    expect(result[0].p).toBe(150.5);
    expect(fetch.calls[0].url).toContain('/v2/stocks/AAPL/trades');
    expect(fetch.calls[0].url).toContain('limit=10');
  });

  it('passes start and end params', async () => {
    const fetch = mockFetch([{ body: { trades: [], next_page_token: null } }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getTrades('AAPL', { start: '2024-01-01', end: '2024-01-31' });

    const url = fetch.calls[0].url;
    expect(url).toContain('start=2024-01-01');
    expect(url).toContain('end=2024-01-31');
  });

  it('works without options', async () => {
    const fetch = mockFetch([{ body: { trades: [], next_page_token: null } }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getTrades('AAPL');

    expect(fetch.calls[0].url).toContain('/v2/stocks/AAPL/trades');
    expect(fetch.calls[0].url).not.toContain('?');
  });
});

describe('getBars', () => {
  it('returns bars for a symbol', async () => {
    const barsResp = {
      bars: [
        { t: '2024-01-01T00:00:00Z', o: 150, h: 155, l: 148, c: 153, v: 1000, n: 50, vw: 151.5 },
        { t: '2024-01-02T00:00:00Z', o: 153, h: 158, l: 152, c: 157, v: 1200, n: 60, vw: 155.0 },
      ],
      next_page_token: null,
    };
    const fetch = mockFetch([{ body: barsResp }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const bars = await client.getBars('AAPL', { timeframe: '1Day', limit: 10 });

    expect(bars).toHaveLength(2);
    expect(bars[0].o).toBe(150);
    expect(fetch.calls[0].url).toContain('/v2/stocks/AAPL/bars');
    expect(fetch.calls[0].url).toContain('timeframe=1Day');
    expect(fetch.calls[0].url).toContain('limit=10');
  });

  it('passes start and end params', async () => {
    const fetch = mockFetch([{ body: { bars: [], next_page_token: null } }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getBars('TSLA', {
      timeframe: '1Hour',
      start: '2024-01-01',
      end: '2024-01-31',
    });

    const url = fetch.calls[0].url;
    expect(url).toContain('start=2024-01-01');
    expect(url).toContain('end=2024-01-31');
  });
});

describe('getLatestQuote', () => {
  it('returns latest quote', async () => {
    const quoteResp = {
      quote: {
        t: '2024-01-01T10:00:00Z', ax: 'N', ap: 151.0, as: 100,
        bx: 'N', bp: 150.5, bs: 200,
      },
    };
    const fetch = mockFetch([{ body: quoteResp }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const quote = await client.getLatestQuote('AAPL');

    expect(quote.bp).toBe(150.5);
    expect(quote.ap).toBe(151.0);
    expect(fetch.calls[0].url).toContain('/v2/stocks/AAPL/quotes/latest');
  });
});

describe('getSnapshots', () => {
  it('returns snapshots for multiple symbols', async () => {
    const snapshots = {
      AAPL: {
        latestTrade: { t: '2024-01-01T10:00:00Z', p: 170, s: 100 },
        latestQuote: { t: '2024-01-01T10:00:00Z', ax: 'N', ap: 170.5, as: 100, bx: 'N', bp: 169.5, bs: 200 },
        minuteBar: { t: '2024-01-01T10:00:00Z', o: 169, h: 171, l: 168, c: 170, v: 500, n: 20, vw: 169.5 },
        dailyBar: { t: '2024-01-01T00:00:00Z', o: 168, h: 172, l: 167, c: 170, v: 10000, n: 500, vw: 169.8 },
        prevDailyBar: { t: '2023-12-31T00:00:00Z', o: 165, h: 169, l: 164, c: 168, v: 9000, n: 450, vw: 167.0 },
      },
    };
    const fetch = mockFetch([{ body: snapshots }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getSnapshots(['AAPL', 'TSLA']);

    expect(result.AAPL.latestTrade.p).toBe(170);
    expect(fetch.calls[0].url).toContain('symbols=AAPL%2CTSLA');
  });
});

// ── Assets ──────────────────────────────────────────────────

describe('getAssets', () => {
  it('returns assets with filters', async () => {
    const assets = [
      { id: 'a1', class: 'us_equity', exchange: 'NASDAQ', symbol: 'AAPL', name: 'Apple Inc.',
        status: 'active', tradable: true, marginable: true, shortable: true, fractionable: true },
    ];
    const fetch = mockFetch([{ body: assets }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getAssets({ status: 'active', asset_class: 'us_equity' });

    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('AAPL');
    expect(fetch.calls[0].url).toContain('status=active');
    expect(fetch.calls[0].url).toContain('asset_class=us_equity');
  });

  it('returns all assets without filters', async () => {
    const fetch = mockFetch([{ body: [] }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getAssets();

    expect(fetch.calls[0].url).toContain('/v2/assets');
    expect(fetch.calls[0].url).not.toContain('?');
  });
});

describe('getAsset', () => {
  it('returns a single asset', async () => {
    const asset = {
      id: 'a1', class: 'us_equity', exchange: 'NASDAQ', symbol: 'AAPL',
      name: 'Apple Inc.', status: 'active', tradable: true,
      marginable: true, shortable: true, fractionable: true,
    };
    const fetch = mockFetch([{ body: asset }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getAsset('AAPL');

    expect(result.symbol).toBe('AAPL');
    expect(fetch.calls[0].url).toContain('/v2/assets/AAPL');
  });
});

// ── Clock ───────────────────────────────────────────────────

describe('getClock', () => {
  it('returns market clock', async () => {
    const clock = {
      timestamp: '2024-01-02T10:00:00-05:00',
      is_open: true,
      next_open: '2024-01-03T09:30:00-05:00',
      next_close: '2024-01-02T16:00:00-05:00',
    };
    const fetch = mockFetch([{ body: clock }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    const result = await client.getClock();

    expect(result.is_open).toBe(true);
    expect(fetch.calls[0].url).toContain('/v2/clock');
  });
});

// ── Error handling ──────────────────────────────────────────

describe('error handling', () => {
  it('includes error message from JSON response', async () => {
    const fetch = mockFetch([{ status: 422, body: { message: 'insufficient qty' } }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await expect(client.placeOrder({
      symbol: 'AAPL', side: 'buy', type: 'market', qty: '99999', time_in_force: 'day',
    })).rejects.toThrow('insufficient qty');
  });

  it('uses paper base URL by default', async () => {
    const fetch = mockFetch([{ body: {} }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getAccount();

    expect(fetch.calls[0].url).toContain('paper-api.alpaca.markets');
  });

  it('uses live base URL when paper=false', async () => {
    const fetch = mockFetch([{ body: {} }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', paper: false, fetchFn: fetch });
    await client.getAccount();

    expect(fetch.calls[0].url).toContain('api.alpaca.markets');
    expect(fetch.calls[0].url).not.toContain('paper');
  });

  it('uses data base URL for market data', async () => {
    const fetch = mockFetch([{ body: { quote: { t: '', ax: '', ap: 0, as: 0, bx: '', bp: 0, bs: 0 } } }]);
    const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', fetchFn: fetch });
    await client.getLatestQuote('AAPL');

    expect(fetch.calls[0].url).toContain('data.alpaca.markets');
  });
});
