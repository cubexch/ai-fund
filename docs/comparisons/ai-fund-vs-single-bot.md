# When to Use ai-fund vs a Single Trading Bot

## The Short Answer

Use **a single bot** if you have one strategy on one exchange and want minimal complexity.
Use **ai-fund** if you need multiple strategies, multiple exchanges, risk management, or you want agents that argue with each other before trading.

## Decision Matrix

| Factor | Single Bot | ai-fund |
|--------|-----------|---------|
| **Strategies** | 1 at a time | 45 agents, mix and match |
| **Exchanges** | Usually 1 | 110+ via CCXT + dedicated connectors |
| **Risk management** | DIY or none | Built-in Risk Manager agent |
| **Cross-exchange arb** | Not possible | Core feature |
| **Smart order routing** | No | Yes — routes to best venue |
| **Setup time** | Minutes | Minutes (paper) to hours (production) |
| **Complexity** | Low | Medium |
| **Cost** | Free-$50/mo | Claude Pro ($20/mo) |
| **Customization** | Edit code | Edit SKILL.md (natural language) |
| **Backtesting** | Varies | 9 built-in strategies |

## When a Single Bot Wins

- You run one strategy (e.g., grid bot on BTC/USDT)
- You want set-and-forget with no interaction
- You don't need cross-exchange features
- You prefer a GUI dashboard
- You want to avoid LLM costs

## When ai-fund Wins

- You want a macro trader AND a quant AND a risk manager working together
- You trade across multiple exchanges and want arb detection
- You want agents with real personalities that challenge each other's theses
- You want KPI tracking and automatic fire recommendations
- You want to backtest before deploying
- You want natural language control instead of editing config files

## Migration Path

Already running a single bot? You can add ai-fund alongside it:

1. `npx ai-fund install` — install agents
2. `/hire risk-manager` — get risk oversight on existing positions
3. `/hire quant-analyst` — scan for new opportunities
4. `/desk` — see everything in one view

ai-fund doesn't replace your existing bot — it adds a management layer on top.
