import { describe, it, expect } from 'vitest';
import { registerAccountTools } from '../src/tools/account';
import { createMockClient, MockMcpServer } from './helpers';

function setup(overrides: Record<string, unknown> = {}) {
  const client = createMockClient({
    getBalance: async () => [
      { currency: 'BTC', free: 1.0, used: 0.5, total: 1.5 },
      { currency: 'USDT', free: 40000, used: 10000, total: 50000 },
    ],
    getPositions: async () => [
      { symbol: 'BTC', side: 'long', amount: 1.5, unrealizedPnl: undefined, entryPrice: undefined, currentPrice: undefined },
      { symbol: 'USDT', side: 'long', amount: 50000, unrealizedPnl: undefined, entryPrice: undefined, currentPrice: undefined },
    ],
    placeOrder: async () => ({
      id: 'ord-close', clientOrderId: 'co-close', symbol: 'BTC/USDT',
      side: 'sell', type: 'market', amount: 1.0, filled: 1.0, remaining: 0,
      price: undefined, average: 65000, status: 'closed',
      timestamp: 1700000000000, datetime: '2023-11-14T22:13:20.000Z',
    }),
    ...overrides,
  } as any);
  const server = new MockMcpServer();
  registerAccountTools(server as any, client);
  return { server, client };
}

// ── get_account ────────────────────────────────────────────

describe('get_account tool', () => {
  it('returns account balances with correct shape', async () => {
    const { server } = setup();
    const result = await server.callTool('get_account', {});

    const data = JSON.parse(result.content[0].text);
    expect(data.exchange).toBe('Coinbase');
    expect(data.exchangeId).toBe('coinbase');
    expect(data.sandbox).toBe(false);
    expect(data.balances).toHaveLength(2);
    expect(data.totalAssets).toBe(2);

    const btc = data.balances.find((b: any) => b.currency === 'BTC');
    expect(btc.free).toBe(1.0);
    expect(btc.used).toBe(0.5);
    expect(btc.total).toBe(1.5);
  });

  it('fails without credentials', async () => {
    const { server } = setup({ hasCredentials: false } as any);
    const result = await server.callTool('get_account', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No API credentials');
  });

  it('returns error on failure', async () => {
    const { server } = setup({
      getBalance: async () => { throw new Error('authentication failed'); },
    });
    const result = await server.callTool('get_account', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('authentication failed');
  });
});

// ── get_positions ──────────────────────────────────────────

describe('get_positions tool', () => {
  it('returns positions', async () => {
    const { server } = setup();
    const result = await server.callTool('get_positions', {});

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(2);
    expect(data[0].symbol).toBe('BTC');
    expect(data[0].amount).toBe(1.5);
  });

  it('passes symbol filter', async () => {
    const { server, client } = setup();
    await server.callTool('get_positions', { symbols: 'BTC/USDT,ETH/USDT' });

    expect(client.calls[0].method).toBe('getPositions');
    expect(client.calls[0].args[0]).toEqual(['BTC/USDT', 'ETH/USDT']);
  });

  it('fails without credentials', async () => {
    const { server } = setup({ hasCredentials: false } as any);
    const result = await server.callTool('get_positions', {});
    expect(result.isError).toBe(true);
  });
});

// ── close_position ─────────────────────────────────────────

describe('close_position tool', () => {
  it('closes full position with market sell', async () => {
    const { server, client } = setup();
    const result = await server.callTool('close_position', {
      symbol: 'BTC/USDT', percentage: 100,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe('ord-close');
    expect(data.side).toBe('sell');
    expect(data.closedPercentage).toBe(100);

    // Should call getBalance then placeOrder
    expect(client.calls[0].method).toBe('getBalance');
    expect(client.calls[1].method).toBe('placeOrder');
    expect(client.calls[1].args[2]).toBe('sell');
    expect(client.calls[1].args[3]).toBe(1.0); // full free balance
  });

  it('closes partial position', async () => {
    const { server, client } = setup();
    await server.callTool('close_position', {
      symbol: 'BTC/USDT', percentage: 50,
    });

    expect(client.calls[1].args[3]).toBe(0.5); // 50% of 1.0 free
  });

  it('closes short position with market buy', async () => {
    const { server, client } = setup({
      getBalance: async () => [
        { currency: 'BTC', free: -2.0, used: 0, total: -2.0 },
        { currency: 'USDT', free: 100000, used: 0, total: 100000 },
      ],
    } as any);
    const result = await server.callTool('close_position', {
      symbol: 'BTC/USDT', percentage: 100,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.closeSide).toBe('buy');
    expect(client.calls[1].method).toBe('placeOrder');
    expect(client.calls[1].args[2]).toBe('buy'); // buy to close short
    expect(client.calls[1].args[3]).toBe(2.0); // abs(-2.0)
  });

  it('rejects percentage <= 0', async () => {
    const { server } = setup();
    const result = await server.callTool('close_position', {
      symbol: 'BTC/USDT', percentage: 0,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid percentage');
  });

  it('rejects percentage > 100', async () => {
    const { server } = setup();
    const result = await server.callTool('close_position', {
      symbol: 'BTC/USDT', percentage: 150,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid percentage');
  });

  it('returns error if no position found', async () => {
    const { server } = setup({
      getBalance: async () => [
        { currency: 'USDT', free: 40000, used: 10000, total: 50000 },
      ],
    });
    const result = await server.callTool('close_position', {
      symbol: 'BTC/USDT', percentage: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No open position');
  });

  it('fails without credentials', async () => {
    const { server } = setup({ hasCredentials: false } as any);
    const result = await server.callTool('close_position', {
      symbol: 'BTC/USDT', percentage: 100,
    });
    expect(result.isError).toBe(true);
  });
});
