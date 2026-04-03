import { describe, it, expect, beforeEach } from 'vitest';
import {
  setStore,
  resetStore,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  getBackendName,
  type CredentialStore,
  type AlpacaCredentials,
} from '../src/client/credential-store.js';

// ── In-memory store for testing ─────────────────────────────

class MemoryStore implements CredentialStore {
  readonly backend = 'file' as const;
  private data: AlpacaCredentials | null = null;

  async load() { return this.data; }
  async save(creds: AlpacaCredentials) { this.data = creds; }
  async delete() { this.data = null; }
}

describe('credential store', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    setStore(store);
  });

  it('returns null when no credentials saved', async () => {
    const creds = await loadCredentials();
    expect(creds).toBeNull();
  });

  it('saves and loads credentials', async () => {
    const creds: AlpacaCredentials = {
      apiKey: 'PK123',
      apiSecret: 'secret456',
      paper: true,
    };

    await saveCredentials(creds);
    const loaded = await loadCredentials();

    expect(loaded).not.toBeNull();
    expect(loaded!.apiKey).toBe('PK123');
    expect(loaded!.apiSecret).toBe('secret456');
    expect(loaded!.paper).toBe(true);
  });

  it('deletes credentials', async () => {
    await saveCredentials({ apiKey: 'k', apiSecret: 's', paper: true });
    expect(await loadCredentials()).not.toBeNull();

    await deleteCredentials();
    expect(await loadCredentials()).toBeNull();
  });

  it('returns backend name', async () => {
    const name = await getBackendName();
    expect(name).toBe('file');
  });

  it('overwrites existing credentials on save', async () => {
    await saveCredentials({ apiKey: 'old', apiSecret: 'old', paper: true });
    await saveCredentials({ apiKey: 'new', apiSecret: 'new', paper: false });

    const loaded = await loadCredentials();
    expect(loaded!.apiKey).toBe('new');
    expect(loaded!.paper).toBe(false);
  });

  it('delete is idempotent', async () => {
    await deleteCredentials();
    await deleteCredentials(); // should not throw
    expect(await loadCredentials()).toBeNull();
  });
});

describe('resetStore', () => {
  it('resets the cached store', async () => {
    const store1 = new MemoryStore();
    setStore(store1);
    await saveCredentials({ apiKey: 'k', apiSecret: 's', paper: true });

    resetStore();
    // After reset, a new store is detected — we won't have the old data
    // but we can verify it doesn't throw
    setStore(new MemoryStore());
    const loaded = await loadCredentials();
    expect(loaded).toBeNull();
  });
});
