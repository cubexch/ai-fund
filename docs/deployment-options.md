# Deployment Options Evaluation

How to run AI Fund as a persistent, remotely-accessible trading desk — not just a local CLI session.

---

## Option 1: Claude Dispatch (Anthropic Official)

**What it is:** Anthropic's built-in remote control layer inside Claude Cowork. Launched March 17, 2026 as a research preview. Send tasks from your phone to Claude running on your desktop.

### How it would work with AI Fund

1. Run Claude Desktop with Cowork on a dedicated machine (Mac Mini, Linux box, etc.)
2. Open the AI Fund repo as a Cowork project — Claude reads `CLAUDE.md`, loads skills, connects MCP servers
3. Enable Dispatch — scan QR code from Claude iOS/Android app
4. From your phone: `/hire risk-manager`, `/desk`, ask CZ to evaluate SOL, approve trades

### Architecture

```
Phone (Claude App)
  → Anthropic servers (relay)
    → Desktop "sessions bridge"
      → Claude Code session
        → MCP servers (Cube, OKX, etc.)
        → .desk/ state
        → Skills
```

### Pros

- **Zero custom code** — AI Fund works as-is, no modifications needed
- **Full MCP support** — all exchange connectors work natively
- **Session persistence** — Cowork maintains state across interactions
- **Official & supported** — Anthropic maintains the infrastructure
- **Multi-channel** — Dispatch now supports Telegram, Discord, and Claude Code Channels
- **Scheduled tasks** — cloud-scheduled tasks run on Anthropic infra (computer stays off)

### Cons

- **Desktop must stay on** — Dispatch is remote control, not cloud hosting (unless using scheduled tasks)
- **Single user** — one phone controls one desktop; no multi-user desk
- **Permission prompts** — dangerous operations still require local terminal approval unless you configure `--dangerously-skip-permissions`
- **Pricing** — $100/mo (Max) or $20/mo (Pro), plus API usage
- **No programmatic API** — can't integrate with external systems (webhooks, alerts)

### Verdict for AI Fund

**Best for solo traders.** Hire your desk, walk away, check from your phone. The biggest limitation is that trade approval prompts may block in the terminal — you'd need to either pre-approve tool patterns or accept the `--dangerously-skip-permissions` risk. For a trading desk, that's a meaningful security tradeoff.

---

## Option 2: OpenClaw (Self-Hosted Agent Gateway)

**What it is:** Open-source (MIT), self-hosted agent runtime and message router. Created by Peter Steinberger (PSPDFKit founder) in late 2025. 250k+ GitHub stars by Q1 2026. Routes messages from Telegram/Discord/WhatsApp/Slack to an AI agent that can execute real actions.

### How it would work with AI Fund

1. Deploy OpenClaw Gateway on a VPS or home server
2. Configure it to use Claude as the LLM backend
3. Port AI Fund skills into OpenClaw's skill format (or load them as system prompts)
4. Connect Telegram as a channel — chat with your desk from any device
5. Wire up exchange APIs via OpenClaw's tool/plugin system (replacing MCP)

### Architecture

```
Telegram / Discord / WhatsApp / Slack
  → OpenClaw Gateway (your server, port 18789)
    → Agent session (Claude API)
      → Skills (ported from AI Fund format)
      → Exchange APIs (via plugins, not MCP)
      → State management (local filesystem)
```

### Pros

- **Multi-channel** — Telegram, Discord, WhatsApp, Slack, iMessage, IRC, Teams, Signal, Matrix
- **Multi-user** — different channels/accounts route to isolated agent sessions
- **Self-hosted** — full control, your data stays on your machine
- **Always-on** — runs as a daemon/systemd service, no desktop needed
- **Free** — MIT licensed, only pay for LLM API calls and hosting
- **Huge ecosystem** — 13,729+ skills on ClawHub

### Cons

- **Skill porting required** — AI Fund skills are Claude Code SKILL.md format; OpenClaw uses its own skill format. Significant rewrite needed.
- **No native MCP support** — OpenClaw has its own plugin/tool system. Exchange connectors (Cube MCP, OKX MCP) would need adapters or reimplementation.
- **Security concerns** — CVE-2026-25253 (CVSS 8.8) was a critical RCE. ClawHavoc campaign found malware in ClawHub skills. Default config exposes API to internet.
- **Operational overhead** — you manage the server, updates, security hardening, backups
- **Creator left** — Steinberger joined OpenAI in Feb 2026; project now under independent foundation
- **Different paradigm** — OpenClaw is a message router, not a coding agent. AI Fund's deep integration with Claude Code (file editing, git, terminal) doesn't translate directly.

### Verdict for AI Fund

