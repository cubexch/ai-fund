# How to Create a Trading Strategy

A strategy in AI Fund is a **desk configuration** — a combination of agents, risk parameters, and a market thesis. This guide walks you through building one from scratch.

## What Is a Strategy?

A strategy is a JSON file in `examples/` (or loaded from anywhere) that defines:
- **Which agents** to hire and why
- **Risk parameters** that govern the desk
- **Strategy-specific config** (assets, timeframes, thresholds)

The Risk Manager is always included. It reviews and approves every trade from every other agent.

---

## Step 1: Define Your Thesis

Before picking agents, write down your thesis in one sentence. Examples:

| Thesis | Style | Agents You Might Want |
|--------|-------|-----------------------|
| "BTC will trend up for the next 6 months" | Trend following | momentum-trader, dca-strategist |
| "Markets will be choppy and range-bound" | Mean reversion | mean-reversion-trader, grid-trader |
| "I want to profit from volatility, not direction" | Volatility harvesting | volatility-analyst, market-maker |
| "On-chain data predicts price before charts do" | Data-driven | onchain-analyst, whale-watcher (custom) |
| "I want to accumulate BTC and ETH with minimal effort" | Passive accumulation | dca-strategist, performance-analyst |

## Step 2: Pick Your Agents

Browse the available agents in `skills/`. Each has a SKILL.md that describes its personality, strategy, and KPIs. A good desk has:

1. **Risk Manager** (always) — The gatekeeper. Approves or rejects every trade.
2. **1-2 signal generators** — Agents that identify trade opportunities (e.g., momentum-trader, onchain-analyst, sentiment-analyst).
3. **0-1 execution specialists** — Agents that optimize how trades are placed (e.g., execution-trader, scalper).
4. **0-1 analysts** — Agents that provide context without trading (e.g., performance-analyst, volatility-analyst).

**Keep it small.** 3-4 agents is the sweet spot. Too many agents create conflicting signals and slow decision-making.

## Step 3: Set Risk Parameters

These go in the `risk_parameters` block of your desk.json:

| Parameter | What It Controls | Conservative | Moderate | Aggressive |
|-----------|-----------------|-------------|----------|------------|
| `max_position_size_pct` | Max % of portfolio in a single position | 5 | 10 | 20 |
| `max_portfolio_drawdown_pct` | Max drawdown before emergency shutdown | 10 | 15 | 25 |
| `max_leverage` | Maximum leverage allowed | 1 | 2 | 5 |
| `stop_loss_required` | Require stop-loss on every trade | true | true | true |
| `max_correlated_exposure_pct` | Max % of portfolio in correlated assets | 20 | 30 | 50 |

**Always keep `stop_loss_required: true`.** There is no good reason to turn it off.

## Step 4: Write Your desk.json

Here is an annotated example for a "Whale-Driven Momentum" strategy:

```jsonc
{
  // Give your strategy a clear name
  "name": "Whale-Driven Momentum",

  // One sentence: what is the thesis?
  "description": "Follow smart money on-chain signals to enter momentum trades on large-cap crypto.",

  // Which agents to hire. Risk manager is always first.
  "agents": [
    "risk-manager",        // Gatekeeper — approves/rejects all trades
    "onchain-analyst",     // Signal generator — reads on-chain data
    "momentum-trader"      // Executor — enters trades when signals align with momentum
  ],

  // Risk limits for the whole desk
  "risk_parameters": {
    "max_position_size_pct": 10,       // No single position > 10% of portfolio
    "max_portfolio_drawdown_pct": 15,  // Shut down if portfolio drops 15%
    "max_leverage": 2,                 // Max 2x leverage
    "stop_loss_required": true,        // Every trade must have a stop
    "max_correlated_exposure_pct": 30  // No more than 30% in correlated assets
  },

  // Strategy-specific config (varies by strategy)
  "momentum_config": {
    "markets": ["BTC-USDC", "ETH-USDC", "SOL-USDC"],
    "timeframe": "4h",
    "entry_signal": "onchain_accumulation_with_momentum",
    "exit_signal": "trailing_stop_2x_atr",
    "min_adx": 25
  }
}
```

## Step 5: Backtest Your Strategy

Before going live, test your strategy on historical data:

```
/backtest
```

The backtest agent will ask you for:
- **Strategy**: Which desk.json to use (or describe the strategy)
- **Time period**: How far back to test
- **Markets**: Which assets to include
- **Starting capital**: Simulated portfolio size

### What to Look For in Backtest Results

| Metric | Good | Concerning |
|--------|------|------------|
| Sharpe Ratio | > 1.0 | < 0.5 |
| Max Drawdown | < your limit | > your limit |
| Win Rate | > 45% (with good R:R) | < 35% |
| Profit Factor | > 1.5 | < 1.0 |
| Number of Trades | > 30 (statistically meaningful) | < 10 |

## Step 6: Run a Demo

Load your strategy in paper mode and observe:

1. `/hire risk-manager` — Start with the gatekeeper
2. `/hire onchain-analyst` — Add your signal generators
3. `/hire momentum-trader` — Add your executors
4. `/desk` — Check that everyone is active and connected

Let it run for a few sessions. Watch for:
- Are agents generating signals that align with your thesis?
- Is the Risk Manager approving reasonable trades and rejecting bad ones?
- Are the KPIs tracking in the right direction?

### Expected Artifacts from a Demo Run

After running your strategy, you should see these files in `.desk/`:

```
.desk/
├── state.json              # Current desk state (agents, exchanges, session info)
├── orders.json             # All proposed, submitted, filled, and rejected trades
├── risk.json               # Risk parameters and current risk metrics
└── briefings/
    ├── risk-manager.md     # Risk events, approvals/rejections, portfolio health
    ├── onchain-analyst.md  # On-chain signals detected, accuracy tracking
    └── momentum-trader.md  # Trades taken, entry/exit quality, P&L
```

Each briefing book contains:
- **Agent status** and hire date
- **Key analyses** with scores, prices, and timestamps
- **Active recommendations** and their current status
- **Running KPIs** and self-evaluation
- **Open questions** for the next session

## Step 7: Iterate

After a demo run, use `/review` to get a desk-wide performance evaluation. Then:

- **Fire underperformers**: `/fire agent-name` if an agent's KPIs are below threshold
- **Hire replacements**: Try a different agent for the same role
- **Adjust risk parameters**: Tighten or loosen based on what you observed
- **Refine the thesis**: Maybe your original thesis was wrong, or the market changed

---

## Example Desk Configurations

Look at the existing examples in `examples/` for inspiration:

| File | Strategy | Agents |
|------|----------|--------|
| `conservative-desk.json` | Passive DCA accumulation | risk-manager, dca-strategist, performance-analyst |
| `momentum-desk.json` | Trend following with quant signals | risk-manager, quant-analyst, momentum-trader, execution-trader |
| `market-maker-desk.json` | Liquidity provision | risk-manager, market-maker, volatility-analyst |
| `cross-exchange-arb.json` | Cross-exchange arbitrage | risk-manager, arbitrageur, execution-trader |

---

## Tips

- **Start conservative.** Lower leverage, tighter stops, smaller positions. You can always loosen up after you see results.
- **Don't over-staff.** 3-4 agents is ideal. More agents means more conflicting signals.
- **Paper trade first.** Always. No exceptions. Use the exchange's demo/testnet mode.
- **Review weekly.** Run `/review` regularly. Fire agents that aren't pulling their weight.
- **Your thesis drives everything.** If the market regime changes, your strategy should change too. Don't ride a trend-following strategy into a choppy market.
