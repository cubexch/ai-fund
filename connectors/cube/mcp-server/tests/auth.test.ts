import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOsmiumAuthHeaders, getEnvironment, resetAuth } from '../src/client/auth';
import { generateKeyPair, toHex } from '../src/client/signing';

describe('getEnvironment', () => {
  it('returns production config for "production"', () => {
    const env = getEnvironment('production');
    expect(env.restUrl).toBe('https://api.cube.exchange/ir/v0');
    expect(env.mdRestUrl).toBe('https://api.cube.exchange/md');
    expect(env.wsTradeUrl).toBe('wss://api.cube.exchange/os');
    expect(env.wsMarketDataUrl).toBe('wss://api.cube.exchange/md');
  });

  it('returns staging config for "staging"', () => {
    const env = getEnvironment('staging');
    expect(env.restUrl).toBe('https://staging.cube.exchange/ir/v0');
    expect(env.mdRestUrl).toBe('https://staging.cube.exchange/md');
  });

  it('defaults to staging when undefined', () => {
    const env = getEnvironment(undefined);
    expect(env.restUrl).toContain('staging');
  });

  it('defaults to staging for unknown env', () => {
    const env = getEnvironment('foobar');
    expect(env.restUrl).toContain('staging');
  });
});

describe('buildOsmiumAuthHeaders', () => {
  beforeEach(() => {
    resetAuth();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetAuth();
  });

  it('includes both x-api-key and x-verification-key-id for Osmium REST compatibility', async () => {
    const keyPair = await generateKeyPair();
    vi.stubEnv('CUBE_SIGNING_KEY', toHex(keyPair.privateKeyRaw));
    vi.stubEnv('CUBE_VERIFICATION_KEY_ID', '8ffac2be-8c57-4dc0-a843-decd5a8b37d0');
    vi.stubEnv('CUBE_VERIFICATION_PUBLIC_KEY', toHex(keyPair.publicKey));

    const headers = await buildOsmiumAuthHeaders();

    expect(headers['x-api-key']).toBe('8ffac2be-8c57-4dc0-a843-decd5a8b37d0');
    expect(headers['x-verification-key-id']).toBe('8ffac2be-8c57-4dc0-a843-decd5a8b37d0');
    expect(headers['x-api-signature']).toBeTruthy();
    expect(headers['x-api-timestamp']).toMatch(/^\d+$/);
  });
});
