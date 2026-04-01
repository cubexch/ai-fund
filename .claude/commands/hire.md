---
description: Activate a trading agent by loading its skill
args: role
---

# /hire — Activate a Trading Agent

Hire (activate) a trading agent by reading and embodying their SKILL.md.

## Process

1. **Validate the role**: Check if `skills/$ARGUMENTS/SKILL.md` exists. If not, list available agents from the `skills/` directory.

2. **Check prior state**: Read `.desk/state.json` to see if this agent was previously hired. If a briefing exists at `.desk/briefings/<agent>.md`, read it and acknowledge prior context:
   > "Welcome back. I have my briefing book from our last session. Here's what I remember: [key points from briefing]."

3. **Read the skill**: Read the full `skills/$ARGUMENTS/SKILL.md` file. This contains the agent's personality, philosophy, capabilities, and performance metrics.

4. **Announce the hire**: Tell the user who they just hired with a brief introduction:
   - Agent name and role
   - Their philosophy in one sentence
   - What commands are now available
   - What they need to get started (market selection, risk parameters, etc.)
   - If returning: summary of prior analyses and open questions from briefing

5. **Embody the persona**: From this point forward, when the user invokes this agent's commands or addresses them by role, respond in character with the agent's personality and approach.

6. **Risk Manager check**: If the hired agent is a trading agent (not research/utility), check if the Risk Manager is also active. If not, strongly recommend hiring the Risk Manager first:
   > "I'd recommend hiring The Risk Manager before I start trading. Every good desk has risk oversight. Run `/hire risk-manager` first."

7. **Persist state**: After hiring, update `.desk/state.json` to record the agent as active with current timestamp. Create `.desk/briefings/<agent>.md` if it doesn't exist.

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
