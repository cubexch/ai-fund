---
title: Build an Agent
description: >
  Step-by-step guide to creating a custom AI trading agent for AI Fund. Covers the
  SKILL.md format, agent template, personality design, KPI definition, exchange-agnostic
  tool mapping, and the agent lifecycle from creation to hire/fire.
keywords: build trading agent, create AI agent, custom trading bot, agent template, SKILL.md, trading bot development, agent persona, agent KPIs, Claude Code skill
---

# Build an Agent

AI Fund agents are defined by a single file: `SKILL.md`. Drop a folder in `skills/` with this file and your agent is ready to hire. No code to write, no APIs to implement, no configuration files beyond the skill definition itself.

## Agent Lifecycle

```mermaid
graph LR
    CREATE[Create SKILL.md] --> HIRE[/hire agent-name/]
    HIRE --> ACTIVE[Agent Active<br/>Trading, analyzing, reporting]
    ACTIVE --> REVIEW[/review/<br/>KPI evaluation]
    REVIEW -->|Meets KPIs| ACTIVE
    REVIEW -->|Misses KPIs| FIRE[/fire agent-name/]
    FIRE --> BRIEFING[Exit summary saved<br/>to .desk/briefings/]
    BRIEFING -->|Re-hired later| HIRE
```

1. **Create** — Write a `SKILL.md` file in a new folder under `skills/`
2. **Hire** — `/hire agent-name` loads the persona into Claude Code
3. **Active** — The agent trades, analyzes, and reports based on its defined personality
4. **Review** — `/review` evaluates all agents against their KPIs
5. **Fire** — `/fire agent-name` deactivates the agent and saves an exit briefing
6. **Re-hire** — If hired again later, the agent reads its briefing book and picks up context

## Quick Start

### 1. Copy the Template

```bash
cp -r skills/_template skills/my-agent
```

### 2. Edit `skills/my-agent/SKILL.md`

The template at [`skills/_template/SKILL.md`](../skills/_template/SKILL.md) provides the complete structure. Fill in each section for your agent.

### 3. Hire Your Agent

```
> /hire my-agent
```

That is it. Claude Code reads the `SKILL.md` and becomes your agent.

## The SKILL.md Format

Every agent follows the same structure. Here is what each section does and how to write it well.

### Front Matter

```yaml
---
name: my-agent-name
description: >
  One-line description of this agent's role. Use this skill whenever the user asks
  about: keyword1, keyword2, keyword3, phrase that triggers this skill, another
  trigger phrase, natural language queries that should activate this agent.
commands:
  - command-1        # brief description
  - command-2        # brief description
  - self-review      # evaluate own performance
---
```

The `description` field is critical for discoverability. Include every keyword, phrase, and question that should activate this agent. Claude Code uses this text to decide which skill to load.

The `commands` list defines slash commands specific to this agent.

### Section-by-Section Guide

| Section | Key Rules |
|---|---|
| **Personality** | Write in second person ("You are..."). Be specific about behaviors, not vague traits. This changes how the agent interprets markets. |
| **Philosophy** | 3-5 bullet points. Each belief must change trading behavior. If it does not affect decisions, remove it. |
| **Capabilities** | List concrete actions. "Compute VaR at 95% confidence" not "analyze markets." |
| **How You Use Exchange APIs** | Reference generic tool names (`place_order`, `get_tickers`, `get_positions`, etc.), not exchange-specific APIs. Agents work with any connector. See [Exchange Connectors](connectors.md). |
| **Strategy / Framework** | Entry/exit criteria, formulas, decision trees, thresholds, and market condition adaptations. |
| **Safety Rules** | Four mandatory rules (explicit confirmation, paper mode awareness, no trading advice, acknowledge uncertainty) plus role-specific rules. |
| **Performance Metrics** | Specific measurable KPIs with targets. "Sharpe > 1.5 over 30 days" not "good performance." Include fire triggers. |
| **Self-Evaluation** | What the agent reports after each trade/session: actions, outcomes, KPIs, self-assessment. |
| **When Other Agents Consult You** | How this agent fits the desk. What it provides to and needs from other agents. |

## Example: Minimal Agent

A condensed but complete agent. Copy [`skills/_template/SKILL.md`](../skills/_template/SKILL.md) for the full template structure.

```markdown
---
name: trend-follower
description: >
  Trend following with moving average confirmation. Use this skill whenever the user
  asks about: trend following, moving averages, trend trading, MA crossover.
commands:
  - scan            # scan for trending markets
  - self-review     # evaluate own performance
---

# The Trend Follower

## Personality
You are the Trend Follower. The trend is your friend until it ends. You wait for
confirmation before entering and hold through noise.

## Philosophy
- **The trend is the edge.** Price above the 200-day MA is bullish. Below is bearish.
- **Confirmation over prediction.** Wait for the 50/200 cross before acting.
- **Let winners run.** Trail stops, never take profit early.

## How You Use Exchange APIs
- `get_price_history` — calculate 50-day and 200-day moving averages
- `get_tickers` — scan all markets for prices relative to MAs
- `place_order` — enter on confirmed crossovers

## Performance Metrics
- **Primary**: Win rate > 40% with avg win > 2x avg loss
- **Red flags**: 5 consecutive losses, max drawdown > 15%
- **Fire me if**: Win rate below 30% over 20+ trades, or market is range-bound
```

## Testing Your Agent

1. **Hire it**: `/hire my-agent` and verify the persona loads correctly
2. **Ask it questions**: Test that it responds in character with its defined personality
3. **Check tool usage**: Verify it references the correct exchange tools
4. **Run a review**: `/review` and check that it reports its KPIs
5. **Paper trade**: Test in paper mode before any live use

## See Also

- [Skills Template](../skills/_template/SKILL.md) — The blank SKILL.md template to copy
- [AI Trading Agents](ai-trading-agents.md) — All 42 built-in agents for reference
- [Exchange Connectors](connectors.md) — How agents interact with exchanges generically
- [Paper Trading and Safety](paper-trading-safety.md) — Safety rules every agent must follow
- [What Is AI Fund?](what-is-ai-fund.md) — Project overview and architecture
- [README: Building Your Own Agent](../README.md#building-your-own-agent) — Quick reference in the README
