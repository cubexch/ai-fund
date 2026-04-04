# AI Fund

An AI trading desk with 45 hedge fund agent personas (including 22 named personas like Arthur Hayes, Jim Simons, George Soros, Jesse Livermore, Warren Buffett, and Peter Lynch) for Claude Code. 150 MCP tools across 3 built-in connectors. 28 shared analysis libraries. Trade on any exchange — Cube, OKX, Kraken, Binance, Coinbase, and 100+ more via CCXT.

## Project Structure

```
ai-fund/
├── skills/              # 44 agent personas (SKILL.md each) + _template/
├── connectors/cube/     # Built-in Cube Exchange MCP server
│   └── mcp-server/
├── connectors/alpaca/   # Built-in Alpaca MCP server (stocks, ETFs, crypto)
│   └── mcp-server/
│       ├── src/cli/         # device-login, login, logout, status
│       ├── src/client/      # iridium (REST), osmium (WS), auth, signing, credential-store
│       ├── src/tools/       # market-data, orders, account, defi, risk
│       ├── src/resources/   # markets, portfolio
│       └── tests/           # vitest test suites
├── connectors/ccxt/     # Built-in CCXT MCP server (Coinbase, Binance, 100+ exchanges)
│   └── mcp-server/
│       ├── src/cli/         # status
│       ├── src/client/      # exchange wrapper, rate limiter, latency tracker, trade journal
│       ├── src/tools/       # market-data, orders, account, strategy, execution, datastore
│       └── tests/           # vitest test suites (190+ tests)
├── lib/                 # Shared TS: indicators, math, format
├── bin/desk-state       # CLI for .desk/ state management
├── scripts/install.js   # npx ai-fund install|list
├── .claude/commands/    # Slash commands (hire, fire, desk, review, setup, backtest)
├── docs/                # Architecture diagram, auth brief
├── examples/            # Preset desk configurations (JSON)
└── .desk/               # Runtime state (gitignored, per-user)
```

## Architecture

- **Skills** (`skills/`): Each skill is a complete hedge fund persona with personality, philosophy, KPIs, and self-evaluation. Skills are exchange-agnostic — they work with any connected exchange.
- **Connectors** (`connectors/`): Exchange MCP servers that bridge Claude to exchange APIs. Cube ships built-in. Others install via npm.
- **Shared Libs** (`lib/`): Technical indicators, financial math, formatting utilities.

## Development Workflow

- **Requirements**: Node >= 20, ES modules (`"type": "module"`)
- **TypeScript**: Strict mode, ES2022 target, Node16 module resolution
- **Build**: `npm run build` — compiles Cube, Robinhood, Alpaca, and CCXT MCP server workspaces
- **Dev**: `npm run dev` — runs Cube MCP server with watch
- **Typecheck**: `npm run typecheck` — runs `tsc --noEmit` across project
- **Test**: `cd connectors/cube/mcp-server && npm test` — vitest (auth, signing, indicators, format, REST orders, WebSocket, credential store, device auth, integration)
- **Install agents**: `npx ai-fund install` (all), `npx ai-fund install <role>` (one), `npx ai-fund list` (show available)

### CI/CD

GitHub Actions runs on every push to `main` and on every PR (`.github/workflows/test.yml`):

1. `npm ci` — install dependencies
2. `npm run typecheck` — TypeScript strict check
3. `npm test --workspace=connectors/cube/mcp-server` — vitest suite

PRs that fail CI will not be merged. Fix locally before pushing.

### Validation After Changes

After every code change, run the following before considering the work done:

1. **Typecheck**: `npm run typecheck` — must pass with zero errors
2. **Unit tests**: Run relevant test suites; fix any failures before committing
   - Cube: `cd connectors/cube/mcp-server && npm test`
   - CCXT: `cd connectors/ccxt/mcp-server && npx vitest run`
3. **Update docs**: If your change affects architecture, commands, agent categories, shared libraries, or exchange support, update `CLAUDE.md` and `README.md` to reflect the new state

### Task Completion Checklists

- **Bug fix**: Write a test reproducing the bug + fix + typecheck + full test suite green
- **New skill**: Copy `skills/_template/SKILL.md` + fill all required sections + update agent categories in `CLAUDE.md` and `README.md`
- **New connector**: MCP server + tool namespace docs + update supported exchanges table in `CLAUDE.md` and `README.md`
- **Library change** (`lib/`): Add/update unit tests + verify all importing code still works if function signatures change
- **Command change** (`.claude/commands/`): Update commands list in `CLAUDE.md` and `README.md`

