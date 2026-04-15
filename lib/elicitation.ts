/**
 * MCP Elicitation helpers — form builders for human-in-the-loop confirmation.
 *
 * Uses the MCP SDK `elicitation/create` protocol to ask the *user* (not the LLM)
 * structured questions mid-tool-call. Supports form mode (typed fields) with
 * graceful fallback when the client doesn't support elicitation.
 *
 * Designed for trading workflows: order confirmation, risk acknowledgment,
 * safety profile selection, execution parameter adjustment.
 */

import type { ConfidenceResult } from './portfolio-analytics.js';

// ── Types ────────────────────────────────────────────────

/** Primitive field types supported by MCP elicitation forms. */
export type PrimitiveSchema =
  | { type: 'boolean'; title?: string; description?: string; default?: boolean }
  | { type: 'string'; title?: string; description?: string; default?: string; format?: 'email' | 'uri' | 'date' | 'date-time' }
  | { type: 'string'; title?: string; description?: string; enum: string[]; default?: string }
  | { type: 'number' | 'integer'; title?: string; description?: string; minimum?: number; maximum?: number; default?: number };

/** A form-mode elicitation request. */
export interface ElicitationForm {
  mode?: 'form';
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, PrimitiveSchema>;
    required?: string[];
  };
}

/** The user's response to an elicitation request. */
export interface ElicitationResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, string | number | boolean | string[]>;
}

/** Minimal interface for the `extra` object passed to MCP tool handlers.
 *  Intentionally uses `any` for the sendRequest signature to match
 *  RequestHandlerExtra's generic overloads without coupling to the SDK. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ToolExtra {
  sendRequest?: (...args: any[]) => Promise<any>;
}

/** Order summary for confirmation forms. */
export interface OrderSummary {
  symbol: string;
  side: string;
  quantity: string;
  price?: string;
  orderType: string;
  exchange?: string;
}

// ── Capability detection ────────────────────────────────

/**
 * Check if elicitation is available on the current client.
 * Returns false if the extra object doesn't have sendRequest (meaning
 * the client can't handle elicitation/create requests).
 *
 * Note: This is a best-effort check. The actual capability is negotiated
 * during initialization. If the client advertised elicitation support,
 * sendRequest will be available. If not, we fall back gracefully.
 */
export function canElicit(extra: unknown): extra is ToolExtra {
  return (
    extra !== null &&
    extra !== undefined &&
    typeof extra === 'object' &&
    'sendRequest' in extra &&
    typeof (extra as ToolExtra).sendRequest === 'function'
  );
}

// ── Form builders ───────────────────────────────────────

/**
 * Build an order confirmation form from confidence rail results.
 *
 * - GO decisions: no form needed (return null)
 * - WARNING decisions: show warnings + confirm checkbox
 * - BLOCKED decisions: show blockers + explicit risk acknowledgment
 */
export function buildOrderConfirmation(
  order: OrderSummary,
  risk: ConfidenceResult,
): ElicitationForm | null {
  if (risk.decision === 'GO') return null;

  const failedRails = risk.rails.filter(r => !r.passed);
  const warnings = failedRails.filter(r => r.severity === 'warn');
  const blockers = failedRails.filter(r => r.severity === 'block');

  const lines: string[] = [];
  lines.push(`Order: ${order.side.toUpperCase()} ${order.quantity} ${order.symbol}`);
  if (order.price) lines.push(`Price: ${order.price}`);
  lines.push(`Type: ${order.orderType}`);
  if (order.exchange) lines.push(`Exchange: ${order.exchange}`);
  lines.push('');
  lines.push(`Risk assessment: ${risk.decision}`);
  lines.push(`Safety profile: ${risk.profile}`);
  lines.push('');

  if (blockers.length > 0) {
    lines.push('BLOCKED:');
    for (const b of blockers) {
      lines.push(`  - ${b.explanation}`);
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('Warnings:');
    for (const w of warnings) {
      lines.push(`  - ${w.explanation}`);
    }
  }

  const properties: Record<string, PrimitiveSchema> = {};
  const required: string[] = [];

  if (risk.decision === 'BLOCKED') {
    properties.override_risk = {
      type: 'boolean',
      title: 'I understand the risks and want to proceed anyway',
    };
    required.push('override_risk');
  }

  properties.confirm = {
    type: 'boolean',
    title: 'Confirm order',
  };
  required.push('confirm');

  return {
    message: lines.join('\n'),
    requestedSchema: {
      type: 'object',
      properties,
      required,
    },
  };
}

/**
 * Build a simple destructive action confirmation form.
 * Used for cancel_order, modify_order, cancel_all_orders, close_position.
 */
export function buildDestructiveConfirmation(
  action: string,
  details: string,
): ElicitationForm {
  return {
    message: `${action}\n\n${details}`,
    requestedSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          title: `Confirm: ${action}`,
        },
      },
      required: ['confirm'],
    },
  };
}

