import { describe, it, expect, afterEach } from 'vitest';
import {
  detectStore,
  resetStore,
} from '../src/client/credential-store';
import type { SigningCredentials } from '../src/client/signing';

const NOW = Math.floor(Date.now() / 1000);

const VALID_CREDS: SigningCredentials = {
  ed25519PrivateKey: 'aa'.repeat(32),
  ed25519PublicKey: 'bb'.repeat(32),
  verificationKey: 'dGVzdA==',
  verificationKeyId: 'd97c889a-fbd8-471d-955d-acc2829dffa5',
  expiresAt: NOW + 86400,
  createdAt: NOW,
  provider: 'device',
};

describe('credential-store platform integration', () => {
  const itMac = process.platform === 'darwin' ? it : it.skip;

  afterEach(() => {
    resetStore();
  });

  itMac('round-trips credentials through macOS Keychain', async () => {
    resetStore();
    const store = await detectStore();
    expect(store.backend).toBe('keychain');

    await store.save(VALID_CREDS);

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.ed25519PublicKey).toBe(VALID_CREDS.ed25519PublicKey);
    expect(loaded!.verificationKeyId).toBe(VALID_CREDS.verificationKeyId);
    expect(loaded!.provider).toBe('device');

    await store.delete();
    const after = await store.load();
    expect(after).toBeNull();
  });

  itMac('handles save → overwrite → load correctly', async () => {
    const store = await detectStore();

    await store.save(VALID_CREDS);
    const updated = { ...VALID_CREDS, provider: 'google' };
    await store.save(updated);

    const loaded = await store.load();
    expect(loaded!.provider).toBe('google');

    await store.delete();
  });
});
