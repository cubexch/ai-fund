import { describe, it, expect } from 'vitest';
import { getEnvironment } from '../src/client/auth';

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
