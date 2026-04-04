# MCP Elicitation Integration — 30/60/90 Plan

> Human-in-the-loop for Cube, Gateway, and the AI Fund trading workflow.

## Executive Summary

The MCP SDK (v1.29.0, already installed across all three connectors) ships `elicitation/create` — a protocol-level mechanism for MCP servers to ask the **user** (not the LLM) structured questions mid-tool-call. Two modes: **form** (typed fields rendered as UI) and **url** (redirect to browser). The server calls `server.elicitInput(params)` inside a tool handler; the client renders a form; the user responds with `accept`/`decline`/`cancel` + typed content.

**Current state**: Every tool handler ignores the `extra` argument that carries elicitation access. Pre-trade risk checks (`checkPreTrade`, `checkConfidenceRails`) and safety profiles (`safe`/`moderate`/`aggressive`) are fully implemented in `lib/portfolio-analytics.ts` but **never called** from any MCP tool. The only confirmation pattern is a docstring ("Always confirm with the user before placing live orders") — zero enforcement.

**Goal**: Wire elicitation into every destructive/irreversible trading action so the user gets a structured confirmation form with risk assessment before orders hit the exchange. Extend to all three connectors and the gateway layer.

---

## Protocol Reference (SDK 1.29.0)

```
Server                           Client                          User
  │                                │                               │
  │  elicitation/create            │                               │
  │  { mode:'form',               │                               │
  │    message: "Confirm order",  │                               │
  │    requestedSchema: {         │                               │
  │      type:'object',           │  Render form UI               │
  │      properties: {...}        │ ─────────────────────────────> │
  │    }                          │                               │
  │  } ────────────────────────>  │                               │
  │                                │  User fills form              │
  │                                │ <───────────────────────────── │
  │  ElicitResult                  │                               │
  │  { action:'accept',           │                               │
  │    content: { confirm: true } │                               │
  │  } <────────────────────────  │                               │
  │                                │                               │
  │  [proceed with order]          │                               │
```

**Supported field types**: `string` (with format: email/uri/date/date-time), `number`/`integer` (with min/max), `boolean`, `enum` (single select with oneOf), `array` (multi-select). All flat — no nesting.

**Access in tool handler**: `server.tool(name, desc, schema, async (params, extra) => { ... })` — the `extra` object carries `sendRequest` which `server.elicitInput()` uses internally. Tool handlers currently ignore `extra`.

---

## 30-Day: Foundation — Cube Order Confirmation

### 1. Elicitation helper module (`lib/elicitation.ts`)

Create a shared module that builds elicitation form schemas from risk check results. All three connectors will use this.

```typescript
// lib/elicitation.ts
import type { ConfidenceResult, ConfidenceRail } from './portfolio-analytics.js';

export interface OrderConfirmationForm {
  message: string;
  requestedSchema: {
    type: 'object';
    properties: Record<string, PrimitiveSchema>;
    required?: string[];
  };
}

/** Build an elicitation form from confidence rail results */
export function buildOrderConfirmation(
  order: { symbol: string; side: string; quantity: string; price?: string; orderType: string },
  riskResult: ConfidenceResult,
): OrderConfirmationForm { ... }

/** Build a simple yes/no confirmation for destructive actions */
export function buildDestructiveConfirmation(
  action: string,
  details: string,
): OrderConfirmationForm { ... }

/** Check if elicitation is available on the client */
export function canElicit(extra: unknown): boolean { ... }
```

**Deliverable**: Pure function module, no connector dependencies. Unit tests covering all form shapes.

### 2. Wire `checkConfidenceRails` into `place_order` (Cube)

Modify `connectors/cube/mcp-server/src/tools/orders.ts`:

```typescript
// Before (line 97):
async params => {

// After:
async (params, extra) => {
  // 1. Run risk checks BEFORE touching the exchange
  const riskResult = checkConfidenceRails(balances, tickers, order, profile, context);

  // 2. If blocked or warning, elicit user confirmation
  if (riskResult.decision !== 'GO' && canElicit(extra)) {
    const form = buildOrderConfirmation(orderSummary, riskResult);
    const result = await server.elicitInput(form);
    if (result.action !== 'accept') {
      return { content: [{ type: 'text', text: JSON.stringify({
        status: 'cancelled_by_user', reason: result.action, riskAssessment: riskResult
      })}] };
    }
  }

  // 3. Proceed with order placement as before
```

**Key decisions**:
- `GO` decisions skip elicitation (no friction for safe orders)
- `WARNING` orders show a form with warnings + confirm checkbox
- `BLOCKED` orders show a form explaining why + override checkbox (requires explicit "I understand the risk")
- If client doesn't support elicitation (Claude Code permission prompt is the fallback), proceed with risk info in response text

