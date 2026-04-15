import { describe, it, expect, vi } from 'vitest';
import {
  withElicitation,
  LiveModeGate,
  RiskCheckPolicy,
  DestructiveActionPolicy,
  createSessionState,
  elicit,
  type ToolHandler,
  type ToolResponse,
  type SessionState,
  type ElicitationConfig,
} from '../../../../lib/elicitation-middleware.js';
import type { ToolExtra, ElicitationResult, ElicitationForm } from '../../../../lib/elicitation.js';
import type { BalanceEntry, TickerEntry } from '../../../../lib/portfolio-analytics.js';

// ── Helpers ──────────────────────────────────────────

function mockExtra(response: ElicitationResult): ToolExtra {
  return {
    sendRequest: vi.fn().mockResolvedValue(response),
  };
}

function noElicitExtra(): ToolExtra {
  return {}; // no sendRequest = no elicitation support
}

const okResponse: ToolResponse = {
  content: [{ type: 'text', text: '{"status":"placed"}' }],
};

function makeHandler(): ToolHandler {
  return vi.fn().mockResolvedValue(okResponse);
}

function makeConfig(overrides: Partial<ElicitationConfig> = {}): ElicitationConfig {
  return {
    tool: 'place_order',
    exchange: 'cube',
    getMode: () => 'paper',
    session: createSessionState(),
    policies: [],
    ...overrides,
  };
}

const testBalances: BalanceEntry[] = [
  { currency: 'USDT', free: 100000, used: 0, total: 100000 },
];

const testTickers: TickerEntry[] = [
  { symbol: 'BTC/USDT', last: 43500 },
];

// ── createSessionState ──────────────────────────────

describe('createSessionState', () => {
  it('creates fresh state with safe defaults', () => {
    const state = createSessionState();
    expect(state.liveAcknowledged).toBe(false);
    expect(state.safetyProfile).toBe('safe');
    expect(state.orderCount).toBe(0);
    expect(state.overrides).toEqual({});
  });
});

// ── elicit ──────────────────────────────────────────

describe('elicit', () => {
  it('returns result when client supports elicitation', async () => {
    const extra = mockExtra({ action: 'accept', content: { confirm: true } });
    const form: ElicitationForm = {
      message: 'test',
      requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] },
    };
    const result = await elicit(extra, form);
    expect(result).toEqual({ action: 'accept', content: { confirm: true } });
  });

  it('returns null when client lacks elicitation support', async () => {
    const result = await elicit(noElicitExtra(), {
      message: 'test',
      requestedSchema: { type: 'object', properties: {} },
    });
    expect(result).toBeNull();
  });

  it('returns null when sendRequest throws', async () => {
    const extra: ToolExtra = {
      sendRequest: vi.fn().mockRejectedValue(new Error('not supported')),
    };
    const result = await elicit(extra, {
      message: 'test',
      requestedSchema: { type: 'object', properties: {} },
    });
    expect(result).toBeNull();
  });
});

// ── LiveModeGate ────────────────────────────────────

describe('LiveModeGate', () => {
  const gate = new LiveModeGate();

  it('returns null in paper mode', () => {
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'paper' as const, session: createSessionState() };
    expect(gate.assess({}, ctx)).toBeNull();
  });

  it('returns form in live mode when not acknowledged', () => {
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'live' as const, session: createSessionState() };
    const form = gate.assess({}, ctx);
    expect(form).not.toBeNull();
    expect(form!.message).toContain('LIVE TRADING MODE');
  });

  it('returns null in live mode when already acknowledged', () => {
    const session = createSessionState();
    session.liveAcknowledged = true;
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'live' as const, session };
    expect(gate.assess({}, ctx)).toBeNull();
  });

  it('validate sets liveAcknowledged and safetyProfile on accept', () => {
    const session = createSessionState();
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'live' as const, session };
    const result = gate.validate(
      { action: 'accept', content: { confirm_live: true, safety_profile: 'moderate' } },
      ctx,
    );
    expect(result).toBe(true);
    expect(session.liveAcknowledged).toBe(true);
    expect(session.safetyProfile).toBe('moderate');
  });

  it('validate returns false on decline', () => {
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'live' as const, session: createSessionState() };
    expect(gate.validate({ action: 'decline' }, ctx)).toBe(false);
  });

  it('validate returns false when confirm_live is false', () => {
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'live' as const, session: createSessionState() };
    expect(gate.validate({ action: 'accept', content: { confirm_live: false } }, ctx)).toBe(false);
  });
});

// ── RiskCheckPolicy ─────────────────────────────────

