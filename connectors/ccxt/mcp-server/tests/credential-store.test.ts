import { describe, it, expect, beforeEach } from 'vitest';
import {
  setStore,
  resetStore,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  getBackendName,
  type CcxtCredentials,
} from '../src/client/credential-store';
import { MemoryStore } from './helpers';

describe('credential store', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    setStore(store);
  });

  it('returns null when no credentials saved', async () => {
    const creds = await loadCredentials('coinbase');
    expect(creds).toBeNull();
  });

  it('saves and loads credentials for an exchange', async () => {
    const creds: CcxtCredentials = {
      exchangeId: 'coinbase',
      apiKey: 'cb-key-123',
      secret: 'cb-secret-456',
      password: 'cb-passphrase',
      sandbox: true,
    };

    await saveCredentials(creds);
    const loaded = await loadCredentials('coinbase');

    expect(loaded).not.toBeNull();
    expect(loaded!.exchangeId).toBe('coinbase');
    expect(loaded!.apiKey).toBe('cb-key-123');
    expect(loaded!.secret).toBe('cb-secret-456');
    expect(loaded!.password).toBe('cb-passphrase');
    expect(loaded!.sandbox).toBe(true);
  });

  it('stores credentials per exchange independently', async () => {
    await saveCredentials({
      exchangeId: 'coinbase',
      apiKey: 'cb-key',
      secret: 'cb-secret',
      sandbox: false,
    });

    await saveCredentials({
      exchangeId: 'binance',
      apiKey: 'bn-key',
      secret: 'bn-secret',
      sandbox: true,
    });

    const coinbase = await loadCredentials('coinbase');
    const binance = await loadCredentials('binance');
    const kraken = await loadCredentials('kraken');

    expect(coinbase!.apiKey).toBe('cb-key');
    expect(coinbase!.sandbox).toBe(false);
    expect(binance!.apiKey).toBe('bn-key');
    expect(binance!.sandbox).toBe(true);
    expect(kraken).toBeNull();
  });

  it('deletes credentials for one exchange without affecting others', async () => {
    await saveCredentials({ exchangeId: 'coinbase', apiKey: 'k', secret: 's', sandbox: false });
    await saveCredentials({ exchangeId: 'binance', apiKey: 'k2', secret: 's2', sandbox: false });

    await deleteCredentials('coinbase');

    expect(await loadCredentials('coinbase')).toBeNull();
    expect(await loadCredentials('binance')).not.toBeNull();
  });

  it('overwrites existing credentials on save', async () => {
    await saveCredentials({ exchangeId: 'coinbase', apiKey: 'old', secret: 'old', sandbox: true });
    await saveCredentials({ exchangeId: 'coinbase', apiKey: 'new', secret: 'new', sandbox: false });

    const loaded = await loadCredentials('coinbase');
    expect(loaded!.apiKey).toBe('new');
    expect(loaded!.sandbox).toBe(false);
  });

  it('delete is idempotent', async () => {
    await deleteCredentials('coinbase');
    await deleteCredentials('coinbase'); // should not throw
    expect(await loadCredentials('coinbase')).toBeNull();
  });

  it('returns backend name', async () => {
    const name = await getBackendName();
    expect(name).toBe('file');
  });

  it('handles credentials without password', async () => {
    await saveCredentials({
      exchangeId: 'binance',
      apiKey: 'key',
      secret: 'secret',
      sandbox: true,
    });

    const loaded = await loadCredentials('binance');
    expect(loaded!.password).toBeUndefined();
  });
});

describe('resetStore', () => {
  it('resets the cached store', async () => {
    const store1 = new MemoryStore();
    setStore(store1);
    await saveCredentials({ exchangeId: 'coinbase', apiKey: 'k', secret: 's', sandbox: true });

    resetStore();
    setStore(new MemoryStore());
    const loaded = await loadCredentials('coinbase');
    expect(loaded).toBeNull();
  });
});
