# End-to-End Trade Flow: Setup → Recommendation → Execution

The exact lifecycle from initial setup to a signed trade hitting the exchange, with every security gate visible.

---

## The Full Chain

```
┌─────────┐    ┌──────────┐    ┌───────────┐    ┌──────────┐    ┌──────────┐
│  SETUP  │───→│  AGENT   │───→│   RISK    │───→│  HUMAN   │───→│ EXCHANGE │
│         │    │ ANALYZES │    │  MANAGER  │    │ APPROVES │    │ EXECUTES │
│ Ed25519 │    │ & proposes│   │ approves/ │    │ via TG   │    │ verifies │
│ keypair │    │ a trade  │    │ rejects   │    │ button   │    │ Ed25519  │
└─────────┘    └──────────┘    └───────────┘    └──────────┘    └──────────┘
```

---

## Phase 1: Setup (One-Time)

### Step 1: Generate Ed25519 Keypair

When you run `npm run login` in the Cube connector, this happens:

```
connectors/cube/mcp-server/src/client/signing.ts

  const keypair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  // → 32-byte private key seed
  // → 32-byte public key
```

The keypair is Ed25519 (same curve as Solana, SSH keys, Signal). The private key never leaves your machine.

### Step 2: Encode Public Key as Protobuf

The public key gets wrapped in a `VerificationKey` protobuf with an expiry date:

```
VerificationKey {
  v0 {
    publicKey {
      curve25519: <32 bytes — your Ed25519 public key>
    }
    expiresAt: 1743955200  (e.g., 7 days from now)
  }
}

Wire bytes: 0a 2a 0a 22 12 20 [32-byte pubkey] 10 [varint expiry]
Encoded:     base64("0a2a0a221220...") → "CioKIhIglStB1pvc..."
```

### Step 3: Device Authorization Flow (RFC 8628)

```
YOUR MACHINE                         CUBE BACKEND                    YOUR BROWSER
     │                                     │                              │
     │  POST /agent/device/code            │                              │
     │  { verificationKey: "CioK...",      │                              │
     │    clientName: "AI Fund" }           │                              │
     │────────────────────────────────────→ │                              │
     │                                     │                              │
     │  { deviceCode: "a1b2...",           │                              │
     │    userCode: "CUBE-A3X7",           │                              │
     │    verificationUriComplete:         │                              │
     │    "cube.exchange/agent/CUBE-A3X7" }│                              │
     │←──────────────────────────────────── │                              │
     │                                     │                              │
     │  Opens browser automatically ═══════════════════════════════════→  │
     │                                     │                              │
     │                                     │  Page: "AI Fund wants to     │
     │                                     │         connect. Approve?"   │
     │                                     │                              │
     │                                     │  User clicks [Approve] ──→   │
     │                                     │  POST /agent/device/approve  │
     │                                     │  { userCode: "CUBE-A3X7",   │
     │                                     │    approved: true }          │
     │                                     │                              │
     │                                     │  Registers Ed25519 public    │
     │                                     │  key for your account        │
     │                                     │                              │
     │  POST /agent/device/token           │                              │
     │  { deviceCode: "a1b2..." }          │                              │
     │────────────────────────────────────→ │                              │
     │                                     │                              │
     │  { verificationKeyId: "d97c...",    │                              │
     │    expiresAt: 1743955200,           │                              │
     │    subaccountId: 1 }                │                              │
     │←──────────────────────────────────── │                              │
     │                                     │                              │
     │  Saves to keychain / credential file│                              │
```

### Step 4: Credential Storage

Private key is stored locally (never sent anywhere):

```
Storage priority:
  1. macOS Keychain (via `security` CLI)
  2. Linux libsecret (GNOME Keyring / KWallet)
  3. File fallback: ~/.cube/credentials.json (mode 0600)

Stored data:
{
  "ed25519PrivateKey": "a1b2c3...hex...",     ← 32-byte seed
  "ed25519PublicKey": "d4e5f6...hex...",      ← 32-byte public key
  "verificationKey": "CioKIhIg...base64...", ← protobuf (sent to exchange)
  "verificationKeyId": "d97c889a-...",        ← UUID assigned by exchange
  "expiresAt": 1743955200,                    ← key dies after this
  "provider": "device"                         ← how it was registered
}
```