## Code Conventions

- **Languages**: TypeScript and Rust only. No Python, no JavaScript-without-types, no shell scripts beyond simple CLI wrappers. New connectors must be TypeScript or Rust — no exceptions.
- **Indentation**: 2 spaces, no tabs
- **Quotes**: Single quotes in TypeScript
- **File naming**: `kebab-case.ts` for files, `kebab-case/` for directories
- **TypeScript naming**: `PascalCase` for types/interfaces/classes, `camelCase` for functions/variables/parameters
- **Imports**: ES module syntax only (`import`/`export`), no `require()`. Use `.js` extensions in import paths.
- **Commit messages**: Conventional Commits format — `feat(skills): add new persona`, `fix(cube): correct order signing`, `docs: update exchange table`. Scopes: `skills`, `cube`, `lib`, `desk`, `commands`, `docs`

## Shared Libraries (28 modules, 250+ exported functions)

- **`lib/indicators.ts`** — `sma`, `ema`, `rsi`, `macd`, `bollingerBands`, `atr`, `obv`, `stochastic`, `adx`, `vwap`, `momentum`, `hurst` + `OHLCV` interface
- **`lib/math.ts`** — `kelly`, `fixedFractionalSize`, `valueAtRisk`, `maxDrawdown`, `sharpeRatio`, `sortinoRatio`, `calmarRatio`, `correlation`, `correlationMatrix`, `mean`, `standardDeviation`, `zScore`, `returns`, `winRate`, `profitFactor`, `annualizedVolatility`, `beta`, `alpha`, `informationRatio`, `tailRisk`
- **`lib/format.ts`** — `usd`, `pct`, `qty`, `price`, `compact`, `timestamp`, `duration`, `signedValue`, `grade`, `assetIcon`, `labelAsset` + `ASSET_ICONS` map
- **`lib/execution-planner.ts`** — `planTwap`, `planVwap`, `planIceberg`, `analyzeSniper`, `estimateMarketImpact`, `realizedVolatility`, `compareExecutionPlans`, `calculateImplementationShortfall`
- **`lib/execution-analytics.ts`** — `simulateOrderBookFill`, `analyzeDepthAtBands`, `computeOrderBookImbalance`, `analyzeOrderBookShape`, `computeWeightedMid`, `analyzeTradeFlow`, `computeMomentumScore`, `computeExecutionQuality`, `recommendEntry`
- **`lib/portfolio-analytics.ts`** — `resolvePrice`, `computePortfolioExposure`, `checkPreTrade`, `simulateStressTest`, `assessPortfolioRisk`, `calculateRebalanceTrades`, `detectCorrelationClusters`, `monitorDrawdown`, `computeMarginHealth`, `computeRiskDashboard`
- **`lib/portfolio-optimizer.ts`** — `meanVariance`, `minimumVariance`, `riskParity`, `blackLitterman`, `maxDiversification`, `efficientFrontier`, `hierarchicalRiskParity`, `equalWeight`, `inverseVolatility`, `rebalanceOptimal`
- **`lib/factor-model.ts`** — Barrel re-export of the three submodules below (backward-compatible)
- **`lib/matrix.ts`** — `matTranspose`, `matMultiply`, `matVecMultiply`, `vecDot`, `vecNorm`, `vecScale`, `vecSub`, `matInverse`, `sampleCov`, `powerIteration`, `deflateMatrix`, `olsRegression`, `zScoreForConfidence`
- **`lib/factor-extraction.ts`** — `pcaFactors`, `factorExposure`, `factorAttribution`, `computeFactorReturns`, `styleAnalysis`
- **`lib/factor-risk.ts`** — `marginalVaR`, `incrementalVaR`, `componentVaR`, `riskDecomposition`, `covarianceMatrix`
- **`lib/factor-models.ts`** — `cryptoFactorModel`, `equityFactorModel`, `sectorExposure`, `crossSectionalMomentum`
- **`lib/options.ts`** — `blackScholes`, `black76`, `binomialPrice`, `impliedVol`, `putCallParity`, `volSurface`, `skewMetrics`, `greeksExposure`, `breakeven`, `maxPain`
- **`lib/monte-carlo.ts`** — `simulateGBM`, `simulateJumpDiffusion`, `monteCarloVaR`, `portfolioMonteCarloVaR`, `confidenceInterval`, `scenarioGeneration`, `drawdownDistribution`, `optionMonteCarlo`
- **`lib/stat-arb.ts`** — `engleGranger`, `adfTest`, `halfLife`, `hedgeRatio`, `spreadZScore`, `pairSignal`, `scorePairs`, `kalmanHedgeRatio`, `johansen`, `rollingSpreadStats`
- **`lib/microstructure.ts`** — `computeVpin`, `kyleLambda`, `classifyTrades`, `adverseSelection`, `amihudIlliquidity`, `realizedSpreadDecomposition`, `rollSpread`, `pinModel`, `hasbrouckInfoShare`, `tradeFlowToxicity`
- **`lib/order-flow.ts`** — `cumulativeVolumeDelta`, `footprintData`, `absorptionDetection`, `icebergDetection`, `aggressivePassiveFlow`, `volumeClockSpeed`, `orderFlowImbalanceProfile`, `deltaProfile`, `largeTradeDetection`, `tradeIntensityMap`
- **`lib/funding.ts`** — `predictFunding`, `fundingAnnualized`, `basisCurve`, `carryTrade`, `fundingArbitrage`, `fundingSentiment`, `cashAndCarry`, `fundingRateStats`, `rollYield`, `fundingHedgeCost`
- **`lib/sentiment.ts`** — `fearGreedIndex`, `fundingSentiment`, `putCallRatio`, `socialVolumeNormalized`, `contrarianSignal`, `longShortRatio`, `sentimentMomentum`, `compositeScore`, `volSurfaceSentiment`, `marketBreadth`
- **`lib/liquidation.ts`** — `estimateLiquidationLevels`, `cascadeRisk`, `leverageHeatmap`, `openInterestAnalysis`, `insuranceFundHealth`, `marginCallSimulation`, `effectiveLeverage`, `liquidationFlowPrediction`, `deleveragingIndex`, `safeMaxLeverage`
- **`lib/time-series.ts`** — `garch11`, `adfTest`, `autocorrelation`, `partialAutocorrelation`, `hurstExponent`, `halfLife`, `structuralBreak`, `ewmaVolatility`, `varianceRatio`, `regimeChangeDetection`
- **`lib/venue-analytics.ts`** — `triangularArb`, `crossVenueSpread`, `smartOrderRoute`, `venueQualityScore`, `fragmentationIndex`, `latencyCostModel`, `venueCorrelation`, `executionVenueSelection`, `makerTakerOptimization`, `crossVenueOBImbalance`
- **`lib/confluence-detector.ts`** — `detectConfluence`, `analyzeTimeframeSignals`, `detectBbSqueeze`, `scanMeanReversion`, `computeVolTermStructure`, `classifyVolRegime`
- **`lib/grid-trading.ts`** — `computeDcaSchedule`, `optimizeGridParams`, `analyzeBasisTrade`, `classifyVolRegime`
- **`lib/volume-profile.ts`** — `computeVolumeProfile`, `detectCorrelationRegime`
- **`lib/datastore.ts`** — `MarketDataStore` (DuckDB columnar store for OHLCV data with SQL queries, Parquet I/O, incremental updates)
- **`lib/analytics-store.ts`** — `AnalyticsStore` class (DuckDB-powered: rolling correlations, cross-sectional sorts, factor returns, covariance, rolling beta, risk reports, universe screening, pairwise correlations, regime stats)
- **`lib/backtester.ts`** — `Backtester` class (9 built-in strategies, walk-forward optimization)
- **`lib/regime-detector.ts`** — `RegimeDetector` class (trend/range/volatile regime classification)
- **`lib/signal-generator.ts`** — `SignalGenerator` class (multi-indicator signal scanning)
- **`lib/valuation.ts`** — 19 valuation functions (DCF, NVT, MVRV, stock-to-flow, etc.)
- **`lib/connector-registry.ts`** — Connector discovery and registration
- **`lib/ingest/exchange.ts`** — `ingestFromExchange` (generic exchange data ingester into DuckDB)

