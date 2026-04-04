# Contributing to AI Fund

We welcome contributions! Whether it's a new agent skill, an exchange connector, a shared library, or a bug fix.

## Quick Start for Contributors

```bash
git clone https://github.com/cubexch/ai-fund.git
cd ai-fund
npm install
npm run typecheck        # must pass with zero errors
npm test --workspace=connectors/cube/mcp-server   # 418+ tests
```

## What We Need

Check the [Roadmap](ROADMAP.md) for planned work, or pick from these areas:

- **New agent skills** — especially specialists (options, DeFi, cross-chain)
- **Exchange connectors** — any CCXT-supported exchange can get a native connector
- **Shared library improvements** — new indicators, math functions, analytics
- **Test coverage** — see `docs/connector-scorecards.md` for gaps
- **Documentation** — explainers, case studies, tutorials

## Adding a New Agent

1. Copy `skills/_template/SKILL.md` to `skills/your-agent-name/SKILL.md`
2. Follow the template — every agent needs: Personality, Philosophy, Capabilities, Performance Metrics, Self-Evaluation, Fire Triggers
3. Keep skills **exchange-agnostic** — reference generic tools, not specific exchange APIs
4. Add the agent to the category list in both `CLAUDE.md` and `README.md`
5. Test with at least one connected exchange (paper mode)
6. Open a PR

## Adding an Exchange Connector

See `connectors/README.md` for the full interface spec. Minimum tools:

- `place_order`, `cancel_order`, `get_positions`, `get_account`, `get_tickers`, `get_bars`, `get_orders`, `get_fills`, `close_position`

Requirements:
- TypeScript or Rust only (see Dependency Policy below)
- MCP server using `@modelcontextprotocol/sdk`
- Paper/sandbox mode by default
- Cross-platform credential storage (see Cube's `credential-store.ts` for the pattern)
- Add `ARCHITECTURE.md` to your connector directory

## Adding to Shared Libraries (`lib/`)

1. Write pure functions — no async, no exchange clients, no MCP
2. Add unit tests in the relevant connector's `tests/` directory
3. Export from `lib/package.json`
4. Update `CLAUDE.md` shared library docs if adding new modules

## Code Style

- **Language**: TypeScript only (Rust for performance-critical connectors)
- **Modules**: ESM (`import`/`export`), `.js` extensions in import paths
- **Indentation**: 2 spaces, no tabs
- **Quotes**: Single quotes
- **Naming**: `kebab-case.ts` files, `PascalCase` types, `camelCase` functions
- **Commits**: Conventional Commits — `feat(scope):`, `fix(scope):`, `docs:`, `refactor(scope):`, `test(scope):`
- **Scopes**: `skills`, `cube`, `ccxt`, `alpaca`, `robinhood`, `lib`, `desk`, `commands`, `docs`

## Before Submitting a PR

1. `npm run typecheck` — must pass with zero errors across all workspaces
2. Run relevant test suites — no regressions
3. Update `CLAUDE.md` and `README.md` if your change affects architecture, commands, agents, or libraries
4. Keep PRs focused — one feature or fix per PR

## Dependency Policy

**All new dependencies require explicit maintainer approval.** Do not add packages to any `package.json` without approval. This minimizes supply chain risk.

## Questions?

Open an issue at [github.com/cubexch/ai-fund/issues](https://github.com/cubexch/ai-fund/issues).
