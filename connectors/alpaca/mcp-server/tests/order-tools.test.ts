import { describe, it, expect } from 'vitest';
import { AlpacaClient } from '../src/client/api';
import { registerOrderTools } from '../src/tools/orders';
import { MockMcpServer, mockFetch } from './helpers';

function setup(responses: { status?: number; body?: unknown }[]) {
  const fetch = mockFetch(responses);
  const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', paper: true, fetchFn: fetch });
  const server = new MockMcpServer();
  registerOrderTools(server as any, client);
  return { server, fetch };
}

const mockOrder = {
  id: 'ord-1',
  client_order_id: 'co-1',
  created_at: '2024-01-01T10:00:00Z',
  updated_at: '2024-01-01T10:00:00Z',
  submitted_at: '2024-01-01T10:00:00Z',
  filled_at: null,
  expired_at: null,
  canceled_at: null,
  asset_id: 'a1',
  symbol: 'AAPL',
  asset_class: 'us_equity',
  qty: '10',
  filled_qty: '0',
  filled_avg_price: null,
  order_class: 'simple',
  type: 'market',
  side: 'buy',
  time_in_force: 'day',
  limit_price: null,
  stop_price: null,
  status: 'accepted',
};

// ── place_order ─────────────────────────────────────────────

describe('place_order tool', () => {
  it('places a market buy order', async () => {
    const { server, fetch } = setup([{ body: mockOrder }]);
    const result = await server.callTool('place_order', {
      symbol: 'AAPL', side: 'buy', type: 'market', qty: '10', time_in_force: 'day',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.orderId).toBe('ord-1');
    expect(data.symbol).toBe('AAPL');
    expect(data.side).toBe('buy');
    expect(data.type).toBe('market');
    expect(data.status).toBe('accepted');

    const body = JSON.parse(fetch.calls[0].init?.body as string);
    expect(body.symbol).toBe('AAPL');
    expect(body.side).toBe('buy');
    expect(body.qty).toBe('10');
  });

  it('places a limit order with price', async () => {
    const limitOrder = { ...mockOrder, type: 'limit', limit_price: '150.00' };
    const { server, fetch } = setup([{ body: limitOrder }]);
    const result = await server.callTool('place_order', {
      symbol: 'AAPL', side: 'buy', type: 'limit', qty: '10',
      time_in_force: 'gtc', limit_price: '150.00',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.limitPrice).toBe('150.00');

    const body = JSON.parse(fetch.calls[0].init?.body as string);
    expect(body.limit_price).toBe('150.00');
    expect(body.time_in_force).toBe('gtc');
  });

  it('places a stop_limit order', async () => {
    const stopLimitOrder = {
      ...mockOrder, type: 'stop_limit', limit_price: '148.00', stop_price: '149.00',
    };
    const { server } = setup([{ body: stopLimitOrder }]);
    const result = await server.callTool('place_order', {
      symbol: 'AAPL', side: 'sell', type: 'stop_limit', qty: '5',
      time_in_force: 'day', limit_price: '148.00', stop_price: '149.00',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.limitPrice).toBe('148.00');
    expect(data.stopPrice).toBe('149.00');
  });

  it('places a notional order', async () => {
    const { server, fetch } = setup([{ body: mockOrder }]);
    await server.callTool('place_order', {
      symbol: 'AAPL', side: 'buy', type: 'market',
      notional: '1000', time_in_force: 'day',
    });

    const body = JSON.parse(fetch.calls[0].init?.body as string);
    expect(body.notional).toBe('1000');
    expect(body.qty).toBeUndefined();
  });

  it('places a trailing_stop order', async () => {
    const trailOrder = { ...mockOrder, type: 'trailing_stop' };
    const { server, fetch } = setup([{ body: trailOrder }]);
    await server.callTool('place_order', {
      symbol: 'AAPL', side: 'sell', type: 'trailing_stop', qty: '10',
      time_in_force: 'day', trail_percent: '2',
    });

    const body = JSON.parse(fetch.calls[0].init?.body as string);
    expect(body.trail_percent).toBe('2');
  });

  it('returns error on rejected order', async () => {
    const { server } = setup([{ status: 422, body: { message: 'insufficient buying power' } }]);
    const result = await server.callTool('place_order', {
      symbol: 'AAPL', side: 'buy', type: 'market', qty: '999999', time_in_force: 'day',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('insufficient buying power');
  });
});

// ── get_orders ──────────────────────────────────────────────

describe('get_orders tool', () => {
  it('returns formatted orders', async () => {
    const filledOrder = {
      ...mockOrder,
      status: 'filled',
      filled_qty: '10',
      filled_avg_price: '151.50',
      filled_at: '2024-01-01T10:01:00Z',
    };
    const { server } = setup([{ body: [filledOrder] }]);
    const result = await server.callTool('get_orders', { status: 'closed', limit: 10 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].orderId).toBe('ord-1');
    expect(data[0].filledQty).toBe('10');
    expect(data[0].filledAvgPrice).toBe('151.50');
    expect(data[0].filledAt).toBe('2024-01-01T10:01:00Z');
  });

  it('passes symbols filter', async () => {
    const { server, fetch } = setup([{ body: [] }]);
    await server.callTool('get_orders', { status: 'open', limit: 50, symbols: 'AAPL,TSLA' });

    expect(fetch.calls[0].url).toContain('symbols=AAPL%2CTSLA');
  });

  it('returns empty array when no orders', async () => {
    const { server } = setup([{ body: [] }]);
    const result = await server.callTool('get_orders', { status: 'open' });

    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual([]);
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'server error' } }]);
    const result = await server.callTool('get_orders', { status: 'all' });

    expect(result.isError).toBe(true);
  });
});

// ── get_order ───────────────────────────────────────────────

describe('get_order tool', () => {
  it('returns a specific order', async () => {
    const { server } = setup([{ body: mockOrder }]);
    const result = await server.callTool('get_order', { order_id: 'ord-1' });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe('ord-1');
  });

  it('returns error for non-existent order', async () => {
    const { server } = setup([{ status: 404, body: { message: 'order not found' } }]);
    const result = await server.callTool('get_order', { order_id: 'fake' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('order not found');
  });
});

// ── cancel_order ────────────────────────────────────────────

describe('cancel_order tool', () => {
  it('cancels an order successfully', async () => {
    const { server } = setup([{ status: 204 }]);
    const result = await server.callTool('cancel_order', { order_id: 'ord-1' });

    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('cancelled');
    expect(data.orderId).toBe('ord-1');
  });

  it('returns error for already filled order', async () => {
    const { server } = setup([{ status: 422, body: { message: 'order is not cancelable' } }]);
    const result = await server.callTool('cancel_order', { order_id: 'ord-filled' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not cancelable');
  });
});

// ── cancel_all_orders ───────────────────────────────────────

describe('cancel_all_orders tool', () => {
  it('cancels all open orders', async () => {
    const results = [
      { id: 'ord-1', status: 200, body: {} },
      { id: 'ord-2', status: 200, body: {} },
    ];
    const { server } = setup([{ body: results }]);
    const result = await server.callTool('cancel_all_orders');

    const data = JSON.parse(result.content[0].text);
    expect(data.cancelled).toBe(2);
    expect(data.orders).toHaveLength(2);
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'server error' } }]);
    const result = await server.callTool('cancel_all_orders');

    expect(result.isError).toBe(true);
  });
});

// ── modify_order ────────────────────────────────────────────

describe('modify_order tool', () => {
  it('modifies an order successfully', async () => {
    const modifiedOrder = { ...mockOrder, limit_price: '155.00', type: 'limit' };
    const { server, fetch } = setup([{ body: modifiedOrder }]);
    const result = await server.callTool('modify_order', {
      order_id: 'ord-1', limit_price: '155.00',
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.orderId).toBe('ord-1');
    expect(data.limitPrice).toBe('155.00');
    expect(fetch.calls[0].init?.method).toBe('PATCH');
  });

  it('modifies qty and stop_price', async () => {
    const modifiedOrder = { ...mockOrder, qty: '20', stop_price: '145.00' };
    const { server, fetch } = setup([{ body: modifiedOrder }]);
    await server.callTool('modify_order', {
      order_id: 'ord-1', qty: '20', stop_price: '145.00',
    });

    const body = JSON.parse(fetch.calls[0].init?.body as string);
    expect(body.qty).toBe('20');
    expect(body.stop_price).toBe('145.00');
  });

  it('returns error for filled order', async () => {
    const { server } = setup([{ status: 422, body: { message: 'order is not open' } }]);
    const result = await server.callTool('modify_order', {
      order_id: 'ord-filled', qty: '5',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not open');
  });
});

// ── get_order_history ───────────────────────────────────────

describe('get_order_history tool', () => {
  it('returns closed orders', async () => {
    const filledOrder = {
      ...mockOrder,
      status: 'filled',
      filled_qty: '10',
      filled_avg_price: '151.50',
      filled_at: '2024-01-01T10:01:00Z',
    };
    const { server, fetch } = setup([{ body: [filledOrder] }]);
    const result = await server.callTool('get_order_history', { limit: 10 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].status).toBe('filled');
    expect(data[0].filledAvgPrice).toBe('151.50');

    // Should use status=closed and direction=desc
    expect(fetch.calls[0].url).toContain('status=closed');
    expect(fetch.calls[0].url).toContain('direction=desc');
  });

  it('passes after and until params', async () => {
    const { server, fetch } = setup([{ body: [] }]);
    await server.callTool('get_order_history', {
      limit: 50, after: '2024-01-01', until: '2024-06-30',
    });

    const url = fetch.calls[0].url;
    expect(url).toContain('after=2024-01-01');
    expect(url).toContain('until=2024-06-30');
  });

  it('passes symbols filter', async () => {
    const { server, fetch } = setup([{ body: [] }]);
    await server.callTool('get_order_history', {
      limit: 50, symbols: 'AAPL,TSLA',
    });

    expect(fetch.calls[0].url).toContain('symbols=AAPL%2CTSLA');
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'server error' } }]);
    const result = await server.callTool('get_order_history', { limit: 10 });

    expect(result.isError).toBe(true);
  });
});

