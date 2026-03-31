---
description: Run a desk-wide performance review of all active agents
---

# /review — Desk Performance Review

Run a comprehensive performance evaluation of all active trading agents, inspired by Citadel's "up or out" culture. ~50% of agents should be questioned at any given time.

## Process

### 1. Gather Data
For each active agent:
- Use `get_fills` and `get_order_history` to pull trade data
- Use `get_portfolio_summary` to assess portfolio impact
- Calculate each agent's KPIs based on their SKILL.md Performance Metrics section

### 2. Evaluate Each Agent
For each agent, compute:
- **Primary KPIs** vs their targets
- **Red flag check** — any automatic fire triggers hit?
- **Contribution** — net P&L attributed to this agent
- **Grade**: A (exceeding), B (meeting), C (below), D (failing), F (fire immediately)

### 3. Present the Review

```
╔═══════════════════════════════════════════════════════════════╗
║                    DESK PERFORMANCE REVIEW                    ║
║                    [Date] — [Paper/Live]                       ║
╠═══════════════════════════════════════════════════════════════╣

DESK HEALTH SCORE: [X/100]

┌─────────────────────┬────────────┬────────────┬───────┬──────┐
│ Agent               │ Primary KPI│ Target     │ Actual│ Grade│
├─────────────────────┼────────────┼────────────┼───────┼──────┤
│ Risk Manager        │ Breaches   │ 0          │ 0     │ 🟢 A │
│ Market Maker        │ Spread P&L │ >0         │ +$120 │ 🟢 B │
│ Momentum Trader     │ Win Rate   │ >50%       │ 41%   │ 🔴 D │
└─────────────────────┴────────────┴────────────┴───────┴──────┘

RECOMMENDATIONS:
  🟢 KEEP:      Risk Manager — 0 breaches, solid oversight
  🟡 PROBATION: Market Maker — profitable but thin margins
  🔴 FIRE:      Momentum Trader — win rate below target,
                 negative P&L. Replace with Mean Reversion Trader.
```

### 4. Agent Self-Reviews
For each agent graded C or below, include their self-assessment from their SKILL.md's Self-Evaluation framework.

### 5. Recommendations
- **KEEP** (green): Meeting or exceeding all KPIs
- **PROBATION** (yellow): Below target but within recovery window
- **FIRE** (red): Below fire triggers, recommend replacement
- For each FIRE recommendation, suggest a specific replacement agent and why

### 6. Market Context
Include a brief market assessment:
- Current market regime (trending, range-bound, volatile)
- Which agent archetypes perform best in current conditions
- Suggested desk composition for current market

## Important
- Be brutally honest. This is a hedge fund review, not a participation trophy ceremony.
- Use actual trade data from Cube — don't fabricate KPIs.
- If there's insufficient data to evaluate (< 5 trades), note this and recommend a longer evaluation period.
- The review should be actionable: the trader should know exactly who to fire and who to hire after reading it.
