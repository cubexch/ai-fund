import { describe, it, expect } from 'vitest';
import { registerOrderTools } from '../src/tools/orders';
import { createMockClient, MockMcpServer } from './helpers';

function setup(overrides: Record<string, unknown> = {}) {
  const client = createMockClient({
    placeOrder: async () => ({
      id: 'ord-123', clientOrderId: 'co-1', symbol: 'BTC/USDT',
      side: 'buy', type: 'limit', amount: 0.1, filled: 0, remaining: 0.1,
      price: 64000, average: undefined, status: 'open',
      timestamp: 1700000000000, datetime: '2023-11-14T22:13:20.000Z',
    }),
    cancelOrder: async () => undefined,
    cancelAllOrders: async () => undefined,
    getOpenOrders: async () => [
      {
        id: 'ord-1', clientOrderId: 'co-1', symbol: 'BTC/USDT', side: 'buy',
        type: 'limit', amount: 0.1, filled: 0, remaining: 0.1,
        price: 64000, average: undefined, status: 'open',
        timestamp: 1700000000000, datetime: '2023-11-14T22:13:20.000Z',
      },
    ],
    getClosedOrders: async () => [
      {
        id: 'ord-2', clientOrderId: 'co-2', symbol: 'BTC/USDT', side: 'sell',
        type: 'market', amount: 0.5, filled: 0.5, remaining: 0,
        price: undefined, average: 65100, status: 'closed',
        timestamp: 1699999000000, datetime: '2023-11-14T21:56:40.000Z',
      },
    ],
    getMyTrades: async () => [
      { id: 'mt1', timestamp: 1700000000000, symbol: 'BTC/USDT', side: 'buy', price: 65000, amount: 0.1, cost: 6500 },
    ],
    ...overrides,
  } as any);
  const server = new MockMcpServer();
  registerOrderTools(server as any, client);
  return { server, client };
}

// ── modify_order ──────────────────────────────────────────

