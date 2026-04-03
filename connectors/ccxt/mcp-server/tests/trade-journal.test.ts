import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// DuckDB is a root-level dependency; skip if not resolvable from this workspace
let TradeJournalClass: typeof import('../src/client/trade-journal.js').TradeJournal;
let available = false;
try {
  const mod = await import('../src/client/trade-journal.js');
  TradeJournalClass = mod.TradeJournal;
  available = true;
} catch {
  // duckdb not resolvable — skip tests
}

import type { TradeRecord } from '../src/client/trade-journal.js';

describe.skipIf(!available)('TradeJournal', () => {
  let journal: InstanceType<typeof TradeJournalClass>;

  beforeEach(async () => {
    journal = new TradeJournalClass(':memory:');
    await journal.init();
  });

  afterEach(() => {
    journal.close();
  });

  // ── Helpers ─────────────────────────────────────────────────

  function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
    return {
      id: 'trade-1',
      exchange: 'coinbase',
      symbol: 'BTC/USDT',
      side: 'buy',
      type: 'limit',
      amount: 1,
      price: 60000,
      cost: 60000,
      fee: 30,
      feeCurrency: 'USDT',
      timestamp: 1700000000000,
      orderId: 'order-1',
      strategy: 'momentum-trader',
      ...overrides,
    };
  }

  // ── record + query round-trip ───────────────────────────────

  describe('record + query round-trip', () => {
    it('records a trade and retrieves it', async () => {
      const trade = makeTrade();
      await journal.record(trade);

      const results = await journal.query({});
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('trade-1');
      expect(results[0].exchange).toBe('coinbase');
      expect(results[0].symbol).toBe('BTC/USDT');
      expect(results[0].side).toBe('buy');
      expect(results[0].amount).toBe(1);
      expect(results[0].price).toBe(60000);
      expect(results[0].cost).toBe(60000);
      expect(results[0].fee).toBe(30);
      expect(results[0].feeCurrency).toBe('USDT');
      expect(results[0].timestamp).toBe(1700000000000);
      expect(results[0].orderId).toBe('order-1');
      expect(results[0].strategy).toBe('momentum-trader');
    });

    it('handles null fields', async () => {
      const trade = makeTrade({
        price: null,
        cost: null,
        fee: null,
        feeCurrency: null,
        orderId: null,
        strategy: null,
      });
      await journal.record(trade);

      const results = await journal.query({});
      expect(results).toHaveLength(1);
      expect(results[0].price).toBeNull();
      expect(results[0].cost).toBeNull();
      expect(results[0].fee).toBeNull();
      expect(results[0].feeCurrency).toBeNull();
      expect(results[0].orderId).toBeNull();
      expect(results[0].strategy).toBeNull();
    });

    it('INSERT OR REPLACE updates existing trade', async () => {
      await journal.record(makeTrade({ price: 60000 }));
      await journal.record(makeTrade({ price: 61000 }));

      const results = await journal.query({});
      expect(results).toHaveLength(1);
      expect(results[0].price).toBe(61000);
    });
  });

  // ── recordBatch ─────────────────────────────────────────────

  describe('recordBatch', () => {
    it('inserts multiple trades', async () => {
      const trades = [
        makeTrade({ id: 'b1', symbol: 'BTC/USDT', timestamp: 1700000001000 }),
        makeTrade({ id: 'b2', symbol: 'ETH/USDT', timestamp: 1700000002000 }),
        makeTrade({ id: 'b3', symbol: 'SOL/USDT', timestamp: 1700000003000 }),
      ];

      const inserted = await journal.recordBatch(trades);
      expect(inserted).toBe(3);

      const results = await journal.query({});
      expect(results).toHaveLength(3);
    });

    it('returns 0 for empty batch', async () => {
      const inserted = await journal.recordBatch([]);
      expect(inserted).toBe(0);
    });

    it('handles large batches (>500)', async () => {
      const trades: TradeRecord[] = [];
      for (let i = 0; i < 600; i++) {
        trades.push(makeTrade({
          id: `bulk-${i}`,
          timestamp: 1700000000000 + i * 1000,
        }));
      }

      const inserted = await journal.recordBatch(trades);
      expect(inserted).toBe(600);

      const results = await journal.query({ limit: 700 });
      expect(results).toHaveLength(600);
    });
  });

  // ── pnl calculation ─────────────────────────────────────────

  describe('pnl', () => {
    it('computes P&L: buy 1 BTC at 60000, sell at 65000 = 5000 - fees', async () => {
      await journal.record(makeTrade({
        id: 'buy-1',
        side: 'buy',
        amount: 1,
        price: 60000,
        cost: 60000,
        fee: 30,
        timestamp: 1700000001000,
      }));
      await journal.record(makeTrade({
        id: 'sell-1',
        side: 'sell',
        amount: 1,
        price: 65000,
        cost: 65000,
        fee: 32.5,
        timestamp: 1700000002000,
      }));

      const report = await journal.pnl({});
      expect(report.totalTrades).toBe(2);
      expect(report.buyVolume).toBe(60000);
      expect(report.sellVolume).toBe(65000);
      expect(report.totalFees).toBe(62.5);
      expect(report.realizedPnl).toBeCloseTo(5000 - 62.5, 2);
      expect(report.symbols).toEqual(['BTC/USDT']);
    });

    it('reports zero P&L with no trades', async () => {
      const report = await journal.pnl({});
      expect(report.totalTrades).toBe(0);
      expect(report.buyVolume).toBe(0);
      expect(report.sellVolume).toBe(0);
      expect(report.totalFees).toBe(0);
      expect(report.realizedPnl).toBe(0);
      expect(report.symbols).toEqual([]);
    });

    it('filters P&L by symbol', async () => {
      await journal.record(makeTrade({ id: 'btc-buy', symbol: 'BTC/USDT', side: 'buy', cost: 60000, fee: 30, timestamp: 1 }));
      await journal.record(makeTrade({ id: 'btc-sell', symbol: 'BTC/USDT', side: 'sell', cost: 65000, fee: 32, timestamp: 2 }));
      await journal.record(makeTrade({ id: 'eth-buy', symbol: 'ETH/USDT', side: 'buy', cost: 3500, fee: 1.75, timestamp: 3 }));

      const btcPnl = await journal.pnl({ symbol: 'BTC/USDT' });
      expect(btcPnl.totalTrades).toBe(2);
      expect(btcPnl.realizedPnl).toBeCloseTo(5000 - 62, 2);
      expect(btcPnl.symbols).toEqual(['BTC/USDT']);
    });

    it('filters P&L by strategy', async () => {
      await journal.record(makeTrade({ id: 't1', strategy: 'scalper', side: 'buy', cost: 1000, fee: 1, timestamp: 1 }));
      await journal.record(makeTrade({ id: 't2', strategy: 'scalper', side: 'sell', cost: 1050, fee: 1, timestamp: 2 }));
      await journal.record(makeTrade({ id: 't3', strategy: 'swing', side: 'buy', cost: 5000, fee: 5, timestamp: 3 }));

      const scalperPnl = await journal.pnl({ strategy: 'scalper' });
      expect(scalperPnl.totalTrades).toBe(2);
      expect(scalperPnl.realizedPnl).toBeCloseTo(50 - 2, 2);
    });
  });

  // ── query filters ───────────────────────────────────────────

  describe('query filters', () => {
    beforeEach(async () => {
      await journal.recordBatch([
        makeTrade({ id: 't1', symbol: 'BTC/USDT', strategy: 'momentum-trader', exchange: 'coinbase', timestamp: 1700000001000 }),
        makeTrade({ id: 't2', symbol: 'ETH/USDT', strategy: 'momentum-trader', exchange: 'coinbase', timestamp: 1700000002000 }),
        makeTrade({ id: 't3', symbol: 'BTC/USDT', strategy: 'scalper', exchange: 'binance', timestamp: 1700000003000 }),
        makeTrade({ id: 't4', symbol: 'SOL/USDT', strategy: 'scalper', exchange: 'binance', timestamp: 1700000004000 }),
      ]);
    });

    it('filters by symbol', async () => {
      const results = await journal.query({ symbol: 'BTC/USDT' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.symbol === 'BTC/USDT')).toBe(true);
    });

    it('filters by strategy', async () => {
      const results = await journal.query({ strategy: 'scalper' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.strategy === 'scalper')).toBe(true);
    });

    it('filters by exchange', async () => {
      const results = await journal.query({ exchange: 'binance' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.exchange === 'binance')).toBe(true);
    });

    it('filters by since', async () => {
      const results = await journal.query({ since: 1700000003000 });
      expect(results).toHaveLength(2);
    });

    it('filters by until', async () => {
      const results = await journal.query({ until: 1700000002000 });
      expect(results).toHaveLength(2);
    });

    it('combines filters', async () => {
      const results = await journal.query({ symbol: 'BTC/USDT', exchange: 'coinbase' });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe('t1');
    });

    it('respects limit', async () => {
      const results = await journal.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it('orders by timestamp descending', async () => {
      const results = await journal.query({});
      expect(results[0].timestamp).toBeGreaterThan(results[results.length - 1].timestamp);
    });
  });

  // ── sql ─────────────────────────────────────────────────────

  describe('sql', () => {
    it('runs raw SELECT queries', async () => {
      await journal.record(makeTrade());
      const rows = await journal.sql('SELECT COUNT(*) as cnt FROM trades');
      expect(rows[0].cnt).toBe(1);
    });

    it('rejects non-SELECT queries', async () => {
      await expect(journal.sql('DROP TABLE trades')).rejects.toThrow('Only SELECT');
      await expect(journal.sql('DELETE FROM trades')).rejects.toThrow('Only SELECT');
    });
  });

  // ── ensureDb guard ──────────────────────────────────────────

  describe('init guard', () => {
    it('throws if not initialized', async () => {
      const uninit = new TradeJournalClass(':memory:');
      await expect(uninit.query({})).rejects.toThrow('not initialized');
    });
  });
});
