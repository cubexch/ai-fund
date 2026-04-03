import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateExchangeId,
  setStore,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
} from '../src/client/credential-store';
import { ExchangeClient } from '../src/client/exchange';
import { MemoryStore } from './helpers';

// ── Path traversal prevention ───────────────────────────────

describe('exchangeId validation', () => {
  it('accepts valid exchange IDs', () => {
    expect(() => validateExchangeId('coinbase')).not.toThrow();
    expect(() => validateExchangeId('binance')).not.toThrow();
    expect(() => validateExchangeId('kraken')).not.toThrow();
    expect(() => validateExchangeId('gate-io')).not.toThrow();
    expect(() => validateExchangeId('okx')).not.toThrow();
    expect(() => validateExchangeId('bybit')).not.toThrow();
    expect(() => validateExchangeId('huobi_pro')).not.toThrow();
  });

  it('rejects path traversal attempts', () => {
    expect(() => validateExchangeId('../../../etc/passwd')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('../../secrets')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('/etc/passwd')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('foo/../bar')).toThrow('Invalid exchange ID');
  });

  it('rejects empty strings', () => {
    expect(() => validateExchangeId('')).toThrow('Invalid exchange ID');
  });

  it('rejects IDs with special characters', () => {
    expect(() => validateExchangeId('exchange;rm -rf /')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('exchange$(whoami)')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('exchange|cat /etc/passwd')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('ex change')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('exchange\n')).toThrow('Invalid exchange ID');
  });

  it('rejects uppercase IDs (CCXT uses lowercase)', () => {
    expect(() => validateExchangeId('Coinbase')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('BINANCE')).toThrow('Invalid exchange ID');
  });

  it('rejects IDs starting with hyphen or underscore', () => {
    expect(() => validateExchangeId('-exchange')).toThrow('Invalid exchange ID');
    expect(() => validateExchangeId('_exchange')).toThrow('Invalid exchange ID');
  });
});

// ── Credential store rejects bad IDs ────────────────────────

describe('credential store rejects bad exchange IDs', () => {
  beforeEach(() => {
    setStore(new MemoryStore());
  });

  it('rejects load with path traversal', async () => {
    await expect(loadCredentials('../../../etc/passwd')).rejects.toThrow('Invalid exchange ID');
  });

  it('rejects save with path traversal', async () => {
    await expect(saveCredentials({
      exchangeId: '../../../tmp/evil',
      apiKey: 'k',
      secret: 's',
      sandbox: false,
    })).rejects.toThrow('Invalid exchange ID');
  });

  it('rejects delete with path traversal', async () => {
    await expect(deleteCredentials('../../../tmp/evil')).rejects.toThrow('Invalid exchange ID');
  });
});

// ── Credential isolation between exchanges ──────────────────

describe('credential isolation', () => {
  beforeEach(() => {
    setStore(new MemoryStore());
  });

  it('cannot read one exchange credentials using another ID', async () => {
    await saveCredentials({
      exchangeId: 'coinbase',
      apiKey: 'coinbase-secret-key',
      secret: 'coinbase-secret',
      sandbox: false,
    });

    const binance = await loadCredentials('binance');
    expect(binance).toBeNull();
  });

  it('deleting one exchange does not affect others', async () => {
    await saveCredentials({ exchangeId: 'coinbase', apiKey: 'k1', secret: 's1', sandbox: false });
    await saveCredentials({ exchangeId: 'binance', apiKey: 'k2', secret: 's2', sandbox: false });

    await deleteCredentials('coinbase');

    expect(await loadCredentials('coinbase')).toBeNull();
    expect(await loadCredentials('binance')).not.toBeNull();
    expect((await loadCredentials('binance'))!.apiKey).toBe('k2');
  });
});

// ── Client doesn't expose credentials ───────────────────────

describe('ExchangeClient credential safety', () => {
  function createMockExchange(overrides: Record<string, unknown> = {}) {
    return {
      apiKey: overrides.apiKey ?? 'super-secret-key',
      secret: overrides.secret ?? 'super-secret-value',
      name: 'MockExchange',
      urls: { api: 'https://api.example.com' },
      markets: {},
      ...overrides,
    };
  }

  it('hasCredentials does not return the actual credentials', () => {
    const client = new ExchangeClient({
      exchangeId: 'test',
      exchangeInstance: createMockExchange() as any,
    });
    // hasCredentials returns boolean, not the credentials themselves
    const result = client.hasCredentials;
    expect(typeof result).toBe('boolean');
    expect(result).toBe(true);
  });

  it('name does not expose credentials', () => {
    const client = new ExchangeClient({
      exchangeId: 'test',
      exchangeInstance: createMockExchange() as any,
    });
    expect(client.name).toBe('MockExchange');
    expect(client.name).not.toContain('secret');
    expect(client.name).not.toContain('key');
  });

  it('exchangeId does not contain credentials', () => {
    const client = new ExchangeClient({
      exchangeId: 'coinbase',
      exchangeInstance: createMockExchange() as any,
    });
    expect(client.exchangeId).toBe('coinbase');
  });
});
