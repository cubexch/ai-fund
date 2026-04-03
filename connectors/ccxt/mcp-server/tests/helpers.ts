/**
 * Test helpers — re-exports shared fixtures and provides CCXT-specific helpers.
 *
 * Most mock utilities now live in @ai-fund/lib/test-fixtures.
 * This file re-exports them for backwards compatibility and adds
 * CCXT-specific wrappers (MemoryStore, typed createMockClient).
 */

import type { ExchangeClient } from '../src/client/exchange';
import type { CredentialStore, CcxtCredentials } from '../src/client/credential-store';
import { LatencyTracker } from '../src/client/latency-tracker';

// Re-export shared fixtures for existing test imports
export {
  MockMcpServer,
  createMockExchangeClient,
  type MockCall,
} from '@ai-fund/lib/test-fixtures';

export {
  TICKERS, BALANCES, MARKETS,
  BTC_BARS, ETH_BARS, SOL_BARS,
  BTC_ORDER_BOOK, BTC_TRADES,
  FILLED_ORDER, OPEN_LIMIT_ORDER,
  generateBars, generateOrderBook, generateTrades,
  ticker, allTickers,
} from '@ai-fund/lib/test-fixtures/market-data';

// ── CCXT-specific: In-memory credential store ────────────────

export class MemoryStore implements CredentialStore {
  readonly backend = 'file' as const;
  private data = new Map<string, CcxtCredentials>();

  async load(exchangeId: string) { return this.data.get(exchangeId) ?? null; }
  async save(creds: CcxtCredentials) { this.data.set(creds.exchangeId, creds); }
  async delete(exchangeId: string) { this.data.delete(exchangeId); }
}

// ── CCXT-specific: Typed mock client ─────────────────────────

/**
 * Create a mock ExchangeClient with call recording.
 * Thin wrapper over createMockExchangeClient with proper typing.
 */
export function createMockClient(overrides: Partial<ExchangeClient> = {}): ExchangeClient & { calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = [];
  const defaultLatency = new LatencyTracker();

  const proxy = new Proxy({} as ExchangeClient & { calls: { method: string; args: unknown[] }[] }, {
    get(target, prop: string) {
      if (prop === 'calls') return calls;
      if (prop === 'exchangeId') return overrides.exchangeId ?? 'coinbase';
      if (prop === 'name') return overrides.name ?? 'Coinbase';
      if (prop === 'hasCredentials') return overrides.hasCredentials ?? true;
      if (prop === 'isSandbox') return overrides.isSandbox ?? false;
      if (prop === 'latency') return overrides.latency ?? defaultLatency;

      if (prop in overrides) {
        const val = (overrides as any)[prop];
        if (typeof val === 'function') {
          return (...args: unknown[]) => {
            calls.push({ method: prop, args });
            return val(...args);
          };
        }
        return val;
      }

      // Default: return async no-op
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return Promise.resolve([]);
      };
    },
  });

  return proxy;
}
