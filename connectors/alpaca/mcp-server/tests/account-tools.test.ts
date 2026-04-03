import { describe, it, expect } from 'vitest';
import { AlpacaClient } from '../src/client/api';
import { registerAccountTools } from '../src/tools/account';
import { MockMcpServer, mockFetch } from './helpers';

function setup(responses: { status?: number; body?: unknown }[]) {
  const fetch = mockFetch(responses);
  const client = new AlpacaClient({ apiKey: 'k', apiSecret: 's', paper: true, fetchFn: fetch });
  const server = new MockMcpServer();
  registerAccountTools(server as any, client);
  return { server, fetch };
}

// ── get_account ─────────────────────────────────────────────

describe('get_account tool', () => {
  const mockAccount = {
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

  it('returns formatted account info', async () => {
    const { server } = setup([{ body: mockAccount }]);
    const result = await server.callTool('get_account');

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe('acc-123');
    expect(data.buyingPower).toBe('$100000.00');
    expect(data.cash).toBe('$50000.00');
    expect(data.portfolioValue).toBe('$75000.00');
    expect(data.paper).toBe(true);
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 401, body: { message: 'unauthorized' } }]);
    const result = await server.callTool('get_account');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed');
    expect(result.content[0].text).toContain('unauthorized');
  });
});

// ── get_positions ───────────────────────────────────────────

describe('get_positions tool', () => {
  it('returns formatted positions', async () => {
    const positions = [{
      asset_id: 'a1', symbol: 'AAPL', exchange: 'NASDAQ', asset_class: 'us_equity',
      avg_entry_price: '150.00', qty: '10', side: 'long',
      market_value: '1700.00', cost_basis: '1500.00',
      unrealized_pl: '200.00', unrealized_plpc: '0.1333',
      current_price: '170.00', lastday_price: '165.00', change_today: '0.0303',
    }];
    const { server } = setup([{ body: positions }]);
    const result = await server.callTool('get_positions');

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].symbol).toBe('AAPL');
    expect(data[0].qty).toBe(10);
    expect(data[0].unrealizedPl).toBe(200);
    expect(data[0].unrealizedPlPct).toBe('13.33%');
    expect(data[0].changeToday).toBe('3.03%');
    expect(data[0].assetClass).toBe('us_equity');
  });

  it('returns empty array when no positions', async () => {
    const { server } = setup([{ body: [] }]);
    const result = await server.callTool('get_positions');

    const data = JSON.parse(result.content[0].text);
    expect(data).toEqual([]);
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'internal error' } }]);
    const result = await server.callTool('get_positions');

    expect(result.isError).toBe(true);
  });
});

// ── close_position ──────────────────────────────────────────

describe('close_position tool', () => {
  it('closes a position and returns order info', async () => {
    const order = {
      id: 'ord-1', symbol: 'AAPL', side: 'sell', type: 'market',
      qty: '10', status: 'pending_new',
      client_order_id: 'co-1', created_at: '', updated_at: '', submitted_at: '',
      filled_at: null, expired_at: null, canceled_at: null,
      asset_id: 'a1', asset_class: 'us_equity', filled_qty: '0',
      filled_avg_price: null, order_class: 'simple', time_in_force: 'day',
      limit_price: null, stop_price: null,
    };
    const { server } = setup([{ body: order }]);
    const result = await server.callTool('close_position', { symbol: 'AAPL' });

    const data = JSON.parse(result.content[0].text);
    expect(data.orderId).toBe('ord-1');
    expect(data.symbol).toBe('AAPL');
    expect(data.side).toBe('sell');
  });

  it('closes partial position with qty', async () => {
    const order = { id: 'ord-2', symbol: 'AAPL', side: 'sell', type: 'market', qty: '5', status: 'pending_new' };
    const { server, fetch } = setup([{ body: order }]);
    await server.callTool('close_position', { symbol: 'AAPL', qty: '5' });

    expect(fetch.calls[0].url).toContain('qty=5');
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 404, body: { message: 'position not found' } }]);
    const result = await server.callTool('close_position', { symbol: 'NOPE' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('position not found');
  });
});

// ── get_clock ───────────────────────────────────────────────

describe('get_clock tool', () => {
  it('returns market clock info', async () => {
    const clock = {
      timestamp: '2024-01-02T10:00:00-05:00',
      is_open: true,
      next_open: '2024-01-03T09:30:00-05:00',
      next_close: '2024-01-02T16:00:00-05:00',
    };
    const { server } = setup([{ body: clock }]);
    const result = await server.callTool('get_clock');

    const data = JSON.parse(result.content[0].text);
    expect(data.isOpen).toBe(true);
    expect(data.nextOpen).toBe('2024-01-03T09:30:00-05:00');
    expect(data.nextClose).toBe('2024-01-02T16:00:00-05:00');
  });

  it('returns error on failure', async () => {
    const { server } = setup([{ status: 500, body: { message: 'server error' } }]);
    const result = await server.callTool('get_clock');

    expect(result.isError).toBe(true);
  });
});