**What the exchange stores:**
- Your Ed25519 public key (for signature verification)
- The verification key ID
- Which user account it belongs to
- Expiry timestamp
- Registration method: `"device"`

**What the exchange does NOT have:**
- Your private key (never transmitted)

---

## Phase 2: Agent Recommends a Trade

### Step 5: Agent Analyzes the Market

You message the bot (via Telegram or terminal):

```
You: "CZ, evaluate SOL"
```

Claude, embodying the CZ skill, calls exchange tools:

```
get_tickers(symbol: "SOL-USDC")           → price $142, 24h vol $50M
get_price_history(symbol: "SOL-USDC",
                  interval: "1d",
                  limit: 90)               → 90 days of OHLCV
get_positions()                            → current portfolio
```

CZ runs his analysis framework (from `skills/cz/SKILL.md`):
```
CZ SCORE: SOL Ecosystem
├── Users:       8/10 (growing DeFi TVL, active wallets up 40%)
├── Developers:  7/10 (Firedancer live, ecosystem expanding)
├── Revenue:     7/10 (fee revenue growing, MEV healthy)
├── Resilience:  8/10 (survived FTX, network stable)
└── TOTAL:       7.5/10
```

### Step 6: Agent Proposes a Trade

CZ outputs a structured proposal:

```
TRADE PROPOSAL
━━━━━━━━━━━━━━
Asset:    SOL-USDC
Side:     BUY (spot only)
Size:     50 SOL (~$7,100)
Type:     Limit @ $142.00
Stop:     $135.00 (4.9% risk)
Thesis:   CZ Score 7.5, ecosystem expansion, builder momentum
Exchange: Cube

Consulting Risk Manager before proceeding...
```

---

## Phase 3: Risk Manager Gate

### Step 7: Risk Manager Reviews

The Risk Manager agent (if hired) evaluates against `.desk/risk.json`:

```json
{
  "parameters": {
    "max_position_size_pct": 5,
    "max_portfolio_drawdown_pct": 10,
    "max_leverage": 1.0,
    "stop_loss_required": true
  }
}
```

Risk Manager checks:
```
RISK REVIEW
━━━━━━━━━━━
Portfolio value:    $100,000
Proposed size:      $7,100 (7.1% of portfolio) ← EXCEEDS 5% LIMIT
Existing SOL:       $0 (0%)
Total if filled:    $7,100 (7.1%)
Stop loss defined:  Yes ($135 = $350 max loss)
Max loss as % port: 0.35% ✓
Leverage:           1.0x (spot) ✓
Correlation:        Low (no existing SOL) ✓

VERDICT: APPROVED WITH CONDITIONS
  → Reduce size to 35 SOL ($4,970 = 4.97%) to stay within 5% limit.
  → Stop loss at $135 approved.
```

---

## Phase 4: Human Approval (Telegram)

### Step 8: Approval Card Sent to Telegram

**With Claude Code Channels (permission relay):**

When CZ calls `place_order`, Claude Code's permission system triggers. The Telegram channel plugin forwards the prompt:

```
Telegram message from @YourDeskBot:

⚠️ Permission Request
━━━━━━━━━━━━━━━━━━━━
Tool: place_order
Args:
  symbol: SOL-USDC
  side: buy
  price: 142.00
  quantity: 35
  order_type: limit

Allow?  [Yes]  [No]
```

You tap **[Yes]** → Claude Code proceeds to execute.

**With Custom Cloudflare Worker (richer UX):**

```
Telegram message from @YourDeskBot:

🔔 Trade Proposal #a7x9
━━━━━━━━━━━━━━━━━━━━━━━
Agent:   CZ (CZ Score: 7.5)
Action:  BUY 35 SOL @ $142.00
Value:   $4,970 (4.97% of portfolio)
Stop:    $135.00 (max loss $245)
Risk Mgr: ✅ Approved (reduced from 50)

[✅ Approve]  [❌ Reject]
[✏️ Modify]   [⏸️ Hold]
```

