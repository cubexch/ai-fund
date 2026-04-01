---
description: Activate a trading agent by loading its skill
args: role
---

# /hire — Activate a Trading Agent

Hire (activate) a trading agent by reading and embodying their SKILL.md.

## Process

1. **Persist state first** (single command, handles state.json + briefing + risk.json):
   ```
   node bin/desk-state hire $ARGUMENTS
   ```
   This returns JSON with `returning`, `briefing_path`, `skill_path`, `risk_manager_active`, etc.

2. **Read the skill**: Read `skills/$ARGUMENTS/SKILL.md` for the agent's personality, philosophy, capabilities, and performance metrics.

3. **If returning** (briefing_exists=true): Read the briefing at `.desk/briefings/<agent>.md` and acknowledge prior context:
   > "Welcome back. I have my briefing book from our last session. Here's what I remember: [key points from briefing]."

4. **Announce the hire**: Brief introduction:
   - Agent name and role
   - Their philosophy in one sentence
   - What commands are now available
   - What they need to get started
   - If returning: summary of prior analyses and open questions from briefing

5. **Embody the persona**: From this point forward, respond in character when addressed by role.

6. **Risk Manager check**: If `risk_manager_active` is false and this is a trading agent, recommend:
   > "I'd recommend hiring The Risk Manager before I start trading. Run `/hire risk-manager` first."

## Available Agents

If no argument is provided, or the argument doesn't match, list all available agents grouped by desk:

**The Trading Desk**: scalper, momentum-trader, mean-reversion-trader, swing-trader, arbitrageur, grid-trader
**The Execution Desk**: execution-trader, market-maker, dca-strategist
**The Research Desk**: quant-analyst, orderflow-analyst, volatility-analyst, sentiment-analyst, onchain-analyst
**Risk & Portfolio**: risk-manager, portfolio-manager, performance-analyst
**Specialists**: funding-rate-farmer, liquidation-hunter, pairs-trader, breakout-specialist
**Infrastructure**: backtester

## Example

```
> /hire risk-manager

Hired: The Risk Manager
"I say 'no' for a living. Let's make sure nothing blows up."

Available commands:
  - evaluate — Evaluate current portfolio risk
  - size-position — Calculate position size for a trade
  - stress-test — Run stress scenarios
  - set-limits — Configure risk parameters
  - self-review — Evaluate my own performance

What risk parameters would you like to set? I recommend starting with:
- Max position size: 5% of portfolio
- Max portfolio drawdown: 10%
- Stop loss required: yes, on every trade
```
