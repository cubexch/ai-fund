# Telegram Deployment Guide

How to deploy AI Fund as a Telegram-accessible trading desk using Claude Code Channels, with Cloudflare Workers for the approval relay.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  YOUR PHONE (Telegram)                                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  @YourDeskBot                                         │  │
│  │  You: /hire risk-manager                              │  │
│  │  Bot: Risk Manager hired. Reading briefing book...    │  │
│  │  You: CZ evaluate SOL                                 │  │
│  │  Bot: CZ Score: 7.8/10. Recommend spot buy 50 SOL... │  │
│  │  Bot: ⚠️ Permission: place_order(SOL, buy, 50)       │  │
│  │       [✅ Approve]  [❌ Deny]                          │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────────┘
                       │ Telegram Bot API
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  CLOUDFLARE WORKER (free tier)                    Optional   │
│  - Webhook receiver for Telegram                             │
│  - Trade approval UI (inline keyboards)                      │
│  - Message queue (KV store)                                  │
│  - Forwards to Claude Code session                           │
└──────────────────────┬───────────────────────────────────────┘
                       │ (or direct if using Channels)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  CLAUDE CODE SESSION (your machine / VPS in tmux)            │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  claude --channels plugin:telegram                     │  │
│  │  ├── CLAUDE.md (AI Fund config)                        │  │
│  │  ├── skills/ (42 agents)                               │  │
│  │  ├── .desk/ (state, orders, briefings)                 │  │
│  │  └── MCP servers:                                      │  │
│  │      ├── Cube Exchange connector                       │  │
│  │      ├── OKX connector                                 │  │
│  │      └── (other exchanges)                             │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## Two Approaches

### Approach A: Claude Code Channels Only (Simplest)

No Cloudflare needed. Claude Code's official Telegram plugin handles everything.

**Cost: $0 extra** (just your Claude subscription + a machine to run on)

```bash
# 1. Create bot with @BotFather on Telegram
#    → copy the bot token

# 2. Install the Telegram plugin
/plugin install telegram@claude-plugins-official

# 3. Configure the bot token
/telegram:configure <YOUR_BOT_TOKEN>

# 4. Launch Claude Code with the channel
claude --channels plugin:telegram@claude-plugins-official

# 5. DM your bot on Telegram → get pairing code
# 6. In terminal: /telegram:access pair <CODE>
# 7. Lock down: /telegram:access policy allowlist

# 8. Keep it running (tmux on a VPS or your machine)
tmux new -s desk
claude --channels plugin:telegram@claude-plugins-official
# Ctrl+B, D to detach
```

**Pros:**
- Zero custom code
- Permission relay works (approve trades from Telegram)
- AI Fund works completely as-is
- Free (beyond Claude subscription)

**Cons:**
- Must keep a machine running with tmux
- No custom approval UI (just text-based approve/deny)
- Messages lost if session restarts while you're away
- Single user (one allowlisted Telegram account per bot)

---

### Approach B: Cloudflare Worker + Claude API (Custom Bot)

Cloudflare Worker handles Telegram webhooks (free). Calls Claude API with AI Fund skills. Custom inline keyboards for trade approval. Always-on, no machine needed.

**Cost: $0 hosting** (Cloudflare free tier: 100K requests/day) + Claude API usage

```
Telegram → Cloudflare Worker (webhook) → Claude API → Exchange APIs
                    ↕
            Cloudflare KV (state, approval queue)
```

**Pros:**
- True always-on (serverless, no machine needed)
- Custom approval UI with inline keyboards
- Message queuing (no lost messages)
- Multi-user possible
- Free hosting

**Cons:**
- Can't run MCP servers (no persistent process on Workers)
- Exchange API calls must be direct (not via MCP connectors)
- Need to port skill loading into system prompts
- 10ms CPU limit on free tier (enough for webhook + API relay, tight for complex logic)
- More code to write and maintain

---

## Security Model

### Layer 1: Telegram Bot Token

```
BotFather → creates bot → gives you a token
Token = full control of the bot
```

