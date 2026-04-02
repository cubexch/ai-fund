import { describe, it, expect } from 'vitest';
import {
  usd, pct, qty, price, compact, timestamp, duration,
  signedValue, assetIcon, labelAsset, grade, ASSET_ICONS,
} from '../../../../lib/format.js';

describe('usd', () => {
  it('formats with $ prefix and commas', () => {
    expect(usd(1234.56)).toBe('$1,234.56');
  });

  it('supports custom decimals', () => {
    expect(usd(100, 0)).toBe('$100');
    expect(usd(99.999, 4)).toBe('$99.9990');
  });
});

describe('pct', () => {
  it('converts decimal to percentage', () => {
    expect(pct(0.5)).toBe('50.0%');
    expect(pct(0.123, 2)).toBe('12.30%');
  });
});

describe('qty', () => {
  it('trims trailing zeros', () => {
    expect(qty(1.5)).toBe('1.5');
    expect(qty(1.0)).toBe('1');
    expect(qty(0.123456)).toBe('0.123456');
  });
});

describe('price', () => {
  it('formats with fixed decimals', () => {
    expect(price(99.1)).toBe('99.10');
    expect(price(100, 4)).toBe('100.0000');
  });
});

describe('compact', () => {
  it('uses B/M/K suffixes', () => {
    expect(compact(1_500_000_000)).toBe('1.5B');
    expect(compact(2_300_000)).toBe('2.3M');
    expect(compact(45_000)).toBe('45.0K');
    expect(compact(999)).toBe('999.00');
  });
});

describe('timestamp', () => {
  it('formats ISO date with UTC suffix', () => {
    const result = timestamp(1700000000000);
    expect(result).toContain('UTC');
    expect(result).toContain('2023-11-14');
  });
});

describe('duration', () => {
  it('formats durations in appropriate units', () => {
    expect(duration(500)).toBe('500ms');
    expect(duration(5000)).toBe('5.0s');
    expect(duration(120_000)).toBe('2.0m');
    expect(duration(7_200_000)).toBe('2.0h');
    expect(duration(172_800_000)).toBe('2.0d');
  });
});

describe('signedValue', () => {
  it('adds + for positive, - for negative', () => {
    expect(signedValue(100)).toBe('+$100.00');
    expect(signedValue(-50)).toBe('-$50.00');
    expect(signedValue(0)).toBe('+$0.00');
  });
});

describe('ASSET_ICONS', () => {
  it('has entries for major assets', () => {
    expect(ASSET_ICONS['BTC']).toBe('₿');
    expect(ASSET_ICONS['ETH']).toBe('Ξ');
    expect(ASSET_ICONS['SOL']).toBe('◎');
    expect(ASSET_ICONS['USDC']).toBe('💵');
  });
});

describe('assetIcon', () => {
  it('returns icon for known asset', () => {
    expect(assetIcon('btc')).toBe('₿');
    expect(assetIcon('ETH')).toBe('Ξ');
  });

  it('returns empty string for unknown', () => {
    expect(assetIcon('UNKNOWN')).toBe('');
  });
});

describe('labelAsset', () => {
  it('prepends icon to symbol', () => {
    expect(labelAsset('BTC')).toBe('₿ BTC');
    expect(labelAsset('SOL')).toBe('◎ SOL');
  });

  it('returns just symbol for unknown', () => {
    expect(labelAsset('FOOBAR')).toBe('FOOBAR');
  });
});

describe('grade', () => {
  it('assigns letter grades correctly', () => {
    expect(grade(95)).toBe('A');
    expect(grade(85)).toBe('B');
    expect(grade(75)).toBe('C');
    expect(grade(65)).toBe('D');
    expect(grade(50)).toBe('F');
  });
});