**High effort, high flexibility.** You'd essentially be rebuilding AI Fund's runtime on a different platform. The multi-channel and multi-user capabilities are compelling, but you lose Claude Code's native tool system (MCP, file access, terminal). Best if you want to turn AI Fund into a SaaS-like product serving multiple traders across platforms.

---

## Option 3: Telegram Bot (Custom Integration)

**What it is:** Build a Telegram bot that bridges to a running Claude Code session, enabling mobile chat with the desk and trade approval workflows.

### Three sub-approaches:

### 3a. Claude Code Channels (Official)

Anthropic launched Channels on March 20, 2026 as a research preview. Push Telegram messages directly into a running Claude Code session.

```
Telegram Bot (@YourDeskBot)
  → Claude Code Channels MCP server
    → Running Claude Code session
      → AI Fund (skills, MCP connectors, .desk/ state)
```

**Setup:** Create bot via @BotFather → install official Telegram plugin → configure token → pair → done.

**Limitation:** Permission prompts appear in the terminal, not Telegram. If Claude needs approval for a trade (e.g., `place_order`), the session pauses until you approve locally. For unattended trading, you'd need to pre-approve exchange MCP tools or use `--dangerously-skip-permissions`.

### 3b. Custom Bot with Claude Agent SDK

Build a purpose-built Telegram bot that uses the Claude Agent SDK to create sessions with AI Fund context.

```
Telegram Bot (your Node.js service)
  → Claude Agent SDK
    → Claude API (with AI Fund system prompt + skills)
    → Exchange APIs (direct, not MCP)
  → Approval queue (Telegram inline keyboards)
  → .desk/ state (managed by your service)
```

**This is the most powerful approach for trade approval.** You control the full flow:

1. Trader messages bot: "CZ, evaluate SOL ecosystem"
2. Bot spawns Claude session with CZ skill loaded
3. CZ analyzes and proposes: "Buy 50 SOL at $142, stop at $135"
4. Bot sends Telegram inline keyboard: `[Approve] [Reject] [Modify]`
5. Trader taps Approve on phone
6. Bot executes via exchange API
7. Bot updates `.desk/orders.json` and briefing

### 3c. OpenClaw as Telegram Bridge

Use OpenClaw purely as the Telegram↔Agent bridge, keeping Claude as the LLM backend.

```
Telegram
  → OpenClaw Gateway (Telegram channel configured)
    → Claude API
    → AI Fund skills (ported to OpenClaw format)
```

Less custom code than 3b, but inherits OpenClaw's skill porting and security issues.

---

## Comparison Matrix

| Factor | Dispatch | OpenClaw | TG Channels | Custom TG Bot |
|--------|----------|----------|-------------|---------------|
| **Setup effort** | Minutes | Hours-days | ~30 min | Days-weeks |
| **Code changes to AI Fund** | None | Major rewrite | None | Moderate |
| **MCP connectors work** | Yes | No (rewrite) | Yes | No (direct API) |
| **Trade approval from phone** | Partial | Yes | No (terminal) | Yes (best) |
| **Multi-user** | No | Yes | No | Yes |
| **Always-on (no desktop)** | No* | Yes | No | Yes |
| **Self-hosted** | No | Yes | No | Yes |
| **Security model** | Anthropic-managed | You manage | Anthropic-managed | You manage |
| **Cost** | $20-100/mo + API | Hosting + API | $20-100/mo + API | Hosting + API |

*Scheduled tasks can run without desktop, but interactive Dispatch needs it.

---

## Recommendation

**For immediate use (today):** **Claude Dispatch** or **Claude Code Channels (Telegram)**. Zero code changes. AI Fund works as-is. Trade from your phone. Accept the limitation that some approvals require terminal access, or configure tool auto-approval for exchange MCP tools you trust.

**For a proper trading desk with mobile approval:** **Custom Telegram Bot (3b)**. Build a thin Node.js service that:
- Runs as a systemd service on a VPS
- Uses Claude Agent SDK to create sessions with AI Fund skills as system prompts
- Manages a trade approval queue via Telegram inline keyboards
- Calls exchange APIs directly (or spawns Claude Code subprocesses with MCP)
- Persists `.desk/` state between sessions

This gives you: always-on, multi-user, proper trade approval UX, and the full AI Fund persona system.

**For a multi-platform product:** **OpenClaw** — but budget significant engineering time for the port. The payoff is every messaging platform, multi-user isolation, and a proven open-source runtime.

---

## Next Steps

1. **Quick win:** Set up Claude Dispatch + Telegram Channel today. Test the desk from your phone.
2. **Design doc:** Spec out the custom Telegram bot architecture — approval flow, state management, session lifecycle.
3. **Prototype:** Build a minimal Telegram bot that loads one skill (e.g., Risk Manager) and routes a single trade approval.
4. **Iterate:** Add more skills, multi-user support, and exchange integrations as needed.
