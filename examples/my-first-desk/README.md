# My First Desk

A beginner-friendly trading desk with four agents that balance trend-following
and mean-reversion strategies under strict risk management.

## Agents

| Agent | Role |
|-------|------|
| **Risk Manager** | Gatekeeps every trade. Hired first, fired last. |
| **Quant Analyst** | Screens markets and scores signals for the traders. |
| **Momentum Trader** | Rides trends (MA crossovers, ADX filters). |
| **Mean Reversion Trader** | Fades overextended moves (Bollinger Bands, RSI). |

## Getting Started

```
> /setup              # Connect an exchange (starts in paper mode)
> /hire risk-manager   # Always hire the risk manager first
> /hire quant-analyst
> /hire momentum-trader
> /hire mean-reversion-trader
> /desk                # View your active agents and portfolio
> /review              # Run a performance review after some trades
```

## What to Expect

- The **Quant Analyst** produces scored signals across BTC, ETH, and SOL.
- The two traders propose orders based on those signals.
- The **Risk Manager** approves or rejects every proposal before execution.
- Run `/review` periodically to see a KPI scorecard (see `expected-output/`).

## Customizing

- **Add markets** -- edit `markets` in `desk.json`.
- **Tighten risk** -- lower `max_position_size_pct` or `max_portfolio_drawdown_pct`.
- **Scale up** -- add an `execution-trader` for smarter order routing, or an
  `arbitrageur` if you connect a second exchange.
- **Fire underperformers** -- `/fire momentum-trader` if win rate drops below 50%.