**Deliverable**: `place_order` tool requires user confirmation for risky orders. Tests with mock elicitation.

### 3. Confirmation for `cancel_order`, `modify_order`, `close_position` (Cube)

Apply the same pattern to all mutating order tools. These are simpler — no risk scoring needed, just "are you sure" with order details.

```typescript
// cancel_order: "Cancel order #X on BTCUSDC? [Yes/No]"
// modify_order: "Modify order #X: price $83.69 → $84.20? [Yes/No]"
// close_position: "Close 0.5 BTC position at market? Est. value: $42,500 [Yes/No]"
```

**Deliverable**: All 4 mutating order tools use elicitation. Graceful fallback when client doesn't support it.

### 4. Paper/Live mode gate

Add a hard elicitation gate when `CUBE_ENV !== 'staging'`:

```typescript
// First live order of the session triggers:
{
  message: "⚠️ LIVE TRADING MODE\nYou are about to place a REAL order on Cube Exchange.\nThis will use real funds.",
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
      }
    },
    required: ['confirm_live', 'safety_profile']
  }
}
```

**Deliverable**: No live order executes without explicit user acknowledgment. Safety profile selection persists for the session.

### 5. Tests

- Unit tests for `lib/elicitation.ts` (form building, edge cases)
- Integration tests for order tool elicitation flow (mock `extra.sendRequest`)
- Tests for fallback behavior when client doesn't support elicitation
- Tests for paper vs. live mode gating

**30-Day Total**: ~8 files changed/created, ~400 lines of new code, ~200 lines of tests.

---

## 60-Day: Expand to All Connectors + Rich Flows

### 6. CCXT connector elicitation

Apply the same pattern to `connectors/ccxt/mcp-server/src/tools/orders.ts`. CCXT covers 100+ exchanges, so the confirmation form includes:

```typescript
{
  message: "Place order on Binance (LIVE)\nBuy 0.5 ETH @ $3,200 LIMIT\nEstimated cost: $1,600",
  requestedSchema: {
    type: 'object',
    properties: {
      confirm: { type: 'boolean', title: 'Confirm order' },
      exchange: { type: 'string', title: 'Exchange', enum: ['binance'], default: 'binance' },
      // Show risk rails
      accept_risk: {
        type: 'boolean',
        title: 'Position exceeds 5% of portfolio (moderate profile)',
      }
    },
    required: ['confirm']
  }
}
```

**Also wire into**: `set_risk_limits` (confirm limit changes), strategy tools (confirm backtest parameter ranges before live deployment).

### 7. Alpaca connector elicitation

Same pattern for `connectors/alpaca/mcp-server/src/tools/orders.ts`. Alpaca-specific additions:
- PDT (Pattern Day Trader) warning when approaching 3 day-trades in 5 days
- Margin call proximity warning
- Extended hours trading confirmation

### 8. Execution algorithm confirmations

For TWAP/VWAP/Iceberg plans, show a rich confirmation form:

```typescript
{
  message: "TWAP Execution Plan\n12 slices over 60 minutes\nTotal: 2.0 BTC @ ~$43,500\nEstimated impact: 0.12%",
  requestedSchema: {
    type: 'object',
    properties: {
      approve_plan: { type: 'boolean', title: 'Approve execution plan' },
      adjust_slices: {
        type: 'integer',
        title: 'Number of slices (default: 12)',
        minimum: 3,
        maximum: 100,
        default: 12,
      },
      adjust_duration: {
        type: 'integer',
        title: 'Duration in minutes (default: 60)',
        minimum: 5,
        maximum: 1440,
        default: 60,
      },
      max_slippage_bps: {
        type: 'number',
        title: 'Max slippage (basis points)',
        minimum: 1,
        maximum: 500,
        default: 50,
      }
    },
    required: ['approve_plan']
  }
}
```

This is where elicitation shines — the user can **adjust parameters** in the form, not just approve/reject. The tool reads back `content.adjust_slices`, `content.adjust_duration`, etc. and re-plans.

### 9. Risk limit changes

When Risk Manager agent proposes new limits via `set_risk_limits`:

```typescript
{
  message: "Risk Manager proposes updated limits:\n• Max position: 2% → 5%\n• Max leverage: 1x → 3x\n• Max daily loss: 1% → 3%",
  requestedSchema: {
    type: 'object',
    properties: {
      approve_limits: { type: 'boolean', title: 'Approve new risk limits' },
      override_max_position: {
        type: 'number',
        title: 'Override max position %',
        minimum: 0.5,
        maximum: 25,
      },
      override_max_leverage: {
        type: 'number',
        title: 'Override max leverage',
        minimum: 1,
        maximum: 20,
      }
    },
    required: ['approve_limits']
  }
}
```

