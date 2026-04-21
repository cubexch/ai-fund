# AI Fund — Open-Source AI Hedge Fund for Claude Code

### Hire your AI trading desk. Fire the ones that miss KPIs.

> 45 AI trading agents. 21 named personas (Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Warren Buffett, Peter Lynch…). 147 built-in MCP tools across Cube (31), CCXT (92), and Alpaca (24), plus 110 CCXT exchanges. Paper trading by default. MIT licensed. Runs on [Claude Code](https://claude.ai/code).

<!-- GitHub Topics (set these in repo Settings > Topics):
ai-trading, crypto-trading-bot, hedge-fund, ai-hedge-fund, trading-agents, mcp, claude-code, algorithmic-trading, market-making, arbitrage, quantitative-trading, risk-management, multi-exchange, defi, bitcoin, ethereum, crypto-fund -->

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/built%20for-Claude%20Code-blueviolet)](https://claude.ai/code)
[![Exchanges](https://img.shields.io/badge/exchanges-110%20CCXT%20venues-green)](connectors/README.md)
[![Agents](https://img.shields.io/badge/agents-45%20hedge%20fund%20roles-orange)](#45-ai-trading-agents--the-full-roster)
[![Powered By Cube](https://www.cube.exchange/api/badge)](https://cube.exchange)

<p align="center">
  <img src="docs/architecture-light.svg" alt="How AI Fund works — You talk to Claude Code, which orchestrates 45 trading agents across cube.exchange, Binance, Coinbase, Kraken, OKX, and 110 CCXT exchanges via MCP connectors" width="100%">
</p>

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

45 autonomous trading agents inside Claude Code, with built-in MCP connectors and broad multi-exchange support via CCXT. Shared analysis libraries cover indicators, execution, portfolio analytics, and risk tooling.

21 are named personas — Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Stanley Druckenmiller, Warren Buffett. The other 24 are role-based: scalpers, market makers, risk managers, quants, arbitrageurs.

No config files. No YAML. You hire agents that fit your thesis and fire the ones that don't deliver. Each one carries its own personality, philosophy, and KPIs.

### Count Snapshot (from this repo)

- **45 agents total** in `skills/` (`_template` excluded)
- **21 named personas** + **24 role-based specialists**
- **147 built-in MCP tools** across active servers
  - Cube: 31 tools
  - CCXT: 92 tools
  - Alpaca: 24 tools
- **110 exchanges via CCXT** (from the installed `ccxt` package in this repo)

### How is this different from a grid bot?

You get a quant analyst that only trusts data, a risk manager that blocks trades when the sizing is wrong, and a market maker running Avellaneda-Stoikov across three venues.

The arbitrageur watches every connected exchange for mispricings and won't shut up about it. They argue with each other. The risk manager says no a lot.

More exchanges = smarter desk. Cross-exchange arb, smart order routing, multi-venue MM.

---

## What You Can Do

| Strategy | Description |
|----------|------------|
| Cross-exchange arb | Spot price gaps, execute both legs |
| Market making | Multi-venue quotes, Avellaneda-Stoikov |
| Macro trading | DXY, yields, Fed policy via Hayes agent |
| Stat arb / quant | Mean reversion, momentum, pairs |
| Portfolio | Risk parity, Kelly sizing, drawdowns |
| Execution algos | TWAP, VWAP, Iceberg routing |

---

## How It Works

| Step | What Happens |
|------|-------------|
| 1. Connect | Connect any exchange via plugins. Paper mode by default. |
| 2. Hire | Pick agents. KPIs get tracked. |
| 3. Trade | Agents propose, risk manager approves. |

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
  ├── Skills (45 SKILL.md files)  ← agent personas, strategies, KPIs
  │
  ├── Exchange Connectors (MCP)   ← connect any exchange
  │   ├── Cube (built-in)
  │   ├── Binance, Coinbase, Kraken, OKX...
  │   └── 110 via CCXT
  │
  ▼
YOUR EXCHANGES (paper or live)
```

Skills define what an agent thinks and does.

Connectors talk to exchanges.

The two layers don't know about each other. Add an exchange, don't touch agent code. Write an agent, don't touch exchange code.

---

## Who Is This For?

| You are a... | ai-fund gives you... |
|-------------|---------------------|
| Crypto trader | 45 agents, natural language |
| Quant | Backtest, stat tools, multi-exchange |
| Fund operator | KPIs, hire/fire, risk controls |
| Developer | MIT skill system, any exchange |

---

## AI Contributor Path (for faster maintenance)

If you are modifying this repo with an AI coding agent, follow the maintainer guide:

- [`docs/ai-maintainer-path.md`](docs/ai-maintainer-path.md)
- `npm run repo:map` for live architecture + risk hotspots
- `npm run repo:map:json` to generate `.ai/repo-map.json` and `.ai/context-pack.md`

This gives agents a machine-readable architecture map, dependency-cycle detection, and a prompt-ready context pack for safer edits.
PRs also run the **AI Repo Intelligence** workflow to publish these artifacts automatically.

---

## Quick Start

```bash
git clone https://github.com/cubexch/ai-fund
cd ai-fund
npm ci
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

### Codex Quick Start

Codex can run AI Fund too. Use `AGENTS.md` as the Codex instruction entrypoint and follow [Running AI Fund With Codex](docs/codex.md) for Codex OAuth, Cube browser auth, and MCP registration.

```bash
codex login
cd ai-fund
npm ci
cd connectors/cube/mcp-server
CUBE_ENV=staging npm run login
```

### Cube CLI + Expanded Tool Surface

Recent Cube connector updates added a first-party `cube` CLI and expanded analysis/trade tooling.

```bash
cd connectors/cube/mcp-server
npm run login
npm run status
npm run cube -- --help
```

Use the command groups directly (`cube account ...`, `cube market ...`, `cube order ...`, `cube risk ...`, `cube trade ...`) or call MCP tools from Claude Code. Full reference: [connectors/cube/README.md](connectors/cube/README.md).

#### Advanced Tool Families (Cube)

- **Portfolio/Risk intelligence:** `assess_portfolio_risk`, `simulate_stress_test`
- **Signal intelligence:** `detect_confluence`, `detect_bb_squeeze`, `get_market_microstructure`
- **Execution planning:** `plan_twap`, `simulate_market_impact`
- **Smart routing/discovery:** `search_assets`, `get_trending`, `execute_trade`

These tools are designed to be chained (scan → validate → risk-check → execution plan → route).

---

## Supported Exchanges (Counted)

Connect any exchange via MCP plugins. Each connector handles authentication differently — some use API keys, others use local auth. See [connectors/README.md](connectors/README.md) for setup details.

When handing an AI agent access to exchange credentials, think about security. See the [API Key Security](#api-key-security--why-this-matters-with-ai-agents) section below.

### Crypto Exchanges

| | Cube | Coinbase | Binance | Kraken | OKX |
|---|---|---|---|---|---|
| **Connector** | Built-in MCP | Built-in (CCXT) | Built-in (CCXT) | CLI | okx-mcp |
| **Auth** | Local (no keys) | Key+secret+pass | Key+secret | Key+secret | Key+secret+pass |
| **Spot** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Perps** | ✅ | Limited | ✅ | ✅ | ✅ |
| **Paper** | ✅ | Sandbox | Testnet | ✅ | Demo |

### Equities and Multi-Asset Platforms

| | Alpaca | Kraken | IBKR |
|---|---|---|---|
| **Setup** | Built-in MCP | CLI | CCXT/custom |
| **API keys** | Key+secret | Key+secret | Portal auth |
| **Stocks** | ✅ No-fee | Tokenized | ✅ |
| **Crypto** | ✅ | ✅ | ❌ |
| **Options** | ❌ | ❌ | ✅ |
| **Paper** | ✅ | ✅ | ✅ |

### API Key Security — Why This Matters With AI Agents

AI agents can read files, call tools, log output, and spawn processes. Your API key in a config file? The agent can see it.

| Risk | Mitigation |
|------|-----------|
| **Keys in config** | Use read-only keys. Disable withdrawal. |
| **Keys in env vars** | Use subaccounts with limited funds. |
| **Keys in logs** | Avoid verbose mode. Review MCP code. |
| **Keys in transcripts** | Scrub before sharing sessions. |
| **No rotation** | Rotate regularly. IP whitelist. |
| **Withdrawal enabled** | Always disable. Use subaccounts. |

Some connectors (like Cube's built-in MCP) use local auth with no API keys. Others require key+secret in config files. Choose connectors that match your security requirements.

> 110 additional exchanges work via `npm i -g ccxt-mcp` — anything CCXT supports in this repo's pinned CCXT version.

More venues = more strategies. Cross-exchange arb doesn't work with one exchange.

See [connectors/README.md](connectors/README.md) for setup details.

---

## 45 AI Trading Agents — The Full Roster

### Named Personas

21 agents modeled after real traders. The philosophy isn't just flavor text — it changes how they read markets and size positions.

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
| **[Warren Buffett](/skills/warren-buffett)** | Value investing. Margin of safety. Competitive moats. Long-term compounding. | Fundamental value |
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

23 agents organized by function. These don't have celebrity personas — they just do their job.

#### Active Traders

| Agent | Role | Multi-Exchange |
|-------|------|---------------|
| Scalper | Sub-second, order book | Lowest-latency venue |
| Momentum | Breakouts, trend riding | Cross-venue scans |
| Mean Reversion | Fades extremes | Cross-venue deviation |
| Swing | Multi-day S/R holds | Best fill routing |
| Arbitrageur | Buy low, sell high | Core cross-exchange |
| Grid | Systematic levels | Grid per venue |

#### Execution

| Agent | Role | Multi-Exchange |
|-------|------|---------------|
| Execution Trader | TWAP, VWAP, Iceberg | Smart order routing |
| Market Maker | Two-sided quotes | Multi-venue quoting |
| DCA Strategist | Scheduled buys | Cheapest venue |

#### Research

| Agent | Role | Multi-Exchange |
|-------|------|---------------|
| Quant Analyst | RSI, MACD, backtests | Cross-venue signals |
| Order Flow | Tape reading, whales | Cross-venue flow |
| Volatility | Vol regime detection | Cross-venue vol |
| Sentiment | Funding, OI, fear/greed | Aggregated data |
| On-Chain | Wallets, exchange flows | Exchange-agnostic |

#### Risk and Portfolio

| Agent | Role | Multi-Exchange |
|-------|------|---------------|
| Risk Manager | VaR, Kelly, drawdown caps | Aggregate all venues |
| Equity Risk Manager | Equity-specific risk: beta, sector, factor | Cross-exchange |
| Portfolio Manager | Allocation, rebalancing | Cross-exchange |
| Performance | Post-trade analysis | Per-venue comparison |

#### Specialists

| Agent | Role | Multi-Exchange |
|-------|------|---------------|
| Funding Farmer | Delta-neutral yield | Best rates cross-venue |
| Liquidation Hunter | Margin monitoring | All exchanges |
| Pairs Trader | Long/short correlated | Cross-exchange pairs |
| Breakout | Range breaks + volume | Cross-venue volume |

#### Infrastructure

| Agent | Role | Multi-Exchange |
|-------|------|---------------|
| Backtester | Historical simulation | Any exchange data |

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

| Component | Description |
|-----------|------------|
| Metrics | Win rate, Sharpe, spread, drawdown |
| Self-Eval | Agent grades its own session |
| Fire Triggers | Hard thresholds, auto-removal |

---

## ai-fund vs Other AI Trading Bots

| | ai-fund | ai-hedge-fund | Freqtrade | Hummingbot |
|---|---|---|---|---|
| **LLM-native** | ✅ Claude | ✅ Multi-LLM | ❌ | ❌ |
| **Agents** | 45 | 18 | User-defined | ~12 |
| **Hire/fire** | ✅ | ❌ | ❌ | ❌ |
| **Personas** | 21 | ✅ | ❌ | ❌ |
| **Exchanges** | 110+ | Stocks only | 30+ | 20+ |
| **Cross-arb** | ✅ | ❌ | ❌ | ❌ |
| **SOR** | ✅ | ❌ | ❌ | ❌ |
| **Crypto** | ✅ | ❌ | ✅ | ✅ |
| **Multi-MM** | ✅ | ❌ | ❌ | 1 venue |
| **No API keys** | ✅ cube | ❌ | ❌ | ❌ |
| **Paper** | ✅ All | ❌ | ✅ | ✅ |
| **License** | MIT | MIT | GPL | Apache |

---

## Commands

| Command | Description |
|---------|------------|
| `/setup` | Connect exchanges, API keys, mode |
| `/desk` | Active agents, positions, KPIs |
| `/hire <role>` | Activate an agent |
| `/fire <role>` | Remove an agent |
| `/review` | Performance review + fire recs |
| `/backtest` | Test on historical data |

---

## Example Desk Configurations

| Desk | Agents |
|------|--------|
| **Conservative** | risk-manager, dca, performance |
| **Arb** | risk, arbitrageur, execution, quant |
| **MM** | risk, market-maker, orderflow, vol |
| **Macro** | hayes, pal, risk, execution |
| **BTC Maxi** | saylor, plan-b, willy-woo, risk |
| **Full** | risk, portfolio, arb, mm, hayes, simons |

---

## Architecture

```
ai-fund/
├── connectors/              # Exchange connections (built-in + beta, 110 via CCXT)
│   ├── cube/                # Built-in: cube.exchange (CLI + MCP tool surface)
│   ├── ccxt/                # Built-in: Coinbase, Binance, 110 exchanges (92 tools)
│   ├── alpaca/              # Built-in: stocks, ETFs, crypto (24 tools)
│   └── README.md            # How to add more exchanges
├── skills/                  # 45 agent personas (exchange-agnostic)
├── lib/                     # 28 shared libraries, 250+ pure functions
│   ├── indicators.ts        # SMA, EMA, RSI, MACD, BB, ATR, ADX, OBV, Stochastic
│   ├── math.ts              # Kelly, VaR, Sharpe, Sortino, correlation, drawdown
│   ├── execution-planner.ts # TWAP, VWAP, iceberg, market impact (Almgren-Chriss)
│   ├── execution-analytics.ts # Order book analysis, slippage, fill simulation
│   ├── portfolio-analytics.ts # Portfolio exposure, stress test, rebalancing
│   ├── confluence-detector.ts # Multi-TF confluence, BB squeeze, mean reversion
│   ├── grid-trading.ts      # DCA scheduling, grid optimization, basis trade
│   ├── volume-profile.ts    # Volume profile, value area, correlation regime
│   └── ...                  # Backtester, regime detector, signal generator, etc.
├── examples/                # Pre-built desk configurations
├── scripts/                 # npx installer
└── .claude/commands/        # Slash commands (/setup, /desk, /hire, etc.)
```

| Layer | Role |
|-------|------|
| `skills/` | 45 agent personalities, strategies, KPIs |
| `connectors/` | Built-in and beta exchange MCP servers with capability-gated surfaces |
| `lib/` | 28 shared libraries — indicators, risk, execution, portfolio, options, stat-arb, microstructure |
| `.claude/commands/` | Slash commands |

Add an exchange — no agent files change. Write an agent — no exchange code involved.

---

## FAQ

### What is ai-fund?
An open-source AI crypto trading framework with 45 agents running inside Claude Code. You hire the ones that match your strategy and fire the ones that miss KPIs. Think of it as a trading desk, not a bot.

### How many trading agents does ai-fund have?
45. 21 named personas (Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Warren Buffett, and more) plus role-based agents across desk functions. They share analysis libraries for indicators, risk, execution, portfolio analytics, market microstructure, and stat-arb workflows.

### What exchanges work with ai-fund?
110 exchanges via CCXT in the pinned dependency, plus dedicated connectors for Cube, Alpaca, Robinhood, Hyperliquid, and gateway orchestration.

### Is ai-fund free?
MIT-licensed, fully open source. You need Claude Pro or Team ($20/month) for the Claude Code runtime.

### Does ai-fund support multi-exchange trading?
Yes. The Arbitrageur scans for price gaps. The Execution Trader routes to the best venue. The Market Maker quotes across venues at once. It's one of the main reasons to use this.

### How is ai-fund different from virattt's ai-hedge-fund?
virattt's project does stocks with investor personas (Buffett, etc.). ai-fund is crypto, works with any exchange, has 45 agents with connector-backed tool surfaces, and fires them when they underperform. [Comparison table.](#ai-fund-vs-other-ai-trading-bots)

### Can ai-fund trade live?
Yes. Everything starts in paper/testnet. The Risk Manager reviews all trades. You have to explicitly confirm before anything goes live.

### Does ai-fund work for stocks?
If the exchange supports them. Kraken has tokenized stocks. Alpaca does US equities with full paper trading support.

### Which exchange should I start with?
Any exchange you already use. The architecture is venue-agnostic — agents work the same way regardless of connector. If you want zero-config to try things out, Cube's built-in connector needs no API keys. For maximum exchange coverage, use CCXT.

### Are my API keys safe with AI agents?
It depends on the connector. Some use local auth (no keys in files). Others require API keys in config — AI agents can read those. Use read-only keys, disable withdrawals, scope to subaccounts, and don't share session transcripts without scrubbing. Full breakdown [here](#api-key-security--why-this-matters-with-ai-agents).

### How do I add my own agent?
Drop a folder in `skills/` with a `SKILL.md` file. Template at `skills/_template/SKILL.md`.

---

## Building Your Own Agent

Create a folder in `skills/` with a `SKILL.md` file. Use `skills/_template/SKILL.md` to start.

| Section | What Goes In It |
|---------|----------------|
| Personality | Who they are, how they talk |
| Philosophy | Beliefs that drive decisions |
| Capabilities | Which tools, how used |
| Metrics | KPIs, red flags, fire triggers |
| Self-Eval | How they grade themselves |

---

## Development

**Package manager**: use `npm` workspaces only. The governed root commands assume `npm ci` and `npm run ...` from the repo root.

**CI/CD**: GitHub Actions runs `npm run build` and `npm run check` on every push and PR (`.github/workflows/test.yml`). The default PR path covers governed workspaces and hermetic suites only.

**Canonical commands**:
- `npm run build` builds the shared lib plus supported connector workspaces.
- `npm run check` runs workspace typecheck, hermetic unit tests, hermetic integration tests, and evals.
- `npm run test:unit` runs deterministic default suites.
- `npm run test:integration` runs mocked or replay-backed connector integration suites.
- `npm run test:platform` runs loopback/keychain/process-sensitive suites and is opt-in.
- `npm run test:live` runs real exchange tests and is opt-in.

**Auth**: Agents authenticate via Device Authorization (RFC 8628) — no API keys needed. See [`docs/agent-auth-brief.md`](docs/agent-auth-brief.md).

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

- [cube.exchange — built-in connector](https://cube.exchange)
- [OKX Trade Kit — 107 trading tools via MCP](https://github.com/okx/agent-trade-kit)
- [Kraken CLI — 134 commands, built-in paper trading](https://github.com/krakenfx/kraken-cli)
- [CCXT MCP — 110 exchanges via universal adapter](https://github.com/lazy-dinosaur/ccxt-mcp)
- [CCXT — universal exchange adapter (Coinbase, Binance, 110)](https://github.com/ccxt/ccxt)
- [Claude Code — AI runtime that powers the desk](https://claude.ai/code)
- [Connectors Guide — how to add any exchange](connectors/README.md)
