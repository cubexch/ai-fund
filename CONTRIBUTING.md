# Contributing to AI Crypto Fund

We welcome contributions! Whether it's a new agent skill, an exchange connector, or a bug fix.

## Adding a New Agent

1. Copy `skills/_template/SKILL.md` to `skills/your-agent-name/SKILL.md`
2. Follow the template structure — every agent needs personality, philosophy, capabilities, KPIs, and fire triggers
3. Keep skills exchange-agnostic — reference generic tools, not specific exchange APIs
4. Test your agent with at least one connected exchange
5. Open a PR

## Adding an Exchange Connector

See `connectors/README.md` for the interface your connector should implement. At minimum:
- `place_order`, `cancel_order`, `get_positions`, `get_balances`, `get_tickers`

## Code Style

- TypeScript for all server code
- ESM modules (`"type": "module"`)
- Markdown for skills (SKILL.md files)

## Questions?

Open an issue or start a discussion.
