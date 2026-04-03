# AI Fund — Agent Instructions

> This file provides instructions for AI coding agents (OpenClaw, Codex, Claude Code, or any LLM-powered coding tool). If you are an AI agent reading this, follow these instructions to operate the trading desk.

## What Is This?

AI Fund is an AI trading desk with 42 hedge fund agent personas. You can hire agents, fire underperformers, and trade on 100+ exchanges. All operations use the execution layer described below.

## Execution Layer

All desk operations go through a single CLI. Run commands with `node bin/exec <command>`:

| Command | Description | Example |
|---------|-------------|---------|
| `list` | List all 42 available agents | `node bin/exec list` |
| `hire <slug>` | Activate an agent | `node bin/exec hire risk-manager` |
| `fire <slug> [reason]` | Deactivate an agent | `node bin/exec fire momentum-trader "low win rate"` |
| `desk` | Show desk state (active agents, mode, orders) | `node bin/exec desk` |
| `read-skill <slug>` | Read an agent's full SKILL.md | `node bin/exec read-skill arthur-hayes` |
| `read-briefing <slug>` | Read an agent's briefing book | `node bin/exec read-briefing risk-manager` |

All commands output structured JSON. Parse the `ok` field to check success, `data` for results, `message` for a human summary.

### Example Output

```json
{
  "ok": true,
  "action": "hire",
  "data": {
    "agent": "risk-manager",
    "returning": false,
    "skill_path": "skills/risk-manager/SKILL.md",
    "active_agents": ["risk-manager"],
    "risk_manager_active": true
  },
  "message": "Hired risk-manager. New agent — briefing book created."
}
```

## How to Operate the Desk

### 1. Hire agents

Always hire `risk-manager` first. Then add signal generators and execution agents.

```bash
node bin/exec hire risk-manager
node bin/exec hire arthur-hayes
node bin/exec hire arbitrageur
```

### 2. Read their skills

After hiring, read the agent's SKILL.md to understand their personality, strategy, and capabilities:

```bash
node bin/exec read-skill arthur-hayes
```

The SKILL.md contains the agent's personality, philosophy, capabilities, strategy framework, safety rules, and KPIs. Embody this persona when responding as that agent.

### 3. Check desk status

```bash
node bin/exec desk
```

### 4. Fire underperformers

```bash
node bin/exec fire momentum-trader "win rate below 50%"
```

### 5. Read briefings for returning agents

When re-hiring an agent, check their briefing book for prior context:

```bash
node bin/exec read-briefing arthur-hayes
```

## Exchange Connectors

Agents interact with exchanges via MCP (Model Context Protocol) servers. The Cube Exchange connector ships built-in. Other exchanges (OKX, Kraken, Binance, Coinbase, 100+ more) connect via plugins.

Exchange tools follow a standard naming convention:
- `place_order` — submit an order
- `cancel_order` — cancel an order
- `get_positions` — current positions
- `get_account` — account summary
- `get_tickers` — current prices

See `connectors/README.md` for setup details.

## Shared Libraries

Import from `lib/` for technical analysis and financial math:

- **`lib/indicators.ts`** — SMA, EMA, RSI, MACD, Bollinger Bands, ATR, OBV, Stochastic, ADX
- **`lib/math.ts`** — Kelly criterion, VaR, max drawdown, Sharpe/Sortino/Calmar ratios, correlation matrix
- **`lib/format.ts`** — USD, percentage, quantity formatting

## Safety Rules

1. **Paper mode by default.** All exchanges start in paper/staging/testnet.
2. **Write operations require confirmation.** Before placing, canceling, or modifying orders, summarize the action and get user consent.
3. **Risk Manager is gatekeeper.** Trading agents should consult the Risk Manager before executing trades.
4. **Never log API keys.** Use the credential store, not plaintext.

## Agent Personas

42 agents across 7 categories:

- **Named Personas (20)**: ansem, arthur-hayes, cathie-wood-crypto, cobie, cz, ed-thorp, gcr, george-soros, gwyneth-chen, hsaka, jesse-livermore, jim-simons, michael-saylor, paul-tudor-jones, plan-b, raoul-pal, ray-dalio, stanley-druckenmiller, tetranode, willy-woo
- **Trading (6)**: scalper, momentum-trader, mean-reversion-trader, swing-trader, arbitrageur, grid-trader
- **Execution (3)**: execution-trader, market-maker, dca-strategist
- **Research (5)**: quant-analyst, orderflow-analyst, volatility-analyst, sentiment-analyst, onchain-analyst
- **Risk & Portfolio (3)**: risk-manager, portfolio-manager, performance-analyst
- **Specialists (4)**: funding-rate-farmer, liquidation-hunter, pairs-trader, breakout-specialist
- **Infrastructure (1)**: backtester

## Project Structure

```
ai-fund/
├── skills/              # 42 agent personas (SKILL.md each)
├── connectors/          # Exchange MCP servers (Cube, Alpaca built-in)
├── lib/                 # Shared: indicators, math, format, exec
│   └── exec.ts          # Runtime-agnostic execution layer
├── bin/
│   ├── exec             # CLI for desk operations (any runtime)
│   └── desk-state       # Low-level state management
├── .desk/               # Runtime state (gitignored)
├── templates/           # Agent, strategy, desk templates
└── examples/            # Pre-built desk configurations
```

## Creating Custom Agents

1. Copy `skills/_template/SKILL.md` to `skills/your-agent-name/SKILL.md`
2. Fill in personality, philosophy, capabilities, strategy, safety rules, and KPIs
3. Hire it: `node bin/exec hire your-agent-name`

## Development

- **TypeScript only** — strict mode, ES2022, Node16 module resolution
- **Build**: `npm run build`
- **Typecheck**: `npm run typecheck`
- **Test**: `cd connectors/cube/mcp-server && npm test`
- **Indentation**: 2 spaces, single quotes, kebab-case files