/**
 * Build a live trading mode confirmation form.
 * Shown on first live order of the session.
 */
export function buildLiveModeConfirmation(
  exchange: string,
): ElicitationForm {
  return {
    message: [
      'LIVE TRADING MODE',
      '',
      `You are about to place a REAL order on ${exchange}.`,
      'This will use real funds. Paper trading is recommended for testing.',
    ].join('\n'),
    requestedSchema: {
      type: 'object',
      properties: {
        confirm_live: {
          type: 'boolean',
          title: 'I confirm this is a live order with real funds',
        },
        safety_profile: {
          type: 'string',
          title: 'Safety profile for this session',
          enum: ['safe', 'moderate', 'aggressive'],
          default: 'safe',
        },
      },
      required: ['confirm_live'],
    },
  };
}

/**
 * Build an execution plan confirmation form.
 * Used for TWAP/VWAP/Iceberg algorithms where the user can adjust parameters.
 */
export function buildExecutionPlanConfirmation(
  plan: {
    algorithm: string;
    symbol: string;
    totalQuantity: string;
    slices: number;
    durationMinutes: number;
    estimatedImpactBps?: number;
  },
): ElicitationForm {
  const lines: string[] = [];
  lines.push(`${plan.algorithm.toUpperCase()} Execution Plan`);
  lines.push(`${plan.slices} slices over ${plan.durationMinutes} minutes`);
  lines.push(`Total: ${plan.totalQuantity} ${plan.symbol}`);
  if (plan.estimatedImpactBps !== undefined) {
    lines.push(`Estimated impact: ${(plan.estimatedImpactBps / 100).toFixed(2)}%`);
  }

  return {
    message: lines.join('\n'),
    requestedSchema: {
      type: 'object',
      properties: {
        approve_plan: {
          type: 'boolean',
          title: 'Approve execution plan',
        },
        adjust_slices: {
          type: 'integer',
          title: `Number of slices (default: ${plan.slices})`,
          minimum: 2,
          maximum: 200,
          default: plan.slices,
        },
        adjust_duration: {
          type: 'integer',
          title: `Duration in minutes (default: ${plan.durationMinutes})`,
          minimum: 1,
          maximum: 1440,
          default: plan.durationMinutes,
        },
      },
      required: ['approve_plan'],
    },
  };
}

// ── Response helpers ────────────────────────────────────

/**
 * Check if the user accepted the elicitation and confirmed the action.
 * Returns true only if action is 'accept' and the confirm field is truthy.
 * For BLOCKED orders, also checks override_risk is truthy.
 */
export function isConfirmed(result: ElicitationResult, wasBlocked = false): boolean {
  if (result.action !== 'accept') return false;
  if (!result.content) return false;
  if (wasBlocked && !result.content.override_risk) return false;
  return !!result.content.confirm;
}

/**
 * Build a cancelled-by-user tool response.
 */
export function cancelledResponse(
  reason: 'decline' | 'cancel' | 'risk_override_refused',
  risk?: ConfidenceResult,
): { content: { type: 'text'; text: string }[]; isError: false } {
  const payload: Record<string, unknown> = {
    status: 'cancelled_by_user',
    reason,
  };
  if (risk) {
    payload.riskAssessment = {
      decision: risk.decision,
      profile: risk.profile,
      summary: risk.summary,
      rails: risk.rails.filter(r => !r.passed).map(r => ({
        name: r.name,
        severity: r.severity,
        detail: r.detail,
      })),
    };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    isError: false,
  };
}

/**
 * Format risk assessment as text for inclusion in tool response
 * when elicitation is not available (fallback path).
 */
export function riskSummaryText(risk: ConfidenceResult): string {
  const lines: string[] = [];
  lines.push(`Risk: ${risk.decision} (${risk.profile} profile)`);
  lines.push(risk.summary);
  const failed = risk.rails.filter(r => !r.passed);
  if (failed.length > 0) {
    lines.push('');
    for (const r of failed) {
      lines.push(`  [${r.severity.toUpperCase()}] ${r.explanation}`);
    }
  }
  return lines.join('\n');
}