describe('modify_order tool', () => {
  it('returns modified order', async () => {
    const { server } = setup({
      modifyOrder: async () => ({
        id: 'ord-mod', clientOrderId: 'co-mod', symbol: 'BTC/USDT',
        side: 'buy', type: 'limit', amount: 0.2, filled: 0, remaining: 0.2,
        price: 63000, average: undefined, status: 'open',
        timestamp: 1700000000000, datetime: '2023-11-14T22:13:20.000Z',
      }),
    } as any);
    const result = await server.callTool('modify_order', {
      order_id: 'ord-1', symbol: 'BTC/USDT', side: 'buy', type: 'limit',
      amount: 0.2, price: 63000,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe('ord-mod');
    expect(data.amount).toBe(0.2);
    expect(data.price).toBe(63000);
  });

  it('passes correct params to client', async () => {
    const { server, client } = setup({
      modifyOrder: async () => ({
        id: 'ord-1', clientOrderId: 'co-1', symbol: 'BTC/USDT',
        side: 'buy', type: 'limit', amount: 0.1, filled: 0, remaining: 0.1,
        price: 64000, average: undefined, status: 'open',
        timestamp: 1700000000000, datetime: '2023-11-14T22:13:20.000Z',
      }),
    } as any);
    await server.callTool('modify_order', {
      order_id: 'ord-1', symbol: 'BTC/USDT', side: 'buy', type: 'limit',
      amount: 0.15, price: 63500,
    });

    expect(client.calls[0].method).toBe('modifyOrder');
    expect(client.calls[0].args).toEqual(['ord-1', 'BTC/USDT', 'limit', 'buy', 0.15, 63500]);
  });

  it('fails without credentials', async () => {
    const { server } = setup({ hasCredentials: false } as any);
    const result = await server.callTool('modify_order', {
      order_id: 'ord-1', symbol: 'BTC/USDT', side: 'buy', type: 'limit',
      amount: 0.1, price: 64000,
    });
    expect(result.isError).toBe(true);
  });
});

// ── place_order ────────────────────────────────────────────

describe('place_order tool', () => {
  it('returns formatted order', async () => {
    const { server } = setup();
    const result = await server.callTool('place_order', {
      symbol: 'BTC/USDT', side: 'buy', type: 'limit', amount: 0.1, price: 64000,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe('ord-123');
    expect(data.symbol).toBe('BTC/USDT');
    expect(data.side).toBe('buy');
    expect(data.type).toBe('limit');
    expect(data.amount).toBe(0.1);
    expect(data.price).toBe(64000);
    expect(data.status).toBe('open');
  });

  it('passes correct params to client', async () => {
    const { server, client } = setup();
    await server.callTool('place_order', {
      symbol: 'ETH/USDT', side: 'sell', type: 'market', amount: 1.5,
    });

    expect(client.calls[0].method).toBe('placeOrder');
    expect(client.calls[0].args).toEqual(['ETH/USDT', 'market', 'sell', 1.5, undefined]);
  });

  it('fails without credentials', async () => {
    const { server } = setup({ hasCredentials: false } as any);
    const result = await server.callTool('place_order', {
      symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No API credentials');
  });

  it('returns error on failure', async () => {
    const { server } = setup({
      placeOrder: async () => { throw new Error('insufficient funds'); },
    });
    const result = await server.callTool('place_order', {
      symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 999,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('insufficient funds');
  });
});

// ── cancel_order ───────────────────────────────────────────

describe('cancel_order tool', () => {
  it('returns success', async () => {
    const { server } = setup();
    const result = await server.callTool('cancel_order', { order_id: 'ord-1' });

    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('cancelled');
    expect(data.orderId).toBe('ord-1');
  });

  it('passes symbol when provided', async () => {
    const { server, client } = setup();
    await server.callTool('cancel_order', { order_id: 'ord-1', symbol: 'BTC/USDT' });

    expect(client.calls[0].method).toBe('cancelOrder');
    expect(client.calls[0].args).toEqual(['ord-1', 'BTC/USDT']);
  });

  it('fails without credentials', async () => {
    const { server } = setup({ hasCredentials: false } as any);
    const result = await server.callTool('cancel_order', { order_id: 'ord-1' });
    expect(result.isError).toBe(true);
  });
});

// ── cancel_all_orders ──────────────────────────────────────

describe('cancel_all_orders tool', () => {
  it('returns success', async () => {
    const { server } = setup();
    const result = await server.callTool('cancel_all_orders', {});

    const data = JSON.parse(result.content[0].text);
    expect(data.status).toBe('all_cancelled');
    expect(data.symbol).toBe('all');
  });

  it('passes symbol filter', async () => {
    const { server, client } = setup();
    await server.callTool('cancel_all_orders', { symbol: 'BTC/USDT' });

    expect(client.calls[0].method).toBe('cancelAllOrders');
    expect(client.calls[0].args[0]).toBe('BTC/USDT');
  });
});

// ── get_orders ─────────────────────────────────────────────

describe('get_orders tool', () => {
  it('returns open orders by default', async () => {
    const { server } = setup();
    const result = await server.callTool('get_orders', { status: 'open', limit: 50 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('ord-1');
    expect(data[0].status).toBe('open');
  });

  it('returns closed orders', async () => {
    const { server } = setup();
    const result = await server.callTool('get_orders', { status: 'closed', limit: 50 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('ord-2');
    expect(data[0].status).toBe('closed');
  });

  it('returns all orders combined', async () => {
    const { server } = setup();
    const result = await server.callTool('get_orders', { status: 'all', limit: 50 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(2);
  });

  it('fails without credentials', async () => {
    const { server } = setup({ hasCredentials: false } as any);
    const result = await server.callTool('get_orders', { status: 'open', limit: 50 });
    expect(result.isError).toBe(true);
  });
});

// ── get_order_history ──────────────────────────────────────

describe('get_order_history tool', () => {
  it('returns closed orders', async () => {
    const { server } = setup();
    const result = await server.callTool('get_order_history', { limit: 50 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('ord-2');
    expect(data[0].average).toBe(65100);
  });
});

// ── get_fills ──────────────────────────────────────────────

describe('get_fills tool', () => {
  it('returns formatted fills', async () => {
    const { server } = setup();
    const result = await server.callTool('get_fills', { limit: 50 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('mt1');
    expect(data[0].price).toBe(65000);
    expect(data[0].amount).toBe(0.1);
    expect(data[0].cost).toBe(6500);
    expect(data[0].side).toBe('buy');
  });

  it('passes symbol filter', async () => {
    const { server, client } = setup();
    await server.callTool('get_fills', { symbol: 'BTC/USDT', limit: 50 });

    expect(client.calls[0].method).toBe('getMyTrades');
    expect(client.calls[0].args[0]).toBe('BTC/USDT');
  });
});
