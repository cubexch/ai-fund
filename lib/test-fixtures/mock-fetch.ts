/**
 * Shared mock fetch for testing HTTP-based connectors (Alpaca, Robinhood, etc).
 *
 * Provides queue-based responses and pattern-matched responses.
 */

// ── Types ────────────────────────────────────────────────────

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface FetchCall {
  url: string;
  init?: RequestInit;
  timestamp: number;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ── Queue-based mock fetch ───────────────────────────────────

/**
 * Create a mock fetch that pops responses from a queue.
 * Throws when the queue is empty (test should have provided enough responses).
 */
export function mockFetch(responses: MockResponse[]): FetchFn & { calls: FetchCall[] } {
  const queue = [...responses];
  const calls: FetchCall[] = [];

  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init, timestamp: Date.now() });
    const mock = queue.shift();
    if (!mock) {
      throw new Error(`No more mock responses. Call #${calls.length} to ${url}`);
    }
    return new Response(
      mock.body !== undefined ? JSON.stringify(mock.body) : null,
      {
        status: mock.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...mock.headers },
      },
    );
  };

  (fn as any).calls = calls;
  return fn as FetchFn & { calls: FetchCall[] };
}

// ── Pattern-matched mock fetch ───────────────────────────────

export interface MockRoute {
  /** URL pattern — string (substring match) or RegExp. */
  pattern: string | RegExp;
  /** HTTP method filter (GET, POST, etc). Omit to match any. */
  method?: string;
  /** Response to return. */
  response: MockResponse;
}

/**
 * Create a mock fetch that matches URL patterns to canned responses.
 * More flexible than queue-based for tests with non-deterministic call order.
 */
export function mockFetchRouter(routes: MockRoute[]): FetchFn & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];

  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init, timestamp: Date.now() });
    const method = init?.method?.toUpperCase() ?? 'GET';

    for (const route of routes) {
      if (route.method && route.method.toUpperCase() !== method) continue;
      const matches = typeof route.pattern === 'string'
        ? url.includes(route.pattern)
        : route.pattern.test(url);
      if (matches) {
        return new Response(
          route.response.body !== undefined ? JSON.stringify(route.response.body) : null,
          {
            status: route.response.status ?? 200,
            headers: { 'Content-Type': 'application/json', ...route.response.headers },
          },
        );
      }
    }

    throw new Error(`No matching route for ${method} ${url}. Registered patterns: ${routes.map(r => String(r.pattern)).join(', ')}`);
  };

  (fn as any).calls = calls;
  return fn as FetchFn & { calls: FetchCall[] };
}
