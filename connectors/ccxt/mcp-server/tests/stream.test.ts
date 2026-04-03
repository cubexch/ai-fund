import { describe, it, expect } from 'vitest';
import ccxt from 'ccxt';
import { StreamManager } from '../src/client/stream.js';

const hasPro = typeof (ccxt as any).pro === 'object' && (ccxt as any).pro !== null;

describe('StreamManager', () => {

  it('throws for an exchange with no ccxt.pro support', () => {
    expect(() => new StreamManager('totally_fake_exchange_xyz')).toThrow(
      /does not support WebSocket streaming/,
    );
  });

  describe.skipIf(!hasPro)('with ccxt.pro available', () => {

    // Use a well-known pro exchange for construction tests — no actual connection made
    const proExchangeId = (() => {
      if (!hasPro) return 'binance';
      const ids = Object.keys((ccxt as any).pro);
      return ids.includes('binance') ? 'binance' : ids[0];
    })();

    it('constructs successfully for a supported pro exchange', () => {
      const mgr = new StreamManager(proExchangeId);
      expect(mgr.exchangeId).toBe(proExchangeId);
    });

    it('getSnapshot returns undefined for unsubscribed symbol', () => {
      const mgr = new StreamManager(proExchangeId);
      expect(mgr.getSnapshot('BTC/USDT')).toBeUndefined();
    });

    it('getSubscriptions returns empty array initially', () => {
      const mgr = new StreamManager(proExchangeId);
      expect(mgr.getSubscriptions()).toEqual([]);
    });

    it('close resolves cleanly with no active subscriptions', async () => {
      const mgr = new StreamManager(proExchangeId);
      await expect(mgr.close()).resolves.toBeUndefined();
    });

    it('unsubscribe is a no-op for symbols not subscribed', () => {
      const mgr = new StreamManager(proExchangeId);
      // Should not throw
      mgr.unsubscribe('BTC/USDT');
      mgr.unsubscribe('ETH/USDT', 'orderBook');
      mgr.unsubscribe('SOL/USDT', 'ticker');
      mgr.unsubscribe('DOGE/USDT', 'trades');
      expect(mgr.getSubscriptions()).toEqual([]);
    });

    it('accepts sandbox config without throwing', () => {
      const mgr = new StreamManager(proExchangeId, { sandbox: true });
      expect(mgr.exchangeId).toBe(proExchangeId);
    });
  });
});
