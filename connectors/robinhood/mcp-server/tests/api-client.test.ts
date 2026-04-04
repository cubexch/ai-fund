/**
 * Unit tests for the RobinhoodClient — retry, pagination, error handling.
 * Mocks httpRequest and AuthManager to test client behavior in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock httpRequest
const mockHttpRequest = vi.fn();
vi.mock('../src/client/http.js', () => ({
  httpRequest: (...args: unknown[]) => mockHttpRequest(...args),
}));

// Mock credential store (required by AuthManager)
vi.mock('../src/client/credential-store.js', () => ({
  loadCredentials: vi.fn().mockResolvedValue(null),
  loadCredentialsRaw: vi.fn().mockResolvedValue(null),
  saveCredentials: vi.fn().mockResolvedValue(undefined),
}));

import { RobinhoodClient } from '../src/client/api';
import { AuthManager } from '../src/client/auth';

// ── Helpers ─────────────────────────────────────────────

function mockResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {},
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function makeClient(): RobinhoodClient {
  const auth = new AuthManager();
  // Inject a fake access token so requests proceed
  vi.spyOn(auth, 'getAccessToken').mockResolvedValue('test_token_abc');
  return new RobinhoodClient(auth);
}

// ── Tests ───────────────────────────────────────────────

describe('RobinhoodClient.get', () => {
  beforeEach(() => {
    mockHttpRequest.mockReset();
  });

  it('sends GET request with auth header', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(200, { data: 'ok' }));

    const client = makeClient();
    const result = await client.get<{ data: string }>('/test/');

    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    const [url, options] = mockHttpRequest.mock.calls[0];
    expect(url).toBe('https://api.robinhood.com/test/');
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toBe('Bearer test_token_abc');
  });

  it('appends query params to URL', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(200, { data: 'ok' }));

    const client = makeClient();
    await client.get('/test/', { symbol: 'BTC', currency: 'USD' });

    const [url] = mockHttpRequest.mock.calls[0];
    expect(url).toContain('symbol=BTC');
    expect(url).toContain('currency=USD');
  });

  it('parses JSON response', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(200, { price: 60000, symbol: 'BTC' }));

    const client = makeClient();
    const result = await client.get<{ price: number; symbol: string }>('/crypto/quote/');

    expect(result.price).toBe(60000);
    expect(result.symbol).toBe('BTC');
  });

  it('throws on 4xx errors', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(404, { detail: 'Not found' }));

    const client = makeClient();
    await expect(client.get('/nonexistent/')).rejects.toThrow('Robinhood API error (404)');
  });

  it('throws on 5xx errors', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(500, { detail: 'Internal error' }));

    const client = makeClient();
    await expect(client.get('/broken/')).rejects.toThrow('Robinhood API error (500)');
  });
});

describe('RobinhoodClient.post', () => {
  beforeEach(() => {
    mockHttpRequest.mockReset();
  });

  it('sends POST request with JSON body', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(200, { id: 'order_1' }));

    const client = makeClient();
    await client.post('/orders/', { symbol: 'BTC', quantity: 0.1 });

    const [, options] = mockHttpRequest.mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ symbol: 'BTC', quantity: 0.1 });
  });
});

describe('RobinhoodClient retry behavior', () => {
  beforeEach(() => {
    mockHttpRequest.mockReset();
  });

  it('retries on 401 (auth refresh)', async () => {
    // First call: 401, second call: 200
    mockHttpRequest
      .mockResolvedValueOnce(mockResponse(401, { detail: 'Unauthorized' }))
      .mockResolvedValueOnce(mockResponse(200, { data: 'refreshed' }));

    const client = makeClient();
    const result = await client.get<{ data: string }>('/protected/');

    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    expect(result.data).toBe('refreshed');
  });

  it('retries on 429 (rate limit) with backoff', async () => {
    // First call: 429, second call: 200
    mockHttpRequest
      .mockResolvedValueOnce(mockResponse(429, { detail: 'Rate limited' }))
      .mockResolvedValueOnce(mockResponse(200, { data: 'ok' }));

    const client = makeClient();
    const result = await client.get<{ data: string }>('/rate-limited/');

    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
    expect(result.data).toBe('ok');
  }, 10_000);

  it('throws after max retries on persistent 401', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(401, { detail: 'Unauthorized' }));

    const client = makeClient();
    await expect(client.get('/always-401/')).rejects.toThrow('Robinhood API error (401)');
    // 1 initial + 3 retries = 4 attempts
    expect(mockHttpRequest).toHaveBeenCalledTimes(4);
  });

  it('throws after max retries on persistent 429', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(429, { detail: 'Rate limited' }));

    const client = makeClient();
    await expect(client.get('/always-429/')).rejects.toThrow('Robinhood API error (429)');
    expect(mockHttpRequest).toHaveBeenCalledTimes(4);
  }, 15_000);
});

describe('RobinhoodClient.getAll (pagination)', () => {
  beforeEach(() => {
    mockHttpRequest.mockReset();
  });

  it('collects results across multiple pages', async () => {
    mockHttpRequest
      .mockResolvedValueOnce(mockResponse(200, {
        results: [{ id: 1 }, { id: 2 }],
        next: 'https://api.robinhood.com/test/?cursor=page2',
        previous: null,
      }))
      .mockResolvedValueOnce(mockResponse(200, {
        results: [{ id: 3 }],
        next: null,
        previous: 'https://api.robinhood.com/test/',
      }));

    const client = makeClient();
    const results = await client.getAll<{ id: number }>('/test/');

    expect(results).toHaveLength(3);
    expect(results.map(r => r.id)).toEqual([1, 2, 3]);
    expect(mockHttpRequest).toHaveBeenCalledTimes(2);
  });

  it('handles single page response', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(200, {
      results: [{ id: 1 }],
      next: null,
      previous: null,
    }));

    const client = makeClient();
    const results = await client.getAll<{ id: number }>('/single-page/');

    expect(results).toHaveLength(1);
    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
  });

  it('handles empty results', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(200, {
      results: [],
      next: null,
      previous: null,
    }));

    const client = makeClient();
    const results = await client.getAll('/empty/');

    expect(results).toHaveLength(0);
  });

  it('passes query params on first request only', async () => {
    mockHttpRequest.mockResolvedValue(mockResponse(200, {
      results: [],
      next: null,
      previous: null,
    }));

    const client = makeClient();
    await client.getAll('/test/', { symbol: 'BTC' });

    const [url] = mockHttpRequest.mock.calls[0];
    expect(url).toContain('symbol=BTC');
  });
});