describe('RiskCheckPolicy', () => {
  const getPortfolio = async () => ({ balances: testBalances, tickers: testTickers });

  it('returns null for non-order params', async () => {
    const policy = new RiskCheckPolicy(getPortfolio);
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'paper' as const, session: createSessionState() };
    const form = await policy.assessAsync({}, ctx);
    expect(form).toBeNull();
  });

  it('returns null (GO) for small orders within moderate limits', async () => {
    const policy = new RiskCheckPolicy(getPortfolio);
    const session = createSessionState();
    session.safetyProfile = 'moderate'; // moderate doesn't require paper mode
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'live' as const, session };
    // 0.001 BTC @ 43500 = $43.5 = 0.44% of $10,000 portfolio (under 5% moderate limit)
    const form = await policy.assessAsync(
      { symbol: 'BTC/USDT', side: 'buy', quantity: '0.001', price: '43500', orderType: 'LIMIT' },
      ctx,
    );
    expect(form).toBeNull();
  });

  it('returns form for oversized orders', async () => {
    const policy = new RiskCheckPolicy(getPortfolio);
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'paper' as const, session: createSessionState() };
    // 1 BTC @ 43500 = $43,500 = 435% of $10,000 portfolio (way over 2% safe limit)
    const form = await policy.assessAsync(
      { symbol: 'BTCUSDC', side: 'buy', quantity: '1', price: '43500', orderType: 'LIMIT' },
      ctx,
    );
    expect(form).not.toBeNull();
    expect(form!.message).toContain('BLOCKED');
  });

  it('validate passes for confirmed order', () => {
    const policy = new RiskCheckPolicy(getPortfolio);
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'paper' as const, session: createSessionState() };
    const result = policy.validate(
      { action: 'accept', content: { confirm: true } },
      ctx,
    );
    expect(result).toBe(true);
  });

  it('validate fails for declined order', () => {
    const policy = new RiskCheckPolicy(getPortfolio);
    const ctx = { tool: 'place_order', exchange: 'cube', mode: 'paper' as const, session: createSessionState() };
    expect(policy.validate({ action: 'decline' }, ctx)).toBe(false);
  });
});

// ── DestructiveActionPolicy ─────────────────────────

describe('DestructiveActionPolicy', () => {
  it('builds confirmation form from params', () => {
    const policy = new DestructiveActionPolicy(
      'Cancel order',
      (p: unknown) => `Order #${(p as { clientOrderId: number }).clientOrderId}`,
    );
    const ctx = { tool: 'cancel_order', exchange: 'cube', mode: 'paper' as const, session: createSessionState() };
    const form = policy.assess({ clientOrderId: 12345 }, ctx);
    expect(form).not.toBeNull();
    expect(form!.message).toContain('Cancel order');
    expect(form!.message).toContain('12345');
  });

  it('validate passes for confirmed action', () => {
    const policy = new DestructiveActionPolicy('Cancel', () => 'details');
    const ctx = { tool: 'cancel_order', exchange: 'cube', mode: 'paper' as const, session: createSessionState() };
    expect(policy.validate({ action: 'accept', content: { confirm: true } }, ctx)).toBe(true);
  });

  it('validate fails for unconfirmed action', () => {
    const policy = new DestructiveActionPolicy('Cancel', () => 'details');
    const ctx = { tool: 'cancel_order', exchange: 'cube', mode: 'paper' as const, session: createSessionState() };
    expect(policy.validate({ action: 'accept', content: { confirm: false } }, ctx)).toBe(false);
  });
});

// ── withElicitation integration ─────────────────────

