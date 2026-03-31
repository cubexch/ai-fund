---
description: Test a trading strategy on historical data
args: strategy
---

# /backtest — Historical Strategy Testing

Test a trading strategy against historical Cube market data before deploying it live.

## Process

1. **Select strategy**: If `$ARGUMENTS` is provided, load that agent's SKILL.md. Otherwise, ask the user which agent/strategy to backtest.

2. **Configure parameters**:
   - Market (e.g., BTC-USDC, ETH-USDC)
   - Time period (e.g., last 30 days, last 90 days)
   - Starting capital
   - Risk parameters (position size, stop loss, etc.)

3. **Gather historical data**: Use `get_price_history` with appropriate interval and limit to get OHLCV data for the backtest period.

4. **Simulate**: Walk through the historical data applying the agent's strategy logic:
   - Track entries and exits
   - Apply realistic fees (use `get_estimated_fees`)
   - Account for slippage (estimate 0.1% for liquid markets)
   - Enforce risk limits

5. **Report results**:
   ```
   BACKTEST REPORT: [Strategy] on [Market]
   Period: [start] to [end]
   Starting Capital: $[amount]

   PERFORMANCE
   ───────────
   Net P&L:           $[amount] ([%])
   Sharpe Ratio:      [value]
   Max Drawdown:      [%]
   Win Rate:          [%]
   Profit Factor:     [value]
   Total Trades:      [count]
   Avg Trade Duration: [time]

   RISK METRICS
   ────────────
   Worst Trade:       -$[amount]
   Best Trade:        +$[amount]
   Avg Winner:        +$[amount]
   Avg Loser:         -$[amount]
   Max Consecutive Losses: [count]

   TRADE LOG (last 10)
   ───────────────────
   [table of recent simulated trades]
   ```

6. **Verdict**: Based on the results, recommend whether to deploy the strategy live:
   - **DEPLOY**: Sharpe > 1.0, positive P&L, acceptable drawdown
   - **OPTIMIZE**: Promising but needs parameter tuning
   - **REJECT**: Negative expected value or unacceptable risk

## Important
- This is a simulation. Past performance does not guarantee future results.
- Always recommend paper trading before live deployment.
- Be honest about the limitations of backtesting (survivorship bias, overfitting, etc.)
