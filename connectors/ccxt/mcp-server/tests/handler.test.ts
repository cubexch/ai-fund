import { describe, it, expect } from 'vitest';
import { handler, authHandler } from '../src/tools/handler.js';
import { createMockClient } from './helpers.js';

describe('handler wrapper', () => {
  it('serializes return value as JSON text content', async () => {
    const fn = handler(async () => ({ price: 65000, symbol: 'BTC/USDT' }));
    const result = await fn({});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    const data = JSON.parse(result.content[0].text);
    expect(data.price).toBe(65000);
    expect(data.symbol).toBe('BTC/USDT');
    expect(result.isError).toBeUndefined();
  });

  it('catches errors and returns sanitized message', async () => {
    const fn = handler(async () => { throw new Error('api_key=SECRETKEY123 leaked'); });
    const result = await fn({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed:');
    expect(result.content[0].text).not.toContain('SECRETKEY123');
    expect(result.content[0].text).toContain('[REDACTED]');
  });

  it('passes params to the inner function', async () => {
    let received: unknown;
    const fn = handler(async (params: any) => { received = params; return 'ok'; });
    await fn({ symbol: 'ETH/USDT', limit: 10 });

    expect(received).toEqual({ symbol: 'ETH/USDT', limit: 10 });
  });

  it('handles non-Error throws', async () => {
    const fn = handler(async () => { throw 'string error'; });
    const result = await fn({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('string error');
  });
});

describe('authHandler wrapper', () => {
  it('rejects when client has no credentials', async () => {
    const client = createMockClient({ hasCredentials: false } as any);
    const fn = authHandler(client, async () => ({ data: 'secret' }));
    const result = await fn({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No API credentials');
  });

  it('executes handler when credentials present', async () => {
    const client = createMockClient({ hasCredentials: true } as any);
    const fn = authHandler(client, async () => ({ balance: 1000 }));
    const result = await fn({});

    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.balance).toBe(1000);
  });

  it('catches inner errors with sanitization', async () => {
    const client = createMockClient({ hasCredentials: true } as any);
    const fn = authHandler(client, async () => { throw new Error('secret=abc123 oops'); });
    const result = await fn({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain('abc123');
  });
});