## Testing

Tests live in `connectors/*/mcp-server/tests/` using vitest.
- **Cube**: `cd connectors/cube/mcp-server && npm test`
- **CCXT**: `cd connectors/ccxt/mcp-server && npx vitest run` (1,303 tests)

### Writing Tests

- **Shared libs** (`lib/`): Import from `../../../../lib/<module>.js`. Use `describe`/`it`/`expect` from vitest. Test edge cases (empty arrays, zero values, insufficient data). See `indicators.test.ts` and `math.test.ts` for patterns.
- **Connector tools** (`src/tools/`): Mock the exchange client (iridium/osmium). Test tool handler input validation, response shaping, and error paths. See `rest-order.test.ts`.
- **Auth/signing** (`src/client/`): Test key generation, signature verification, credential persistence. See `signing.test.ts`, `credential-store.test.ts`.
- **File naming**: `<module>.test.ts` matching the source file name
- **Integration tests**: Suffix with `.integration.test.ts` — these hit real APIs and may be skipped in CI

## MCP Tool Loading

MCP tools in Claude Code are **deferred** (lazy-loaded). They won't appear in your available tool list until fetched via `ToolSearch`. This means:

- **Never conclude "0 tools" or "server not connected" by inspecting your tool list.** The tools exist but haven't been materialized yet.
- **To verify an MCP server works**: use `ToolSearch` to fetch a tool, then call it. For Cube, `get_assets` requires no auth and is a good connectivity test.
- **Auth is separate from connectivity.** The Cube MCP server registers ALL tools regardless of auth status. Public endpoints (market data) work without credentials. Auth-required tools (trading, positions) return an error at call time if not authenticated.
- **To check auth status**: run the exchange's status CLI (e.g., `npx tsx connectors/cube/mcp-server/src/cli/status.ts`).

