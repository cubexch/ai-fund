# Roadmap

Public roadmap for AI Fund. Items are grouped by confidence level and timeframe. Contributions welcome on any item — see [CONTRIBUTING.md](CONTRIBUTING.md).

> **Last updated**: April 2026

## Now (Active / In Progress)

High confidence — actively being worked on.

### Shared Libraries
- [ ] Split `analytics-store.ts` (~980 lines) into focused submodules (rolling stats, screening, risk reports)
- [ ] Split `cube.ts` CLI (~1,200 lines) into product-group routers
- [ ] Expand test coverage for `lib/` edge cases (empty arrays, degenerate inputs)

### Connectors
- [ ] Robinhood crypto connector — implement tools against official crypto API
- [ ] Alpaca analysis tool coverage — add execution algorithm and risk tool tests
- [ ] CCXT sandbox mode validation across top 10 exchanges

### Developer Experience
- [ ] Connector reliability scorecards — automated scoring from test results
- [ ] Packaged use-case recipes: arb scanner, market-making starter, macro desk
- [ ] Confidence rails — preflight output explaining why trades are blocked/approved

## Next (1-3 Months)

Medium confidence — scoped and ready for contributors.

### New Connectors
- [ ] Hyperliquid — on-chain perps via EIP-712 signing (research complete)
- [ ] dYdX v4 — Cosmos-based perpetuals
- [ ] Jupiter/Solana DEX aggregator

### Shared Libraries
- [ ] Options pricing: exotic payoffs (barriers, digitals, Asian)
- [ ] Cross-exchange order book aggregation in `venue-analytics.ts`
- [ ] Streaming indicator engine — incremental updates without full recompute
- [ ] DuckDB query builder for `analytics-store.ts` (type-safe, composable)

### Agent Skills
- [ ] Options specialist agent — vol surface trading, spread construction
- [ ] DeFi yield farming agent — cross-chain yield optimization
- [ ] Cross-exchange arbitrage agent — latency-aware venue routing
- [ ] News/event-driven agent — earnings, token unlocks, governance votes

### Execution
- [ ] Gateway orchestration layer — route orders across connectors with failover
- [ ] Smart order router — split orders across venues by cost model
- [ ] Live execution analytics — real-time slippage and fill quality tracking

### Testing & Quality
- [ ] Integration test harness — replay recorded HTTP against all connectors
- [ ] Property-based testing for math/indicator libraries
- [ ] Mutation testing to validate test suite effectiveness

## Later (3-6 Months)

Lower confidence — directional, subject to change.

### Platform
- [ ] Team mode — shared desk state, role-based access, audit trail
- [ ] Plugin system — third-party skill and connector loading
- [ ] Analytics export — Parquet/CSV/webhook pipelines for external tools
- [ ] Web dashboard — read-only desk view with charts and PnL

### Research
- [ ] Reinforcement learning agent — adaptive strategy selection
- [ ] On-chain analytics integration — wallet tracking, MEV detection
- [ ] Alternative data feeds — social sentiment, satellite imagery, on-chain flows
- [ ] Multi-agent coordination — agents that delegate to and supervise other agents

### Connectors
- [ ] Interactive Brokers — stocks, options, futures, forex
- [ ] Bybit — derivatives-focused exchange
- [ ] FTX successor exchanges as they emerge

## Completed

Recent completions — moved here as items ship.

- [x] Factor model decomposition — split into matrix, extraction, risk, models submodules
- [x] Backtester strategy extraction — 9 strategies into `backtest-strategies.ts`
- [x] Cube execution tools — VWAP, Iceberg, Sniper, Compare plans
- [x] Alpaca analysis test expansion — 2 to 19 tests
- [x] Connector scorecards — 6-dimension rubric across all connectors
- [x] Case studies — weekend macro, cross-exchange arb, vol regime adaptation
- [x] `/first-trade` onboarding command — guided 5-minute paper trade flow
- [x] Robinhood scoped to crypto-only with ARCHITECTURE.md
- [x] Comprehensive contributor guide (CONTRIBUTING.md)

## How to Contribute

Pick any unchecked item above and open an issue or PR. For larger items (new connectors, new agents), open an issue first to discuss approach. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and guidelines.

Quick wins for first-time contributors:
- Add tests for any `lib/` module (see scorecards for gaps)
- Write a new agent skill from the template
- Improve error messages in existing connector tools
- Add missing JSDoc to exported library functions
