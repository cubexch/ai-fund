# Running AI Fund With Codex

This guide maps the Claude-oriented setup onto Codex. There are three separate pieces of auth:

- **Codex OAuth**: signs the Codex CLI into OpenAI.
- **Codex MCP registration**: tells Codex how to start the local AI Fund MCP server.
- **Cube agent auth**: signs the Cube connector into Cube Exchange with a browser/device flow and stores a local Ed25519 key.

Cube agent auth does not require API keys.

## 1. Sign Codex In

```bash
codex login
codex login status
```

If the browser flow is awkward on the machine running Codex, use device auth:

```bash
codex login --device-auth
```

## 2. Install The Repo

```bash
git clone https://github.com/cubexch/ai-fund
cd ai-fund
npm ci
```

Use Node 20 or newer. If `tsx` reports an `esbuild` platform mismatch, remove `node_modules` and rerun `npm ci` with the same Node architecture you use to run Codex.

## 3. Log Into Cube

Start in staging/paper mode:

```bash
cd connectors/cube/mcp-server
CUBE_ENV=staging npm run login
CUBE_ENV=staging npm run status
```

The login command opens a browser approval flow, generates a local Ed25519 keypair, and stores credentials in the OS keychain or `~/.cube/credentials.json`.

For headless sessions:

```bash
CUBE_ENV=staging npm run login -- --headless
```

If a keypair already exists and the CLI asks what to do, rerun with one of:

```bash
CUBE_ENV=staging npm run login -- --reuse-keypair
CUBE_ENV=staging npm run login -- --new-keypair
```

## 4. Use The Repo-Local Cube MCP Server

AI Fund keeps the Cube MCP registration local to this repo. Start from the committed template:

```bash
cp .codex/config.example.toml .codex/config.toml
```

`.codex/config.toml` is ignored by Git because it is local machine configuration. Do not add `ai-fund-cube` to `~/.codex/config.toml`. Global registration makes Codex start this trading MCP server from unrelated repos. Keep only the project trust entry in your global config:

```toml
[projects."/absolute/path/to/ai-fund"]
trust_level = "trusted"
```

Start Codex from the repo root so it loads your local `.codex/config.toml`:

```bash
cd ai-fund
codex
```

Verify Codex can see the repo-scoped server:

```bash
codex mcp list
codex mcp get ai-fund-cube
```

If `ai-fund-cube` appears in `codex mcp list` while you are outside this repo, remove the global entry:

```bash
codex mcp remove ai-fund-cube
```

Restart Codex after changing config. Then ask Codex to call a public Cube tool such as `get_assets` before testing authenticated account or trading tools.

## 5. Working With Agents In Codex

Codex reads `AGENTS.md`, not `.claude/commands/`. To activate an AI Fund persona, ask Codex directly, for example:

```text
Hire risk-manager and arthur-hayes for this session.
```

Codex should:

1. Run `bin/desk-state hire <role>`.
2. Read `skills/<role>/SKILL.md`.
3. Read `.desk/briefings/<role>.md` if it exists.
4. Use MCP market/account tools only after setup is verified.

The Claude examples still translate naturally:

```text
Ask arthur-hayes for the current macro thesis.
Ask risk-manager to size a BTC position against the current portfolio.
Scan Cube staging markets for BTC liquidity and spreads.
```

## Safety Defaults

- Keep `CUBE_ENV=staging` for paper trading.
- Only switch to `CUBE_ENV=production` after explicit user confirmation.
- Require user confirmation before placing, canceling, or modifying orders.
- Never commit `.desk/`, `.env`, `.mcp.json`, `~/.cube/credentials.json`, or any API key material.
