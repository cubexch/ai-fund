---
title: AI Trading Agents
description: >
  42 AI trading agents with distinct hedge fund personas, trading philosophies, and
  measurable KPIs. 20 named personas including Arthur Hayes, Jim Simons, George Soros,
  and Jesse Livermore. Hire and fire agents based on performance.
keywords: AI trading agents, trading personas, hedge fund agents, hire fire agents, agent KPIs, trading bot personas, autonomous trading agents, multi-agent trading system
---

# AI Trading Agents

AI Fund ships with 42 autonomous trading agents. Each agent has its own personality, trading philosophy, strategy framework, and KPI targets. You hire agents that match your market thesis and fire the ones that underperform.

## How the Agent System Works

Every agent is defined by a single `SKILL.md` file in the [`skills/`](../skills/) directory. This file contains everything Claude Code needs to embody that agent:

| Section | What It Contains |
|---|---|
| **Personality** | Who the agent is, how they think and communicate |
| **Philosophy** | Core beliefs that drive trading decisions |
| **Capabilities** | What the agent can do, mapped to exchange tools |
| **Strategy** | Decision frameworks, formulas, entry/exit logic |
| **Performance Metrics** | Primary KPIs, red flags, fire triggers |
| **Self-Evaluation** | How the agent grades its own performance |

Agents are exchange-agnostic. They reference generic trading capabilities (place orders, get prices, check positions) that work with any connected exchange. See [Exchange Connectors](connectors.md) for how this works across venues.

## The Hire/Fire Model

Hiring and firing is the core management workflow. It replaces configuration files and dashboards with natural language commands.

### Hiring an Agent

```
> /hire arthur-hayes
```

When you hire an agent:
1. Claude Code loads the agent's `SKILL.md` and adopts its persona
2. The agent reads its briefing book from `.desk/briefings/` (if one exists from a prior session)
3. The agent acknowledges prior context and is ready to work
4. Agent state is recorded in `.desk/state.json`

### Firing an Agent

```
> /fire momentum-trader
```

When you fire an agent:
1. The agent's briefing book is updated with a final exit summary
2. The agent is removed from the active desk
3. State is updated in `.desk/state.json`

### Performance Review

```
> /review
```

The `/review` command runs a desk-wide evaluation. Every active agent reports its KPIs, grades itself, and the desk generates fire recommendations for agents below target.

## The 20 Named Personas

These agents are modeled after real traders and investors. Their philosophies are not cosmetic — they change how the agent reads markets, sizes positions, and manages risk.

| Persona | Philosophy | Trading Style |
|---|---|---|
| [Arthur Hayes](../skills/arthur-hayes/) | Macro-to-crypto, DXY, real yields, liquidity cycles | Leveraged macro conviction |
| [George Soros](../skills/george-soros/) | Reflexivity theory, boom-bust cycles | Thesis-driven, concentrated |
| [Stanley Druckenmiller](../skills/stanley-druckenmiller/) | Go for the jugular on high conviction | High-conviction sizing |
| [Paul Tudor Jones](../skills/paul-tudor-jones/) | Risk management IS the strategy, 5:1 R:R | Trend following, risk-first |
| [Ray Dalio](../skills/ray-dalio/) | All-weather portfolio, risk parity | Balanced allocation |
| [Jim Simons](../skills/jim-simons/) | Pure quant, statistical edge, zero emotion | Systematic stat arb |
| [Ed Thorp](../skills/ed-thorp/) | Kelly criterion, mathematical edge | Optimal bet sizing |
| [Jesse Livermore](../skills/jesse-livermore/) | Tape reading, pyramiding, patience | Classic speculation |
| [Michael Saylor](../skills/michael-saylor/) | Bitcoin is digital property, never sell | BTC accumulation |
| [Cathie Wood](../skills/cathie-wood-crypto/) | Disruptive innovation, Wright's law | High-conviction innovation |
| [Raoul Pal](../skills/raoul-pal/) | Exponential age, network value, 4-year cycles | Cycle-based portfolio |
| [PlanB](../skills/plan-b/) | Stock-to-Flow, halving cycles | Model-based BTC valuation |
| [Willy Woo](../skills/willy-woo/) | On-chain analytics, NVT, holder behavior | On-chain signals |
| [CZ](../skills/cz/) | Build in the bear, ecosystem investing | Value investing |
| [GCR](../skills/gcr/) | Contrarian, fade the crowd | Contrarian conviction |
| [Cobie](../skills/cobie/) | Narrative trading, early to the meta | Narrative lifecycle |
| [Ansem](../skills/ansem/) | Early discovery, momentum alpha | Micro-cap momentum |
| [Hsaka](../skills/hsaka/) | Chart structure, S/R levels, A+ setups only | Technical swing trading |
| [Tetranode](../skills/tetranode/) | DeFi yield, real yield vs emissions | Yield optimization |
| [Gwyneth Chen](../skills/gwyneth-chen/) | Professional market making, Avellaneda-Stoikov | Institutional MM |