describe('withElicitation', () => {
  it('passes through to handler when no policies', async () => {
    const handler = makeHandler();
    const wrapped = withElicitation(handler, makeConfig());
    const extra = noElicitExtra();

    const result = await wrapped({}, extra);
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual(okResponse);
  });

  it('passes through when all policies return null (no confirmation needed)', async () => {
    const handler = makeHandler();
    const gate = new LiveModeGate(); // paper mode → null
    const wrapped = withElicitation(handler, makeConfig({ policies: [gate] }));

    const result = await wrapped({}, noElicitExtra());
    expect(handler).toHaveBeenCalledOnce();
    expect(result).toEqual(okResponse);
  });

  it('blocks live orders when client lacks elicitation', async () => {
    const handler = makeHandler();
    const gate = new LiveModeGate();
    const config = makeConfig({ policies: [gate], getMode: () => 'live' });
    const wrapped = withElicitation(handler, config);

    const result = await wrapped({}, noElicitExtra());
    expect(handler).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('blocked');
    expect(parsed.reason).toBe('live_mode_unacknowledged');
  });

  it('allows live orders after user confirms via elicitation', async () => {
    const handler = makeHandler();
    const gate = new LiveModeGate();
    const config = makeConfig({ policies: [gate], getMode: () => 'live' });
    const wrapped = withElicitation(handler, config);

    const extra = mockExtra({ action: 'accept', content: { confirm_live: true, safety_profile: 'moderate' } });
    const result = await wrapped({}, extra);
    expect(handler).toHaveBeenCalledOnce();
    expect(config.session.liveAcknowledged).toBe(true);
    expect(config.session.safetyProfile).toBe('moderate');
  });

  it('cancels when user declines live mode', async () => {
    const handler = makeHandler();
    const gate = new LiveModeGate();
    const config = makeConfig({ policies: [gate], getMode: () => 'live' });
    const wrapped = withElicitation(handler, config);

    const extra = mockExtra({ action: 'decline' });
    const result = await wrapped({}, extra);
    expect(handler).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('cancelled_by_user');
    expect(parsed.reason).toBe('decline');
  });

  it('blocks oversized orders via risk policy without elicitation', async () => {
    const handler = makeHandler();
    const riskPolicy = new RiskCheckPolicy(async () => ({
      balances: testBalances,
      tickers: testTickers,
    }));
    const config = makeConfig({ policies: [riskPolicy] });
    const wrapped = withElicitation(handler, config);

    // 10 BTC @ 43500 = way over safe limits
    const result = await wrapped(
      { symbol: 'BTC/USDT', side: 'buy', quantity: '10', price: '43500', orderType: 'LIMIT' },
      noElicitExtra(),
    );
    expect(handler).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('blocked_by_risk');
  });

  it('evaluates policies in order and stops at first blocking decline', async () => {
    const handler = makeHandler();
    const gate = new LiveModeGate();
    const destructive = new DestructiveActionPolicy('test', () => 'details');
    const config = makeConfig({
      policies: [gate, destructive],
      getMode: () => 'live',
    });
    const wrapped = withElicitation(handler, config);

    // User declines live mode gate — should never reach destructive policy
    const extra = mockExtra({ action: 'decline' });
    await wrapped({}, extra);
    // Only one sendRequest call (for the gate), not two
    expect(extra.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('increments orderCount on successful execution', async () => {
    const handler = makeHandler();
    const config = makeConfig();
    const wrapped = withElicitation(handler, config);

    expect(config.session.orderCount).toBe(0);
    await wrapped({}, noElicitExtra());
    expect(config.session.orderCount).toBe(1);
    await wrapped({}, noElicitExtra());
    expect(config.session.orderCount).toBe(2);
  });

  it('does not increment orderCount when cancelled', async () => {
    const handler = makeHandler();
    const gate = new LiveModeGate();
    const config = makeConfig({ policies: [gate], getMode: () => 'live' });
    const wrapped = withElicitation(handler, config);

    await wrapped({}, mockExtra({ action: 'decline' }));
    expect(config.session.orderCount).toBe(0);
  });

  it('stacks multiple policies — live gate + risk check', async () => {
    const handler = makeHandler();
    const gate = new LiveModeGate();
    const riskPolicy = new RiskCheckPolicy(async () => ({
      balances: testBalances,
      tickers: testTickers,
    }));
    const config = makeConfig({
      policies: [gate, riskPolicy],
      getMode: () => 'live',
    });
    const wrapped = withElicitation(handler, config);

    // First call: accepts live gate with 'moderate' profile (doesn't require paper mode)
    let callCount = 0;
    const smartExtra: ToolExtra = {
      sendRequest: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // Live mode gate response — moderate allows live trading
          return { action: 'accept', content: { confirm_live: true, safety_profile: 'moderate' } };
        }
        // Risk check shouldn't trigger for small orders
        return { action: 'accept', content: { confirm: true } };
      }),
    };

    // Small order: 0.001 BTC × $43500 = $43.5 = 0.44% of portfolio → GO → no risk elicitation
    const result = await wrapped(
      { symbol: 'BTC/USDT', side: 'buy', quantity: '0.001', price: '43500', orderType: 'LIMIT' },
      smartExtra,
    );
    expect(handler).toHaveBeenCalledOnce();
    // Only 1 sendRequest (live gate), risk policy returned null (GO)
    expect(smartExtra.sendRequest).toHaveBeenCalledTimes(1);
  });

  it('skips live gate on subsequent calls after acknowledgment', async () => {
    const handler = makeHandler();
    const gate = new LiveModeGate();
    const config = makeConfig({
      policies: [gate],
      getMode: () => 'live',
    });
    const wrapped = withElicitation(handler, config);

    // First call: acknowledge
    const extra1 = mockExtra({ action: 'accept', content: { confirm_live: true } });
    await wrapped({}, extra1);
    expect(extra1.sendRequest).toHaveBeenCalledTimes(1);

    // Second call: skip gate (already acknowledged)
    const extra2 = mockExtra({ action: 'accept', content: { confirm_live: true } });
    await wrapped({}, extra2);
    expect(extra2.sendRequest).not.toHaveBeenCalled(); // no elicitation needed
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
