---
description: Generate a desk health report with PnL, drawdown, hit rate, and next actions
---

# /health-report — Desk Health Report

Generate a daily health summary of the trading desk.

## Process

### 1. Gather Data
- Run `node bin/desk-state health` to get the full health report as JSON
- Run `node bin/desk-state health md` for the markdown summary
- Read `.desk/orders.json` for detailed order history
- Read `.desk/risk.json` for current risk parameters

### 2. Present the Report

Display the health report with these sections:

```
╔═══════════════════════════════════════════════════════════════╗
║                      DESK HEALTH REPORT                       ║
║                    [Date] — [Paper/Live]                       ║
╠═══════════════════════════════════════════════════════════════╣

METRICS
───────
  PnL:          +$1,234.56
  Win Rate:     62.5%
  Max Drawdown: -2.3%
  Filled:       24 orders (3 rejected)

ACTIVE AGENTS
─────────────
  ● risk-manager
  ● market-maker
  ● arbitrageur

VIOLATIONS
──────────
  ⚠ Max drawdown 3.1% exceeds 2.5% limit

NEXT ACTIONS
────────────
  1. Review drawdown breach with risk manager
  2. Consider reducing position sizes
```

### 3. Interpretation
After the data, add a plain-English paragraph interpreting the desk's health:
- Is the desk performing well or struggling?
- Are risk limits being respected?
- Which agents are pulling their weight?
- What should the trader do next?

### 4. Output Formats
Mention that the report is also available as JSON:
> Run `node bin/desk-state health` for the machine-readable JSON version.

## Important
- Use actual data from `.desk/` state files — do not fabricate metrics
- If no orders exist yet, say so clearly and guide the user to place their first trade
- Be honest about violations — this is a health check, not a marketing document