## The 22 Role-Based Agents

These agents are defined by function, not celebrity. They handle specific trading strategies, execution, research, risk, and infrastructure tasks.

### Active Traders
| Agent | Role | Multi-Exchange Use |
|---|---|---|
| [Scalper](../skills/scalper/) | Sub-second, order book trading | Routes to lowest-latency venue |
| [Momentum Trader](../skills/momentum-trader/) | Breakouts, trend riding | Cross-venue scans |
| [Mean Reversion Trader](../skills/mean-reversion-trader/) | Fades extremes | Cross-venue deviation |
| [Swing Trader](../skills/swing-trader/) | Multi-day S/R holds | Best fill routing |
| [Arbitrageur](../skills/arbitrageur/) | Buy low on one exchange, sell high on another | Core cross-exchange |
| [Grid Trader](../skills/grid-trader/) | Systematic level-based entries | Grid per venue |

### Execution and Market Making
| Agent | Role | Multi-Exchange Use |
|---|---|---|
| [Execution Trader](../skills/execution-trader/) | TWAP, VWAP, Iceberg | Smart order routing |
| [Market Maker](../skills/market-maker/) | Two-sided quotes, spread capture | Multi-venue quoting |
| [DCA Strategist](../skills/dca-strategist/) | Scheduled recurring buys | Routes to cheapest venue |

### Research and Analysis
| Agent | Role |
|---|---|
| [Quant Analyst](../skills/quant-analyst/) | RSI, MACD, backtests, statistical signals |
| [Order Flow Analyst](../skills/orderflow-analyst/) | Tape reading, whale detection |
| [Volatility Analyst](../skills/volatility-analyst/) | Vol regime detection, IV/RV analysis |
| [Sentiment Analyst](../skills/sentiment-analyst/) | Funding rates, open interest, fear/greed |
| [On-Chain Analyst](../skills/onchain-analyst/) | Wallet tracking, exchange flows |

### Risk and Portfolio
| Agent | Role |
|---|---|
| [Risk Manager](../skills/risk-manager/) | VaR, Kelly criterion, drawdown caps |
| [Portfolio Manager](../skills/portfolio-manager/) | Allocation, rebalancing, risk parity |
| [Performance Analyst](../skills/performance-analyst/) | Post-trade analysis, attribution |

### Specialists
| Agent | Role |
|---|---|
| [Funding Rate Farmer](../skills/funding-rate-farmer/) | Delta-neutral yield from funding rates |
| [Liquidation Hunter](../skills/liquidation-hunter/) | Margin monitoring, liquidation cascade detection |
| [Pairs Trader](../skills/pairs-trader/) | Long/short correlated asset pairs |
| [Breakout Specialist](../skills/breakout-specialist/) | Range breaks with volume confirmation |

### Infrastructure
| Agent | Role |
|---|---|
| [Backtester](../skills/backtester/) | Historical simulation, walk-forward, Monte Carlo |

## Desk Configurations

Pre-built combinations for common strategies:

| Desk | Agents |
|---|---|
| **Conservative** | risk-manager, dca-strategist, performance-analyst |
| **Arbitrage** | risk-manager, arbitrageur, execution-trader, quant-analyst |
| **Market Making** | risk-manager, market-maker, orderflow-analyst, volatility-analyst |
| **Macro** | arthur-hayes, raoul-pal, risk-manager, execution-trader |
| **BTC Maxi** | michael-saylor, plan-b, willy-woo, risk-manager |
| **Full Desk** | risk-manager, portfolio-manager, arbitrageur, market-maker, arthur-hayes, jim-simons |

## Briefing Books

Each agent maintains a briefing book at `.desk/briefings/<agent>.md`. This is a compacted summary (not a full transcript) that persists between sessions and contains:

- Agent status and hire date
- Key analyses with scores, prices, and dates
- Active recommendations and trade proposals
- Open questions and unresolved items
- Exit summary (if previously fired)

## See Also

- [What Is AI Fund?](what-is-ai-fund.md) — Project overview and quick start
- [Build an Agent](build-an-agent.md) — Create your own custom trading agent
- [Paper Trading and Safety](paper-trading-safety.md) — How the Risk Manager protects the desk
- [How to Backtest](how-to-backtest.md) — Validate strategies before going live
- [README: Full Roster](../README.md#42-ai-trading-agents--the-full-roster) — Complete agent table with descriptions
- [Skills Template](../skills/_template/SKILL.md) — The SKILL.md format every agent follows
