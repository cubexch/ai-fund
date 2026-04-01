# AI Fund — Open-Source AI Crypto Trading Agents for Claude Code

### Hire your AI trading desk. Not another grid bot.

> 42 AI hedge fund agents, 20 named personas (Arthur Hayes, Jim Simons, George Soros, etc.), 100+ crypto exchanges. Ships with [cube.exchange](https://cube.exchange) built in. MIT licensed. Runs on [Claude Code](https://claude.ai/code).

<!-- GitHub Topics (set these in repo Settings > Topics):
ai-trading, crypto-trading-bot, hedge-fund, ai-hedge-fund, trading-agents, mcp, claude-code, algorithmic-trading, market-making, arbitrage, quantitative-trading, risk-management, multi-exchange, defi, bitcoin, ethereum, crypto-fund -->

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-blueviolet)](https://claude.ai/code)
[![Exchanges](https://img.shields.io/badge/exchanges-100%2B%20supported-green)](connectors/README.md)
[![Agents](https://img.shields.io/badge/agents-42%20hedge%20fund%20roles-orange)](#42-ai-trading-agents--the-full-roster)

```
> /hire risk-manager
> /hire arthur-hayes
> /hire market-maker

> @arthur-hayes what's the macro thesis right now?
> scan all exchanges for BTC price differences
> the arbitrageur found a 15bps spread between cube.exchange and Binance — execute it
> risk-manager, approve this trade
```

---

## What Is ai-fund?

ai-fund runs 42 autonomous trading agents inside Claude Code. 20 of them are named personas modeled after real traders: Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Stanley Druckenmiller. The other 22 are role-based — scalpers, market makers, risk managers, quants, arbitrageurs.

Each agent has its own personality, trading philosophy, and KPIs. You don't configure parameters or tweak YAML files. You **hire** agents that match your thesis and **fire** the ones that underperform.

The difference between this and a grid bot: ai-fund gives you a quant analyst that only trusts data. A risk manager that will block your trade if sizing is off. A market maker running Avellaneda-Stoikov across three venues. An arbitrageur watching every connected exchange for mispricings. They argue with each other. The risk manager says no a lot.

Connect more exchanges and the desk gets smarter. Cross-exchange arb, smart order routing, multi-venue MM — stuff that used to require a prime brokerage account and a team of six.

---

## What You Can Do

- **Cross-exchange arbitrage** — spot price differences across 100+ exchanges, execute both legs simultaneously
- **Market making** — quote on multiple venues, manage inventory, capture spread. Avellaneda-Stoikov built in.
- **Macro trading** — the Arthur Hayes agent actually reads DXY, real yields, and Fed policy before sizing
- **Stat arb and quant strategies** — mean reversion, momentum, pairs. Everything gets backtested first.
- **Portfolio construction** — risk parity, Kelly sizing, drawdown limits. The portfolio manager thinks in Sharpe ratios.
- **Execution algos** — TWAP, VWAP, Iceberg. Route to the venue with best liquidity.

---

## How It Works

1. **Connect** your exchanges. [cube.exchange](https://cube.exchange) is built in — or add Binance, Coinbase, Kraken, OKX, and 100+ more via CCXT.
2. **Hire** agents. Each one runs a specific strategy with defined KPIs.
3. **Trade.** Agents analyze, propose, and execute. The risk manager approves (or blocks) every order.

Paper trading is the default on every exchange. You have to explicitly opt in to live.

```
YOU (trader)
  │
  ├── /hire risk-manager          ← activate agents
  ├── /hire arbitrageur
  ├── /hire market-maker
  │
  ▼
CLAUDE CODE (AI runtime)
  │
  ├── Skills (42 SKILL.md files)  ← agent personas, strategies, KPIs
  │
  ├── Exchange Connectors (MCP)   ← connect any exchange
  │   ├── cube.exchange (built-in)
  │   ├── Binance, Coinbase, Kraken, OKX, Robinhood...
  │   └── 100+ via CCXT
  │
  ▼
YOUR EXCHANGES (paper or live)
```

Skills define personality and strategy. Connectors handle exchange access. The two layers are completely separate — skills never call exchange APIs directly, so adding a new exchange doesn't require touching any agent code.

---

## Who Is This For?

- **Crypto traders** — you want AI doing the analysis and execution but you don't want to write Python
- **Quants** — prototype strategies in natural language, backtest them, iterate fast
- **Fund operators** — spin up a simulated desk with real KPIs and risk controls
- **Developers** — build your own agents on top of the framework. It's MIT, do what you want.

---

## Quick Start

```bash
git clone https://github.com/cubexch/ai-fund
cd ai-fund
npm install
```

Open Claude Code and connect your exchanges:

```
claude
> /setup
```

Hire your first agents:

```
> /hire risk-manager
> /hire arthur-hayes
> /hire jim-simons
```

Start working:

```
> @arthur-hayes what's the macro thesis? DXY is falling and the Fed paused.
> @jim-simons scan for statistical anomalies across BTC pairs on all exchanges
> @risk-manager size a long position given current portfolio
```

---

## Supported Exchanges

[cube.exchange](https://cube.exchange) ships built in with zero setup — 200μs matching, lowest fees in crypto. For everything else, connect any exchange that has an MCP server.

| Exchange | Setup | Highlights |
|----------|-------|------------|
| **[cube.exchange](https://cube.exchange)** | Built-in, zero install | 200μs matching engine. Lowest fees in crypto. Best for market making and scalping. Recommended. |
| **[Binance](https://binance.com)** | `npm i -g ccxt-mcp` | World's largest exchange. Spot + futures. Via CCXT. |
| **[Coinbase](https://coinbase.com)** | [AgentKit](https://github.com/coinbase/agentkit) | US-regulated. Wallet + onchain + trading. |
| **[Kraken](https://kraken.com)** | [Install CLI](https://github.com/krakenfx/kraken-cli) | Stocks, futures, staking. Built-in paper trading. |
| **[Robinhood](https://robinhood.com)** | Via Alpaca MCP | Stocks, ETFs, crypto. Commission-free. |
| **[OKX](https://okx.com)** | `npm i -g @okx_ai/okx-trade-mcp` | 107 tools. Spot, futures, options, earn, bots. |
| **100+ more** | `npm i -g ccxt-mcp` | Any CCXT-supported exchange. |

Multiple exchanges unlock cross-exchange arb, smart order routing, and multi-venue market making. That's the whole point.

See [connectors/README.md](connectors/README.md) for full setup instructions.

---

## 42 AI Trading Agents — The Full Roster

### Named Personas — Trade Like the Legends

Each persona trades with the philosophy of the person they're modeled after. Pick the one closest to how you think.

| Persona | Philosophy | Style |
|---------|-----------|-------|
| **[Arthur Hayes](/skills/arthur-hayes)** | Macro-to-crypto. DXY, real yields, liquidity cycles. | Leveraged macro conviction |
| **[George Soros](/skills/george-soros)** | Reflexivity theory. Attack regime breaks. Boom-bust cycles. | Thesis-driven, concentrated |
| **[Stanley Druckenmiller](/skills/stanley-druckenmiller)** | Go for the jugular. Concentrated macro bets when conviction is high. | High-conviction sizing |
| **[Paul Tudor Jones](/skills/paul-tudor-jones)** | Risk management IS the strategy. 200-day MA. 5:1 R:R minimum. | Trend following, risk-first |
| **[Ray Dalio](/skills/ray-dalio)** | All-weather portfolio. Risk parity. 15 uncorrelated bets. | Balanced allocation |
| **[Jim Simons](/skills/jim-simons)** | Pure quant. Statistical edge. Zero emotion. Sharpe > 2.0. | Systematic stat arb |
| **[Ed Thorp](/skills/ed-thorp)** | Kelly criterion. Mathematical edge. The original quant. | Optimal bet sizing |
| **[Jesse Livermore](/skills/jesse-livermore)** | Tape reading. Pyramiding. "It was my sitting that made the big money." | Classic speculation |
| **[Michael Saylor](/skills/michael-saylor)** | Bitcoin is digital property. Stack sats. Never sell. | Relentless BTC accumulation |
| **[Cathie Wood](/skills/cathie-wood-crypto)** | Disruptive innovation. Wright's law. 5-year thesis. | High-conviction innovation |
| **[Raoul Pal](/skills/raoul-pal)** | Exponential age. Network value. 4-year cycles. | Cycle-based portfolio |
| **[PlanB](/skills/plan-b)** | Stock-to-Flow. Halving cycles. On-chain models. | Model-based BTC valuation |
| **[Willy Woo](/skills/willy-woo)** | On-chain analytics. NVT. Holder behavior. "The chain doesn't lie." | On-chain signals |
| **[CZ](/skills/cz)** | Build in the bear. Spot only. Ecosystem investing. Fundamentals > hype. | Ecosystem value investing |
| **[GCR](/skills/gcr)** | Contrarian. Fade the crowd. "When everyone agrees, they're usually wrong." | Contrarian conviction |
| **[Cobie](/skills/cobie)** | Narrative trading. Early to the meta. Asymmetric bets. | Narrative lifecycle |
| **[Ansem](/skills/ansem)** | Early discovery. Momentum alpha. Degen with discipline. | Micro-cap momentum |
| **[Hsaka](/skills/hsaka)** | Chart structure. S/R levels. Only A+ setups. Patience. | Technical swing trading |
| **[Tetranode](/skills/tetranode)** | DeFi yield. Real yield vs emissions. Governance power. | Yield optimization |
| **[Gwyneth Chen](/skills/gwyneth-chen)** | Pro market maker. Spread capture. Adverse selection. Avellaneda-Stoikov. | Institutional MM |

```
> /hire arthur-hayes
> @arthur-hayes what's the macro setup? DXY is falling and the Fed just paused.

> /hire jim-simons
> @jim-simons scan for statistical anomalies across all BTC pairs

> /hire michael-saylor
> @michael-saylor set up a weekly DCA into BTC across all exchanges
```

### Active Traders
| Agent | What They Do | Multi-Exchange |
|-------|-------------|----------------|
| **The Scalper** | Sub-second execution. Lives in the order book. Optimizes for spread capture. | Routes to lowest-latency venue |
| **The Momentum Trader** | Rides breakouts. Adds to winners. Cuts losers early. | Scans trends across venues |
| **The Mean Reversion Trader** | Fades extremes. Waits for statistical overshoot, then strikes. | Compares deviations across venues |
| **The Swing Trader** | Multi-day holds. Reads support/resistance. Conviction holds. | Best fill across exchanges |
| **The Arbitrageur** | **Cross-exchange arb.** Detects mispricings, executes simultaneously. | **Core multi-exchange agent** |
| **The Grid Trader** | Systematic grid. Sets levels. Lets math work. | Grid per venue |

### Execution Desk
| Agent | What They Do | Multi-Exchange |
|-------|-------------|----------------|
| **The Execution Trader** | TWAP, VWAP, Iceberg, POV. Moves size without moving price. | **Smart order routing** across venues |
| **The Market Maker** | Provides liquidity. Earns the spread. Manages inventory risk. | **Multi-venue quoting** |
| **The DCA Strategist** | Disciplined accumulator. Time in the market > timing the market. | Buys on cheapest venue |

### Research Desk
| Agent | What They Do | Multi-Exchange |
|-------|-------------|----------------|
| **The Quant Analyst** | RSI, MACD, Bollinger. Data-driven signals. Backtests everything. | Cross-venue data comparison |
| **The Order Flow Analyst** | Reads the tape. Spots whales. Detects institutional flow. | Cross-venue flow detection |
| **The Volatility Analyst** | Vol regime specialist. Detects when markets are about to move. | Vol comparison across venues |
| **The Sentiment Analyst** | Funding rates, OI, fear/greed. Reads crowd positioning. | Aggregates sentiment data |
| **The On-Chain Analyst** | Whale wallets. Exchange flows. Smart money tracking. | Chain data is exchange-agnostic |

### Risk & Portfolio
| Agent | What They Do | Multi-Exchange |
|-------|-------------|----------------|
| **The Risk Manager** | VaR limits, Kelly sizing, drawdown caps. Blocks trades that don't pass. | **Aggregate risk across all exchanges** |
| **The Portfolio Manager** | Allocates capital across strategies. Thinks in Sharpe ratios. | **Cross-exchange allocation** |
| **The Performance Analyst** | Post-trade analysis. Figures out what actually worked. | Compares execution per venue |

### Specialists
| Agent | What They Do | Multi-Exchange |
|-------|-------------|----------------|
| **The Funding Rate Farmer** | Delta-neutral yield. Captures perpetual funding payments. | Best funding across venues |
| **The Liquidation Hunter** | Monitors margin levels. Positions before liquidation cascades. | Monitors leverage across exchanges |
| **The Pairs Trader** | Long/short correlated assets. Market-neutral stat arb. | Cross-exchange pairs |
| **The Breakout Specialist** | Waits for consolidation, then strikes on range break with volume. | Volume confirmation across venues |

### Infrastructure
| Agent | What They Do | Multi-Exchange |
|-------|-------------|----------------|
| **The Backtester** | Prove it works before you trade it. Historical simulation with realistic slippage. | Backtest on any exchange's data |

---

## Performance Evaluation — Hire and Fire Agents Based on KPIs

Every agent has KPIs. Hit them and you stay. Miss them and you're out. The `/review` command runs a desk-wide evaluation:

```
> /review

╔═══════════════════════════════════════════════════╗
║              DESK PERFORMANCE REVIEW              ║
╠═══════════════════════════════════════════════════╣

  CONNECTED: cube.exchange (live) · Binance (paper) · Kraken (paper)

┌──────────────────┬────────────┬────────┬──────────┐
│ Agent            │ Primary KPI│ Actual │ Grade    │
├──────────────────┼────────────┼────────┼──────────┤
│ Risk Manager     │ Breaches   │ 0      │ 🟢 A     │
│ Arbitrageur      │ Net P&L    │ +$340  │ 🟢 B+    │
│ Market Maker     │ Spread P&L │ +$120  │ 🟢 B     │
│ Momentum Trader  │ Win Rate   │ 41%    │ 🔴 D     │
└──────────────────┴────────────┴────────┴──────────┘

RECOMMENDATION:
  🔴 FIRE Momentum Trader — win rate below 55% target
     Market is range-bound. Replace with Mean Reversion Trader.
```

Each agent ships with:
- **Performance Metrics** — KPI targets: win rate, Sharpe ratio, spread capture, max drawdown
- **Self-Evaluation** — the agent writes an honest post-session assessment
- **Fire Triggers** — hard thresholds. Cross them and the agent recommends its own removal.

---

## ai-fund vs Other AI Trading Bots

| Feature | ai-fund | [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | [Freqtrade](https://github.com/freqtrade/freqtrade) | [Hummingbot](https://github.com/hummingbot/hummingbot) |
|---------|---------------|---------------|-----------|------------|
| AI-native (LLM-powered) | ✅ Claude Code | ✅ Multiple LLMs | ❌ | ❌ |
| Built-in agents | 42 (22 roles + 20 personas) | 18 investor personas | User-defined | ~12 strategies |
| Agent personalities & KPIs | ✅ Hire/fire loop | ✅ Named personas | ❌ | ❌ |
| Multi-exchange | ✅ Any exchange | ❌ Stocks only | ✅ 30+ exchanges | ✅ 20+ exchanges |
| Cross-exchange arbitrage | ✅ | ❌ | ❌ | ❌ |
| Smart order routing | ✅ | ❌ | ❌ | ❌ |
| Crypto-focused | ✅ | ❌ (stocks) | ✅ | ✅ |
| Market making | ✅ Multi-venue | ❌ | ❌ | ✅ Single venue |
| Paper trading | ✅ All exchanges | ❌ | ✅ | ✅ |
| Open source | ✅ MIT | ✅ MIT | ✅ GPL | ✅ Apache |

---

## Commands

| Command | Description |
|---------|-------------|
| `/setup` | Connect exchanges, configure API keys, set paper/live mode |
| `/desk` | Dashboard: connected exchanges, active agents, positions, KPIs |
| `/hire <role>` | Activate a trading agent |
| `/fire <role>` | Deactivate an underperforming agent |
| `/review` | Desk-wide performance evaluation with fire recommendations |
| `/backtest` | Test a strategy on historical data from any exchange |

---

## Example Desk Configurations

**Conservative** — low risk, steady accumulation:
```
/hire risk-manager
/hire dca-strategist
/hire performance-analyst
```

**Cross-Exchange Arbitrage** — this is what multi-venue is for:
```
/hire risk-manager
/hire arbitrageur
/hire execution-trader
/hire quant-analyst
```

**Market Making** — provide liquidity, earn spread:
```
/hire risk-manager
/hire market-maker
/hire orderflow-analyst
/hire volatility-analyst
```

**Macro Conviction** — big picture, big bets:
```
/hire arthur-hayes
/hire raoul-pal
/hire risk-manager
/hire execution-trader
```

**Bitcoin Maximalist** — stack sats with data:
```
/hire michael-saylor
/hire plan-b
/hire willy-woo
/hire risk-manager
```

**Full Desk** — everything running:
```
/hire risk-manager
/hire portfolio-manager
/hire arbitrageur
/hire market-maker
/hire arthur-hayes
/hire jim-simons
/hire performance-analyst
```

---

## Architecture

```
ai-fund/
├── connectors/              # Exchange connections
│   ├── cube/                # Built-in: cube.exchange (200μs, recommended)
│   │   └── mcp-server/     # MCP server (Osmium WebSocket + Iridium REST)
│   ├── README.md            # How to add Binance, Coinbase, Kraken, OKX, etc.
│   └── community/           # Links to community connectors
├── skills/                  # 42 agent personas (exchange-agnostic)
├── lib/                     # Shared: indicators, financial math, formatting
├── examples/                # Pre-built desk configurations
├── scripts/                 # npx installer
└── .claude/commands/        # Slash commands (/setup, /desk, /hire, etc.)
```

Skills are exchange-agnostic — they define personality and strategy but know nothing about specific exchange APIs. Connectors handle that. You can add a new exchange without touching a single agent file, and you can write a new agent without knowing anything about exchange integration.

---

## FAQ

### What is ai-fund?
An open-source AI crypto trading framework. 42 autonomous agents run inside Claude Code, each with its own trading strategy and measurable KPIs. Instead of configuring bot parameters, you hire agents and fire them when they underperform.

### How many trading agents does ai-fund include?
42. There are 20 named personas (Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Michael Saylor, and 15 more) and 22 role-based agents spread across 6 desks: Active Traders, Execution, Research, Risk & Portfolio, Specialists, and Infrastructure.

### What exchanges does ai-fund support?
[cube.exchange](https://cube.exchange) ships built in with a 200μs matching engine and the lowest fees in crypto. Beyond that, anything with an MCP server works — Binance, Coinbase, Kraken, OKX, Robinhood, and 100+ more via CCXT.

### Is ai-fund free?
The framework is MIT-licensed and free. You'll need a Claude Pro or Team subscription ($20/month) because it runs on Claude Code.

### Can ai-fund trade across multiple exchanges at once?
That's one of the main reasons it exists. The Arbitrageur scans all connected exchanges for price differences. The Execution Trader routes to the best venue. The Market Maker quotes on multiple exchanges at the same time.

### How does ai-fund compare to virattt's ai-hedge-fund?
Different focus. virattt's project is for stocks with investor personas (Warren Buffett, etc.). ai-fund is crypto-native, supports any exchange, and has 42 agents. See the [comparison table](#ai-fund-vs-other-ai-trading-bots).

### Can I use ai-fund for live trading?
You can, but every exchange defaults to paper/testnet mode. The Risk Manager reviews all trades, and any write operation needs your explicit go-ahead.

### Can I use ai-fund for stocks?
If your exchange supports them. Kraken has tokenized stocks. Robinhood and Alpaca do US equities.

### Can I add my own agents?
Drop a folder in `skills/` with a `SKILL.md` file. There's a template at `skills/_template/SKILL.md`.

---

## Building Your Own Agent

Create a folder in `skills/` with a `SKILL.md` file. Use `skills/_template/SKILL.md` as the starting point.

Every agent needs:
1. **Personality** — who they are, how they think
2. **Philosophy** — the beliefs that drive their decisions
3. **Capabilities** — what tools they use
4. **Performance Metrics** — KPIs, red flags, when to fire them
5. **Self-Evaluation** — how they grade themselves

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). New agents, exchange connectors, bug fixes — all welcome.

---

## Disclaimer

ai-fund is for educational and research purposes. Not financial advice. Crypto trading carries substantial risk of loss. Use paper trading when testing. Backtests don't predict the future.

---

## License

MIT.

---

[![Star History Chart](https://api.star-history.com/svg?repos=cubexch/ai-fund&type=Date)](https://star-history.com/#cubexch/ai-fund&Date)

---

## Links

- [cube.exchange — 200μs matching, lowest fees, built-in connector](https://cube.exchange)
- [OKX Trade Kit — 107 trading tools via MCP](https://github.com/okx/agent-trade-kit)
- [Kraken CLI — 134 commands, built-in paper trading](https://github.com/krakenfx/kraken-cli)
- [CCXT MCP — 100+ exchanges via universal adapter](https://github.com/lazy-dinosaur/ccxt-mcp)
- [Coinbase AgentKit — wallet + onchain + trading](https://github.com/coinbase/agentkit)
- [Claude Code — AI runtime that powers the desk](https://claude.ai/code)
- [Connectors Guide — how to add any exchange](connectors/README.md)
