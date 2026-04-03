import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  detectStore,
  setStore,
  resetStore,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  getBackendName,
  type CredentialStore,
} from '../src/client/credential-store';
import type { SigningCredentials } from '../src/client/signing';

// ── Test Fixtures ────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);

const VALID_CREDS: SigningCredentials = {
  ed25519PrivateKey: 'aa'.repeat(32),
  ed25519PublicKey: 'bb'.repeat(32),
  verificationKey: 'dGVzdA==',
  verificationKeyId: 'd97c889a-fbd8-471d-955d-acc2829dffa5',
  expiresAt: NOW + 86400, // +1 day
  createdAt: NOW,
  provider: 'device',
};

const EXPIRED_CREDS: SigningCredentials = {
  ...VALID_CREDS,
  expiresAt: NOW - 600, // expired 10 min ago
};

const ABOUT_TO_EXPIRE_CREDS: SigningCredentials = {
  ...VALID_CREDS,
  expiresAt: NOW + 200, // expires in ~3 min (within 5 min buffer)
};

// ── In-Memory Mock Store ─────────────────────────────────────

function createMockStore(initial?: SigningCredentials): CredentialStore & { data: SigningCredentials | null } {
  const store = {
    backend: 'file' as const,
    data: initial ?? null,
    async load() { return store.data; },
    async save(creds: SigningCredentials) { store.data = creds; },
    async delete() { store.data = null; },
  };
  return store;
}

// ── Tests ────────────────────────────────────────────────────

describe('credential-store', () => {
  afterEach(() => {
    resetStore();
  });

  describe('loadCredentials', () => {
    it('returns valid credentials', async () => {
      setStore(createMockStore(VALID_CREDS));
      const creds = await loadCredentials();
      expect(creds).not.toBeNull();
      expect(creds!.verificationKeyId).toBe(VALID_CREDS.verificationKeyId);
      expect(creds!.provider).toBe('device');
    });

    it('returns null when no credentials exist', async () => {
      setStore(createMockStore());
      const creds = await loadCredentials();
      expect(creds).toBeNull();
    });

    it('returns null for expired credentials', async () => {
      setStore(createMockStore(EXPIRED_CREDS));
      const creds = await loadCredentials();
      expect(creds).toBeNull();
    });

    it('returns null for credentials expiring within 5 min buffer', async () => {
      setStore(createMockStore(ABOUT_TO_EXPIRE_CREDS));
      const creds = await loadCredentials();
      expect(creds).toBeNull();
    });
  });

  describe('saveCredentials', () => {
    it('persists credentials to the store', async () => {
      const store = createMockStore();
      setStore(store);
      await saveCredentials(VALID_CREDS);
      expect(store.data).not.toBeNull();
      expect(store.data!.ed25519PublicKey).toBe(VALID_CREDS.ed25519PublicKey);
    });

    it('overwrites existing credentials', async () => {
      const store = createMockStore(VALID_CREDS);
      setStore(store);
      const newCreds = { ...VALID_CREDS, provider: 'google' };
      await saveCredentials(newCreds);
      expect(store.data!.provider).toBe('google');
    });
  });

  describe('deleteCredentials', () => {
    it('removes stored credentials', async () => {
      const store = createMockStore(VALID_CREDS);
      setStore(store);
      await deleteCredentials();
      expect(store.data).toBeNull();
    });

    it('is a no-op when no credentials exist', async () => {
      const store = createMockStore();
      setStore(store);
      await deleteCredentials();
      expect(store.data).toBeNull();
    });
  });

  describe('getBackendName', () => {
    it('returns the backend name of the active store', async () => {
      setStore(createMockStore());
      const name = await getBackendName();
      expect(name).toBe('file');
    });
  });

  describe('detectStore', () => {
    it('returns a store with a valid backend name', async () => {
      const store = await detectStore();
      expect(['keychain', 'secret-tool', 'file']).toContain(store.backend);
    });

    it('returns keychain on macOS', async () => {
      if (process.platform === 'darwin') {
        const store = await detectStore();
        expect(store.backend).toBe('keychain');
      }
    });
  });
});
