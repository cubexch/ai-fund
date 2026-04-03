/**
 * Test helpers — mock CCXT exchange, McpServer, and MemoryStore for tool testing.
 */

import type { ExchangeClient } from '../src/client/exchange';
import type { CredentialStore, CcxtCredentials } from '../src/client/credential-store';
import { LatencyTracker } from '../src/client/latency-tracker';

// ── In-memory credential store for testing ────────────────

export class MemoryStore implements CredentialStore {
  readonly backend = 'file' as const;
  private data = new Map<string, CcxtCredentials>();

  async load(exchangeId: string) { return this.data.get(exchangeId) ?? null; }
  async save(creds: CcxtCredentials) { this.data.set(creds.exchangeId, creds); }
  async delete(exchangeId: string) { this.data.delete(exchangeId); }
}

// ── Mock Exchange ──────────────────────────────────────────

export interface MockCall {
  method: string;
  args: unknown[];
}

/**
 * Create a mock ExchangeClient that returns predefined responses.
 * Each method call is recorded in `calls` for assertion.
 */
export function createMockClient(overrides: Partial<ExchangeClient> = {}): ExchangeClient & { calls: MockCall[] } {
  const calls: MockCall[] = [];
  const defaultLatency = new LatencyTracker();

  const proxy = new Proxy({} as ExchangeClient & { calls: MockCall[] }, {
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

// ── Mock MCP Server ────────────────────────────────────────

/**
 * Minimal McpServer mock that captures tool registrations
 * and lets tests invoke them directly.
 */
export class MockMcpServer {
  tools = new Map<string, {
    name: string;
    description: string;
    schema: unknown;
    handler: (params: any) => Promise<any>;
  }>();

  tool(name: string, description: string, schema: unknown, handler: (params: any) => Promise<any>) {
    this.tools.set(name, { name, description, schema, handler });
  }

  async callTool(name: string, params: Record<string, unknown> = {}) {
    const t = this.tools.get(name);
    if (!t) throw new Error(`Tool "${name}" not registered`);
    return t.handler(params);
  }
}