### 10. Shared elicitation middleware

Extract common patterns into a middleware layer that wraps tool handlers:

```typescript
// lib/elicitation-middleware.ts
export function withConfirmation<T>(
  handler: ToolHandler<T>,
  assessRisk: (params: T) => ConfidenceResult | null,
): ToolHandler<T> {
  return async (params, extra) => {
    const risk = assessRisk(params);
    if (risk && risk.decision !== 'GO') {
      const form = buildOrderConfirmation(params, risk);
      if (canElicit(extra)) {
        const result = await elicitInput(extra, form);
        if (result.action !== 'accept') return cancelledResponse(risk);
      }
    }
    return handler(params, extra);
  };
}
```

**60-Day Total**: ~15 files changed/created, ~800 lines of new code, ~400 lines of tests.

---

## 90-Day: Gateway Orchestration + Agent Workflows

### 11. Gateway elicitation router

Build the gateway orchestration layer (from the existing 90-day roadmap) with elicitation as a first-class concern:

```typescript
// lib/gateway.ts
export class TradingGateway {
  private connectors: Map<string, ExchangeConnector>;
  private safetyProfile: SafetyProfile;
  private elicitFn?: ElicitFunction;

  /** Route an order through risk checks → elicitation → best exchange */
  async executeOrder(order: NormalizedOrder): Promise<OrderResult> {
    // 1. Pre-trade risk check against ALL connected exchanges
    const risk = this.assessCrossVenueRisk(order);

    // 2. Elicit confirmation with cross-venue context
    if (risk.decision !== 'GO') {
      const result = await this.elicitConfirmation(order, risk);
      if (result.action !== 'accept') return { status: 'cancelled' };
    }

    // 3. Smart route to best venue
    const venue = await this.selectVenue(order);

    // 4. Execute
    return venue.placeOrder(order);
  }
}
```

The gateway becomes the single point where:
- Cross-venue risk is assessed (position across Cube + Binance + Alpaca)
- Elicitation happens once (not per-connector)
- Audit trail is recorded

### 12. Agent-to-agent elicitation chain

When an agent persona (e.g., Jesse Livermore) proposes a trade, it flows through:

```
Jesse Livermore → proposes trade
  → Risk Manager agent → evaluates risk
    → Gateway → elicit user confirmation
      → User accepts/declines/adjusts
        → Gateway → execute on best venue
```

The elicitation form includes the agent's reasoning:

```typescript
{
  message: "Jesse Livermore proposes:\nBuy 1.5 ETH @ $3,180 (LIMIT)\n\nReasoning: 'Price has broken above the pivot point at $3,150 with increasing volume. This is a classic breakout pattern.'\n\nRisk Manager assessment: APPROVED (moderate risk)\n• Position size: 3.2% of portfolio\n• Stop loss: $3,050 (-4.1%)\n• Target: $3,400 (+6.9%)\n• Risk/Reward: 1:1.7",
  requestedSchema: {
    type: 'object',
    properties: {
      approve: { type: 'boolean', title: 'Approve trade' },
      adjust_size: {
        type: 'number',
        title: 'Adjust position size (ETH)',
        minimum: 0.1,
        maximum: 10,
        default: 1.5,
      },
      adjust_stop: {
        type: 'number',
        title: 'Adjust stop loss price',
        minimum: 2800,
        maximum: 3170,
        default: 3050,
      }
    },
    required: ['approve']
  }
}
```

### 13. URL-mode elicitation for complex workflows

Use URL-mode elicitation for scenarios that exceed flat form capabilities:

- **Portfolio rebalance approval**: Server generates a web page showing current vs. target allocation with interactive charts, user approves in browser
- **Multi-leg trade confirmation**: Complex options strategies or arbitrage legs shown as a visual diagram
- **Backtest results review**: Before deploying a strategy live, redirect user to a results dashboard

```typescript
// URL elicitation flow
const elicitationId = crypto.randomUUID();
const result = await server.elicitInput({
  mode: 'url',
  message: 'Review the rebalance plan in your browser before execution',
  elicitationId,
  url: `https://app.cube.exchange/rebalance/${elicitationId}`,
});
```

### 14. Elicitation audit trail

Persist every elicitation request + response to `.desk/`:

```typescript
// .desk/elicitations.jsonl
{"ts":"2026-04-15T...","tool":"place_order","exchange":"cube","risk":"WARNING",
 "form":{"symbol":"BTCUSDC","side":"buy","qty":"0.5"},
 "action":"accept","user_adjustments":{"qty":"0.3"},"latency_ms":4200}
