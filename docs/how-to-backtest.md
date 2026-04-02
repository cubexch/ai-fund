---
title: How to Backtest Trading Strategies
description: >
  Backtest trading strategies with AI Fund's Backtester agent. Supports walk-forward
  optimization, Monte Carlo simulation, parameter sensitivity analysis, multi-exchange
  fee modeling, and out-of-sample validation. Paper trading integration included.
keywords: backtest trading strategy, AI backtest, paper trading, simulated trading, walk-forward optimization, Monte Carlo simulation, historical simulation, strategy testing, overfitting detection, backtesting framework
---

# How to Backtest Trading Strategies

AI Fund includes a dedicated [Backtester agent](../skills/backtester/) that validates trading strategies on historical data before you risk real capital. The Backtester is the gatekeeper between a theory and live money — no strategy gets allocated capital without passing its tests.

## Running a Backtest

### Using the `/backtest` Command

```
> /backtest
```

The `/backtest` slash command activates the Backtester agent and walks you through strategy validation. You can also hire it directly:

```
> /hire backtester
> @backtester test a 20/50 EMA crossover on BTC/USDT, 4h candles, last 6 months
```

### What You Can Test

Any strategy that can be described in natural language:

- Moving average crossovers (SMA, EMA, DEMA)
- RSI overbought/oversold with confirmation
- Bollinger Band mean reversion
- MACD signal line crossovers
- Breakout strategies with volume filters
- Momentum strategies with trailing stops
- Multi-indicator combinations
- Custom entry/exit logic

## Data Sources

The Backtester pulls historical OHLCV candle data from whichever exchanges you have connected. It uses the `get_price_history` tool, which works with any exchange connector.

| Data Need | Which Tool | Notes |
|---|---|---|
| Historical candles | `get_price_history` | OHLCV data at any timeframe |
| Market specifications | `get_markets` | Tick sizes, lot sizes for realistic simulation |
| Fee schedules | `get_estimated_fees` | Actual fees from your exchange for cost modeling |
| Current spreads | `get_tickers` | Calibrates slippage model against live conditions |

### Multi-Exchange Data

When multiple exchanges are connected, the Backtester can:

- **Use the exchange with the deepest history** for longer-term validation
- **Use the exchange where you plan to trade live** for realistic fee and slippage modeling
- **Compare results across exchange datasets** to verify robustness

If a strategy only works on one exchange's data, it may be fitting to venue-specific microstructure rather than capturing a real edge.

## What the Backtester Checks

Every backtest runs through a four-stage pipeline:

### 1. Data Preparation

- Fetches OHLCV candles via connected exchange
- Splits data into in-sample (70%) and out-of-sample (30%) by default
- The out-of-sample period is never used for optimization

### 2. Execution Simulation

- Applies strategy logic to generate entry/exit signals
- Simulates fills with a slippage model (spread + volume impact + volatility)
- Deducts trading fees using the exchange's actual fee schedule
- Tracks position, equity, and drawdown over time

### 3. Performance Calculation

Metrics computed on both in-sample and out-of-sample periods:

| Metric | What It Measures |
|---|---|
| **Sharpe Ratio** | Risk-adjusted return (target: > 1.0) |
| **Sortino Ratio** | Downside risk-adjusted return |
| **Max Drawdown** | Largest peak-to-trough decline |
| **Win Rate** | Percentage of profitable trades |
| **Profit Factor** | Gross profit / gross loss |
| **Expectancy** | Average dollar P&L per trade |
| **Calmar Ratio** | Annual return / max drawdown |
| **Total Trades** | Sample size for statistical significance |

A metric that degrades more than 30% out-of-sample is flagged as an overfitting signal.

### 4. Robustness Testing

| Test | What It Does | Pass Criteria |
|---|---|---|
| **Walk-Forward** | Rolling window optimization and validation | OOS Sharpe > 0.5, degradation < 50% |
| **Monte Carlo** | Reshuffles trade sequence 1000 times | Ruin probability < 5% |
| **Parameter Sensitivity** | Varies each parameter by +/- 20% | No sharp performance cliffs |

## Interpreting Results

The Backtester produces a structured results report with a final verdict:

| Verdict | Meaning |
|---|---|
| **PASS** | Strategy is robust across all tests. Ready for paper trading. |
| **CONDITIONAL PASS** | Strategy shows promise but has warnings. Proceed with reduced size. |
| **FAIL** | Strategy is overfit, too fragile, or unprofitable after costs. Do not trade. |

### Red Flags the Backtester Watches For

- **Sharpe > 3.0** on a daily strategy — almost certainly overfit
- **Win rate > 80%** — likely survivorship bias or look-ahead bias
- **Zero losing months** — too good to be true
- **Fewer than 30 trades** — insufficient data for statistical significance
- **OOS degradation > 50%** — strategy was fit to noise, not signal
- **Parameter sensitivity spikes** — small changes cause large performance swings

## From Backtest to Paper Trading

A backtest that passes validation is ready for paper trading. The workflow:

1. **Backtest** the strategy with `/backtest` (historical simulation)
2. **Paper trade** the strategy on a live exchange in paper/testnet mode
3. **Compare** paper trading results to backtest predictions
4. **Go live** only after paper results confirm the backtest within 30% of predicted Sharpe

Paper trading is enabled by default on all exchanges. See [Paper Trading and Safety](paper-trading-safety.md) for details on staying safe.

## Advanced: Walk-Forward Optimization

Walk-forward is the gold standard for strategy validation. Instead of a single train/test split, it uses rolling windows:

```
> @backtester run walk-forward on the RSI mean-reversion strategy, 60-candle in-sample, 20-candle out-of-sample
```

The Backtester divides the historical data into overlapping windows, optimizes parameters on each in-sample segment, tests on the adjacent out-of-sample segment, and aggregates results across all windows.

## Advanced: Monte Carlo Simulation

Monte Carlo reshuffles the order of your trades to test whether the equity curve depends on a lucky sequence:

```
> @backtester run Monte Carlo on my last backtest, 1000 iterations
```

Key outputs: median final equity, 5th percentile worst case, 95th percentile max drawdown, and probability of ruin.

## Cost Modeling

The Backtester models transaction costs conservatively. A strategy that ignores fees and slippage is a fantasy, not a strategy.

| Cost Component | How It Is Modeled |
|---|---|
| **Trading fees** | Actual maker/taker rates from connected exchange |
| **Slippage** | Half the spread + volume impact + volatility impact |
| **Round-trip cost** | Entry fee + exit fee + entry slippage + exit slippage |

When multiple exchanges are connected, the Backtester compares net performance across venues so you can see where execution is cheapest.

## See Also

- [Backtester Skill](../skills/backtester/SKILL.md) — Full agent definition with formulas and frameworks
- [Paper Trading and Safety](paper-trading-safety.md) — Move from backtest to paper to live safely
- [AI Trading Agents](ai-trading-agents.md) — All 42 agents and how they interact
- [Exchange Connectors](connectors.md) — Connect exchanges to access historical data
- [What Is AI Fund?](what-is-ai-fund.md) — Project overview and quick start
- [README: Commands](../README.md#commands) — All slash commands including `/backtest`