Approval callback is HMAC-signed + timestamped + one-time-use (see `docs/security-model.md`).

---

## Phase 5: Order Signed and Executed

### Step 9: Build the Order

Once approved, the MCP server constructs the order:

```typescript
// connectors/cube/mcp-server/src/tools/orders.ts

const order = {
  clientOrderId: 1234567890,
  requestId: 9876543210,
  marketId: 200054,           // SOL-USDC market ID on Cube
  subaccountId: 1,
  side: 0,                    // 0 = BID (buy)
  orderType: 0,               // 0 = LIMIT
  price: 14200,               // $142.00 in market-specific units
  quantity: 3500,              // 35 SOL in market-specific units
  timeInForce: 1,             // GFS (Good for Session)
  postOnly: 0,
  cancelOnDisconnect: false,
};
```

### Step 10: Sign the Request (Ed25519)

```
connectors/cube/mcp-server/src/client/auth.ts

The signature authenticates YOU to the exchange:

  message = "cube.xyz" (8 bytes) + timestamp (8 bytes, little-endian)
            ↓
  signature = Ed25519_sign(message, privateKey)
            ↓
  base64(signature)  →  "Hk7kJf9mN2x..." (64 bytes → 88 chars base64)

HTTP headers:
  x-verification-key-id: d97c889a-fbd8-471d-955d-acc2829dffa5
  x-api-signature: Hk7kJf9mN2x...
  x-api-timestamp: 1743523200
```

### Step 11: Send to Exchange

**Primary path — WebSocket (faster):**

```
connectors/cube/mcp-server/src/client/osmium.ts

1. Fetch access token:
   Ed25519 signature → POST /users/hmac → temporary HMAC credentials

2. Connect WebSocket:
   wss://api.cube.exchange/os
   → Send Credentials protobuf (HMAC auth)
   → Receive Bootstrap { done: true }

3. Send order:
   OrderRequest protobuf (binary) → ws.send(encoded)
   → Receive OrderResponse (ACK or REJECT)
```

**Fallback path — REST:**

```
POST https://api.cube.exchange/os/v0/order
Headers:
  Content-Type: application/json
  x-verification-key-id: d97c889a-...
  x-api-signature: Hk7kJf9mN2x...     ← Ed25519 signature
  x-api-timestamp: 1743523200
Body:
  { clientOrderId, marketId, side, price, quantity, ... }
```

### Step 12: Exchange Verifies and Executes

```
CUBE EXCHANGE MATCHING ENGINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Look up verification key ID → find your registered public key
2. Reconstruct message: "cube.xyz" + timestamp (LE bytes)
3. Verify Ed25519 signature against public key
   → VALID ✓
4. Check timestamp freshness (within ~30 seconds)
   → FRESH ✓
5. Check key not expired
   → ACTIVE ✓ (expires in 5 days)
6. Validate order parameters:
   → Market SOL-USDC exists ✓
   → Price 14200 valid tick size ✓
   → Quantity 3500 valid lot size ✓
   → Subaccount has sufficient balance ✓
7. Place order in matching engine
   → LIMIT BUY 35 SOL @ $142.00 → ORDER PLACED
8. If there's a matching sell at $142.00 or lower:
   → FILLED (partial or full)
9. Return OrderResponse to client
```

---

## What Gets Signed vs. What Doesn't

```
SIGNED (Ed25519):
  ✓ Authentication — "this request comes from the holder of private key X"
  ✓ Timestamp — "this request was made at time T" (prevents replay)

NOT SIGNED (order content is NOT in the signature):
  ✗ The order parameters themselves (price, qty, side)
  ✗ These are protected by the HTTPS/WSS transport layer (TLS)

WHY: Cube uses Ed25519 for IDENTITY ("who are you?"), not for
     order integrity ("what did you ask for?"). The TLS channel
     provides integrity. This is different from on-chain DeFi
     where the signed message IS the transaction.
```

This means the signature proves *who* is placing the order, but the order details are protected by TLS encryption in transit, not by the Ed25519 signature itself. The exchange trusts its own transport layer for content integrity.

---

## Other Venues: How Each Exchange Signs Orders

