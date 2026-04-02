---
title: What Is AI Fund?
description: >
  AI Fund is an open-source AI hedge fund platform for Claude Code with 42 autonomous
  trading agents, 20 named hedge fund personas, and 100+ exchange connectors. Multi-agent
  trading desk with hire/fire workflow, KPI tracking, and paper trading by default.
keywords: AI hedge fund, AI trading agents, multi-agent trading, Claude Code, open source hedge fund, crypto trading bot, algorithmic trading, automated trading
---

# What Is AI Fund?

AI Fund is an open-source AI hedge fund that runs inside [Claude Code](https://claude.ai/code). It gives you 42 autonomous trading agents — each with its own personality, trading philosophy, and measurable KPIs — connected to 100+ cryptocurrency and equities exchanges.

You hire agents that match your thesis. You fire the ones that miss their targets. The desk manages itself through natural language, not configuration files.

## Who It Is For

| You are a... | AI Fund gives you... |
|---|---|
| **Crypto trader** | 42 AI trading agents you control with natural language |
| **Quantitative researcher** | Backtesting, statistical tools, multi-exchange data |
| **Fund operator** | KPI dashboards, hire/fire workflow, risk controls |
| **Developer** | MIT-licensed skill system, extensible to any exchange |

AI Fund is designed for anyone who wants to run an AI-assisted trading desk without building one from scratch. It works for solo traders experimenting with paper trading and for teams evaluating multi-agent architectures.

## How AI Fund Works

The platform has two independent layers:

1. **Skills** — 42 agent personas in `skills/`, each defined by a `SKILL.md` file. Skills are exchange-agnostic. They describe how an agent thinks, what strategies it uses, and how it measures itself.
2. **Connectors** — Exchange MCP servers in `connectors/` that bridge Claude Code to exchange APIs. Cube ships built-in. Others install via npm.

Add an exchange without touching agent code. Write an agent without touching exchange code. The two layers never depend on each other.

```
YOU (trader)
  |
  v
CLAUDE CODE (AI runtime)
  |
  ├── Skills (42 SKILL.md files)   -- agent personas, strategies, KPIs
  |
  ├── Exchange Connectors (MCP)    -- connect any exchange
  |   ├── Cube (built-in)
  |   ├── Binance, Coinbase, Kraken, OKX, Alpaca...
  |   └── 100+ via CCXT
  |
  v
YOUR EXCHANGES (paper or live)
```

## What Makes AI Fund Different

| Feature | AI Fund | Typical trading bots |
|---|---|---|
| **Agent count** | 42 agents, 20 named personas | 1 bot, user-configured |
| **Hire/fire workflow** | KPI-based agent management | Manual start/stop |
| **Multi-exchange** | 100+ exchanges, cross-venue arbitrage | Usually 1 exchange |
| **Smart order routing** | Route to best venue automatically | Single venue |
| **Risk manager** | Dedicated agent that blocks bad trades | User-set stop-losses |
| **Paper trading** | On by default, all exchanges | Often opt-in or missing |
| **LLM-native** | Built for Claude Code | Standalone scripts |
| **License** | MIT | Varies (GPL, Apache, proprietary) |

For a detailed feature comparison with other AI trading projects, see the [comparison table in the README](../README.md#ai-fund-vs-other-ai-trading-bots).

## Named Personas

20 agents are modeled after real traders and investors. Their philosophies change how they read markets and size positions:

- **Arthur Hayes** — Macro-to-crypto, DXY, liquidity cycles
- **Jim Simons** — Pure quant, statistical edge, Sharpe > 2.0
- **George Soros** — Reflexivity theory, regime breaks
- **Jesse Livermore** — Tape reading, pyramiding, patience
- **Michael Saylor** — Bitcoin maximalism, never sell
- **Ray Dalio** — All-weather portfolio, risk parity

Plus 14 more named personas and 22 role-based agents (scalper, market maker, arbitrageur, risk manager, and others). See [AI Trading Agents](ai-trading-agents.md) for the full roster.

## Quick Start

```bash
git clone https://github.com/cubexch/ai-fund
cd ai-fund
npm install
claude
> /setup
> /hire risk-manager
> /hire arthur-hayes
```

Paper trading is enabled by default. You must explicitly opt in to live trading.

## Core Commands

| Command | Purpose |
|---|---|
| `/setup` | Connect exchanges, configure API keys |
| `/desk` | View active agents, positions, KPIs |
| `/hire <role>` | Activate a trading agent |
| `/fire <role>` | Deactivate an underperformer |
| `/review` | Desk-wide performance evaluation |
| `/backtest` | Test a strategy on historical data |

## See Also

- [AI Trading Agents](ai-trading-agents.md) — Full roster of 42 agents and the hire/fire model
- [Exchange Connectors](connectors.md) — How to connect Cube, Binance, Kraken, OKX, and 100+ more
- [Paper Trading and Safety](paper-trading-safety.md) — Why paper mode is default and how risk management works
- [How to Backtest](how-to-backtest.md) — Test strategies on historical data before risking capital
- [Build an Agent](build-an-agent.md) — Create your own custom trading agent
- [README](../README.md) — Project overview, FAQ, and architecture details
- [Connectors README](../connectors/README.md) — Exchange setup instructions
