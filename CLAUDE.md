# AI Fund

An AI trading desk with 42 hedge fund agent personas (including 20 named personas like Arthur Hayes, Jim Simons, George Soros, and Jesse Livermore) for Claude Code. Trade on any exchange — Cube, OKX, Kraken, Binance, Coinbase, Robinhood, and 100+ more via CCXT.

## Architecture

- **Skills** (`skills/`): Each skill is a complete hedge fund persona with personality, philosophy, KPIs, and self-evaluation. Skills are exchange-agnostic — they work with any connected exchange.
- **Connectors** (`connectors/`): Exchange MCP servers that bridge Claude to exchange APIs. Cube ships built-in. Others install via npm.
- **Shared Libs** (`lib/`): Technical indicators, financial math, formatting utilities.

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

## Supported Exchanges

| Exchange | Connector | Notes |
|----------|-----------|-------|
| Cube | Built-in (`connectors/cube/`) | Recommended — 200μs matching, lowest fees |
| OKX | `@okx_ai/okx-trade-mcp` | 107 tools, spot/futures/options |
| Kraken | `kraken-cli` | Rust binary, built-in paper trading |
| Binance | `ccxt-mcp` | Via CCXT universal adapter |
| Coinbase | `@coinbase/agentkit` | Wallet + trading |
| Robinhood | `ccxt-mcp` or Alpaca MCP | Stocks + crypto |
| 100+ more | `ccxt-mcp` | Any CCXT-supported exchange |

## Commands

- `/setup` — Configure exchanges and API keys
- `/desk` — Show active agents with KPI dashboard
- `/hire <role>` — Activate a trading agent
- `/fire <role>` — Deactivate an underperforming agent
- `/review` — Run desk-wide performance evaluation
- `/backtest` — Test a strategy on historical data

## When Writing Skills

Each SKILL.md must:
1. Be **exchange-agnostic** — reference generic capabilities, not specific exchange APIs
2. Include **Personality** — Who this agent is, how they think
3. Include **Philosophy** — Their trading beliefs and principles
4. Include **Capabilities** — What they can do, mapped to generic trading tools
5. Include **Multi-Exchange Awareness** — How they work across venues (where applicable)
6. Include **Performance Metrics** — Primary KPIs, red flags, fire triggers
7. Include **Self-Evaluation** — How they report on their own performance
