---
description: Show active agents, connected exchanges, portfolio status, and KPI dashboard
---

# /desk — Trading Desk Dashboard

Show a comprehensive dashboard of the trader's current desk.

## What to Display

### 0. Load Desk State
- Read `.desk/state.json` to load previously hired agents and their status
- Read `.desk/orders.json` to load pending/recent order history
- Read `.desk/risk.json` to load risk parameters
- For each active agent, read `.desk/briefings/<agent>.md` to load their briefing book
- Show a "Returning desk" summary if agents were previously hired:
  > "Loaded desk from last session (2026-03-31). 4 agents active. 4 orders in log."

### 1. Connected Exchanges
- Check `.mcp.json` to see which exchanges are enabled
- For each enabled exchange, try a read-only call to verify connection
- Show trading mode (paper/live) for each

```
EXCHANGES
─────────
✓ Cube        Paper Mode    45 markets    $12,340 balance
✓ OKX         Demo Mode     300+ markets  $5,000 balance
✗ Kraken      Not connected
✗ Binance     Not connected
```

### 2. Portfolio Overview (Across All Exchanges)
- Aggregate balances from all connected exchanges
- Show total portfolio value
- All positions with current prices and allocation %
- Available cash/stablecoins per exchange

### 3. Active Agents
Look at which skills are currently loaded in the conversation context. For each active agent, show:

```
ACTIVE AGENTS
─────────────
┌─────────────────────┬────────┬──────────────────────┬────────┐
│ Agent               │ Status │ Key KPI              │ Grade  │
├─────────────────────┼────────┼──────────────────────┼────────┤
│ Risk Manager        │ Active │ [relevant KPI]       │ [A-F]  │
│ Market Maker        │ Active │ [relevant KPI]       │ [A-F]  │
│ Arbitrageur         │ Active │ [relevant KPI]       │ [A-F]  │
│ ...                 │        │                      │        │
└─────────────────────┴────────┴──────────────────────┴────────┘
```

### 4. Cross-Exchange Opportunities
If multiple exchanges are connected:
- Show any visible price discrepancies across venues
- Note spread differences between exchanges
- Flag arbitrage opportunities

### 5. Recent Activity
- Recent orders and fills across all connected exchanges
- Label which exchange each trade was on

### 6. Desk Health Score
If multiple agents are active, compute overall desk health:
- Are risk limits being respected?
- Are agents generating positive expected value?
- Is there adequate diversification across exchanges and strategies?

## Available Agents (not yet hired)
List all agents in `skills/` that are NOT currently active.

## Format
Use clean tables and clear formatting. This is the trader's command center — Bloomberg terminal energy, not a log dump.
