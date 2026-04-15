import { describe, it, expect } from 'vitest';
import {
  canElicit,
  buildOrderConfirmation,
  buildDestructiveConfirmation,
  buildLiveModeConfirmation,
  buildExecutionPlanConfirmation,
  isConfirmed,
  cancelledResponse,
  riskSummaryText,
} from '../../../../lib/elicitation.js';
import type { ConfidenceResult } from '../../../../lib/portfolio-analytics.js';
import type { ElicitationResult, OrderSummary } from '../../../../lib/elicitation.js';

// ── Fixtures ──────────────────────────────────────────

const baseOrder: OrderSummary = {
  symbol: 'BTCUSDC',
  side: 'buy',
  quantity: '0.5',
  price: '43500',
  orderType: 'LIMIT',
};

function makeRisk(overrides: Partial<ConfidenceResult> = {}): ConfidenceResult {
  return {
    decision: 'GO',
    profile: 'safe',
    order: { symbol: 'BTCUSDC', side: 'buy', amount: 0.5, price: 43500 },
    orderValue: 21750,
    rails: [],
    summary: 'All checks passed.',
    ...overrides,
  };
}

// ── canElicit ─────────────────────────────────────────

describe('canElicit', () => {
  it('returns true when extra has sendRequest function', () => {
    const extra = { sendRequest: async () => ({}) };
    expect(canElicit(extra)).toBe(true);
  });

  it('returns false for null/undefined', () => {
    expect(canElicit(null)).toBe(false);
    expect(canElicit(undefined)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(canElicit({})).toBe(false);
  });

  it('returns false when sendRequest is not a function', () => {
    expect(canElicit({ sendRequest: 'not a function' })).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(canElicit(42)).toBe(false);
    expect(canElicit('string')).toBe(false);
    expect(canElicit(true)).toBe(false);
  });
});

// ── buildOrderConfirmation ───────────────────────────

describe('buildOrderConfirmation', () => {
  it('returns null for GO decisions', () => {
    const risk = makeRisk({ decision: 'GO' });
    expect(buildOrderConfirmation(baseOrder, risk)).toBeNull();
  });

  it('builds form for WARNING decisions', () => {
    const risk = makeRisk({
      decision: 'WARNING',
      rails: [
        {
          name: 'open_orders',
          passed: false,
          severity: 'warn',
          detail: 'Open orders: 18 (max 20)',
          explanation: 'Approaching open order limit.',
        },
      ],
    });

    const form = buildOrderConfirmation(baseOrder, risk);
    expect(form).not.toBeNull();
    expect(form!.message).toContain('WARNING');
    expect(form!.message).toContain('BUY 0.5 BTCUSDC');
    expect(form!.message).toContain('43500');
    expect(form!.requestedSchema.properties.confirm).toBeDefined();
    expect(form!.requestedSchema.required).toContain('confirm');
    // WARNING: no override_risk needed
    expect(form!.requestedSchema.properties.override_risk).toBeUndefined();
  });

  it('builds form for BLOCKED decisions with override_risk', () => {
    const risk = makeRisk({
      decision: 'BLOCKED',
      rails: [
        {
          name: 'position_size',
          passed: false,
          severity: 'block',
          detail: '15.2% of portfolio (max 2%)',
          explanation: 'Position exceeds 2% of portfolio.',
        },
      ],
    });

    const form = buildOrderConfirmation(baseOrder, risk);
    expect(form).not.toBeNull();
    expect(form!.message).toContain('BLOCKED');
    expect(form!.message).toContain('Position exceeds');
    expect(form!.requestedSchema.properties.override_risk).toBeDefined();
    expect(form!.requestedSchema.required).toContain('override_risk');
    expect(form!.requestedSchema.required).toContain('confirm');
  });

  it('includes exchange when provided', () => {
    const order = { ...baseOrder, exchange: 'Cube' };
    const risk = makeRisk({ decision: 'WARNING', rails: [{ name: 'x', passed: false, severity: 'warn', detail: 'x', explanation: 'x' }] });
    const form = buildOrderConfirmation(order, risk);
    expect(form!.message).toContain('Exchange: Cube');
  });

  it('handles multiple failed rails', () => {
    const risk = makeRisk({
      decision: 'BLOCKED',
      rails: [
        { name: 'position_size', passed: false, severity: 'block', detail: 'x', explanation: 'Position too large.' },
        { name: 'daily_loss', passed: false, severity: 'block', detail: 'x', explanation: 'Daily loss exceeded.' },
        { name: 'open_orders', passed: false, severity: 'warn', detail: 'x', explanation: 'Too many orders.' },
        { name: 'leverage', passed: true, severity: 'warn', detail: 'x', explanation: 'OK' },
      ],
    });

    const form = buildOrderConfirmation(baseOrder, risk);
    expect(form!.message).toContain('Position too large.');
    expect(form!.message).toContain('Daily loss exceeded.');
    expect(form!.message).toContain('Too many orders.');
    // Passed rails should NOT appear as warnings/blockers
    expect(form!.message).not.toContain('OK');
  });

  it('omits price line when price is undefined', () => {
    const order = { ...baseOrder, price: undefined };
    const risk = makeRisk({ decision: 'WARNING', rails: [{ name: 'x', passed: false, severity: 'warn', detail: 'x', explanation: 'x' }] });
    const form = buildOrderConfirmation(order, risk);
    expect(form!.message).not.toContain('Price:');
  });
});

// ── buildDestructiveConfirmation ─────────────────────

describe('buildDestructiveConfirmation', () => {
  it('builds a confirmation form with action and details', () => {
    const form = buildDestructiveConfirmation('Cancel order', 'Order #12345 on BTCUSDC (BID @ 43500)');
    expect(form.message).toContain('Cancel order');
    expect(form.message).toContain('Order #12345');
    expect(form.requestedSchema.properties.confirm.type).toBe('boolean');
    expect(form.requestedSchema.required).toContain('confirm');
  });
});

// ── buildLiveModeConfirmation ───────────────────────

describe('buildLiveModeConfirmation', () => {
  it('builds a live mode confirmation form', () => {
    const form = buildLiveModeConfirmation('Cube Exchange');
    expect(form.message).toContain('LIVE TRADING MODE');
    expect(form.message).toContain('Cube Exchange');
    expect(form.message).toContain('real funds');
    expect(form.requestedSchema.properties.confirm_live).toBeDefined();
    expect(form.requestedSchema.properties.safety_profile).toBeDefined();
    // safety_profile should be an enum
    const sp = form.requestedSchema.properties.safety_profile;
    expect('enum' in sp && sp.enum).toEqual(['safe', 'moderate', 'aggressive']);
    expect(form.requestedSchema.required).toContain('confirm_live');
  });
});

// ── buildExecutionPlanConfirmation ──────────────────

describe('buildExecutionPlanConfirmation', () => {
  it('builds a TWAP confirmation form', () => {
    const form = buildExecutionPlanConfirmation({
      algorithm: 'twap',
      symbol: 'BTC',
      totalQuantity: '2.0',
      slices: 12,
      durationMinutes: 60,
      estimatedImpactBps: 12,
    });

    expect(form.message).toContain('TWAP');
    expect(form.message).toContain('12 slices');
    expect(form.message).toContain('60 minutes');
    expect(form.message).toContain('2.0 BTC');
    expect(form.message).toContain('0.12%');
    expect(form.requestedSchema.properties.approve_plan).toBeDefined();
    expect(form.requestedSchema.properties.adjust_slices).toBeDefined();
    expect(form.requestedSchema.properties.adjust_duration).toBeDefined();
    expect(form.requestedSchema.required).toContain('approve_plan');
  });

  it('omits impact when not provided', () => {
    const form = buildExecutionPlanConfirmation({
      algorithm: 'vwap',
      symbol: 'ETH',
      totalQuantity: '10',
      slices: 20,
      durationMinutes: 120,
    });
    expect(form.message).not.toContain('impact');
  });

  it('sets correct min/max on adjustable fields', () => {
    const form = buildExecutionPlanConfirmation({
      algorithm: 'iceberg',
      symbol: 'SOL',
      totalQuantity: '100',
      slices: 5,
      durationMinutes: 30,
    });
    const slices = form.requestedSchema.properties.adjust_slices;
    expect('minimum' in slices && slices.minimum).toBe(2);
    expect('maximum' in slices && slices.maximum).toBe(200);
  });
});

// ── isConfirmed ─────────────────────────────────────

describe('isConfirmed', () => {
  it('returns true for accept + confirm true', () => {
    const result: ElicitationResult = { action: 'accept', content: { confirm: true } };
    expect(isConfirmed(result)).toBe(true);
  });

  it('returns false for decline', () => {
    const result: ElicitationResult = { action: 'decline' };
    expect(isConfirmed(result)).toBe(false);
  });

  it('returns false for cancel', () => {
    const result: ElicitationResult = { action: 'cancel' };
    expect(isConfirmed(result)).toBe(false);
  });

  it('returns false when confirm is false', () => {
    const result: ElicitationResult = { action: 'accept', content: { confirm: false } };
    expect(isConfirmed(result)).toBe(false);
  });

  it('returns false when content is missing', () => {
    const result: ElicitationResult = { action: 'accept' };
    expect(isConfirmed(result)).toBe(false);
  });

  it('returns false for blocked order without override_risk', () => {
    const result: ElicitationResult = { action: 'accept', content: { confirm: true } };
    expect(isConfirmed(result, true)).toBe(false);
  });

  it('returns true for blocked order with override_risk + confirm', () => {
    const result: ElicitationResult = {
      action: 'accept',
      content: { confirm: true, override_risk: true },
    };
    expect(isConfirmed(result, true)).toBe(true);
  });

  it('returns false for blocked order with override_risk but no confirm', () => {
    const result: ElicitationResult = {
      action: 'accept',
      content: { confirm: false, override_risk: true },
    };
    expect(isConfirmed(result, true)).toBe(false);
  });
});

// ── cancelledResponse ───────────────────────────────

describe('cancelledResponse', () => {
  it('returns cancelled status with reason', () => {
    const resp = cancelledResponse('decline');
    const parsed = JSON.parse(resp.content[0].text);
    expect(parsed.status).toBe('cancelled_by_user');
    expect(parsed.reason).toBe('decline');
    expect(resp.isError).toBe(false);
  });

  it('includes risk assessment when provided', () => {
    const risk = makeRisk({
      decision: 'BLOCKED',
      rails: [
        { name: 'position_size', passed: false, severity: 'block', detail: '15%', explanation: 'Too large' },
        { name: 'leverage', passed: true, severity: 'warn', detail: 'OK', explanation: 'OK' },
      ],
    });
    const resp = cancelledResponse('risk_override_refused', risk);
    const parsed = JSON.parse(resp.content[0].text);
    expect(parsed.riskAssessment.decision).toBe('BLOCKED');
    expect(parsed.riskAssessment.rails).toHaveLength(1); // only failed rails
    expect(parsed.riskAssessment.rails[0].name).toBe('position_size');
  });

  it('omits risk assessment when not provided', () => {
    const resp = cancelledResponse('cancel');
    const parsed = JSON.parse(resp.content[0].text);
    expect(parsed.riskAssessment).toBeUndefined();
  });
});

// ── riskSummaryText ─────────────────────────────────

describe('riskSummaryText', () => {
  it('includes decision and profile', () => {
    const risk = makeRisk({ decision: 'WARNING', profile: 'moderate' });
    const text = riskSummaryText(risk);
    expect(text).toContain('WARNING');
    expect(text).toContain('moderate');
  });

  it('includes failed rail explanations', () => {
    const risk = makeRisk({
      decision: 'BLOCKED',
      rails: [
        { name: 'pos', passed: false, severity: 'block', detail: 'x', explanation: 'Position too large.' },
        { name: 'ok', passed: true, severity: 'warn', detail: 'x', explanation: 'Fine' },
      ],
    });
    const text = riskSummaryText(risk);
    expect(text).toContain('[BLOCK] Position too large.');
    expect(text).not.toContain('Fine'); // passed rails excluded
  });

  it('works with no failed rails', () => {
    const risk = makeRisk({ decision: 'GO', summary: 'All good.' });
    const text = riskSummaryText(risk);
    expect(text).toContain('All good.');
  });
});
