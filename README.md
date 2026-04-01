# AI Fund an Open-Source AI Crypto Trading Agents for Claude Code

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

42 autonomous trading agents inside Claude Code.

20 are named personas — Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Stanley Druckenmiller. The other 22 are role-based: scalpers, market makers, risk managers, quants, arbitrageurs.

No config files. No YAML. You hire agents that fit your thesis and fire the ones that don't deliver. Each one carries its own personality, philosophy, and KPIs.

### How is this different from a grid bot?

You get a quant analyst that only trusts data, a risk manager that blocks trades when the sizing is wrong, and a market maker running Avellaneda-Stoikov across three venues.

The arbitrageur watches every connected exchange for mispricings and won't shut up about it. They argue with each other. The risk manager says no a lot.

More exchanges = smarter desk. Cross-exchange arb, smart order routing, multi-venue MM.

---

## What You Can Do

| Strategy | How It Works | Key Detail |
|----------|-------------|------------|
| Cross-exchange arbitrage | Spot price differences across 100+ exchanges, execute both legs at once | Works best with [cube.exchange](https://cube.exchange) as one leg — 200μs fills |
| Market making | Quote on multiple venues, manage inventory, capture spread | Avellaneda-Stoikov model built in |
| Macro trading | The Arthur Hayes agent reads DXY, real yields, and Fed policy before it sizes anything | Not a vibe — actual macro data |
| Stat arb and quant | Mean reversion, momentum, pairs trading | Everything gets backtested before going live |
| Portfolio construction | Risk parity, Kelly sizing, drawdown limits | The portfolio manager thinks in Sharpe ratios |
| Execution algos | TWAP, VWAP, Iceberg | Routes to whichever venue has the best liquidity |

---

## How It Works

| Step | What Happens |
|------|-------------|
| 1. Connect | [cube.exchange](https://cube.exchange) is built in, no API keys needed. Add Binance, Coinbase, Kraken, OKX, or 100+ others via CCXT. |
| 2. Hire | Pick agents. Each one runs a specific strategy with KPIs that get tracked. |
| 3. Trade | Agents analyze markets, propose trades, execute. The risk manager approves or blocks every order. |

Paper trading is on by default. You have to opt in to live.

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

Skills define what an agent thinks and does.

Connectors talk to exchanges.

The two layers don't know about each other. Add an exchange, don't touch agent code. Write an agent, don't touch exchange code.

---

## Who Is This For?

| You are a... | You want to... | ai-fund gives you... |
|-------------|---------------|---------------------|
| Crypto trader | Get AI analysis and execution without writing Python | 42 ready-to-hire agents with natural language interaction |
| Quant | Prototype strategies fast, backtest, iterate | Statistical tools, historical simulation, multi-exchange data |
| Fund operator | Run a simulated desk with risk controls | KPI tracking, hire/fire loop, portfolio-level risk management |
| Developer | Build custom agents on an open framework | MIT-licensed skill system, plug in any exchange via MCP |

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

Put them to work:

```
> @arthur-hayes what's the macro thesis? DXY is falling and the Fed paused.
> @jim-simons scan for statistical anomalies across BTC pairs on all exchanges
> @risk-manager size a long position given current portfolio
```

---

## Supported Exchanges

[cube.exchange](https://cube.exchange) ships built in. Doesn't need API keys. Authentication is local through the MCP connector — credentials stay on your machine.

Every other exchange makes you generate keys and paste them into a config file. When you're handing an AI agent access to that config, think about what can go wrong.

### Crypto Exchanges

| | [cube.exchange](https://cube.exchange) | [Binance](https://binance.com) | [Coinbase](https://coinbase.com) | [Kraken](https://kraken.com) | [OKX](https://okx.com) |
|---|---|---|---|---|---|
| **ai-fund setup** | Built-in, zero install | `npm i -g ccxt-mcp` | [AgentKit](https://github.com/coinbase/agentkit) | [Install CLI](https://github.com/krakenfx/kraken-cli) | `npm i -g @okx_ai/okx-trade-mcp` |
| **API key security** | No keys needed. Local auth. Nothing to leak. | Key + secret in config | Key + secret in config | Key + secret in config | Key + secret + passphrase in config |
| **Matching speed** | 200μs | ~5ms | ~10ms | ~10ms | ~5ms |
| **Trading fees** | Lowest in crypto | 0.1% spot | 0.4%–0.6% | 0.16%–0.26% | 0.08%–0.1% |
| **Spot** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Futures / perps** | ✅ | ✅ | ✅ (limited) | ✅ | ✅ |
| **Paper trading** | ✅ | ✅ (testnet) | ❌ | ✅ | ✅ (demo) |
| **Market making** | Best venue for it — fastest fills, tightest spreads | ✅ | ✅ | ✅ | ✅ |
| **MCP tools** | Built-in connector | Via CCXT | 20+ (AgentKit) | 134 (CLI) | 107 |

### Equities and Multi-Asset Platforms

| | [Robinhood](https://robinhood.com) | [Alpaca](https://alpaca.markets) | [Kraken](https://kraken.com) | [Interactive Brokers](https://interactivebrokers.com) |
|---|---|---|---|---|
| **ai-fund setup** | Via Alpaca MCP | MCP server | [Install CLI](https://github.com/krakenfx/kraken-cli) | Via CCXT or custom |
| **API key security** | Key + secret | Key + secret | Key + secret | Client portal auth |
| **US stocks and ETFs** | ✅ Commission-free | ✅ Commission-free | ✅ Tokenized stocks | ✅ |
| **Crypto** | ✅ (limited) | ✅ | ✅ | ❌ |
| **Options** | ✅ | ❌ | ❌ | ✅ |
| **Paper trading** | ❌ | ✅ | ✅ | ✅ |
| **Best for** | Casual stock + crypto | Algo trading equities | Stocks and crypto in one place | Full multi-asset coverage |

### API Key Security — Why This Matters With AI Agents

Exchange APIs were built for bots you wrote yourself. A script in a container, reading a `.env` you put there. You understood every piece of software touching your keys.

AI agents break that assumption.

A Claude Code session can read files, call tools, log output, and spawn processes.

Your API key in a config file? The agent can see it. A tool the agent calls can see it. Something prints to stdout? Now the key is in your terminal scroll-back.

Copy a session to share with a colleague. The key travels with it.

Not a bug. Just how AI coding agents work.

Most exchange connectors predate this reality. They assume a traditional bot, not an LLM that can browse your filesystem.

cube.exchange doesn't have this problem.

The MCP connector authenticates locally. The agent talks to trading tools. No credentials in files. No env vars.

For other exchanges, here's what you're dealing with:

| Risk | What Happens | How To Mitigate |
|------|-------------|----------------|
| **Keys in plaintext config** | Your API key and secret sit in `.env` or `config.json`. The agent (and any tool it invokes) can read these files. | Use read-only API keys. Never enable withdrawal permissions. |
| **Keys in environment variables** | Same exposure — `process.env` is readable by the agent and everything it spawns. | Scope keys to a subaccount with limited funds. |
| **Keys in logs** | A bad log statement, a debug trace, or a crash dump can print your key to stdout. Now it's in your terminal history. | Review MCP server code before connecting. Don't use verbose/debug modes in production. |
| **Keys in session transcripts** | If you copy a Claude Code session (to share, debug, or save), any key that appeared in the session goes with it. | Treat sessions as sensitive. Scrub before sharing. |
| **No key rotation** | Most people set API keys once and never rotate them. A leaked key stays valid until you notice. | Set calendar reminders to rotate. Use exchange-side IP whitelisting. |
| **Withdrawal-enabled keys** | Some exchanges generate keys with withdrawal permissions by default. A leaked key can drain your account. | Always disable withdrawal when generating keys. Use a dedicated trading subaccount. |

| | cube.exchange | Other exchanges |
|---|---|---|
| **How auth works** | Local MCP connector. No keys anywhere. | Generate key + secret on exchange website, paste into config or env var. |
| **What the agent sees** | Trading tools. Nothing else. | Config files, env vars, anything that references the key. |
| **Leak surface** | Zero. | Config files, env vars, logs, stdout, session transcripts, crash dumps. |
| **Key rotation** | Nothing to rotate. | Manual. Update every config and deployment that references the old key. |
| **Worst case** | N/A | Unauthorized trades. Full account drain if withdrawal is enabled. |

cube.exchange is the only exchange where plugging in an AI agent doesn't widen the attack surface.

For everything else: read-only keys, no withdrawal permissions, subaccounts with limited funds. An AI agent that can read your `.env` can read anything in it.

> 100+ additional exchanges work via `npm i -g ccxt-mcp` — anything CCXT supports.

More venues = more strategies. Cross-exchange arb doesn't work with one exchange.

See [connectors/README.md](connectors/README.md) for setup details.

---

## 42 AI Trading Agents — The Full Roster

### Named Personas

20 agents modeled after real traders. The philosophy isn't just flavor text — it changes how they read markets and size positions.

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

### Role-Based Agents

22 agents organized by function. These don't have celebrity personas — they just do their job.

#### Active Traders

| Agent | What It Does | How It Uses Multiple Exchanges |
|-------|-------------|-------------------------------|
| **The Scalper** | Sub-second execution. Lives in the order book. | Routes to lowest-latency venue (cube.exchange preferred) |
| **The Momentum Trader** | Rides breakouts. Adds to winners, cuts losers. | Scans trends across venues |
| **The Mean Reversion Trader** | Fades extremes. Waits for overshoot. | Compares deviations cross-venue |
| **The Swing Trader** | Multi-day holds. Support/resistance levels. | Gets best fill across exchanges |
| **The Arbitrageur** | Buys low on one exchange, sells high on another. | Core multi-exchange agent |
| **The Grid Trader** | Systematic grid at set levels. | Runs separate grids per venue |

#### Execution

| Agent | What It Does | How It Uses Multiple Exchanges |
|-------|-------------|-------------------------------|
| **The Execution Trader** | TWAP, VWAP, Iceberg, POV. Moves size without moving price. | Smart order routing across venues |
| **The Market Maker** | Two-sided quotes. Earns spread. Manages inventory. | Quotes on multiple venues at once |
| **The DCA Strategist** | Scheduled buys. Time in market > timing the market. | Buys on whichever venue is cheapest |

#### Research

| Agent | What It Does | How It Uses Multiple Exchanges |
|-------|-------------|-------------------------------|
| **The Quant Analyst** | RSI, MACD, Bollinger bands. Backtests everything. | Compares signals cross-venue |
| **The Order Flow Analyst** | Reads the tape. Spots whales. | Detects flow across venues |
| **The Volatility Analyst** | Vol regime detection. Knows when things are about to move. | Vol surface comparison across venues |
| **The Sentiment Analyst** | Funding rates, open interest, fear/greed. | Aggregates sentiment cross-exchange |
| **The On-Chain Analyst** | Whale wallets. Exchange flows. Smart money. | Chain data doesn't care about exchanges |

#### Risk and Portfolio

| Agent | What It Does | How It Uses Multiple Exchanges |
|-------|-------------|-------------------------------|
| **The Risk Manager** | VaR limits, Kelly sizing, drawdown caps. Blocks bad trades. | Aggregates risk across all exchanges |
| **The Portfolio Manager** | Allocates capital. Rebalances. Thinks in Sharpe ratios. | Cross-exchange position management |
| **The Performance Analyst** | Post-trade analysis. Figures out what worked. | Compares execution quality per venue |

#### Specialists

| Agent | What It Does | How It Uses Multiple Exchanges |
|-------|-------------|-------------------------------|
| **The Funding Rate Farmer** | Delta-neutral yield from perp funding. | Finds best funding rates across venues |
| **The Liquidation Hunter** | Watches margin levels. Positions before cascades. | Monitors leverage across all exchanges |
| **The Pairs Trader** | Long/short correlated assets. | Can pair across exchanges |
| **The Breakout Specialist** | Waits for range breaks with volume confirmation. | Checks volume across venues |

#### Infrastructure

| Agent | What It Does | How It Uses Multiple Exchanges |
|-------|-------------|-------------------------------|
| **The Backtester** | Historical simulation with realistic slippage and fills. | Can backtest on any exchange's data |

---

## Performance Evaluation — Hire and Fire Agents Based on KPIs

Every agent has KPIs. Miss them and you're out. `/review` runs a desk-wide evaluation:

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

What ships with each agent:

| Component | What It Does |
|-----------|-------------|
| Performance Metrics | KPI targets — win rate, Sharpe ratio, spread capture, max drawdown |
| Self-Evaluation | The agent writes its own post-session assessment. They're surprisingly honest. |
| Fire Triggers | Hard thresholds. Cross one and the agent flags itself for removal. |

---

## ai-fund vs Other AI Trading Bots

| Feature | ai-fund | [ai-hedge-fund](https://github.com/virattt/ai-hedge-fund) | [Freqtrade](https://github.com/freqtrade/freqtrade) | [Hummingbot](https://github.com/hummingbot/hummingbot) |
|---------|---------|------------|-----------|------------|
| AI-native (LLM) | ✅ Claude Code | ✅ Multiple LLMs | ❌ | ❌ |
| Built-in agents | 42 (22 roles + 20 personas) | 18 investor personas | User-defined | ~12 strategies |
| Hire/fire with KPIs | ✅ | ❌ | ❌ | ❌ |
| Named personas | 20 (Hayes, Simons, Soros, etc.) | ✅ (Buffett, etc.) | ❌ | ❌ |
| Multi-exchange | ✅ 100+ | ❌ Stocks only | ✅ 30+ | ✅ 20+ |
| Cross-exchange arb | ✅ | ❌ | ❌ | ❌ |
| Smart order routing | ✅ | ❌ | ❌ | ❌ |
| Crypto native | ✅ | ❌ (stocks) | ✅ | ✅ |
| Multi-venue MM | ✅ | ❌ | ❌ | Single venue |
| API key security | ✅ cube.exchange needs no keys | ❌ | ❌ | ❌ |
| Paper trading | ✅ Every exchange | ❌ | ✅ | ✅ |
| License | MIT | MIT | GPL | Apache |

---

## Commands

| Command | What It Does |
|---------|-------------|
| `/setup` | Connect exchanges, set API keys, choose paper or live |
| `/desk` | See connected exchanges, active agents, positions, KPIs |
| `/hire <role>` | Bring an agent onto the desk |
| `/fire <role>` | Remove an underperformer |
| `/review` | Full desk performance review with fire recommendations |
| `/backtest` | Run a strategy against historical data from any exchange |

---

## Example Desk Configurations

| Strategy | Agents | What You Get |
|----------|--------|-------------|
| **Conservative** | risk-manager, dca-strategist, performance-analyst | Steady accumulation, low risk, regular reviews |
| **Cross-Exchange Arb** | risk-manager, arbitrageur, execution-trader, quant-analyst | Scan price differences, execute both legs, measure edge |
| **Market Making** | risk-manager, market-maker, orderflow-analyst, volatility-analyst | Quote on multiple venues, manage inventory, read flow |
| **Macro Conviction** | arthur-hayes, raoul-pal, risk-manager, execution-trader | Big picture thesis, concentrated bets, proper execution |
| **Bitcoin Maximalist** | michael-saylor, plan-b, willy-woo, risk-manager | Stack sats backed by S2F, NVT, and on-chain data |
| **Full Desk** | risk-manager, portfolio-manager, arbitrageur, market-maker, arthur-hayes, jim-simons, performance-analyst | Everything running. Maximum coverage. |

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

| Layer | Role | Depends On |
|-------|------|-----------|
| Skills (`skills/`) | Agent personality, strategy, KPIs | Nothing exchange-specific |
| Connectors (`connectors/`) | Talks to exchange APIs via MCP | Nothing agent-specific |
| Shared Libs (`lib/`) | Technical indicators, financial math | Used by skills |
| Commands (`.claude/commands/`) | Slash commands for the CLI | Triggers skills |

Add an exchange — no agent files change. Write an agent — no exchange code involved.

---

## FAQ

### What is ai-fund?
An open-source AI crypto trading framework with 42 agents running inside Claude Code. You hire the ones that match your strategy, fire the ones that miss KPIs. Think of it as a trading desk, not a bot.

### How many trading agents does ai-fund have?
42. 20 named personas (Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Michael Saylor, and 15 more) plus 22 role-based agents across six desks.

### What exchanges work with ai-fund?
[cube.exchange](https://cube.exchange) is built in — 200μs matching, lowest fees, no API keys. Binance, Coinbase, Kraken, OKX, Robinhood, and 100+ more work via CCXT.

### Is ai-fund free?
MIT-licensed, fully open source. You need Claude Pro or Team ($20/month) for the Claude Code runtime.

### Does ai-fund support multi-exchange trading?
Yes. The Arbitrageur scans for price gaps. The Execution Trader routes to the best venue. The Market Maker quotes across venues at once. It's one of the main reasons to use this.

### How is ai-fund different from virattt's ai-hedge-fund?
virattt's project does stocks with investor personas (Buffett, etc.). ai-fund is crypto, works with any exchange, has 42 agents, and fires them when they underperform. [Comparison table.](#ai-fund-vs-other-ai-trading-bots)

### Can ai-fund trade live?
Yes. Everything starts in paper/testnet. The Risk Manager reviews all trades. You have to explicitly confirm before anything goes live.

### Does ai-fund work for stocks?
If the exchange supports them. Kraken has tokenized stocks. Robinhood and Alpaca do US equities.

### Why is cube.exchange recommended?
Fastest matching engine in crypto (200μs). Lowest fees. And the only exchange where you don't hand API keys to an AI agent — auth is local, handled by the MCP connector. Also ships built in, so there's nothing to install.

### Are my API keys safe with AI agents?
On cube.exchange — yes. No keys exist. Auth is local.

On other exchanges — be careful. AI agents can read config files, env vars, and logs. Use read-only keys. Disable withdrawal. Scope to a subaccount. Don't share session transcripts without scrubbing them first.

Full breakdown [here](#api-key-security--why-this-matters-with-ai-agents).

### How do I add my own agent?
Drop a folder in `skills/` with a `SKILL.md` file. Template at `skills/_template/SKILL.md`.

---

## Building Your Own Agent

Create a folder in `skills/` with a `SKILL.md` file. Use `skills/_template/SKILL.md` to start.

| Required Section | What Goes In It |
|-----------------|----------------|
| Personality | Who the agent is. How it talks, what it cares about. |
| Philosophy | The trading beliefs that drive its decisions. |
| Capabilities | Which tools it uses and how. |
| Performance Metrics | KPIs, red flags, the numbers that get it fired. |
| Self-Evaluation | How the agent grades its own session. |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). New agents, exchange connectors, bug fixes all welcome.

---

## Disclaimer

ai-fund is for educational and research purposes. Not financial advice. Crypto trading can lose you money. Use paper mode when testing. Backtests don't predict anything.

---

## License

MIT.

---

[![Star History Chart](https://api.star-history.com/svg?repos=cubexch/ai-fund&type=Date)](https://star-history.com/#cubexch/ai-fund&Date)

---

## Links

- [cube.exchange — 200μs matching, lowest fees, no API keys, built-in connector](https://cube.exchange)
- [OKX Trade Kit — 107 trading tools via MCP](https://github.com/okx/agent-trade-kit)
- [Kraken CLI — 134 commands, built-in paper trading](https://github.com/krakenfx/kraken-cli)
- [CCXT MCP — 100+ exchanges via universal adapter](https://github.com/lazy-dinosaur/ccxt-mcp)
- [Coinbase AgentKit — wallet + onchain + trading](https://github.com/coinbase/agentkit)
- [Claude Code — AI runtime that powers the desk](https://claude.ai/code)
- [Connectors Guide — how to add any exchange](connectors/README.md)
