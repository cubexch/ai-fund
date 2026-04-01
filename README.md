# AI Fund — Open-Source AI Crypto Trading Agents for Claude Code

### Hire your AI trading desk. Not another grid bot.

> 42 autonomous AI hedge fund agents — including personas like Arthur Hayes, Jim Simons, and George Soros — that trade on 100+ crypto exchanges. Open source. MIT licensed. Powered by [Claude Code](https://claude.ai/code).

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
> the arbitrageur found a 15bps spread between Binance and Coinbase — execute it
> risk-manager, approve this trade
```

---

## What Is ai-fund?

ai-fund is an open-source AI crypto hedge fund that runs 42 autonomous trading agents inside Claude Code — including 20 named personas modeled after legends like Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, and Stanley Druckenmiller. Each agent has a distinct personality, trading philosophy, risk framework, and measurable KPIs. You don't configure parameters. You **hire and fire** agents based on performance, just like a real trading desk.

Unlike traditional crypto bots that execute pre-built grid strategies, ai-fund gives you a team of specialists: a quant analyst that only trusts data, a risk manager that enforces VaR limits, Kelly sizing, and drawdown caps, a market maker that optimizes inventory across venues, and an arbitrageur that detects cross-exchange mispricings in real time.

The more exchanges you connect, the smarter your desk gets. Institutional-grade strategies — cross-exchange arb, smart order routing, multi-venue market making — open source.

**Connect your exchanges. Hire your team. Trade.**

---

## What You Can Do

- **Cross-exchange arbitrage** — Scan 100+ exchanges for price differences and execute instantly
- **AI market making** — Provide liquidity across multiple venues with automated inventory management
- **Macro conviction trading** — Trade crypto based on DXY, real yields, and Fed policy like Arthur Hayes
- **Quantitative strategies** — Statistical arbitrage, mean reversion, momentum — backtested before live
- **Portfolio management** — Risk parity, Kelly sizing, drawdown limits across all connected exchanges
- **Smart order routing** — TWAP, VWAP, Iceberg execution routed to the best venue automatically

---

## How It Works

**ai-fund works in three steps:**

1. **Connect** your exchanges — Binance, Coinbase, Kraken, OKX, Cube, or any of 100+ supported venues
2. **Hire** AI agents — each one is a specialist with a defined strategy, personality, and KPIs
3. **Trade** — agents analyze markets, propose trades, and execute with risk management oversight

All exchanges default to paper trading. Live trading requires explicit confirmation.

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
  │   ├── Cube (built-in)
  │   ├── OKX, Kraken, Binance, Coinbase, Robinhood...
  │   └── 100+ via CCXT
  │
  ▼
YOUR EXCHANGES (paper or live)
```

Skills define personality and strategy. Connectors provide exchange access. Skills never call exchange APIs directly — they compose generic trading tools (place orders, get prices, manage positions) that work with any connected exchange.

---

## Who Is This For?

- **Crypto traders** who want AI-powered analysis and execution without writing code
- **Quants** who want to prototype and backtest strategies in natural language
- **Fund operators** who want a simulated trading desk with measurable KPIs and risk controls
- **Developers** who want to build custom trading agents on an open-source framework

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

ai-fund works with any exchange that has an MCP server. Connect one or connect ten.

| Exchange | Setup | Highlights |
|----------|-------|------------|
| **[Cube](https://cube.exchange)** | Built-in, zero install | 200μs matching engine. Lowest fees. Best for market making and scalping. |
| **[Binance](https://binance.com)** | `npm i -g ccxt-mcp` | World's largest exchange. Spot + futures. Via CCXT. |
| **[Coinbase](https://coinbase.com)** | [AgentKit](https://github.com/coinbase/agentkit) | US-regulated. Wallet + onchain + trading. |
| **[Kraken](https://kraken.com)** | [Install CLI](https://github.com/krakenfx/kraken-cli) | Stocks, futures, staking. Built-in paper trading. |
| **[Robinhood](https://robinhood.com)** | Via Alpaca MCP | Stocks, ETFs, crypto. Commission-free. |
| **[OKX](https://okx.com)** | `npm i -g @okx_ai/okx-trade-mcp` | 107 tools. Spot, futures, options, earn, bots. |
| **100+ more** | `npm i -g ccxt-mcp` | Any CCXT-supported exchange. |

> **Pro tip**: Connect multiple exchanges to unlock cross-exchange arbitrage, smart order routing, and multi-venue market making.

See [connectors/README.md](connectors/README.md) for full setup instructions.

---

## 42 AI Trading Agents — The Full Roster

### Named Personas — Trade Like the Legends

Each persona trades with the philosophy of the legend they're modeled after. Start with the one that matches your style.

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
| **The Risk Manager** | Enforces VaR limits, Kelly sizing, and drawdown caps. Approves every trade. | **Aggregate risk across all exchanges** |
| **The Portfolio Manager** | Allocates capital across strategies. Optimizes for Sharpe ratio. | **Cross-exchange allocation** |
| **The Performance Analyst** | Post-trade analysis. Dissects what worked and what didn't. | Compares execution per venue |

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

Every agent has measurable KPIs. Underperformers get fired — just like a real trading desk.

```
> /review

╔═══════════════════════════════════════════════════╗
║              DESK PERFORMANCE REVIEW              ║
╠═══════════════════════════════════════════════════╣

  CONNECTED: Binance (live) · Cube (paper) · Kraken (paper)

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

Each agent includes:
- **Performance Metrics** — specific KPI targets (win rate, Sharpe ratio, spread capture, max drawdown)
- **Self-Evaluation** — honest assessment after every trading session
- **Fire Triggers** — quantitative thresholds that signal when to cut an agent

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

**Conservative** — Low risk, steady accumulation:
```
/hire risk-manager
/hire dca-strategist
/hire performance-analyst
```

**Cross-Exchange Arbitrage** — The multi-venue edge:
```
/hire risk-manager
/hire arbitrageur
/hire execution-trader
/hire quant-analyst
```

**Market Making** — Liquidity provision across venues:
```
/hire risk-manager
/hire market-maker
/hire orderflow-analyst
/hire volatility-analyst
```

**Macro Conviction** — Trade like the legends:
```
/hire arthur-hayes
/hire raoul-pal
/hire risk-manager
/hire execution-trader
```

**Bitcoin Maximalist** — Stack sats with data:
```
/hire michael-saylor
/hire plan-b
/hire willy-woo
/hire risk-manager
```

**Full Desk** — Maximum coverage:
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
│   ├── cube/                # Built-in: Cube Exchange (200μs, recommended)
│   │   └── mcp-server/     # MCP server (Osmium WebSocket + Iridium REST)
│   ├── README.md            # How to add Binance, Coinbase, Kraken, OKX, etc.
│   └── community/           # Links to community connectors
├── skills/                  # 42 agent personas (exchange-agnostic)
├── lib/                     # Shared: indicators, financial math, formatting
├── examples/                # Pre-built desk configurations
├── scripts/                 # npx installer
└── .claude/commands/        # Slash commands (/setup, /desk, /hire, etc.)
```

**Skills are exchange-agnostic.** They define personality and strategy. Connectors provide exchange access. Anyone can add a new exchange connector without touching the skills.

---

## FAQ

### What is ai-fund?
ai-fund is an open-source AI crypto trading framework with 42 autonomous agents that run inside Claude Code. Unlike traditional bots that execute pre-built strategies, each agent has a distinct personality, trading philosophy, and measurable KPIs — you hire and fire them based on performance, just like a real hedge fund.

### How many trading agents does ai-fund include?
42 total. 20 named personas modeled after legendary traders (Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Michael Saylor, and 15 more) plus 22 role-based agents across 6 desks: Active Traders, Execution, Research, Risk & Portfolio, Specialists, and Infrastructure.

### What exchanges does ai-fund support?
Any exchange with an MCP server — Binance, Coinbase, Kraken, Robinhood, OKX, Cube, and 100+ more via CCXT. Cube Exchange ships as a built-in connector with a 200μs matching engine.

### Is ai-fund free?
Yes. ai-fund is MIT-licensed and fully open source. The only requirement is a Claude Pro or Team subscription ($20/month) for the Claude Code runtime.

### Can ai-fund trade across multiple exchanges at once?
Yes — this is a core feature. The Arbitrageur scans all connected exchanges for price differences. The Execution Trader routes orders to the best venue. The Market Maker quotes on multiple exchanges simultaneously. The more venues you connect, the more strategies you unlock.

### How does ai-fund compare to virattt's ai-hedge-fund?
virattt's ai-hedge-fund focuses on stock trading with investor personas (Warren Buffett, etc.). ai-fund is crypto-native with 42 trader personas and supports any exchange. See the [comparison table](#ai-fund-vs-other-ai-trading-bots).

### Can I use ai-fund for live trading?
Yes, but all exchanges default to paper/demo/testnet mode. The Risk Manager agent reviews every trade, and write operations require explicit confirmation before execution.

### Can I use ai-fund for stocks?
Yes, if your exchange supports it. Kraken offers tokenized stocks. Robinhood and Alpaca support US equities.

### Can I add my own agents?
Yes. Create a folder in `skills/` with a `SKILL.md` file. See `skills/_template/SKILL.md` for the template.

---

## Building Your Own Agent

Create a new folder in `skills/` with a `SKILL.md` file. See `skills/_template/SKILL.md`.

Every agent needs:
1. **Personality** — Who they are, how they think
2. **Philosophy** — Core beliefs that guide decisions
3. **Capabilities** — Mapped to generic exchange tools
4. **Performance Metrics** — KPIs, red flags, fire triggers
5. **Self-Evaluation** — How they report on their own performance

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). We welcome new agents, exchange connectors, and improvements.

---

## Disclaimer

ai-fund is for educational and research purposes. It is not financial advice. Trading cryptocurrencies carries substantial risk of loss. Always use paper trading mode when testing. Past performance of backtests does not guarantee future results.

---

## License

MIT — use it, fork it, build on it.

---

[![Star History Chart](https://api.star-history.com/svg?repos=cubexch/ai-fund&type=Date)](https://star-history.com/#cubexch/ai-fund&Date)

---

## Links

- [Cube Exchange — 200μs matching engine, built-in connector](https://cube.exchange)
- [OKX Trade Kit — 107 trading tools via MCP](https://github.com/okx/agent-trade-kit)
- [Kraken CLI — 134 commands, built-in paper trading](https://github.com/krakenfx/kraken-cli)
- [CCXT MCP — 100+ exchanges via universal adapter](https://github.com/lazy-dinosaur/ccxt-mcp)
- [Coinbase AgentKit — wallet + onchain + trading](https://github.com/coinbase/agentkit)
- [Claude Code — AI runtime that powers the desk](https://claude.ai/code)
- [Connectors Guide — how to add any exchange](connectors/README.md)