Cube uses Ed25519. Every other exchange has a different auth model. Here's how each one works in the context of AI Fund.

---

### OKX — HMAC-SHA256 + Passphrase

```
Credentials: API Key + Secret Key + Passphrase (3 values)
Signing:     HMAC-SHA256
Stored:      ~/.okx/config.toml (official MCP) or .mcp.json env vars
```

**How it works:**

```
1. Construct prehash string:
   prehash = timestamp + method + requestPath + body
   example: "2026-04-02T12:00:00.000Z" + "POST" + "/api/v5/trade/order" + '{"instId":"SOL-USDT",...}'

2. Sign with HMAC-SHA256:
   signature = Base64(HMAC-SHA256(secretKey, prehash))

3. Send headers:
   OK-ACCESS-KEY:        your-api-key
   OK-ACCESS-SIGN:       base64(hmac-sha256-signature)
   OK-ACCESS-TIMESTAMP:  2026-04-02T12:00:00.000Z
   OK-ACCESS-PASSPHRASE: your-passphrase
   
4. Exchange verifies: HMAC matches, timestamp within 30 seconds
```

**Security features:**
- API keys can be scoped: Read / Trade / Withdraw (separate permissions)
- IP whitelist supported (up to 20 IPs)
- Passphrase adds a third factor beyond key+secret
- Demo trading mode via `x-simulated-trading: 1` header
- **Official OKX MCP (`okx-trade-mcp`) never exposes keys to the LLM** — signing happens in the MCP server process, Claude only sends trading intent

**Permission scoping for AI Fund:**
```
Create API key with:
  ✅ Read (market data, positions, balances)
  ✅ Trade (place/cancel orders)
  ❌ Withdraw (NEVER enable for bot trading)
  ❌ Transfer (don't allow fund movement between accounts)
```

---

### Kraken — Handled by CLI (No Manual Signing)

```
Credentials: API Key + Private Key (via `kraken auth login`)
Signing:     Handled internally by kraken-cli binary (Rust)
Stored:      Local config with restricted file permissions
```

**How it works:**

```
1. Authenticate:
   $ kraken auth login
   Opens browser → OAuth flow → credentials saved locally

2. MCP server:
   $ kraken mcp -s market,trade,paper
   Built-in MCP server over stdio — no API wrappers needed
   All signing, nonce management, rate limiting handled by the binary

3. Order placement:
   Claude calls → kraken MCP tool → kraken-cli signs internally → Kraken API
   The LLM never sees API keys or signing details
```

**Security features:**
- Scoped MCP services: `market` (read-only), `trade`, `paper`, `all`
- Dangerous calls require explicit `--allow-dangerous` flag
- API keys scoped to specific permissions (Query Funds, Create Order, Cancel Order, etc.)
- Built-in paper trading engine (local state, live market data, zero risk)
- Release binaries are signed with minisign for supply chain verification
- Written in Rust — single zero-dependency binary

**Permission scoping for AI Fund:**
```
kraken mcp -s market,trade,paper    ← recommended: no funding, no withdrawal
kraken mcp -s market                ← read-only mode for analysis agents
kraken mcp -s paper                 ← paper trading only (safest for testing)
```

---

### CCXT (Binance, Bybit, 100+ exchanges) — HMAC-SHA256 (varies)

```
Credentials: API Key + Secret (+ Passphrase for some exchanges)
Signing:     HMAC-SHA256 (most exchanges), varies per exchange
Stored:      .mcp.json env vars or ccxt-accounts.json config file
```

**How it works:**

CCXT is a universal adapter. It abstracts away each exchange's unique signing scheme:

```
                    CCXT Library
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
    Binance          Bybit           Gate.io
    HMAC-SHA256      HMAC-SHA256     HMAC-SHA512
    + timestamp      + timestamp     + timestamp
    + recv_window    + recv_window   + body hash
```

Each exchange has different rules, but CCXT handles all of them:

```
Claude calls place_order on ccxt-mcp
  → ccxt-mcp looks up exchange config
  → CCXT library constructs the exchange-specific request
  → Signs with the exchange-specific algorithm (HMAC-SHA256 for most)
  → Sends to the exchange API
  → Returns result
```

