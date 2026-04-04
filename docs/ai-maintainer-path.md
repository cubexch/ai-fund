# AI Maintainer Path

This guide gives AI agents a **fast path** through the repo so changes are safer and more local.

## 1) Start Here (10-minute orientation)

1. Read `README.md` for product shape and high-level architecture.
2. Read `connectors/README.md` to understand exchange boundaries.
3. Run `npm run repo:map` to generate a current complexity map.
4. Pick the narrowest workspace (`lib` vs specific connector) before editing.

## 2) Mental Model: Layered Architecture

- `skills/`: agent personas and behavior contracts (`SKILL.md` files).
- `lib/`: shared quant/math/analytics primitives used by multiple connectors.
- `connectors/*/mcp-server/src/client`: exchange-specific API/auth wrappers.
- `connectors/*/mcp-server/src/tools`: MCP tool surface and user-facing operations.
- `connectors/*/mcp-server/src/cli`: local operational CLI wrappers.

Rule of thumb:
- If logic is exchange-agnostic, prefer `lib/`.
- If logic depends on one venue API, keep it in that connector's `client/`.
- If adding a user capability, wire it in `tools/` with a targeted test.

## 3) Current Complexity Hotspots

These files are largest and should be treated as refactor candidates before adding major new behavior:

- `connectors/cube/mcp-server/src/cli/cube.ts`
- `lib/factor-model.ts`
- `lib/backtester.ts`
- `lib/analytics-store.ts`
- `lib/venue-analytics.ts`
- `lib/portfolio-optimizer.ts`
- `lib/signal-generator.ts`
- `connectors/cube/mcp-server/src/client/iridium.ts`
- `connectors/ccxt/mcp-server/src/client/exchange.ts`

Use `npm run repo:map` to refresh this list.

## 4) Change Strategy for AI Agents

### A. Additive-first edits

Prefer adding a new module + narrow integration point over expanding a hotspot file.

Example pattern:
1. Add pure helper in `lib/` or connector-local helper module.
2. Add/adjust tool handler to call helper.
3. Add unit test for helper and tool behavior.

### B. Keep PR scope under control

- 1 behavior change per PR.
- 1 connector at a time unless change is explicitly cross-cutting.
- Avoid mixing formatting-only and behavior changes.

### C. Refactor trigger

If touched file is >600 LOC and change is non-trivial:
- extract parsing/validation, formatting, and API calls into separate modules first,
- then add behavior.

## 5) Fast Navigation Commands

```bash
# Generate structural overview
npm run repo:map

# Locate tool registrations
rg "register.*Tools" connectors/*/mcp-server/src

# Locate MCP entrypoints
rg "new Server|setRequestHandler|tool\(" connectors/*/mcp-server/src

# Check biggest implementation files (ignoring tests/node_modules)
python scripts/repo-map.js --top 20 --min-lines 200
```

## 6) Definition of Done (AI-focused)

A change is "easy to maintain" when:

- Behavior lives in the smallest sensible module.
- Existing hotspot size does not grow unnecessarily.
- There is at least one automated test near changed behavior.
- `npm run repo:map` output still shows understandable boundaries.

## 7) Suggested Refactor Backlog

1. Split `connectors/cube/mcp-server/src/cli/cube.ts` into command-group modules (`account`, `market`, `order`, `risk`, `trade`) + shared renderer utils.
2. Extract model/stat helpers from `lib/factor-model.ts` and `lib/backtester.ts` into focused submodules.
3. Create a shared "tool registration composition" helper to reduce duplication across connectors.
4. Introduce per-connector `ARCHITECTURE.md` docs with ownership + extension points.
