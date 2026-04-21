# AI Fund Codex Instructions

This repo was originally documented for Claude Code in `CLAUDE.md`. For Codex, treat `CLAUDE.md` as the detailed architecture and policy reference, and use this file for Codex-specific operating instructions.

## Runtime Setup

- Use `docs/codex.md` for the Codex quick start, MCP registration, and Cube browser login flow.
- Codex/OpenAI auth and Cube Exchange auth are separate:
  - `codex login` authenticates the Codex CLI with OpenAI.
  - `npm run login` in `connectors/cube/mcp-server/` authenticates the Cube connector with Cube via browser/device authorization.
- Keep `CUBE_ENV=staging` unless the user explicitly asks for production trading and confirms the risk.
- Do not put exchange API keys in repo files, `.mcp.json`, or prompts. Prefer Cube's local device auth.

## Command Parity

Claude slash commands live in `.claude/commands/`; Codex does not load them as native slash commands. When the user asks for the same workflows, emulate them directly:

- `/setup`: follow `docs/codex.md`; verify Codex login, Cube login, and MCP registration.
- `/hire <role>`: verify `skills/<role>/SKILL.md` exists, run `node bin/desk-state hire <role>`, then read that skill and its `.desk/briefings/<role>.md` briefing if present.
- `/fire <role>`: run `node bin/desk-state fire <role> [reason]` and preserve the exit summary in the briefing.
- `/desk`: run `node bin/desk-state show` and summarize active agents, KPIs, exchange status, and open risks.
- `/review`: review active agents against their skill KPIs, update briefings, and flag agents that should be fired.
- `/backtest`: use the backtester skill and connector backtest tools where applicable.

## Trading Safety

- Paper/staging mode is the default.
- Before any order placement, cancellation, or modification, summarize the exact action and wait for explicit user approval.
- Route proposed live trades through `skills/risk-manager/SKILL.md` first.
- Treat MCP tools as execution surfaces, not advice engines. Explain assumptions, sizing, and risk before taking action.

## Development Rules

- Follow the code conventions and validation guidance in `CLAUDE.md`.
- Do not edit `.desk/state.json` or `.desk/risk.json` by hand; use `node bin/desk-state`. Briefings may be read or updated as part of agent workflows.
- Do not add dependencies without explicit user approval.
- For code changes, run `npm run typecheck` and the relevant workspace tests when the local toolchain is healthy.
- If `tsx` fails with an `esbuild` platform mismatch, reinstall dependencies using the same Node architecture that will run Codex and the MCP server.