// ── get_fills ───────────────────────────────────────────────

describe('get_fills tool', () => {
  it('returns formatted fills', async () => {
    const activities = [{
      id: 'act-1', activity_type: 'FILL', symbol: 'AAPL', side: 'buy',
      qty: '10', price: '150.50', cum_qty: '10', leaves_qty: '0',
      order_id: 'ord-1', transaction_time: '2024-01-01T10:00:00Z', type: 'fill',
    }];
    const { server, fetch } = setup([{ body: activities }]);
    const result = await server.callTool('get_fills', { limit: 50 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].symbol).toBe('AAPL');
    expect(data[0].price).toBe('150.50');
    expect(data[0].orderId).toBe('ord-1');
    expect(data[0].transactionTime).toBe('2024-01-01T10:00:00Z');

    expect(fetch.calls[0].url).toContain('/v2/account/activities/FILL');
  });

  it('passes symbols and date filters', async () => {
    const { server, fetch } = setup([{ body: [] }]);
    await server.callTool('get_fills', {
      limit: 10, symbols: 'AAPL,TSLA', after: '2024-01-01', until: '2024-06-30',
    });

    const url = fetch.calls[0].url;
    expect(url).toContain('symbols=AAPL%2CTSLA');
    expect(url).toContain('after=2024-01-01');
    expect(url).toContain('until=2024-06-30');
  });

  it('returns empty fills', async () => {
    const { server } = setup([{ body: [] }]);
    const result = await server.callTool('get_fills', { limit: 50 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual([]);
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'server error' } }]);
    const result = await server.callTool('get_fills', { limit: 50 });

    expect(result.isError).toBe(true);
  });
});
