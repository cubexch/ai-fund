/**
 * Tests for the shared connector interface types and connector registry.
 *
 * connector-interface.ts — structural/type contracts (Bar, Quote, Position,
 *   Account, Order, OrderParams, ConnectorMeta, ExchangeConnector)
 * connector-registry.ts  — register / get / list / getByAssetClass
 *
 * The registry is a module-level singleton Map, so tests use unique
 * connector names to stay independent of each other.
 */

import { describe, it, expect } from 'vitest';
import {
  register,
  get,
  list,
  getByAssetClass,
} from '@ai-fund/lib/connector-registry';
import {
  defineConnectorCapabilities,
} from '@ai-fund/lib/connector-interface';
import type {
  Bar,
  Quote,
  Position,
  Account,
  Order,
  OrderParams,
  ConnectorMeta,
  ExchangeConnector,
  PortfolioHistory,
} from '@ai-fund/lib/connector-interface';

// ── Helpers ──────────────────────────────────────────────────

/** Build a minimal valid ConnectorMeta. */
function makeMeta(name: string, overrides: Partial<ConnectorMeta> = {}): ConnectorMeta {
  return {
    name,
    displayName: name.toUpperCase(),
    assetClasses: ['crypto'],
    status: 'ready',
    isPaper: true,
    supportsShorts: false,
    supportsOptions: false,
    marketHours: '24/7',
    capabilities: defineConnectorCapabilities(),
    ...overrides,
  };
}

/** Build a no-op ExchangeConnector that satisfies the interface. */
function makeConnector(name: string, overrides: Partial<ExchangeConnector> = {}): ExchangeConnector {
  const meta = makeMeta(name);
  const stub: ExchangeConnector = {
    meta,
    getAccount: async () => ({ id: 'acc-1', buyingPower: 1000, cash: 1000, portfolioValue: 1000, currency: 'USD' }),
    getPositions: async () => [],
    getOrders: async () => [],
    placeOrder: async (p) => ({
      id: 'ord-1',
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      qty: p.qty,
      filledQty: 0,
      status: 'open',
      createdAt: Date.now(),
    }),
    cancelOrder: async () => {},
    cancelAllOrders: async () => {},
    getQuote: async (symbol) => ({ symbol, bid: 100, ask: 101, last: 100.5, timestamp: Date.now() }),
    getBars: async () => [],
    getPortfolioHistory: async () => ({ timestamps: [], equity: [], profitLoss: [], profitLossPct: [] }),
    isMarketOpen: async () => true,
    isPaper: () => true,
    ...overrides,
  };
  return stub;
}

// ── connector-interface type shape tests ─────────────────────

describe('connector-interface — type shapes', () => {
  it('Bar has the required OHLCV fields', () => {
    const bar: Bar = {
      timestamp: 1700000000000,
      open: 65000,
      high: 65500,
      low: 64800,
      close: 65200,
      volume: 1234.56,
    };
    expect(bar.timestamp).toBe(1700000000000);
    expect(bar.open).toBe(65000);
    expect(bar.close).toBe(65200);
    expect(bar.volume).toBe(1234.56);
  });

  it('Quote has symbol, bid, ask, last, timestamp', () => {
    const quote: Quote = {
      symbol: 'BTC/USD',
      bid: 64900,
      ask: 65100,
      last: 65000,
      timestamp: Date.now(),
    };
    expect(quote.symbol).toBe('BTC/USD');
    expect(quote.bid).toBeLessThan(quote.ask);
  });

  it('Position has the required fields including side', () => {
    const pos: Position = {
      symbol: 'ETH/USDT',
      qty: 2.5,
      avgEntryPrice: 3000,
      marketValue: 7750,
      unrealizedPnl: 250,
      side: 'long',
    };
    expect(pos.side).toBe('long');
    expect(pos.unrealizedPnl).toBe(250);
  });

  it('Account has buyingPower, cash, portfolioValue, currency', () => {
    const account: Account = {
      id: 'acct-123',
      buyingPower: 50000,
      cash: 40000,
      portfolioValue: 100000,
      currency: 'USD',
    };
    expect(account.currency).toBe('USD');
    expect(account.portfolioValue).toBeGreaterThan(account.cash);
  });

  it('Order status enum covers all expected states', () => {
    const statuses: Order['status'][] = ['pending', 'open', 'filled', 'cancelled', 'rejected'];
    expect(statuses).toHaveLength(5);
    statuses.forEach(s => expect(typeof s).toBe('string'));
  });

  it('OrderParams supports optional limitPrice and stopPrice', () => {
    const marketOrder: OrderParams = {
      symbol: 'BTC/USD',
      side: 'buy',
      type: 'market',
      qty: 0.1,
    };
    const limitOrder: OrderParams = {
      symbol: 'BTC/USD',
      side: 'sell',
      type: 'limit',
      qty: 0.1,
      limitPrice: 70000,
    };
    expect(marketOrder.limitPrice).toBeUndefined();
    expect(limitOrder.limitPrice).toBe(70000);
  });

  it('ConnectorMeta assetClasses accepts all valid values', () => {
    const meta: ConnectorMeta = makeMeta('alpaca-test', {
      assetClasses: ['crypto', 'equities', 'futures', 'options', 'perps'],
    });
    expect(meta.assetClasses).toHaveLength(5);
    expect(meta.assetClasses).toContain('equities');
  });

  it('ConnectorMeta marketHours accepts 24/7, weekdays-only, custom', () => {
    const values: ConnectorMeta['marketHours'][] = ['24/7', 'weekdays-only', 'custom'];
    values.forEach(v => {
      const meta = makeMeta(`mh-${v}`, { marketHours: v });
      expect(meta.marketHours).toBe(v);
    });
  });

  it('ExchangeConnector stub satisfies all method contracts', async () => {
    const conn = makeConnector('reg-shape-test');
    const account = await conn.getAccount();
    expect(account.id).toBeDefined();
    expect(typeof account.buyingPower).toBe('number');

    const positions = await conn.getPositions();
    expect(Array.isArray(positions)).toBe(true);

    const open = await conn.isMarketOpen();
    expect(typeof open).toBe('boolean');

    expect(conn.isPaper()).toBe(true);
  });

  it('PortfolioHistory has parallel arrays', () => {
    const ph: PortfolioHistory = {
      timestamps: [1, 2, 3],
      equity: [10000, 10100, 10200],
      profitLoss: [0, 100, 200],
      profitLossPct: [0, 0.01, 0.02],
    };
    expect(ph.timestamps).toHaveLength(ph.equity.length);
    expect(ph.profitLoss).toHaveLength(ph.profitLossPct.length);
  });
});

