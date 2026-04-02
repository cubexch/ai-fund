import { describe, it, expect } from 'vitest';
import { toLots, fromLots, SIDE_MAP, TIF_MAP, ORDER_TYPE_MAP } from '../src/tools/orders.js';

describe('toLots', () => {
  it('converts price with tick size 0.01', () => {
    // 83.69 / 0.01 = 8369
    expect(toLots('83.69', '0.01')).toBe(8369);
  });

  it('converts quantity with tick size 0.0001', () => {
    // 0.0119 / 0.0001 = 119
    expect(toLots('0.0119', '0.0001')).toBe(119);
  });

  it('handles whole numbers', () => {
    expect(toLots('100', '1')).toBe(100);
  });

  it('rounds to nearest lot', () => {
    // 83.695 / 0.01 = 8369.5 → rounds to 8370
    expect(toLots('83.695', '0.01')).toBe(8370);
  });

  it('throws on zero tick size', () => {
    expect(() => toLots('100', '0')).toThrow('Invalid tick size');
  });
});

describe('fromLots', () => {
  it('converts lots back to human-readable value', () => {
    expect(fromLots(8369, '0.01')).toBe('83.69');
  });

  it('converts quantity lots back', () => {
    expect(fromLots(119, '0.0001')).toBe('0.0119');
  });

  it('handles whole number tick sizes', () => {
    expect(fromLots(100, '1')).toBe('100');
  });
});

describe('SIDE_MAP', () => {
  it('maps BID to 0 and ASK to 1', () => {
    expect(SIDE_MAP.BID).toBe(0);
    expect(SIDE_MAP.ASK).toBe(1);
  });
});

describe('TIF_MAP', () => {
  it('maps time-in-force values correctly', () => {
    expect(TIF_MAP.IOC).toBe(0);
    expect(TIF_MAP.GFS).toBe(1);
    expect(TIF_MAP.FOK).toBe(2);
  });
});

describe('ORDER_TYPE_MAP', () => {
  it('maps all order types', () => {
    expect(ORDER_TYPE_MAP.LIMIT).toBe(0);
    expect(ORDER_TYPE_MAP.MARKET_LIMIT).toBe(1);
    expect(ORDER_TYPE_MAP.MARKET_WITH_PROTECTION).toBe(2);
    expect(ORDER_TYPE_MAP.STOP_LOSS).toBe(3);
    expect(ORDER_TYPE_MAP.STOP_LIMIT).toBe(4);
  });
});
