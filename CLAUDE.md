# AI Fund

An AI trading desk with 42 hedge fund agent personas (including 20 named personas like Arthur Hayes, Jim Simons, George Soros, and Jesse Livermore) for Claude Code. Trade on any exchange — Cube, OKX, Kraken, Binance, Coinbase, Robinhood, and 100+ more via CCXT.

## Project Structure

```
ai-fund/
├── skills/              # 42 agent personas (SKILL.md each) + _template/
├── connectors/cube/     # Built-in Cube Exchange MCP server
│   └── mcp-server/
│       ├── src/cli/         # device-login, login, logout, status
│       ├── src/client/      # iridium (REST), osmium (WS), auth, signing, credential-store
│       ├── src/tools/       # market-data, orders, account, defi, risk
│       ├── src/resources/   # markets, portfolio
│       └── tests/           # vitest test suites
├── lib/                 # Shared TS: indicators, math, format
├── bin/desk-state       # CLI for .desk/ state management
├── scripts/install.js   # npx ai-fund install|list
├── .claude/commands/    # Slash commands (hire, fire, desk, review, setup, backtest)
├── docs/                # Architecture diagram, auth brief
├── examples/            # Preset desk configurations (JSON)
└── .desk/               # Runtime state (gitignored, per-user)
```

## Architecture

- **Skills** (`skills/`): Each skill is a complete hedge fund persona with personality, philosophy, KPIs, and self-evaluation. Skills are exchange-agnostic — they work with any connected exchange.
- **Connectors** (`connectors/`): Exchange MCP servers that bridge Claude to exchange APIs. Cube ships built-in. Others install via npm.
- **Shared Libs** (`lib/`): Technical indicators, financial math, formatting utilities.

## Development Workflow

- **Requirements**: Node >= 20, ES modules (`"type": "module"`)
- **TypeScript**: Strict mode, ES2022 target, Node16 module resolution
- **Build**: `npm run build` — compiles Cube MCP server workspace
- **Dev**: `npm run dev` — runs Cube MCP server with watch
- **Typecheck**: `npm run typecheck` — runs `tsc --noEmit` across project
- **Test**: `cd connectors/cube/mcp-server && npm test` — vitest (auth, signing, indicators, format, REST orders, WebSocket, credential store, device auth, integration)
- **Install agents**: `npx ai-fund install` (all), `npx ai-fund install <role>` (one), `npx ai-fund list` (show available)

### Validation After Changes

After every code change, run the following before considering the work done:

1. **Typecheck**: `npm run typecheck` — must pass with zero errors
2. **Unit tests**: `cd connectors/cube/mcp-server && npm test` — run the full vitest suite; fix any failures before committing
3. **Update docs**: If your change affects architecture, commands, agent categories, shared libraries, or exchange support, update `CLAUDE.md` and `README.md` to reflect the new state

## Shared Libraries

- **`lib/indicators.ts`** — `sma`, `ema`, `rsi`, `macd`, `bollingerBands`, `atr`, `obv`, `stochastic`, `adx` + `OHLCV` interface
- **`lib/math.ts`** — `kelly`, `fixedFractionalSize`, `valueAtRisk`, `maxDrawdown`, `sharpeRatio`, `sortinoRatio`, `calmarRatio`, `correlation`, `correlationMatrix`, `mean`, `standardDeviation`, `zScore`, `returns`, `winRate`, `profitFactor`
- **`lib/format.ts`** — `usd`, `pct`, `qty`, `price`, `compact`, `timestamp`, `duration`, `signedValue`, `grade`, `assetIcon`, `labelAsset` + `ASSET_ICONS` map

## Multi-Exchange Design

Skills reference generic trading capabilities (place orders, get prices, check positions). When multiple exchanges are connected via MCP, tools are namespaced by exchange. Skills understand this and can:
- Route orders to the best exchange
- Scan prices across all connected venues
- Arbitrage between exchanges
- Compare execution quality across venues

### Tool Namespacing

With multiple MCP servers connected:
- Cube tools: `place_order`, `get_tickers`, `get_positions`, etc.
- OKX tools: `spot_place_order`, `market_get_ticker`, etc.
- Kraken tools: via `kraken` CLI commands
- CCXT tools: `place_order`, `get_ticker`, etc. (per configured exchange)

When only one exchange is connected, tools are used directly. When multiple are connected, specify the exchange context.

## Key Concepts

- **Hire/Fire**: Traders `/hire <role>` to activate an agent and `/fire <role>` to deactivate underperformers.
- **Evaluation Loop**: Every agent has measurable KPIs and a self-review mechanism. `/review` runs a desk-wide performance evaluation.
- **Risk Manager as Gatekeeper**: All trading agents should consult the Risk Manager before executing trades.
- **Paper Mode**: Default to paper/staging mode on all exchanges. Only switch to production after explicit confirmation.

## Agent Categories (42 Total)