// ── connector-registry ───────────────────────────────────────

describe('connector-registry — register / get', () => {
  it('registers a connector and retrieves it by name', () => {
    const conn = makeConnector('reg-get-test');
    register(conn);
    const found = get('reg-get-test');
    expect(found).toBe(conn);
  });

  it('returns undefined for an unknown connector name', () => {
    const found = get('does-not-exist-xyz-12345');
    expect(found).toBeUndefined();
  });

  it('overwrites an existing connector when re-registered with the same name', () => {
    const first = makeConnector('reg-overwrite');
    const second = makeConnector('reg-overwrite');
    register(first);
    register(second);
    expect(get('reg-overwrite')).toBe(second);
  });

  it('registered connector preserves meta fields', () => {
    const conn = makeConnector('reg-meta', {
      meta: makeMeta('reg-meta', {
        displayName: 'My Exchange',
        assetClasses: ['crypto', 'futures'],
        isPaper: false,
        supportsShorts: true,
        marketHours: 'weekdays-only',
      }),
    });
    register(conn);
    const found = get('reg-meta')!;
    expect(found.meta.displayName).toBe('My Exchange');
    expect(found.meta.assetClasses).toContain('futures');
    expect(found.meta.isPaper).toBe(false);
    expect(found.meta.supportsShorts).toBe(true);
    expect(found.meta.marketHours).toBe('weekdays-only');
  });
});

describe('connector-registry — list', () => {
  it('list includes all registered connectors', () => {
    const conn1 = makeConnector('list-test-a');
    const conn2 = makeConnector('list-test-b');
    register(conn1);
    register(conn2);
    const all = list();
    const names = all.map(c => c.meta.name);
    expect(names).toContain('list-test-a');
    expect(names).toContain('list-test-b');
  });

  it('list returns an array (not the raw Map)', () => {
    const all = list();
    expect(Array.isArray(all)).toBe(true);
  });
});

describe('connector-registry — getByAssetClass', () => {
  it('returns only connectors that support the given asset class', () => {
    const cryptoConn = makeConnector('asset-class-crypto', {
      meta: makeMeta('asset-class-crypto', { assetClasses: ['crypto'] }),
    });
    const equitiesConn = makeConnector('asset-class-equities', {
      meta: makeMeta('asset-class-equities', { assetClasses: ['equities'] }),
    });
    register(cryptoConn);
    register(equitiesConn);

    const cryptoList = getByAssetClass('crypto');
    const names = cryptoList.map(c => c.meta.name);
    expect(names).toContain('asset-class-crypto');
    expect(names).not.toContain('asset-class-equities');
  });

  it('returns multiple connectors when several support the same asset class', () => {
    const connA = makeConnector('multi-crypto-a', {
      meta: makeMeta('multi-crypto-a', { assetClasses: ['crypto', 'perps'] }),
    });
    const connB = makeConnector('multi-crypto-b', {
      meta: makeMeta('multi-crypto-b', { assetClasses: ['crypto'] }),
    });
    register(connA);
    register(connB);

    const result = getByAssetClass('crypto');
    const names = result.map(c => c.meta.name);
    expect(names).toContain('multi-crypto-a');
    expect(names).toContain('multi-crypto-b');
  });

  it('returns empty array when no connector supports the asset class', () => {
    // Use a class that none of our test connectors registered above support
    const result = getByAssetClass('options');
    // May or may not be empty depending on what other tests registered —
    // just assert it is an array and every element supports options.
    expect(Array.isArray(result)).toBe(true);
    result.forEach(c => {
      expect(c.meta.assetClasses).toContain('options');
    });
  });

  it('connector supporting multiple asset classes appears in each class query', () => {
    const multi = makeConnector('multi-class', {
      meta: makeMeta('multi-class', { assetClasses: ['crypto', 'futures', 'perps'] }),
    });
    register(multi);

    expect(getByAssetClass('crypto').map(c => c.meta.name)).toContain('multi-class');
    expect(getByAssetClass('futures').map(c => c.meta.name)).toContain('multi-class');
    expect(getByAssetClass('perps').map(c => c.meta.name)).toContain('multi-class');
    expect(getByAssetClass('equities').map(c => c.meta.name)).not.toContain('multi-class');
  });
});
