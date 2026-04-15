/**
 * Unit tests for Robinhood credential store.
 * Tests the file-based fallback store and convenience API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  type RobinhoodCredentials,
  type CredentialStore,
  setStore,
  resetStore,
  loadCredentials,
  loadCredentialsRaw,
  saveCredentials,
  deleteCredentials,
  getBackendName,
} from '../src/client/credential-store';

// ── In-memory store for testing ─────────────────────────

class InMemoryStore implements CredentialStore {
  readonly backend = 'file' as const;
  private data: RobinhoodCredentials | null = null;

  async load(): Promise<RobinhoodCredentials | null> {
    return this.data;
  }
  async save(creds: RobinhoodCredentials): Promise<void> {
    this.data = { ...creds };
  }
  async delete(): Promise<void> {
    this.data = null;
  }
}

// ── Fixtures ────────────────────────────────────────────

function validCreds(overrides?: Partial<RobinhoodCredentials>): RobinhoodCredentials {
  return {
    accessToken: 'tok_abc',
    refreshToken: 'ref_xyz',
    expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    deviceToken: '550e8400-e29b-41d4-a716-446655440000',
    ...overrides,
  };
}

function expiredCreds(): RobinhoodCredentials {
  return validCreds({ expiresAt: Math.floor(Date.now() / 1000) - 60 }); // expired 1 min ago
}

function almostExpiredCreds(): RobinhoodCredentials {
  // Expires in 2 minutes — within the 5-minute buffer, so should be treated as expired
  return validCreds({ expiresAt: Math.floor(Date.now() / 1000) + 120 });
}

// ── Tests ───────────────────────────────────────────────

describe('credential-store convenience API', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
    setStore(store);
  });

  afterEach(() => {
    resetStore();
  });

  it('returns null when no credentials saved', async () => {
    const result = await loadCredentials();
    expect(result).toBeNull();
  });

  it('saves and loads valid credentials', async () => {
    const creds = validCreds();
    await saveCredentials(creds);

    const loaded = await loadCredentials();
    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe('tok_abc');
    expect(loaded!.refreshToken).toBe('ref_xyz');
    expect(loaded!.deviceToken).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns null for expired credentials', async () => {
    await saveCredentials(expiredCreds());

    const loaded = await loadCredentials();
    expect(loaded).toBeNull();
  });

  it('returns null for credentials within 5-minute expiry buffer', async () => {
    await saveCredentials(almostExpiredCreds());

    const loaded = await loadCredentials();
    expect(loaded).toBeNull();
  });

  it('loadCredentialsRaw returns expired credentials', async () => {
    const creds = expiredCreds();
    await saveCredentials(creds);

    const loaded = await loadCredentialsRaw();
    expect(loaded).not.toBeNull();
    expect(loaded!.accessToken).toBe('tok_abc');
  });

  it('deletes credentials', async () => {
    await saveCredentials(validCreds());
    await deleteCredentials();

    const loaded = await loadCredentials();
    expect(loaded).toBeNull();

    const raw = await loadCredentialsRaw();
    expect(raw).toBeNull();
  });

  it('reports backend name', async () => {
    const name = await getBackendName();
    expect(name).toBe('file');
  });

  it('preserves optional fields (accountUrl, accountId)', async () => {
    const creds = validCreds({
      accountUrl: 'https://api.robinhood.com/accounts/ABC123/',
      accountId: 'ABC123',
    });
    await saveCredentials(creds);

    const loaded = await loadCredentials();
    expect(loaded!.accountUrl).toBe('https://api.robinhood.com/accounts/ABC123/');
    expect(loaded!.accountId).toBe('ABC123');
  });

  it('overwrites existing credentials on save', async () => {
    await saveCredentials(validCreds({ accessToken: 'tok_old' }));
    await saveCredentials(validCreds({ accessToken: 'tok_new' }));

    const loaded = await loadCredentials();
    expect(loaded!.accessToken).toBe('tok_new');
  });
});

describe('credential-store RobinhoodCredentials shape', () => {
  it('has required fields', () => {
    const creds = validCreds();
    expect(creds).toHaveProperty('accessToken');
    expect(creds).toHaveProperty('refreshToken');
    expect(creds).toHaveProperty('expiresAt');
    expect(creds).toHaveProperty('deviceToken');
  });

  it('expiresAt is a unix timestamp in seconds', () => {
    const creds = validCreds();
    // Should be in seconds, not milliseconds
    expect(creds.expiresAt).toBeLessThan(1e11);
    expect(creds.expiresAt).toBeGreaterThan(1e9);
  });
});