## Cube Login

The Cube login command is `npm run login` in `connectors/cube/mcp-server/`, which runs `src/cli/device-login.ts`. The device login uses RFC 8628 device authorization — **no API keys needed**. It generates an Ed25519 keypair locally and registers it with Cube via browser approval.

When run from Claude Code (no TTY), the CLI:
- Auto-enables headless mode (prints URL instead of opening browser)
- Accepts `--reuse-keypair` or `--new-keypair` flags to skip the interactive keypair question
- Exits with code 2 if an existing keypair is found and no flag was provided — read the output, ask the user, then re-run with the chosen flag
- Prints a verification URL and code for the user to approve in their browser
- Polls until approved (up to 10 minutes)

## Multi-Exchange Design

Skills reference generic trading capabilities (place orders, get prices, check positions). When multiple exchanges are connected via MCP, tools are namespaced by exchange. Skills understand this and can:
- Route orders to the best exchange
- Scan prices across all connected venues
- Arbitrage between exchanges
- Compare execution quality across venues

### Unified Tool API

All connectors follow a standard tool naming convention (Alpaca-style, snake_case). See `connectors/README.md` for the full spec.

**Core tools every connector provides:** `place_order`, `cancel_order`, `get_positions`, `get_account`, `get_tickers`, `get_bars`, `get_orders`, `get_fills`, `close_position`

**Advanced tools (Cube reference implementation):** `get_quote`, `execute_trade`, `compare_venues`, `search_assets`, `get_trending`, `get_portfolio`, `get_fees`, `get_technical_analysis`, `calculate_position_size`

**CCXT advanced tools (market-maker/arbitrage grade):**
- *Strategy*: `get_technical_analysis`, `calculate_position_size`, `get_fees`, `get_exchange_info`, `get_market_info`, `assess_portfolio_risk`, `get_optimal_entry`
- *Execution*: `get_execution_quality`, `get_spread_monitor`, `get_order_flow_imbalance`, `detect_arbitrage_opportunity`, `get_latency_stats`, `get_market_microstructure`, `get_momentum_scanner`
- *Datastore (DuckDB)*: `ingest_history`, `query_market_data`, `get_cached_symbols`, `analyze_cross_symbol`, `get_volume_profile`, `get_vwap`, `get_trade_journal`, `get_pnl_report`
- *Algorithms*: `plan_twap`, `plan_vwap`, `plan_iceberg`, `analyze_sniper`, `compare_execution_plans`, `simulate_market_impact`, `plan_smart_route`, `calculate_implementation_shortfall`
- *Risk*: `set_risk_limits`, `get_portfolio_exposure`, `check_position_limits`, `calculate_var`, `get_drawdown_monitor`, `check_correlation_risk`, `simulate_stress_test`, `check_pre_trade`, `get_risk_dashboard`, `get_margin_health`
- *Backtesting*: `backtest_strategy`, `compare_strategies`, `optimize_strategy`, `walk_forward_test` (9 built-in strategies: SMA crossover, RSI mean reversion, MACD momentum, Bollinger breakout/mean-reversion, EMA trend, stochastic, ADX, multi-indicator confluence)
- *Regime Detection*: `detect_market_regime`, `scan_regime_changes`, `get_regime_history`, `match_strategy_to_regime`
- *Signal Scanner*: `scan_signals`, `scan_market`, `find_support_resistance`, `detect_patterns`, `get_signal_dashboard`, `scan_divergences`, `get_multi_timeframe_signals`, `scan_breakouts`

