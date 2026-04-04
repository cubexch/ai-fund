/**
 * Elicitation middleware — gateway-aware wrapper for MCP tool handlers.
 *
 * Provides a `withElicitation` higher-order function that wraps any tool handler
 * with pre-execution risk checks and user confirmation. Works across ALL connectors
 * (Cube, CCXT, Alpaca, future ones) with a single integration point.
 *
 * Design principles:
 * - Connector-agnostic: works with any MCP server.tool() callback
 * - Composable: stack multiple policies (risk check, live mode gate, audit)
 * - Graceful degradation: falls back to text warnings when client lacks elicitation
 * - Gateway-ready: designed for single-point enforcement in orchestration layer
 */

import type { ConfidenceResult, SafetyProfileName, SafetyProfile } from './portfolio-analytics.js';
import { checkConfidenceRails, type BalanceEntry, type TickerEntry } from './portfolio-analytics.js';
import {
  canElicit,
  buildOrderConfirmation,
  buildLiveModeConfirmation,
  buildDestructiveConfirmation,
  isConfirmed,
  cancelledResponse,
  riskSummaryText,
  type ElicitationForm,
  type ElicitationResult,
  type ToolExtra,
  type OrderSummary,
} from './elicitation.js';

// ── Types ────────────────────────────────────────────────

/** Standard MCP tool response. */
export interface ToolResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Any MCP tool handler callback: (params, extra) => response.
 *  The `extra` parameter uses `any` for compatibility with the MCP SDK's
 *  RequestHandlerExtra type without coupling to it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolHandler<P = unknown> = (
  params: P,
  extra: any,
) => ToolResponse | Promise<ToolResponse>;

/** Policy that decides whether to elicit based on params. */
export interface ElicitationPolicy {
  /** Policy name for audit trail. */
  name: string;
  /** Return an elicitation form if this policy requires user confirmation, or null to skip. */
  assess(params: unknown, context: PolicyContext): ElicitationForm | null;
  /** Validate the user's response. Return true to proceed, false to cancel. */
  validate(result: ElicitationResult, context: PolicyContext): boolean;
}

/** Context available to policies. */
export interface PolicyContext {
  /** Tool name being called. */
  tool: string;
  /** Exchange name (e.g. 'cube', 'binance', 'alpaca'). */
  exchange: string;
  /** Whether we're in paper or live mode. */
  mode: 'paper' | 'live';
  /** Session state for tracking live-mode acknowledgments, etc. */
  session: SessionState;
}

/** Mutable session state shared across tool calls within a session. */
export interface SessionState {
  /** Whether the user has acknowledged live mode this session. */
  liveAcknowledged: boolean;
  /** Active safety profile name. */
  safetyProfile: SafetyProfileName;
  /** Total orders placed this session (for circuit breakers). */
  orderCount: number;
  /** Custom overrides set by user via elicitation forms. */
  overrides: Record<string, unknown>;
}

/** Creates a fresh session state with safe defaults. */
export function createSessionState(): SessionState {
  return {
    liveAcknowledged: false,
    safetyProfile: 'safe',
    orderCount: 0,
    overrides: {},
  };
}

// ── Elicitation engine ──────────────────────────────────

/**
 * Send an elicitation form to the user via MCP protocol.
 * Returns the user's response, or null if the client doesn't support elicitation.
 */
export async function elicit(
  extra: ToolExtra,
  form: ElicitationForm,
): Promise<ElicitationResult | null> {
  if (!canElicit(extra)) return null;

  try {
    // The MCP SDK's Server.elicitInput() calls sendRequest internally,
    // but from a tool handler we need to go through extra.sendRequest directly.
    // The protocol method is 'elicitation/create'.
    const result = await extra.sendRequest!(
      { method: 'elicitation/create', params: form },
      // The SDK validates against ElicitResultSchema internally
      { parse: (v: unknown) => v },
    );
    return result as ElicitationResult;
  } catch {
    // Client doesn't support elicitation or request failed
    return null;
  }
}

// ── Built-in policies ───────────────────────────────────

/**
 * Live mode gate — requires user acknowledgment before first live order.
 * Only triggers once per session (after acknowledgment, it's stored in session state).
 */
export class LiveModeGate implements ElicitationPolicy {
  name = 'live_mode_gate';

  assess(_params: unknown, ctx: PolicyContext): ElicitationForm | null {
    if (ctx.mode !== 'live') return null;
    if (ctx.session.liveAcknowledged) return null;
    return buildLiveModeConfirmation(ctx.exchange);
  }

  validate(result: ElicitationResult, ctx: PolicyContext): boolean {
    if (result.action !== 'accept') return false;
    if (!result.content?.confirm_live) return false;
    // Persist acknowledgment + safety profile choice
    ctx.session.liveAcknowledged = true;
    if (result.content.safety_profile && typeof result.content.safety_profile === 'string') {
      ctx.session.safetyProfile = result.content.safety_profile as SafetyProfileName;
    }
    return true;
  }
}

/**
 * Risk check policy — runs checkConfidenceRails and elicits on WARNING/BLOCKED.
 * Requires a function to fetch current balances and tickers.
 */
export class RiskCheckPolicy implements ElicitationPolicy {
  name = 'risk_check';

  constructor(
    private getPortfolio: () => Promise<{ balances: BalanceEntry[]; tickers: TickerEntry[] }>,
  ) {}

  private lastRisk: ConfidenceResult | null = null;

  assess(params: unknown, ctx: PolicyContext): ElicitationForm | null {
    // This is sync but we need async data — handled in assessAsync
    // The withElicitation wrapper calls assessAsync for this policy
    return null;
  }

