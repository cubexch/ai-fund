---
title: Paper Trading and Safety
description: >
  AI Fund defaults to paper trading mode on all exchanges. The Risk Manager agent acts
  as a gatekeeper for all trades. Learn how to stay safe with AI trading agents, manage
  API key security, and protect against drawdowns and unauthorized trades.
keywords: paper trading, safe AI trading, risk management, trading simulation, API key security, drawdown protection, position sizing, stop loss, risk controls, demo trading, testnet trading
---

# Paper Trading and Safety

AI Fund is designed for safety first. Paper trading is enabled by default on every exchange. No trade reaches a live market unless you explicitly opt in. The Risk Manager agent reviews all trades before execution.

## Why Paper Mode Is Default

AI agents can act fast, read files, call APIs, and execute trades in seconds. That speed is useful when it works correctly and dangerous when it does not. Paper mode gives you a controlled environment to:

- **Validate strategies** before risking real capital
- **Test agent behavior** and observe how personas interact
- **Verify exchange connections** without financial exposure
- **Learn the system** without consequences

You must explicitly confirm before switching any exchange to live/production mode. The system prompts for confirmation and the Risk Manager flags the transition.

## Paper Trading by Exchange

| Exchange | Paper Mode | How to Enable |
|---|---|---|
| **Cube** | Staging environment | Default via `/setup` |
| **Binance** | Testnet | Use testnet API keys |
| **Kraken** | Built-in paper mode | `kraken auth login --paper` |
| **OKX** | Demo trading | Set demo mode in config |
| **Coinbase** | Not available | Use small allocations |
| **Robinhood** | Not available | Use Alpaca paper mode instead |
| **CCXT exchanges** | Varies | Check exchange testnet support |

See [Exchange Connectors](connectors.md) for full setup instructions per exchange.

## The Risk Manager

The [Risk Manager agent](../skills/risk-manager/) is the most important agent on the desk. It acts as a gatekeeper — all trading agents should consult it before executing trades.

### What the Risk Manager Does

| Function | Description |
|---|---|
| **Position sizing** | Calculates optimal size using Kelly criterion and fixed fractional methods |
| **Exposure limits** | Enforces per-asset and portfolio-wide concentration limits |
| **Drawdown protection** | Monitors max drawdown and triggers protective stops |
| **Trade approval** | Reviews proposed trades against risk budget before execution |
| **Stress testing** | Simulates flash crash, correlation spike, and liquidity drain scenarios |
| **VaR calculation** | Computes Value at Risk at 95% and 99% confidence levels |
| **Cross-exchange aggregation** | Aggregates exposure across all connected venues |
| **Emergency cancel** | Issues mass cancel across all exchanges if limits are breached |

### Hiring the Risk Manager

The Risk Manager should always be the first agent you hire:

```
> /hire risk-manager
> @risk-manager evaluate current portfolio risk
> @risk-manager set max drawdown to 10%
> @risk-manager approve this trade: long 0.5 BTC at market
```

### Risk Parameters

The Risk Manager stores its parameters in `.desk/risk.json`. These persist between sessions:

- Max portfolio drawdown (default: configurable per session)
- Per-position size limits
- Correlation thresholds
- Leverage limits
- Sector/asset concentration caps

## Safety Rules Built Into Every Agent

Every agent in the system follows these safety rules, defined in their `SKILL.md`:

1. **Write operations require explicit confirmation.** Before any order, cancel, or modification, the agent summarizes the action and waits for user consent.
2. **Paper mode awareness.** Agents use demo/paper/testnet mode for testing and display `[PAPER MODE]` in all outputs when not in production.
3. **Never present analysis as trading advice.** Agents present data and probabilities, not recommendations.
4. **Acknowledge uncertainty.** All analysis includes confidence levels and the disclaimer that past patterns do not guarantee future results.

## API Key Security

When you give AI agents access to exchange credentials, security matters. AI agents can read files, call tools, log output, and spawn processes.

### Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Keys stored in config files | Use read-only API keys; disable withdrawal permissions |
| Keys in environment variables | Use subaccounts with limited funds |
| Keys in logs or output | Avoid verbose mode; review MCP server code |
| Keys in session transcripts | Scrub transcripts before sharing |
| No key rotation | Rotate API keys regularly; use IP whitelists |
| Withdrawal permissions enabled | Always disable withdrawals on trading API keys |

### Best Practices

Create dedicated subaccounts with limited capital. Use read-only keys for research agents. Disable withdrawal permissions. Set IP whitelists. Rotate keys monthly. Never share session transcripts without scrubbing keys.

**Zero-key options**: Cube Exchange uses local device authorization (Ed25519 keys, browser approval) with no API keys in files. See [Agent Auth](agent-auth-brief.md). Kraken CLI uses browser-based login stored locally.

## Transitioning From Paper to Live

The safe path from idea to live trading:

```
1. BACKTEST     -- /backtest validates the strategy on historical data
                   Must pass: Sharpe > 0.5, ruin probability < 5%

2. PAPER TRADE  -- Run the strategy on paper/testnet
                   Compare paper results to backtest predictions
                   Run for at least 2 weeks or 30+ trades

3. RISK REVIEW  -- Risk Manager reviews paper performance
                   Approves or rejects live transition
                   Sets position limits and drawdown caps

4. LIVE (small) -- Switch to live with minimal capital
                   Risk Manager monitors in real-time
                   Must confirm explicitly: "yes, go live"

5. SCALE UP     -- Increase size only after live results
                   confirm backtest predictions (within 30%)
```

At every stage, the Risk Manager is involved. You cannot skip the approval step.

## Desk State and Persistence

All agent state, trade history, and risk parameters persist in `.desk/` (gitignored, per-user). The Risk Manager remembers its limits between sessions, and agents pick up where they left off.

## See Also

- [Risk Manager Skill](../skills/risk-manager/SKILL.md) — Full agent definition with risk frameworks
- [How to Backtest](how-to-backtest.md) — Validate strategies before paper trading
- [AI Trading Agents](ai-trading-agents.md) — All 42 agents and the hire/fire workflow
- [Exchange Connectors](connectors.md) — Paper mode setup for each exchange
- [Agent Auth](agent-auth-brief.md) — Cube's zero-key authentication for AI agents
- [What Is AI Fund?](what-is-ai-fund.md) — Project overview and quick start
- [README: API Key Security](../README.md#api-key-security--why-this-matters-with-ai-agents) — Full security breakdown