**Configuration:**
```json
// ccxt-accounts.json
{
  "accounts": [
    {
      "name": "binance-spot",
      "exchangeId": "binance",
      "apiKey": "your-key",
      "secret": "your-secret",
      "defaultType": "spot"
    },
    {
      "name": "bybit-futures",
      "exchangeId": "bybit",
      "apiKey": "your-key",
      "secret": "your-secret",
      "defaultType": "future"
    }
  ]
}
```

**Security features (varies by exchange):**

| Exchange | Signing | IP Whitelist | Permission Scoping | Withdrawal Disable |
|----------|---------|-------------|-------------------|-------------------|
| Binance | HMAC-SHA256 | Yes (required for unrestricted) | Read/Trade/Withdraw | Yes |
| Bybit | HMAC-SHA256 | Yes | Read/Trade/Withdraw/Transfer | Yes |
| Gate.io | HMAC-SHA512 | Yes | Read/Trade/Withdraw | Yes |
| Bitget | HMAC-SHA256 | Yes | Read/Trade/Withdraw | Yes |
| KuCoin | HMAC-SHA256 + Passphrase | Yes | General/Trade/Margin | Yes |

**Key safety for CCXT:**
- Some CCXT MCP implementations have `SAFE_MODE` (read-only, no trading)
- Rate limiting: max 10 orders/minute per session (configurable)
- CCXT MCP servers sign locally — the LLM never sees API keys

---

### Coinbase — ECDSA (ES256) + JWT

```
Credentials: CDP API Key ID + API Key Secret
Signing:     ECDSA (ES256) → JWT token
Stored:      Environment variables
```

**How it works:**

Coinbase uses a different pattern — ECDSA keys generate JWTs:

```
1. Create CDP API key (Coinbase Developer Platform)
   → Select ECDSA (ES256) algorithm (NOT Ed25519 — not supported)
   → Get: api_key_id + api_key_secret (PEM format)

2. Generate JWT:
   jwt = ES256_sign({
     sub: api_key_id,
     iss: "coinbase-cloud",
     aud: ["cdp_service"],
     exp: now + 120,  // 2 minute expiry
     uri: "POST api.coinbase.com/api/v3/brokerage/orders"
   }, api_key_secret)

3. Send request:
   Authorization: Bearer <jwt>
```

**AgentKit + MCP:**
- AgentKit wraps Coinbase APIs into agent-friendly tools
- MCP extension provides standardized tool interface
- Agentic Wallets (Feb 2026): non-custodial wallets in Trusted Execution Environments (TEEs)
- Trade, Send, Earn — pre-built skills

**Permission scoping:**
```
CDP API Key permissions:
  ✅ View — read-only (balances, prices, history)
  ✅ Trade — place/cancel orders
  ❌ Transfer — don't allow fund movement
  
IP allowlist: Yes (set in CDP dashboard)
Portfolio restriction: Can scope key to specific portfolio
```

---

### Hyperliquid — On-Chain Signing (EVM Wallet)

```
Credentials: EVM private key (Ethereum wallet)
Signing:     EIP-712 typed data signing (secp256k1)
Stored:      Environment variable or wallet file
```

**How it works:**

Hyperliquid is different — it's a DEX. Orders are signed on-chain style:

```
1. Construct EIP-712 typed data:
   {
     type: "Order",
     asset: 4,        // SOL index
     isBuy: true,
     limitPx: "142.0",
     sz: "35.0",
     ...
   }

2. Sign with EVM private key:
   signature = secp256k1_sign(keccak256(EIP712_hash(order)), privateKey)

3. Send to Hyperliquid API:
   POST /exchange { action: { type: "order", orders: [...], grouping: "na" },
                    nonce: timestamp,
                    signature: { r, s, v } }
```