```

This feeds into:
- Performance analyst agent (did user overrides improve outcomes?)
- Risk manager agent (are users consistently overriding risk limits?)
- `/review` command (show elicitation accept/decline rates)

### 15. Configurable elicitation policy

Allow per-session and per-agent configuration:

```typescript
// .desk/risk.json additions
{
  "elicitation": {
    "policy": "always" | "risk-only" | "live-only" | "never",
    "autoApproveProfile": "safe",     // auto-approve if within safe profile
    "requireForLive": true,            // always elicit for live orders
    "requireForAgents": true,          // always elicit when agent proposes
    "timeout": 300000,                 // 5 min timeout, then cancel
    "maxDailyAutoApprove": 50          // circuit breaker
  }
}
```

**90-Day Total**: ~20 files changed/created, ~1500 lines of new code, ~600 lines of tests.

---

## Implementation Priority Matrix

| Item | Impact | Effort | Risk | Phase |
|------|--------|--------|------|-------|
| Elicitation helper module | High | Low | Low | 30d #1 |
| `place_order` confirmation | Critical | Medium | Low | 30d #2 |
| Other mutating order tools | High | Low | Low | 30d #3 |
| Paper/Live mode gate | Critical | Low | Low | 30d #4 |
| CCXT connector elicitation | High | Medium | Low | 60d #6 |
| Alpaca connector elicitation | Medium | Medium | Low | 60d #7 |
| Execution algorithm forms | High | Medium | Low | 60d #8 |
| Risk limit change forms | Medium | Low | Low | 60d #9 |
| Elicitation middleware | High | Medium | Low | 60d #10 |
| Gateway orchestration | Critical | High | Medium | 90d #11 |
| Agent-to-agent chain | High | High | Medium | 90d #12 |
| URL-mode elicitation | Medium | High | Medium | 90d #13 |
| Audit trail | Medium | Medium | Low | 90d #14 |
| Configurable policy | Medium | Medium | Low | 90d #15 |

---

## Technical Dependencies

- **SDK 1.29.0**: Already installed. No dependency changes needed.
- **Client support**: Claude Code must support `elicitation/create`. If not yet supported, forms degrade to text-based risk summaries in the tool response (the LLM asks the user instead). The code MUST handle this gracefully.
- **`checkConfidenceRails`**: Fully implemented, tested, unused. Ready to wire.
- **`SAFETY_PROFILES`**: `safe`/`moderate`/`aggressive` defined. Ready to wire.
- **`extra` argument**: Available in every tool callback signature. Currently ignored by all handlers — just need to add the second parameter.

## Migration / Backward Compatibility

- **Non-breaking**: Elicitation is additive. If the client doesn't support it (`canElicit(extra) === false`), the tool proceeds as today but includes risk assessment in the response text.
- **No schema changes**: Tool input schemas stay the same. Elicitation happens inside the handler, invisible to tool callers.
- **No new dependencies**: Everything uses the existing MCP SDK.

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Claude Code doesn't support elicitation yet | Graceful fallback: include risk info in response text, rely on Claude's permission prompt |
| User fatigue from too many confirmations | `autoApproveProfile` for safe orders, `risk-only` policy option |
| Elicitation timeout (user walks away) | 5-minute timeout → cancel order, no hanging requests |
| Form too complex for mobile clients | Keep forms flat, max 4-5 fields, sensible defaults |
| Cross-connector state drift | Gateway layer (90d) consolidates risk checks to single point |

---

## Files Touched (Summary)

### New Files
- `lib/elicitation.ts` — form builders, helpers
- `lib/elicitation-middleware.ts` — reusable handler wrapper (60d)
- `lib/gateway.ts` — orchestration layer (90d)
- `connectors/*/mcp-server/tests/elicitation.test.ts` — per-connector tests

### Modified Files
- `connectors/cube/mcp-server/src/tools/orders.ts` — add `extra` param, wire risk checks + elicit
- `connectors/ccxt/mcp-server/src/tools/orders.ts` — same pattern
- `connectors/alpaca/mcp-server/src/tools/orders.ts` — same pattern
- `connectors/*/mcp-server/src/tools/analysis.ts` — execution plan confirmation
- `connectors/*/mcp-server/src/tools/risk.ts` — risk limit change confirmation
- `lib/package.json` — add `./elicitation` export
- `CLAUDE.md` — document elicitation architecture