**Rules:**
- Never commit the token to git
- Store as environment variable or Cloudflare Worker secret
- Rotate immediately if leaked: `/revoke` in BotFather
- Set bot privacy mode: `/setprivacy` → enabled (bot only sees messages addressed to it in groups)

### Layer 2: Sender Allowlist

```
Only allowlisted Telegram user IDs can interact with the bot.
Everyone else is silently dropped.
```

**Setup (Channels approach):**
```bash
# After pairing your account:
/telegram:access policy allowlist

# Add another user:
/telegram:access pair <THEIR_PAIRING_CODE>
```

**Setup (Custom Worker approach):**
```typescript
// In your Cloudflare Worker
const ALLOWED_USERS = [
  123456789,  // your Telegram user ID
  // add trusted users here
];

// In the webhook handler:
if (!ALLOWED_USERS.includes(update.message.from.id)) {
  return new Response('ok'); // silently drop
}
```

### Layer 3: Permission Relay (Trade Approval)

```
Claude wants to call place_order(SOL, buy, 50, $142)
  → Permission prompt forwarded to Telegram
  → You see: "Allow place_order?" with [Approve] [Deny]
  → You tap Approve
  → Trade executes
```

**How it works with Channels:**
The Telegram channel plugin declares `permission relay` capability. When Claude hits a tool that requires approval (like `place_order`), the prompt is forwarded to your Telegram chat instead of blocking in the terminal.

**How it works with custom Worker:**
You implement it yourself — which gives you a *better* UX:

```typescript
// When Claude proposes a trade:
await bot.sendMessage(chatId, 
  `🔔 Trade Proposal\n\n` +
  `Agent: CZ\n` +
  `Action: Buy 50 SOL @ $142\n` +
  `Stop: $135\n` +
  `Risk: 2.3% of portfolio\n\n` +
  `Risk Manager: ✅ Approved (within limits)`,
  {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Approve', callback_data: 'approve:trade_123' },
          { text: '❌ Reject', callback_data: 'reject:trade_123' },
        ],
        [
          { text: '✏️ Modify Size', callback_data: 'modify:trade_123' },
          { text: '⏸️ Hold', callback_data: 'hold:trade_123' },
        ]
      ]
    }
  }
);
```

### Layer 4: Exchange API Keys

```
API keys connect to real exchanges with real money.
These are the crown jewels.
```

**Rules:**
- **Never store in code or git** — use Cloudflare Worker secrets or local env vars
- **Use read-only keys where possible** — separate keys for reading vs trading
- **IP whitelist** — most exchanges support restricting API keys to specific IPs. Whitelist your Cloudflare Worker's egress IPs or your VPS IP.
- **Subaccount isolation** — trade from a subaccount with limited funds, not your main account
- **Cube's device auth** — AI Fund's existing Ed25519 device auth (see `docs/agent-auth-brief.md`) means no API keys at all. The agent gets a signing key that expires in days, not a permanent secret.

### Layer 5: Cloudflare Worker Secrets

```bash
# Store secrets in Cloudflare (never in code)
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put CUBE_API_KEY
wrangler secret put ANTHROPIC_API_KEY
```

These are encrypted at rest, only available to your Worker at runtime, and never exposed in logs or dashboards.

---

## What Cloudflare Can Host (Free)

| Component | Cloudflare Service | Free Tier |
|-----------|-------------------|-----------|
| Telegram webhook receiver | Workers | 100K req/day |
| Approval queue / state | KV | 100K reads/day, 1K writes/day |
| Trade history / orders | D1 (SQLite) | 5M rows read/day, 100K writes/day |
| Bot configuration | Workers secrets | Unlimited |
| Static dashboard | Pages | Unlimited |

### What Cloudflare CANNOT Host

| Component | Why Not | Alternative |
|-----------|---------|-------------|
| Claude Code session | Needs persistent process, filesystem | VPS with tmux, your machine |
| MCP servers | Long-running daemons | Same machine as Claude Code |
| Exchange WebSocket feeds | Workers don't support outbound WS | Durable Objects ($5/mo) or VPS |

---

## Recommended Path: Start Simple, Upgrade Later

