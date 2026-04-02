import { describe, it, expect } from 'vitest';
import { MendelevClient } from '../src/client/mendelev.js';

/**
 * Tests for MendelevClient data accessors and state management.
 * WebSocket connections are not tested (require live endpoints).
 * Instead, we test the client's data retrieval methods on a fresh instance.
 */

describe('MendelevClient', () => {
  it('creates a new instance', () => {
    const client = new MendelevClient();
    expect(client).toBeInstanceOf(MendelevClient);
  });

  describe('isTopsConnected', () => {
    it('is false initially', () => {
      const client = new MendelevClient();
      expect(client.isTopsConnected).toBe(false);
    });
  });

  describe('isSubscribed', () => {
    it('returns false for unsubscribed markets', () => {
      const client = new MendelevClient();
      expect(client.isSubscribed(100001)).toBe(false);
      expect(client.isSubscribed(999999)).toBe(false);
    });
  });

  describe('getOrderBook', () => {
    it('returns null for unsubscribed markets', () => {
      const client = new MendelevClient();
      expect(client.getOrderBook(100001)).toBeNull();
    });
  });

  describe('getSummary', () => {
    it('returns null for unsubscribed markets', () => {
      const client = new MendelevClient();
      expect(client.getSummary(100001)).toBeNull();
    });
  });

  describe('getRecentTrades', () => {
    it('returns empty array for unsubscribed markets', () => {
      const client = new MendelevClient();
      expect(client.getRecentTrades(100001)).toEqual([]);
    });
  });

  describe('getTops', () => {
    it('returns empty array when not connected', () => {
      const client = new MendelevClient();
      expect(client.getTops()).toEqual([]);
    });
  });

  describe('getTop', () => {
    it('returns null when not connected', () => {
      const client = new MendelevClient();
      expect(client.getTop(100001)).toBeNull();
    });
  });

  describe('unsubscribe', () => {
    it('does not throw for non-existent subscription', () => {
      const client = new MendelevClient();
      expect(() => client.unsubscribe(99999)).not.toThrow();
    });
  });

  describe('disconnectTops', () => {
    it('does not throw when not connected', () => {
      const client = new MendelevClient();
      expect(() => client.disconnectTops()).not.toThrow();
      expect(client.isTopsConnected).toBe(false);
    });
  });

  describe('disconnectAll', () => {
    it('does not throw with no subscriptions', () => {
      const client = new MendelevClient();
      expect(() => client.disconnectAll()).not.toThrow();
    });
  });
});