  async assessAsync(params: unknown, ctx: PolicyContext): Promise<ElicitationForm | null> {
    const order = this.extractOrder(params);
    if (!order) return null;

    const { balances, tickers } = await this.getPortfolio();
    const risk = checkConfidenceRails(
      balances,
      tickers,
      { symbol: order.symbol, side: order.side as 'buy' | 'sell', amount: parseFloat(order.quantity), price: parseFloat(order.price || '0') },
      ctx.session.safetyProfile,
      { mode: ctx.mode },
    );

    this.lastRisk = risk;
    return buildOrderConfirmation(order, risk);
  }

  validate(result: ElicitationResult, _ctx: PolicyContext): boolean {
    const wasBlocked = this.lastRisk?.decision === 'BLOCKED';
    return isConfirmed(result, wasBlocked);
  }

  getRiskResult(): ConfidenceResult | null {
    return this.lastRisk;
  }

  private extractOrder(params: unknown): OrderSummary | null {
    if (!params || typeof params !== 'object') return null;
    const p = params as Record<string, unknown>;
    if (!p.quantity && !p.amount) return null;
    return {
      symbol: String(p.symbol || p.market || ''),
      side: String(p.side || ''),
      quantity: String(p.quantity || p.amount || ''),
      price: p.price !== undefined ? String(p.price) : undefined,
      orderType: String(p.orderType || p.order_type || 'LIMIT'),
    };
  }
}

/**
 * Destructive action policy — confirms cancels, modifications, mass operations.
 */
export class DestructiveActionPolicy implements ElicitationPolicy {
  name = 'destructive_action';

  constructor(
    private actionLabel: string,
    private detailsFn: (params: unknown) => string,
  ) {}

  assess(params: unknown, _ctx: PolicyContext): ElicitationForm | null {
    const details = this.detailsFn(params);
    return buildDestructiveConfirmation(this.actionLabel, details);
  }

  validate(result: ElicitationResult, _ctx: PolicyContext): boolean {
    return isConfirmed(result);
  }
}

// ── Main wrapper ────────────────────────────────────────

/**
 * Configuration for the elicitation wrapper.
 */
export interface ElicitationConfig {
  /** Tool name (for audit/logging). */
  tool: string;
  /** Exchange name. */
  exchange: string;
  /** How to determine paper vs live mode. */
  getMode: () => 'paper' | 'live';
  /** Session state (shared across tool calls). */
  session: SessionState;
  /** Ordered list of policies to evaluate. All must pass. */
  policies: (ElicitationPolicy | RiskCheckPolicy)[];
}

/**
 * Wrap a tool handler with elicitation policies.
 *
 * Evaluates each policy in order. If any policy requires user confirmation:
 * 1. If client supports elicitation: show the form, validate response
 * 2. If client doesn't support elicitation: include risk warning in response text
 *
 * All policies must pass for the handler to execute.
 *
 * @example
 * ```ts
 * server.tool('place_order', schema, withElicitation(
 *   async (params, extra) => { /* original handler *\/ },
 *   {
 *     tool: 'place_order',
 *     exchange: 'cube',
 *     getMode: () => process.env.CUBE_ENV === 'production' ? 'live' : 'paper',
 *     session: sessionState,
 *     policies: [new LiveModeGate(), riskPolicy],
 *   },
 * ));
 * ```
 */
export function withElicitation<P>(
  handler: ToolHandler<P>,
  config: ElicitationConfig,
): ToolHandler<P> {
  return async (params: P, extra: ToolExtra) => {
    const ctx: PolicyContext = {
      tool: config.tool,
      exchange: config.exchange,
      mode: config.getMode(),
      session: config.session,
    };

    for (const policy of config.policies) {
      // Get the form — some policies are async (need to fetch portfolio data)
      let form: ElicitationForm | null;
      if ('assessAsync' in policy && typeof policy.assessAsync === 'function') {
        form = await policy.assessAsync(params, ctx);
      } else {
        form = policy.assess(params, ctx);
      }

      if (!form) continue; // policy doesn't require confirmation

      // Try elicitation
      const result = await elicit(extra, form);

      if (result) {
        // Client supports elicitation — validate user response
        if (!policy.validate(result, ctx)) {
          // User declined or validation failed
          const risk = 'getRiskResult' in policy ? (policy as RiskCheckPolicy).getRiskResult() : null;
          return cancelledResponse(
            result.action === 'accept' ? 'risk_override_refused' : result.action,
            risk ?? undefined,
          );
        }
        // User confirmed — continue to next policy
      } else {
        // Client doesn't support elicitation — fallback behavior
        // For risk policies, include warning text in the eventual response
        // For live mode gate, we can't proceed without acknowledgment
        if (policy.name === 'live_mode_gate') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                status: 'blocked',
                reason: 'live_mode_unacknowledged',
                message: 'Live trading requires explicit user confirmation. Your client does not support interactive forms. Please use a client that supports MCP elicitation, or set safety_profile via environment.',
              }, null, 2),
            }],
            isError: true,
          };
        }

        // For risk warnings, attach to the response (non-blocking)
        if ('getRiskResult' in policy) {
          const risk = (policy as RiskCheckPolicy).getRiskResult();
          if (risk && risk.decision === 'BLOCKED') {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  status: 'blocked_by_risk',
                  riskAssessment: riskSummaryText(risk),
                  message: 'Order blocked by risk checks. Enable elicitation to override.',
                }, null, 2),
              }],
              isError: true,
            };
          }
          // WARNING without elicitation: proceed but log
        }
      }
    }

    // All policies passed — execute the original handler
    config.session.orderCount++;
    return handler(params, extra);
  };
}