### Tool Namespacing

With multiple MCP servers connected, tools are namespaced by exchange:
- Cube tools: `place_order`, `get_tickers`, `get_account`, etc.
- OKX tools: `spot_place_order`, `market_get_ticker`, etc.
- Kraken tools: via `kraken` CLI commands
- Alpaca tools: `place_order`, `get_positions`, `get_bars`, `get_tickers`, `search_assets`, etc.

When only one exchange is connected, tools are used directly. When multiple are connected, specify the exchange context.

## Key Concepts

- **Hire/Fire**: Traders `/hire <role>` to activate an agent and `/fire <role>` to deactivate underperformers.
- **Evaluation Loop**: Every agent has measurable KPIs and a self-review mechanism. `/review` runs a desk-wide performance evaluation.
- **Risk Manager as Gatekeeper**: All trading agents should consult the Risk Manager before executing trades.
- **Paper Mode**: Default to paper/staging mode on all exchanges. Only switch to production after explicit confirmation.

## Agent Categories (45 Total)

- **Named Personas (22)**: ansem, arthur-hayes, cathie-wood-crypto, cobie, cz, ed-thorp, gcr, george-soros, gwyneth-chen, hsaka, jesse-livermore, jim-simons, michael-saylor, paul-tudor-jones, peter-lynch, plan-b, raoul-pal, ray-dalio, stanley-druckenmiller, tetranode, warren-buffett, willy-woo
- **Trading (6)**: scalper, momentum-trader, mean-reversion-trader, swing-trader, arbitrageur, grid-trader
- **Execution (3)**: execution-trader, market-maker, dca-strategist
- **Research (5)**: quant-analyst, orderflow-analyst, volatility-analyst, sentiment-analyst, onchain-analyst
- **Risk & Portfolio (4)**: risk-manager, equity-risk-manager, portfolio-manager, performance-analyst
- **Specialists (4)**: funding-rate-farmer, liquidation-hunter, pairs-trader, breakout-specialist
- **Infrastructure (1)**: backtester

## Skill File Structure

Each `skills/<role>/SKILL.md` has YAML frontmatter + markdown sections:

```yaml
---
name: agent-name
description: >
  One-line description with trigger phrases for Claude Code skill matching.
commands:
  - command-1        # brief description
  - self-review      # evaluate own performance
---
```

