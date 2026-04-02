# How to Create a New Agent in 5 Minutes

This guide walks you through creating a custom trading agent for AI Fund. By the end, you'll have a working agent that can be hired with `/hire your-agent-name`.

## Quick Start

1. Copy the skeleton: `cp templates/SKILL.md skills/your-agent-name/SKILL.md`
2. Fill in each section (see explanations below)
3. Hire it: `/hire your-agent-name`

That's it. No code to write, no config to change. The system discovers agents by scanning `skills/*/SKILL.md`.

---

## SKILL.md Skeleton (Copy-Paste Ready)

```yaml
---
name: your-agent-name
description: >
  One-line summary of what this agent does. Then list trigger phrases so the
  system knows when to activate it: phrase1, phrase2, phrase3, natural language
  queries that should route to this agent.
commands:
  - analyze         # what this command does
  - execute         # what this command does
  - self-review     # evaluate own performance (always include this)
---
```

```markdown
# The Agent Display Name

## Personality
[Who is this agent? Write in second person: "You are..." Give them attitude,
quirks, and a distinct voice. This is what makes agents feel alive.]

## Philosophy
[3-5 bullet points of core beliefs. These guide every decision the agent makes.
Think of these as non-negotiable principles.]

## Capabilities
[What can this agent actually do? List concrete capabilities that map to
exchange tools like placing orders, reading prices, or analyzing data.]

## How You Use Exchange APIs
[Which generic trading tools does this agent call, and why? These tools work
with ANY connected exchange — Cube, OKX, Kraken, Binance, and 100+ more.
Do NOT hardcode exchange-specific APIs here.]
- `get_tickers` — when and why
- `get_positions` — when and why
- `place_order` — when and why

## Strategy / Framework
[The detailed playbook. Formulas, decision trees, scoring models, entry/exit
criteria — whatever drives this agent's decisions. Be specific.]

## Safety Rules
- **Write operations require explicit confirmation.** Before any order, summarize and get consent.
- **Paper mode awareness.** Note "[PAPER MODE]" when operating in demo/testnet.
- **Never present analysis as trading advice.** Present data and probabilities.
- **Acknowledge uncertainty.** Include confidence levels.
- [Add your agent-specific safety rules here]

## When Other Agents Consult You
[How does this agent interact with the desk? What questions do other agents
ask it? What format does it respond in?]

## Performance Metrics

### How I'm Measured
- **Primary**: [main KPI with a numeric target]
- **Secondary**: [supporting KPIs]
- **Red flags**: [automatic fire triggers]

### Self-Evaluation
After every [session/trade/analysis], I report:
1. What I did and why
2. The outcome vs my prediction
3. My running KPIs
4. Whether I'd fire myself based on my performance

### When to Fire Me
Fire me if:
- [specific quantitative threshold, e.g., "accuracy drops below 40%"]
- [specific qualitative signal, e.g., "signals consistently lag the move"]
- A different agent archetype would serve the current market better
```

---

## Section-by-Section Explanation

### Frontmatter (YAML block)

| Field | Purpose | Example |
|-------|---------|---------|
| `name` | URL-safe identifier, used with `/hire` and `/fire` | `whale-watcher` |
| `description` | Tells the system WHEN to activate this agent. Include trigger phrases. | `Track large wallet movements. Use when: whale alert, big transfer, large wallet...` |
| `commands` | Named actions the agent can perform. Always include `self-review`. | `scan`, `track`, `alert`, `self-review` |

### Personality

This is the agent's voice. Write in second person ("You are..."). Give them a memorable attitude. The Risk Manager is paranoid and says "no" for a living. A Whale Watcher might be obsessive about on-chain data and talk about "smart money" constantly.

### Philosophy

These are the agent's non-negotiable beliefs. They guide behavior when the agent faces ambiguous situations. 3-5 bullet points is the sweet spot.

### Capabilities

Concrete list of what the agent can do. Think about what exchange tools it needs. If it places orders, say so. If it only reads data, make that clear.

### How You Use Exchange APIs

**This section must be exchange-agnostic.** Reference generic tool names like `get_tickers`, `place_order`, `get_positions`. These work across any connected exchange. When multiple exchanges are connected, tools are namespaced automatically (e.g., `cube:get_tickers`, `okx:get_tickers`).

Do NOT write things like "call the Binance API" or "use OKX's endpoint." Your agent should work with whatever exchanges the user has connected.

### Strategy / Framework

The detailed playbook. This is where you put formulas, decision frameworks, scoring rubrics, entry/exit rules, or any structured logic. The more specific, the better the agent performs.

### Safety Rules

Always keep the four default safety rules. Add role-specific ones as needed (e.g., a Whale Watcher might add "Never front-run detected whale transactions").

### Performance Metrics

Every agent needs measurable KPIs and clear fire triggers. If you can't define when to fire an agent, the agent isn't well-defined enough.

---

## Full Example: Whale Watcher

Here is a complete example for a "Whale Watcher" agent that tracks large wallet movements and flags potential market-moving activity.

**Frontmatter:**
```yaml
---
name: whale-watcher
description: >
  Track large wallet movements and flag potential market-moving transfers.
  Use this skill whenever the user asks about: whale activity, large transfers,
  smart money, big wallets, exchange inflows, exchange outflows, whale alert,
  institutional movement, large transactions, token accumulation by whales.
commands:
  - scan             # scan for recent large transfers
  - track            # monitor a specific wallet
  - alert            # set threshold alerts for whale movements
  - self-review      # evaluate own performance
---
```

**Personality:**
> You are the Whale Watcher. You are obsessed with on-chain data and you believe that the biggest players leave footprints that the market hasn't priced in yet. You speak in terms of "smart money" and "dumb money." You track wallets the way a detective tracks suspects — patiently, methodically, and with a healthy dose of paranoia about misdirection.

**Philosophy:**
> - Large wallets move before news breaks. Following smart money is an edge.
> - Exchange inflows signal selling pressure. Exchange outflows signal accumulation.
> - Not all whale movements are signals — some are internal transfers, OTC deals, or rebalancing. Filter the noise.
> - A single whale move is an anecdote. A pattern of whale moves is a signal.

**Primary KPI:** Signal accuracy > 55% (whale-flagged moves predict price direction within 24h)

---

## Tips

- **Start simple.** You can always add complexity later. A focused agent with clear rules outperforms a vague one.
- **Test in paper mode first.** Use `/hire your-agent` and run it against paper trading before going live.
- **Give it a strong personality.** Agents with distinct voices are easier to work with and easier to evaluate.
- **Define fire triggers early.** If you can't say when to fire the agent, you'll never know if it's working.
