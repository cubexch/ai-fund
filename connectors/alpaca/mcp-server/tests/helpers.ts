/**
 * Test helpers — mock fetch and McpServer for tool testing.
 */

import type { FetchFn, AlpacaClient } from '../src/client/api.js';

/**
 * Create a mock fetch function that returns predefined responses.
 * Each call pops the next response from the queue.
 */
export function mockFetch(responses: MockResponse[]): FetchFn & { calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];

  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const mock = queue.shift();
    if (!mock) {
      throw new Error(`No more mock responses. Call #${calls.length} to ${url}`);
    }
    return new Response(
      mock.body !== undefined ? JSON.stringify(mock.body) : null,
      {
        status: mock.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  fn.calls = calls;
  return fn;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
}

export interface FetchCall {
  url: string;
  init?: RequestInit;
}

/**
 * Create an AlpacaClient with a mock fetch function.
 */
export async function createMockClient(responses: MockResponse[]) {
  // Dynamic import to avoid circular issues
  const { AlpacaClient } = await import('../src/client/api.js');
  const fetch = mockFetch(responses);
  const client = new AlpacaClient({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    paper: true,
    fetchFn: fetch,
  });
  return { client, fetch };
}

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
