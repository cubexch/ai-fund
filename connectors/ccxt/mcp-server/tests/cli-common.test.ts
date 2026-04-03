import { describe, it, expect } from 'vitest';
import { parseArgs, envPrefix } from '../src/cli/common';

describe('parseArgs', () => {
  it('defaults to coinbase', () => {
    const args = parseArgs([]);
    expect(args.exchangeId).toBe('coinbase');
    expect(args.sandbox).toBe(false);
  });

  it('parses --exchange flag', () => {
    const args = parseArgs(['--exchange', 'binance']);
    expect(args.exchangeId).toBe('binance');
  });

  it('parses --sandbox flag', () => {
    const args = parseArgs(['--sandbox']);
    expect(args.sandbox).toBe(true);
  });

  it('parses both flags together', () => {
    const args = parseArgs(['--exchange', 'bybit', '--sandbox']);
    expect(args.exchangeId).toBe('bybit');
    expect(args.sandbox).toBe(true);
  });

  it('rejects invalid exchange IDs', () => {
    expect(() => parseArgs(['--exchange', '../../../etc/passwd'])).toThrow('Invalid exchange ID');
    expect(() => parseArgs(['--exchange', 'COINBASE'])).toThrow('Invalid exchange ID');
    expect(() => parseArgs(['--exchange', 'foo bar'])).toThrow('Invalid exchange ID');
  });
});

describe('envPrefix', () => {
  it('returns uppercase with underscores', () => {
    expect(envPrefix('coinbase')).toBe('COINBASE');
    expect(envPrefix('gate-io')).toBe('GATE_IO');
    expect(envPrefix('huobi_pro')).toBe('HUOBI_PRO');
  });
});
