# AI Maintainer Path

This repo now includes an **AI intelligence map pipeline** so agents can reason over architecture with both human-readable and machine-readable outputs.

## 1) Quickstart (modern AI workflow)

```bash
# 1) Generate architecture intelligence (console)
npm run repo:map

# 2) Generate machine-readable + prompt-ready context pack
npm run repo:map:json

# 3) Load .ai/context-pack.md into your coding agent before making edits
```

Artifacts produced:
- `.ai/repo-map.json` (structured metrics: risk, fan-in/fan-out, cycles, buckets)
- `.ai/context-pack.md` (LLM-ready summary)

## 2) What "latest" techniques are used

The analyzer combines several maintainability signals (not just file size):

- **Risk scoring** per file from weighted factors:
  - LOC percentile (size pressure)
  - Fan-in percentile (blast radius)
  - Fan-out percentile (change complexity)
- **Local dependency graph** extraction from TypeScript import/export statements.
- **Cycle detection** via strongly connected components.
- **Machine-readable output** for AI orchestration pipelines.
- **Context-pack generation** for direct copy/paste into LLM prompts.

## 3) How to decide where to change

1. Start with files **outside** top risk set when possible.
2. If a high-risk file must change, use extraction-first refactors.
3. Keep one connector/lib subsystem per PR.
4. Add tests adjacent to touched behavior.

## 4) Repo mental model

- `skills/`: agent behavior/personas (`SKILL.md` contracts).
- `lib/`: shared quant + analytics primitives.
- `connectors/*/mcp-server/src/client`: exchange API/auth wrappers.
- `connectors/*/mcp-server/src/tools`: MCP tool surfaces.
- `connectors/*/mcp-server/src/cli`: operator-facing CLI behavior.

Rule of thumb:
- Exchange-agnostic logic -> `lib/`
- Venue-specific logic -> connector `client/`
- User-facing capability -> connector `tools/` + tests

## 5) AI-safe PR checklist

- [ ] `npm run repo:map:json` executed before editing.
- [ ] Change scope is single subsystem.
- [ ] No unnecessary growth in top-risk files.
- [ ] Tests added/updated near changed behavior.
- [ ] `npm run repo:map` still reports understandable boundaries.

## 6) Strategic backlog (high value)

1. Split `connectors/cube/mcp-server/src/cli/cube.ts` by command groups and renderers.
2. Break `lib/factor-model.ts` + `lib/backtester.ts` into composable submodules.
3. Add per-connector `ARCHITECTURE.md` with extension points and invariants.
4. Add CI job that uploads `.ai/repo-map.json` as build artifact for every PR.