- **Named Personas (20)**: ansem, arthur-hayes, cathie-wood-crypto, cobie, cz, ed-thorp, gcr, george-soros, gwyneth-chen, hsaka, jesse-livermore, jim-simons, michael-saylor, paul-tudor-jones, plan-b, raoul-pal, ray-dalio, stanley-druckenmiller, tetranode, willy-woo
- **Trading (6)**: scalper, momentum-trader, mean-reversion-trader, swing-trader, arbitrageur, grid-trader
- **Execution (3)**: execution-trader, market-maker, dca-strategist
- **Research (5)**: quant-analyst, orderflow-analyst, volatility-analyst, sentiment-analyst, onchain-analyst
- **Risk & Portfolio (3)**: risk-manager, portfolio-manager, performance-analyst
- **Specialists (4)**: funding-rate-farmer, liquidation-hunter, pairs-trader, breakout-specialist
- **Infrastructure (1)**: backtester

## Skill File Structure

Each `skills/<role>/SKILL.md` has YAML frontmatter + markdown sections:

```yaml
---
name: agent-name
description: >
  One-line description with trigger phrases for Claude Code skill matching.
commands:
  - command-1        # brief description
  - self-review      # evaluate own performance
---
```

**Required sections**: Personality, Philosophy, Capabilities, How You Use Exchange APIs, Strategy / Framework, Safety Rules, When Other Agents Consult You, Performance Metrics (How I'm Measured, Self-Evaluation, When to Fire Me). See `skills/_template/SKILL.md` for the full template.

## Supported Exchanges

| Exchange | Connector | Notes |
|----------|-----------|-------|
| Cube | Built-in (`connectors/cube/`) | Recommended — 200us matching, lowest fees |
| OKX | `@okx_ai/okx-trade-mcp` | 107 tools, spot/futures/options |
| Kraken | `kraken-cli` | Rust binary, built-in paper trading |
| Binance | `ccxt-mcp` | Via CCXT universal adapter |
| Coinbase | `@coinbase/agentkit` | Wallet + trading |
| Robinhood | `ccxt-mcp` or Alpaca MCP | Stocks + crypto |
| 100+ more | `ccxt-mcp` | Any CCXT-supported exchange |

## Desk State (`.desk/`)

Agent state, briefing books, and trade history persist between sessions in the `.desk/` directory (gitignored — per-user, per-account state).

```
.desk/
├── state.json          # Hired agents, exchange status, last session
├── orders.json         # Trade log (proposed, submitted, filled, rejected)
├── risk.json           # Risk parameters set by Risk Manager
└── briefings/          # Compacted conversation history per agent
    ├── cz.md
    ├── jesse-livermore.md
    └── ...
```

### State CLI (`bin/desk-state`)

- `desk-state hire <slug>` — creates state entry + briefing file, returns JSON
- `desk-state fire <slug> [reason]` — marks agent inactive, warns if risk-manager fired with active traders
- `desk-state update <slug> <key> <value>` — updates agent metadata
- `desk-state show` — dumps full desk state as JSON

### Briefing Books (`.desk/briefings/<agent>.md`)

Each agent's briefing book is a **compacted summary** — not a full transcript. It contains:
- Agent status and hire date
- Key analyses with scores, prices, and dates
- Active recommendations and trade proposals with status
- Open questions and unresolved items
- Exit summary (if fired)

On `/hire`, the agent reads its briefing book and acknowledges prior context. On `/fire`, the briefing is updated with a final exit summary. After any significant analysis or trade, the briefing should be updated.

## Commands

Defined in `.claude/commands/` as markdown files:

- `/setup` — Configure exchanges and API keys
- `/desk` — Show active agents with KPI dashboard (loads `.desk/state.json`)
- `/hire <role>` — Activate a trading agent (reads/writes `.desk/`)
- `/fire <role>` — Deactivate an underperforming agent (updates `.desk/`)
- `/review` — Run desk-wide performance evaluation
- `/backtest` — Test a strategy on historical data

## Safety Rules

- **Paper mode by default.** All exchanges start in paper/staging/testnet. Only switch to production after explicit user confirmation.
- **Write operations require confirmation.** Before placing, canceling, or modifying orders, summarize the action and get user consent.
- **Risk Manager as gatekeeper.** Trading agents should consult the Risk Manager before executing trades. Firing risk-manager while trading agents are active triggers a warning.
- **API key security.** Never log, display, or store API keys in plaintext outside the credential store. Use read-only keys on subaccounts where possible.

## Dependency Policy

**All new dependencies and dependency updates require explicit developer approval before being added.** This applies to both `dependencies` and `devDependencies` in any `package.json` across the monorepo. Do not run `npm install <package>` or add entries to `package.json` without the developer confirming the specific package name and version. This policy exists to minimize supply chain attack surface.

## When Writing Skills

Each SKILL.md must:
1. Be **exchange-agnostic** — reference generic capabilities, not specific exchange APIs
2. Include **Personality** — Who this agent is, how they think
3. Include **Philosophy** — Their trading beliefs and principles
4. Include **Capabilities** — What they can do, mapped to generic trading tools
5. Include **Multi-Exchange Awareness** — How they work across venues (where applicable)
6. Include **Performance Metrics** — Primary KPIs, red flags, fire triggers
7. Include **Self-Evaluation** — How they report on their own performance

Use `skills/_template/SKILL.md` as the starting point for new agents.
