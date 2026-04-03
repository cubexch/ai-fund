import { describe, it, expect } from 'vitest';
import { generateSignature, getEnvironment } from '../src/client/auth';

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

describe('generateSignature', () => {
  it('produces a base64 string', () => {
    const sig = generateSignature(
      '6203b1c7291ed69f5f171a1ec77eaf0a4db0e7b096a59b3e9f92683c7efa6649',
      1700000000
    );
    expect(sig).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('produces deterministic output for same inputs', () => {
    const key = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
    const ts = 1700000000;
    const sig1 = generateSignature(key, ts);
    const sig2 = generateSignature(key, ts);
    expect(sig1).toBe(sig2);
  });

  it('produces different output for different timestamps', () => {
    const key = 'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233';
    const sig1 = generateSignature(key, 1700000000);
    const sig2 = generateSignature(key, 1700000001);
    expect(sig1).not.toBe(sig2);
  });

  it('produces different output for different keys', () => {
    const ts = 1700000000;
    const sig1 = generateSignature(
      'aabbccdd00112233aabbccdd00112233aabbccdd00112233aabbccdd00112233',
      ts
    );
    const sig2 = generateSignature(
      '1122334455667788112233445566778811223344556677881122334455667788',
      ts
    );
    expect(sig1).not.toBe(sig2);
  });
});