**Security:**
- The private key IS the identity — no API key/secret separation
- This means if the key leaks, the attacker has FULL control (trade + withdraw)
- Use an agent sub-wallet (Hyperliquid vault) with limited funds
- No IP whitelisting (it's a DEX, permissionless)

---

## Signing Comparison Across All Venues

| Exchange | Algorithm | Key Type | Expiry | LLM Sees Keys? | Withdrawal Disable |
|----------|-----------|----------|--------|----------------|-------------------|
| **Cube** | Ed25519 | Signing key | 1-30 days | No (MCP signs) | N/A (device auth) |
| **OKX** | HMAC-SHA256 | API key+secret+passphrase | Permanent | No (MCP signs) | Yes |
| **Kraken** | Internal (Rust CLI) | API key+private key | Permanent | No (CLI signs) | Yes |
| **Binance** | HMAC-SHA256 | API key+secret | Permanent | No (CCXT signs) | Yes |
| **Bybit** | HMAC-SHA256 | API key+secret | Permanent | No (CCXT signs) | Yes |
| **Coinbase** | ECDSA (ES256) | CDP key (PEM) | JWT: 2 min | No (AgentKit signs) | Yes |
| **Hyperliquid** | secp256k1 (EIP-712) | EVM private key | Never | Depends on MCP | No (DEX) |

**Key insight:** In every case, the MCP server handles signing locally. The LLM (Claude) never sees API keys or private keys. Claude sends trading *intent* ("buy 35 SOL at $142"), the MCP server translates it into a signed API request.

### What This Means for the Telegram Bot

```
Telegram message: "CZ evaluate SOL"
  → Claude: analysis + trade proposal
  → You: tap [Approve]
  → MCP server (whichever exchange):
      OKX:         HMAC-SHA256 signs the order
      Kraken:      kraken-cli binary signs internally
      Binance:     CCXT HMAC-SHA256 signs the order
      Coinbase:    AgentKit ECDSA/JWT signs the order
      Cube:        Ed25519 signs the auth header
      Hyperliquid: secp256k1 signs EIP-712 typed data
  → Exchange: verifies signature, executes order
```

You never need to think about the signing differences. Each MCP connector handles its own exchange's auth protocol. Your Telegram bot and the AI agents are completely exchange-agnostic.

---

## Complete Security Chain Summary

```
GATE 1: Telegram Allowlist
  Only your Telegram user ID can message the bot.
  Everyone else silently dropped.
         │
         ▼
GATE 2: Webhook Secret (if using Cloudflare Worker)
  Validates request actually came from Telegram servers.
  Random attacker hitting your Worker URL is rejected.
         │
         ▼
GATE 3: AI Agent Analysis
  Agent uses market data tools (read-only) to analyze.
  Agent proposes a trade with explicit parameters.
  Agent cannot execute without passing through gates below.
         │
         ▼
GATE 4: Risk Manager (AI)
  Checks against hard limits in .desk/risk.json.
  Can reduce size, add conditions, or reject entirely.
  Not a hard security gate — enforced by prompt, not code.
         │
         ▼
GATE 5: Human Approval (Telegram button)
  You see the exact trade and tap [Approve] or [Reject].
  HMAC-signed callback, one-time use, 5-minute expiry.
  THIS IS THE CRITICAL GATE — nothing executes without your tap.
         │
         ▼
GATE 6: Hard Limits (Worker code) — if using custom Worker
  Max order size, max daily volume, allowed symbols.
  Enforced in code, not prompts. Claude cannot override.
         │
         ▼
GATE 7: Ed25519 Signature
  Private key signs the authentication request.
  Exchange verifies signature against registered public key.
  Key expires in 1-30 days (not permanent).
         │
         ▼
GATE 8: Exchange Validation
  Market exists, valid tick/lot size, sufficient balance.
  Subaccount isolation limits blast radius.
  No withdrawal permission on trading keys.
         │
         ▼
ORDER EXECUTES ON MATCHING ENGINE
```

---

## Key Expiry & Rotation

```
Day 0:   Generate keypair, register via device auth
Day 1-6: Normal trading, key is active
Day 7:   Key expires. All API calls start returning 401.
         Agent detects expiry (5-minute buffer in credential-store.ts).
         Must re-run device auth flow to register a new key.
         Old key is dead — even if leaked, it's useless.

This is BY DESIGN. Short-lived keys limit the blast radius of
any compromise. A leaked API key at a traditional exchange is
permanent until manually rotated. A leaked Cube signing key
is dead in days.
```
