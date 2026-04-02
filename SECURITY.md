# Security

## 1. Security Policy

### Reporting Vulnerabilities

If you discover a security vulnerability in ai-fund, please report it responsibly:

- **Email**: Send details to the maintainers via the email listed in the repository (do not open a public issue for security bugs).
- **GitHub Security Advisories**: Use the "Report a vulnerability" button under the Security tab of this repository to submit a private advisory.

Please include: a description of the vulnerability, steps to reproduce, affected components, and any suggested fix.

### Scope

The following components are in scope for security reports:

- **Connectors** (`connectors/`): MCP servers bridging Claude to exchange APIs
- **Skills** (`skills/`): Agent persona definitions and trading logic
- **CLI and desk state** (`.desk/`): Local state files, trade logs, risk parameters
- **Shared libraries** (`lib/`): Technical indicators and financial math utilities

Third-party MCP packages (e.g., `@okx_ai/okx-trade-mcp`, `ccxt-mcp`, `@coinbase/agentkit`) are outside the direct scope of this project. Report issues with those packages to their respective maintainers.

---

## 2. Threat Model for AI Agent Trading

AI trading agents operate with broad capabilities. Understanding what an agent can access -- and what it should not need to access -- is essential before connecting real funds.

### Agent Capabilities

An AI agent running in this system can:

- **Read files** on the local filesystem, including config files and credentials
- **Call MCP tools** to place orders, cancel orders, and query account state
- **Log output** to conversation transcripts and session history
- **Spawn processes** such as shell commands and package managers

### Attack Surface

| Surface | Risk | Example |
|---------|------|---------|
| API keys in config files | Agent (or any code it runs) can read `.mcp.json` | A malicious MCP server could exfiltrate keys from the config |
| API keys in environment variables | Visible to any child process the agent spawns | Env vars logged by a verbose subprocess |
| Keys in logs / transcripts | Session transcripts may contain keys or signed requests | Sharing a transcript publicly leaks credentials |
| Desk state files | `.desk/orders.json` contains trade history and proposals | Sensitive trading strategy details exposed |
| MCP server code | Third-party MCP packages execute locally with full access | Unreviewed npm packages could contain malicious code |

### Access Boundary Diagram

```
+----------------------------------------------------------+
|  What the agent CAN access                               |
|                                                          |
|  - ~/.mcp.json (API keys, secrets, passphrases)         |
|  - Environment variables (OKX_API_KEY, etc.)             |
|  - .desk/ state files (orders, risk params, briefings)   |
|  - MCP tools (place_order, cancel_order, get_balances)   |
|  - Local filesystem (read/write)                         |
|  - Network (via MCP servers and spawned processes)        |
+----------------------------------------------------------+

+----------------------------------------------------------+
|  What the agent SHOULD access                            |
|                                                          |
|  - MCP tools for trading (via well-scoped permissions)   |
|  - Market data (prices, order books, candles)            |
|  - .desk/ state (its own briefing book, desk state)      |
|  - lib/ utilities (indicators, math, formatting)         |
+----------------------------------------------------------+
```

The gap between these two boxes is your risk. Minimize it by restricting API key permissions, using subaccounts, and reviewing connector code.

---

## 3. Connector Security Tiers

Not all connectors handle authentication the same way. Choose connectors that match your risk tolerance.

| Tier | Auth Model | Key Exposure | Examples |
|------|-----------|--------------|---------|
| **Tier 1** | Local device auth (no keys in files) | None -- private keys never leave the machine; approval happens in the browser | Connectors using device authorization (RFC 8628), local Ed25519 signing |
| **Tier 2** | API key + secret in config file | Medium -- keys are stored in `.mcp.json` on disk and readable by the agent | CCXT-based connectors, most exchange MCP servers requiring `API_KEY` / `API_SECRET` |
| **Tier 3** | Keys in environment variables only | Medium-High -- keys are visible to all child processes and may appear in process listings | Custom setups passing credentials solely via env vars without file-based config |

**Tier 1** connectors eliminate the largest class of key-exposure risk. If your exchange supports device auth or local signing, prefer that over API key-based connectors.

**Tier 2** connectors are the most common. If you use them, apply every mitigation in the Best Practices section below.

**Tier 3** setups add risk because environment variables can leak through process tables, crash dumps, and logging. Treat them with extra caution.

---

## 4. Best Practices

### API Key Hygiene

- **Use read-only API keys** when the agent only needs market data. Create separate keys for trading.
- **Disable withdrawal permissions** on every API key used by an agent. There is no legitimate reason for an AI agent to initiate withdrawals.
- **Use subaccounts with limited funds.** Never connect an agent to your main account. Fund a subaccount with only what you are willing to risk.
- **Rotate keys regularly.** Set a calendar reminder. If a key may have been exposed (e.g., you shared a session transcript), rotate immediately.
- **IP-whitelist where supported.** Lock API keys to the IP address where the agent runs.

### Session and Transcript Safety

- **Never share session transcripts without scrubbing.** Transcripts may contain API keys, order IDs, account balances, or strategy details. Redact all sensitive content before sharing.
- **Avoid verbose/debug logging** in production. Verbose MCP output may echo credentials.

### MCP Connector Vetting

- **Review MCP connector source code before trusting it.** Third-party npm packages run with the same permissions as your shell. Read the code or audit the package before `npm install`.
- **Pin connector versions.** Avoid auto-updating MCP packages in production to prevent supply-chain attacks.
- **Prefer well-known connectors** with public source code and active maintenance.

---

## 5. Paper Trading as Default

### Why Paper Mode Is the Default

All agents default to paper/staging mode. This is intentional:

- New strategies should be validated before risking real capital.
- Agent personas may behave unexpectedly on first use -- paper mode lets you observe before committing funds.
- Misconfigured connectors or API permissions are caught safely in paper mode.

### How to Verify You Are in Paper Mode

- **Check your connector config.** Most exchanges have an explicit paper/sandbox flag or a separate sandbox API URL.
- **Run `/desk`** to see the current trading mode for each connected exchange.
- **Look at order responses.** Paper-mode orders typically have sandbox-specific order IDs or are routed to testnet endpoints.
- **When in doubt, check your exchange account directly.** Verify that no real orders have been placed.

### Risk Manager as Gatekeeper

The Risk Manager agent (`/hire risk-manager`) acts as a gatekeeper for all trading activity:

- All trading agents should consult the Risk Manager before executing trades.
- The Risk Manager enforces position limits, drawdown thresholds, and exposure caps defined in `.desk/risk.json`.
- Switching from paper to production requires explicit confirmation -- the Risk Manager will flag the transition.

Never bypass the Risk Manager to "move faster." It exists to prevent the mistakes that happen when agents act without oversight.
