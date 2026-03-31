---
description: Deactivate an underperforming trading agent
args: role
---

# /fire — Deactivate a Trading Agent

Fire (deactivate) a trading agent from the desk.

## Process

1. **Validate the role**: Check if `skills/$ARGUMENTS/SKILL.md` exists and if the agent is currently active.

2. **Performance review**: Before firing, run the agent's self-review one final time:
   - Show their KPIs since hire
   - Show their self-assessment
   - Note whether they would fire themselves

3. **Log the exit**: Create a brief exit record:
   ```
   FIRED: [Agent Name]
   Date: [today]
   Reason: [user's reason or performance-based]
   KPIs at exit:
     - [KPI 1]: [value]
     - [KPI 2]: [value]
   Trades executed: [count]
   Net P&L contribution: [amount]
   ```

4. **Recommend replacement**: Based on the fired agent's role and current market conditions, suggest alternative agents:
   > "Consider replacing with [Agent] — they're better suited for [current conditions]."

5. **Deactivate**: Stop embodying the agent's persona. Remove their commands from the active set.

## Safety Checks

- **Cannot fire Risk Manager if other trading agents are active**: The Risk Manager is the last line of defense. If trading agents are still active, warn:
  > "Warning: You still have active trading agents. Firing the Risk Manager removes risk oversight. Are you sure?"

- **Open positions check**: If the agent has contributed to open positions, warn the user to manage them before firing.

## Example

```
> /fire momentum-trader

EXIT REVIEW: The Momentum Trader
─────────────────────────────────
Active since: 2026-03-25
Trades executed: 12
Win rate: 41% (target: >50%)
Avg winner/loser ratio: 1.8x (target: >2x)
Net P&L: -$340

Self-assessment: "I've been fighting the trend. This is a
mean-reversion market — not my environment. Fire me."

Verdict: UNDERPERFORMING — below target on both win rate and P&L.

The Momentum Trader has been removed from the desk.

Suggestion: Consider /hire mean-reversion-trader — this range-bound
market is their bread and butter.
```