**Required sections**: Personality, Philosophy, Capabilities, How You Use Exchange APIs, Strategy / Framework, Safety Rules, When Other Agents Consult You, Performance Metrics (How I'm Measured, Self-Evaluation, When to Fire Me). See `skills/_template/SKILL.md` for the full template.

## Supported Exchanges

| Exchange | Connector | Notes |
|----------|-----------|-------|
| Cube | Built-in (`connectors/cube/`) | Recommended — 200us matching, lowest fees |
| Alpaca | Built-in (`connectors/alpaca/`) | Stocks, ETFs, crypto — paper trading built-in |
| CCXT (Coinbase, Binance, 100+) | Built-in (`connectors/ccxt/`) | Universal adapter — any CCXT exchange, sandbox support |
| OKX | `@okx_ai/okx-trade-mcp` | 107 tools, spot/futures/options |
| Kraken | `kraken-cli` | Rust binary, built-in paper trading |
| Robinhood | Built-in (`connectors/robinhood/`) | Roadmap — crypto only (official API) |

## Desk State (`.desk/`)

Agent state, briefing books, and trade history persist between sessions in the `.desk/` directory (gitignored — per-user, per-account state).

```
.desk/
├── state.json          # Hired agents, exchange status, last session
├── orders.json         # Trade log (proposed, submitted, filled, rejected)
├── risk.json           # Risk parameters set by Risk Manager
└── briefings/          # Compacted conversation history per agent
    ├── cz.md
    ├── jesse-livermore.md
    └── ...
```

### State CLI (`bin/desk-state`)

- `desk-state hire <slug>` — creates state entry + briefing file, returns JSON
- `desk-state fire <slug> [reason]` — marks agent inactive, warns if risk-manager fired with active traders
- `desk-state update <slug> <key> <value>` — updates agent metadata
- `desk-state show` — dumps full desk state as JSON
- `desk-state health` — generates health report as JSON
- `desk-state health md` — generates health report as markdown

### Briefing Books (`.desk/briefings/<agent>.md`)

Each agent's briefing book is a **compacted summary** — not a full transcript. It contains:
- Agent status and hire date
- Key analyses with scores, prices, and dates
- Active recommendations and trade proposals with status
- Open questions and unresolved items
- Exit summary (if fired)

On `/hire`, the agent reads its briefing book and acknowledges prior context. On `/fire`, the briefing is updated with a final exit summary. After any significant analysis or trade, the briefing should be updated.

## Commands

Defined in `.claude/commands/` as markdown files:

- `/setup` — Configure exchanges and API keys
- `/desk` — Show active agents with KPI dashboard (loads `.desk/state.json`)
- `/hire <role>` — Activate a trading agent (reads/writes `.desk/`)
- `/fire <role>` — Deactivate an underperforming agent (updates `.desk/`)
- `/review` — Run desk-wide performance evaluation
- `/health-report` — Generate desk health report with PnL, drawdown, violations
- `/backtest` — Test a strategy on historical data

## Safety Rules

- **Paper mode by default.** All exchanges start in paper/staging/testnet. Only switch to production after explicit user confirmation.
- **Write operations require confirmation.** Before placing, canceling, or modifying orders, summarize the action and get user consent.
- **Risk Manager as gatekeeper.** Trading agents should consult the Risk Manager before executing trades. Firing risk-manager while trading agents are active triggers a warning.
- **API key security.** Never log, display, or store API keys in plaintext outside the credential store. Use read-only keys on subaccounts where possible. See `docs/agent-auth-brief.md` for the device authorization flow (RFC 8628) — agents register Ed25519 signing keys without ever handling API keys directly.

## Dependency Policy

**All new dependencies and dependency updates require explicit developer approval before being added.** This applies to both `dependencies` and `devDependencies` in any `package.json` across the monorepo. Do not run `npm install <package>` or add entries to `package.json` without the developer confirming the specific package name and version. This policy exists to minimize supply chain attack surface.

## Do Not

- Use `eval()`, `exec()`, `Function()`, or `pickle` on untrusted input
- Add exchange-specific API calls inside skill files — skills must stay exchange-agnostic
- Modify `.desk/` state files directly — always use `bin/desk-state` CLI
- Commit `.desk/` contents, `.env` files, API keys, or credentials
- Use `require()` — ESM imports only
- Change SKILL.md frontmatter schema without updating `skills/_template/SKILL.md`
- Add or update dependencies without explicit developer approval (see Dependency Policy)
- Skip typecheck or tests before committing — CI will catch it, but don't waste the round-trip

## Architecture Flow

```
User command (/hire, /desk, /review, ...)
  → .claude/commands/<command>.md (skill definition)
    → Skill loaded from skills/<role>/SKILL.md
      → Reads .desk/ state via bin/desk-state
        → Calls exchange tools via MCP connectors
          → Results persisted to .desk/ (briefings, orders, risk)
```

**Connector layer**: MCP protocol → tool handlers (`src/tools/`) → exchange API clients (`src/client/`)

**Public API boundaries**:
- `lib/` exports are public and stable — used by skills and connectors
- `connectors/cube/mcp-server/src/client/` is internal to the Cube connector
- Skill SKILL.md files are the interface for agent behavior

## When Writing Skills

Each SKILL.md must:
1. Be **exchange-agnostic** — reference generic capabilities, not specific exchange APIs
2. Include **Personality** — Who this agent is, how they think
3. Include **Philosophy** — Their trading beliefs and principles
4. Include **Capabilities** — What they can do, mapped to generic trading tools
5. Include **Multi-Exchange Awareness** — How they work across venues (where applicable)
6. Include **Performance Metrics** — Primary KPIs, red flags, fire triggers
7. Include **Self-Evaluation** — How they report on their own performance

Use `skills/_template/SKILL.md` as the starting point for new agents.