### Phase 1: Today (30 minutes, $0 extra)

Use Claude Code Channels with the official Telegram plugin. Run on your machine.

```bash
# Terminal 1: start Claude Code with Telegram channel
tmux new -s ai-fund
cd ~/ai-fund
claude --channels plugin:telegram@claude-plugins-official

# In Telegram: DM your bot, pair, set allowlist
# Now: /hire risk-manager, /desk, chat with agents from phone
```

Trade approvals work via permission relay. Your machine must stay on.

### Phase 2: Always-On (1 hour, ~$5/mo)

Move to a VPS. Any cheap provider works.

```bash
# On VPS
ssh your-vps
tmux new -s ai-fund
cd ~/ai-fund
claude --channels plugin:telegram@claude-plugins-official
# Ctrl+B, D to detach

# Reconnect anytime:
ssh your-vps -t "tmux attach -t ai-fund"
```

### Phase 3: Custom Approval UX (days, $0 hosting)

Build a Cloudflare Worker that:
1. Receives Telegram webhooks
2. Forwards messages to Claude API with the appropriate skill loaded
3. Shows rich trade approval cards with inline keyboards
4. Stores approval history in Cloudflare KV/D1
5. Calls exchange APIs directly on approval

This is the production-grade version. Skeleton Worker code below.

---

## Cloudflare Worker Skeleton

```typescript
// wrangler.toml
// name = "ai-fund-bot"
// main = "src/index.ts"
// compatibility_date = "2026-04-01"
// [vars]
// ALLOWED_USERS = "123456789,987654321"
// [[kv_namespaces]]
// binding = "DESK_STATE"
// id = "your-kv-namespace-id"

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  ALLOWED_USERS: string;
  DESK_STATE: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('ok');
    }

    const update = await request.json() as TelegramUpdate;
    const userId = update.message?.from?.id || update.callback_query?.from?.id;
    
    // Security: allowlist check
    const allowed = env.ALLOWED_USERS.split(',').map(Number);
    if (!userId || !allowed.includes(userId)) {
      return new Response('ok'); // silent drop
    }

    // Handle trade approval callbacks
    if (update.callback_query) {
      return handleApproval(update.callback_query, env);
    }

    // Handle messages → forward to Claude
    if (update.message?.text) {
      return handleMessage(update.message, env);
    }

    return new Response('ok');
  }
};

async function handleMessage(message: TelegramMessage, env: Env) {
  // Load active skill from KV
  const deskState = await env.DESK_STATE.get('state', 'json');
  
  // Call Claude API with skill as system prompt
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(deskState),
      messages: [{ role: 'user', content: message.text }],
    }),
  });

  const result = await response.json();
  
  // Check if response contains a trade proposal
  // If so, send approval keyboard instead of raw text
  // Otherwise, send the response text
  
  await sendTelegramMessage(env, message.chat.id, result.content[0].text);
  return new Response('ok');
}

async function handleApproval(query: TelegramCallbackQuery, env: Env) {
  const [action, tradeId] = query.data.split(':');
  
  if (action === 'approve') {
    // Execute the trade via exchange API
    // Update .desk/orders in KV
    await sendTelegramMessage(env, query.message.chat.id, 
      `✅ Trade ${tradeId} approved and submitted.`);
  } else if (action === 'reject') {
    await sendTelegramMessage(env, query.message.chat.id, 
      `❌ Trade ${tradeId} rejected.`);
  }
  
  return new Response('ok');
}
```

---

## Setup Checklist

- [ ] Create Telegram bot via @BotFather
- [ ] Set bot privacy mode (`/setprivacy` → enabled)
- [ ] Disable bot group joins (`/setjoingroups` → disabled)
- [ ] Install Claude Code Telegram plugin
- [ ] Configure bot token
- [ ] Pair your Telegram account
- [ ] Switch to allowlist mode
- [ ] Test: send `/desk` from Telegram
- [ ] Test: hire an agent, get analysis, see permission relay
- [ ] (Optional) Set up tmux on VPS for always-on
- [ ] (Optional) Deploy Cloudflare Worker for custom approval UX
