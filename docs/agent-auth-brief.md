# Agent Auth: Browser-Based Key Registration for AI Agents

> Implementation note as of April 8, 2026: the Cube MCP connector now uses OAuth-style callback `code` + `state` validation and PKCE (`codeChallenge` / `codeVerifier`) for `/agent/authorize`. Historical `callbackToken` references below describe the older flow and should be reconciled before this doc is treated as the source of truth.

## Overview

Build a login flow that lets AI agents (MCP servers, Claude Code, CLI tools) register Ed25519 signing keys with Cube Exchange. Modeled after [Cloudflare's `wrangler login`](https://blog.cloudflare.com/wrangler-oauth/) — the agent opens a browser, the user approves with one click, the browser redirects to localhost, and the CLI picks it up instantly. No manual codes, no copy-paste, no API tokens.

**Two modes:**
- **Interactive** (default): Localhost callback server — instant, like `wrangler login`
- **Headless** (fallback): Polling-based — for containers, SSH, CI/CD where localhost isn't reachable

## User Experience

### Interactive mode (like Cloudflare wrangler)

```
$ cube-login

  ⬡ Cube Exchange

  Logging in via browser...

  Opening https://cube.exchange/agent/authorize?code=a1b2c3d4...

  Waiting for approval in browser...

  ✓ Successfully logged in.
    Key expires: Apr 6, 2026
    Credentials saved to ~/.cube/credentials.json
```

What happens:
1. CLI generates Ed25519 keypair
2. CLI starts a localhost callback server on port 9876
3. CLI calls `POST /agent/device/code` with the public key and callback URL
4. CLI opens `cube.exchange/agent/authorize?code=...` in the default browser
5. User sees approval page, clicks **Approve**
6. Browser redirects to `http://localhost:9876/callback?token=...`
7. CLI captures redirect, verifies token with backend, saves credentials
8. Browser shows "Cube is now connected. You can close this tab."
9. CLI prints success

### Headless mode (containers, SSH)

```
$ cube-login --headless

  ⬡ Cube Exchange

  Your pairing code is: brave-solar-mint-echo
  This code verifies your authentication with Cube Exchange.

  Press Enter to open the browser or visit:
    https://cube.exchange/agent/brave-solar-mint-echo

  Waiting for approval...

  Done! Cube Exchange CLI is now configured.
    Key expires: Apr 6, 2026
    Stored in: macOS Keychain
```

Falls back automatically if browser can't be opened. Uses polling instead of localhost callback.

### Browser side

The browser opens `cube.exchange/agent/authorize?code=...` (interactive) or `cube.exchange/agent/brave-solar-mint-echo` (headless).

1. If not logged in → redirect to Google/Apple/Telegram login → redirect back
2. See approval prompt:

```
┌──────────────────────────────────────┐
│                                      │
│         ⬡ Cube Exchange              │
│                                      │
│   "AI Fund" wants access      │
│                                      │
│   This will allow the agent to       │
│   sign transactions on your behalf.  │
│                                      │
│   Key expires: Apr 6, 2026           │
│                                      │
│       [ Approve ]    [ Deny ]        │
│                                      │
└──────────────────────────────────────┘
```

3. Click **Approve** →

```
┌──────────────────────────────────────┐
│                                      │
│         ✓ Connected                  │
│                                      │
│   Cube is now connected.             │
│   You can close this tab.            │
│                                      │
└──────────────────────────────────────┘
```

This page is served by the localhost callback server (interactive) or by Cube's frontend (headless).

---

## Architecture

### Interactive flow (primary)

```
Agent (CLI)                        Cube Backend                    User (Browser)
     │                                  │                               │
     │  1. Start localhost:9876          │                               │
     │                                  │                               │
     │  2. POST /agent/device/code      │                               │
     │  { verificationKey, clientName,  │                               │
     │    callbackUrl }                 │                               │
     │──────────────────────────────────>│                               │
     │  { deviceCode, authorizeUrl }    │                               │
     │<──────────────────────────────────│                               │
     │                                  │                               │
     │  3. open(authorizeUrl)           │                               │
     │  ════════════════════════════════════════════>  browser opens     │
     │                                  │                               │
     │                                  │  4. GET /agent/authorize?...   │
     │                                  │<──────────────────────────────│
     │                                  │  → approval page              │
     │                                  │──────────────────────────────>│
     │                                  │                               │
     │                                  │  5. POST /agent/device/approve│
     │                                  │<──────────────────────────────│
     │                                  │  → registers Ed25519 key      │
     │                                  │  → returns { callbackToken }  │
     │                                  │──────────────────────────────>│
     │                                  │                               │
     │  6. Browser redirects to         │                               │
     │     localhost:9876/callback?      │                               │
     │     token=<callbackToken>        │                               │
     │<═════════════════════════════════════════════  redirect           │
     │                                  │                               │
     │  7. POST /agent/device/token     │                               │
     │  { deviceCode, callbackToken }   │                               │
     │──────────────────────────────────>│                               │
     │  { verificationKeyId,            │                               │
     │    expiresAt, subaccountId }     │                               │
     │<──────────────────────────────────│                               │
     │                                  │                               │
     │  8. Serve "Connected" page       │                               │
     │     & shut down localhost        │                               │
     │──════════════════════════════════════════════> "You can close     │
     │                                  │             this tab."         │
```

### Headless flow (fallback)

Same as interactive but:
- No localhost server started
- No `callbackUrl` sent in step 2
- Backend returns `userCode` (e.g. `brave-solar-mint-echo`) instead
- Agent prints URL for manual opening
- Agent polls `POST /agent/device/token` every 5s until approved

---

## Backend: 3 API Endpoints

All endpoints under `/ir/v0/agent/device/`.

### 1. `POST /ir/v0/agent/device/code`

Agent requests a device code. **No authentication required.**

#### Request

```json
{
  "verificationKey": "CioKIhIglStB1pvcV5IVsmN/R/Sc3ewcm6lGYQ69uQmnx5yknSoQ6L3PzgY=",
  "clientName": "AI Fund",
  "callbackUrl": "http://localhost:9876/callback"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `verificationKey` | string | yes | Base64 protobuf `VerificationKey` (Ed25519 pubkey + expiry) |
| `clientName` | string | yes | Display name on approval page (max 64 chars) |
| `callbackUrl` | string | no | Localhost callback URL. If omitted → headless mode (polling) |

#### Verification Key Format

Same protobuf already used by `auth.cube.exchange` and the existing `/users/verification-keys` system:

```
VerificationKey {
  v0: VerificationKeyV0 {                    // field 1, length-delimited
    publicKey: PublicKey {                    // field 1, length-delimited
      curve25519: bytes                      // field 2, 32 bytes (Ed25519 public key)
    }
    expiresAt: uint64                        // field 2, varint (unix timestamp)
  }
}
```

Wire format (hex):
```
0a 2a                          // field 1 (v0), length 42
  0a 22                        // field 1 (publicKey), length 34
    12 20 <32 bytes pubkey>    // field 2 (curve25519), 32 bytes
  10 <varint>                  // field 2 (expiresAt)
```

Reference: decode any existing key from `GET /ir/v0/users/verification-keys` to verify.

#### Response (200)

**Interactive mode** (callbackUrl provided):

```json
{
  "deviceCode": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "authorizeUrl": "https://cube.exchange/agent/authorize?code=a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "expiresIn": 600,
  "interval": 5
}
```

**Headless mode** (no callbackUrl):

```json
{
  "deviceCode": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "userCode": "brave-solar-mint-echo",
  "authorizeUrl": "https://cube.exchange/agent/brave-solar-mint-echo",
  "expiresIn": 600,
  "interval": 5
}
```

| Field | Type | Description |
|-------|------|-------------|
| `deviceCode` | string | Opaque secret for polling/token exchange. UUID v4. Never shown to user. |
| `userCode` | string | Human-readable pairing code for headless mode. Format: 4 lowercase words joined by hyphens (e.g. `brave-solar-mint-echo`). Displayed in both the terminal and the browser approval page so the user can verify they're approving the right session. Only returned when `callbackUrl` is omitted. |
| `authorizeUrl` | string | URL to open in browser. Interactive mode uses `deviceCode` in query param; headless uses `userCode` in path. |
| `expiresIn` | number | Seconds until code expires (600 = 10 min) |
| `interval` | number | Min polling interval in seconds (headless mode) |

#### Callback URL validation

`callbackUrl` **must** be a localhost URL:
- Scheme: `http` only
- Host: `localhost`, `127.0.0.1`, or `[::1]`
- Port: any
- Path: any
- Reject all other hosts/schemes

#### Backend logic

1. Validate `verificationKey`: decode protobuf, 32-byte curve25519 key, `expiresAt` in the future and ≤ 30 days out
2. Validate `clientName`: 1–64 chars, no control characters
3. If `callbackUrl` provided: validate localhost, store it
4. Generate `deviceCode` (UUID v4)
5. If headless: also generate `userCode` — 4 random words from a curated 256-word list, joined by hyphens (e.g. `brave-solar-mint-echo`). This gives 32 bits of entropy (256^4 = 4 billion combinations), which is sufficient for a 10-minute TTL code. The same code is displayed in the terminal and the browser approval page so the user can visually verify the session.
6. Store in `device_codes` table (see Data Model)
7. Return response

Rate limit: 10 requests/min per IP.

#### Errors

| Status | Body | Reason |
|--------|------|--------|
| 400 | `{ "error": "invalid_verification_key" }` | Malformed protobuf, expired, or too far in future |
| 400 | `{ "error": "invalid_client_name" }` | Empty, too long, or invalid chars |
| 400 | `{ "error": "invalid_callback_url" }` | Non-localhost callback URL |
| 429 | `{ "error": "rate_limited" }` | Too many requests |

---

### 2. `POST /ir/v0/agent/device/approve`

User approves or denies. **Requires authentication** (session cookie).

Called by the frontend approval page after user clicks Approve/Deny.

#### Request

```json
{
  "deviceCode": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "approved": true
}
```

For headless (user code based):
```json
{
  "userCode": "brave-solar-mint-echo",
  "approved": true
}
```

Either `deviceCode` or `userCode` is required (not both).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deviceCode` | string | one of | The device code (interactive mode) |
| `userCode` | string | one of | The user code (headless mode, case-insensitive) |
| `approved` | boolean | yes | true = approve, false = deny |

#### Response — Approved (200)

```json
{
  "status": "approved",
  "verificationKeyId": "d97c889a-fbd8-471d-955d-acc2829dffa5",
  "callbackUrl": "http://localhost:9876/callback",
  "callbackToken": "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9...",
  "expiresAt": 1743955200
}
```

| Field | Type | Description |
|-------|------|-------------|
| `callbackUrl` | string | null | The stored localhost callback URL (null if headless) |
| `callbackToken` | string | Short-lived opaque token for the callback redirect. Agent uses this to prove the browser redirect came from a real approval. |

The frontend uses `callbackUrl` + `callbackToken` to redirect the browser:
```
http://localhost:9876/callback?token=eyJ0eXAi...
```

If `callbackUrl` is null (headless mode), frontend shows "Connected. You can close this tab." inline.

#### Response — Denied (200)

```json
{
  "status": "denied"
}
```

#### Backend logic (approve path)

1. Validate user is authenticated (session cookie)
2. Look up by `deviceCode` or `userCode` (non-expired, status = pending)
3. If not found → `404`
4. If `approved == false`: set status to `denied`, return
5. If `approved == true`:
   a. Decode `verificationKey` protobuf → extract Ed25519 public key
   b. Register via existing verification key system (same as OpenID registration)
   c. Set `registrationMethod: "device"`
   d. Associate with authenticated user's account
   e. Generate short-lived `callbackToken` (HMAC-SHA256 of deviceCode + timestamp, or JWT, expires in 60s)
   f. Update entry: `status = approved`, `userId`, `verificationKeyId`
   g. Return with `callbackUrl` and `callbackToken`

#### Errors

| Status | Body | Reason |
|--------|------|--------|
| 401 | `{ "error": "unauthorized" }` | Not logged in |
| 404 | `{ "error": "code_not_found" }` | Code invalid, expired, or already used |
| 409 | `{ "error": "already_used" }` | Already approved or denied |

---

### 3. `POST /ir/v0/agent/device/token`

Agent exchanges the device code for key registration details. **No authentication required.**

Two usage patterns:
- **Interactive**: Called once after receiving the callback redirect. Includes `callbackToken` for verification.
- **Headless**: Polled repeatedly until approved.

#### Request

```json
{
  "deviceCode": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "callbackToken": "eyJ0eXAi..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `deviceCode` | string | yes | The secret device code from step 1 |
| `callbackToken` | string | no | Token from callback redirect (interactive mode). Skips pending state — returns immediately if valid. |

#### Response — Approved (200)

```json
{
  "verificationKeyId": "d97c889a-fbd8-471d-955d-acc2829dffa5",
  "publicKey": "EiCUxgK/kgIZtV+cGdopP7kO7FFowmZcucDBInc44nINiA==",
  "expiresAt": 1743955200,
  "subaccountId": 1,
  "registrationMethod": "device"
}
```

Agent saves the key details to `~/.cube/credentials.json` and shuts down the localhost server.

#### Response — Pending (400)

```json
{
  "error": "authorization_pending"
}
```

Headless mode only. Agent retries after `interval` seconds.

#### Response — Denied (400)

```json
{
  "error": "access_denied"
}
```

#### Response — Expired (400)

```json
{
  "error": "expired_token"
}
```

#### Response — Slow Down (400)

```json
{
  "error": "slow_down"
}
```

Polling too fast. Increase interval by 5s.

#### Backend logic

1. Look up `deviceCode`
2. Not found → `400 expired_token`
3. If `callbackToken` provided: validate it (HMAC/JWT check, < 60s old). If valid and status = approved → return 200 immediately. If invalid → `400 { "error": "invalid_token" }`.
4. If no `callbackToken` (polling mode):
   - Expired → `400 expired_token`, delete
   - Pending → `400 authorization_pending`
   - Denied → `400 access_denied`, delete
   - Approved → `200` with key details, delete
5. Rate limit polls: if polled faster than `interval` → `400 slow_down`

---

## Frontend: Approval Page

### Routes

| Route | Description |
|-------|-------------|
| `/agent/authorize?code=<deviceCode>` | Interactive mode — code in query param |
| `/agent/<userCode>` | Headless mode — human-readable code in path |
| `/agent` | Manual entry — input field for user code |

All three render the same React component with different initial state.

### Authentication gate

If not logged in → redirect to login (Google/Apple/Telegram) with return URL back to the agent page. After login, user lands on the approval prompt automatically.

### Page states

**1. Loading**
- Fetch device info: `GET /ir/v0/agent/device/info?code=<deviceCode>` or `?userCode=brave-solar-mint-echo`

**2. Approval prompt**
```
┌──────────────────────────────────────┐
│                                      │
│         ⬡ Cube Exchange              │
│                                      │
│   "AI Fund" wants access      │
│                                      │
│   This will allow the agent to       │
│   sign transactions on your behalf.  │
│                                      │
│   Key expires: Apr 6, 2026           │
│                                      │
│       [ Approve ]    [ Deny ]        │
│                                      │
└──────────────────────────────────────┘
```

**3. Approved — Interactive mode**
- POST approve → get `callbackUrl` + `callbackToken`
- Redirect browser to `callbackUrl?token=callbackToken`
- The localhost server serves a "Connected" page (see below)

**4. Approved — Headless mode** (no callbackUrl in response)
```
┌──────────────────────────────────────┐
│                                      │
│         ✓ Connected                  │
│                                      │
│   Cube is now connected to your      │
│   agent. You can close this tab.     │
│                                      │
└──────────────────────────────────────┘
```

**5. Denied**
```
┌──────────────────────────────────────┐
│                                      │
│         ✗ Connection denied          │
│                                      │
└──────────────────────────────────────┘
```

**6. Error / Expired**
```
┌──────────────────────────────────────┐
│                                      │
│   This link has expired or is        │
│   invalid. Ask the agent to          │
│   try again.                         │
│                                      │
└──────────────────────────────────────┘
```

**7. Manual entry** (`/agent` base route)
```
┌──────────────────────────────────────┐
│                                      │
│   Enter agent code                   │
│                                      │
│   [ CUBE-______ ]    [ Connect ]     │
│                                      │
└──────────────────────────────────────┘
```

### Frontend → Backend calls

1. On load: `GET /ir/v0/agent/device/info?code=...` or `?userCode=...`
2. Approve: `POST /ir/v0/agent/device/approve` → if callbackUrl → redirect browser to it
3. Deny: `POST /ir/v0/agent/device/approve` with `approved: false`

All calls use session cookie (same-origin).

### Localhost "Connected" page

When the browser redirects to `http://localhost:9876/callback?token=...`, the agent's localhost server responds with a simple HTML page:

```html
<!DOCTYPE html>
<html>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fff;">
  <div style="text-align: center;">
    <div style="font-size: 48px; margin-bottom: 16px;">✓</div>
    <h1 style="margin: 0 0 8px;">Connected</h1>
    <p style="color: #888;">Cube is now connected. You can close this tab.</p>
  </div>
</body>
</html>
```

This is exactly like Cloudflare's wrangler — after redirect, you see a success page and close the tab.

---

## Data Model

### `device_codes` table

| Column | Type | Description |
|--------|------|-------------|
| `device_code` | UUID | Primary key, secret polling token |
| `user_code` | VARCHAR(10) | Human-readable code (headless only), unique among active |
| `verification_key` | TEXT | Base64 protobuf VerificationKey |
| `client_name` | VARCHAR(64) | Agent display name |
| `callback_url` | TEXT | Localhost callback URL (null = headless mode) |
| `callback_token` | TEXT | Short-lived token for redirect verification (set on approve) |
| `status` | ENUM('pending', 'approved', 'denied') | Current state |
| `created_at` | TIMESTAMP | When code was generated |
| `expires_at` | TIMESTAMP | created_at + 10 min |
| `user_id` | UUID | Set on approval — who approved |
| `verification_key_id` | UUID | Set on approval — FK to registered key |
| `last_polled_at` | TIMESTAMP | For rate limiting polls |

**Indexes:**
- Primary: `device_code`
- Unique: `user_code` WHERE status = 'pending' AND expires_at > now()
- TTL: delete all rows older than 1 hour

---

## Security

- **Callback URL must be localhost** — validated server-side. No external redirects possible.
- **callbackToken is short-lived** (60s) — prevents replay. HMAC-signed with server secret, includes deviceCode + timestamp.
- **deviceCode is secret** — only the requesting agent knows it. Never shown to user, never in human-readable URLs.
- **Private key never leaves the agent** — only the public key is transmitted.
- **10-minute expiry** on device codes — short window limits phishing.
- **Single-use** — once approved/denied, code can't be reused.
- **Authenticated approval** — only a logged-in user can approve.
- **Rate limiting** — 10 code requests/min per IP. Polling enforced at `interval` seconds.
- **Existing key infrastructure** — registered keys go through the same system as OpenID keys, including expiry and `GET/DELETE /ir/v0/users/verification-keys` management.

---

## Cleanup / TTL

- Pending entries: delete after `expires_at` (10 min)
- Approved/denied entries: delete after 1 hour
- Cron or DB TTL indexes

---

## Scoped Permissions (Future — Not P0)

Not in scope for P0. Currently all signing keys have full access. Future work:
- Allow agents to request specific scopes (read-only, trade-only, swap-only)
- Show requested scopes on approval page
- Enforce scopes when validating signed intents

---

## Test Plan

| # | Scenario | Expected |
|---|----------|----------|
| 1 | **Happy path (interactive)** | CLI starts localhost → opens browser → user approves → browser redirects to localhost → CLI gets key → key in `/users/verification-keys` with `registrationMethod: device` |
| 2 | **Happy path (headless)** | CLI prints URL → user opens manually → approves → CLI polls and gets key |
| 3 | **Deny** | User clicks Deny → CLI gets `access_denied` |
| 4 | **Expiry** | Wait 10+ min → CLI gets `expired_token` |
| 5 | **Not logged in** | Open approval URL without session → redirected to login → back to approval |
| 6 | **Invalid code** | Open `/agent/CUBE-XXXX` with bad code → "expired or invalid" |
| 7 | **Callback token replay** | Use same callbackToken after 60s → rejected |
| 8 | **Non-localhost callback** | Send `callbackUrl: "https://evil.com"` → `400 invalid_callback_url` |
| 9 | **Rate limit** | Poll faster than interval → `slow_down` |
| 10 | **Malformed key** | Send garbage verificationKey → `400 invalid_verification_key` |
| 11 | **Double approve** | Approve same code twice → `409 already_used` |
| 12 | **Port conflict** | Localhost port 9876 in use → CLI tries next port (9877, 9878...) |
| 13 | **Browser can't open** | `open` fails → auto-fallback to headless mode with printed URL |

---

## Reference: Existing Verification Key System

The agent auth flow registers keys into the **existing** verification key system:

- `GET /ir/v0/users/verification-keys` — lists all registered keys (HMAC API key auth)
- Each key: `id`, `publicKey` (base64 protobuf), `issuedAt`, `expiresAt`, `registrationMethod`
- Current `registrationMethod` values: `"openId"` (Google/Apple web login)
- New from this feature: `"device"`
- Keys sign orders and DeFi intents via wallet WebSocket (`wss://api.cube.exchange/os/wallet`)
- The `publicKey` field in API responses is the inner `PublicKey` protobuf (`0x12 0x20 <32 bytes>`), not the full `VerificationKey` envelope

## Reference: Cloudflare Wrangler Pattern

This design follows the same UX pattern as `wrangler login`:

| Aspect | Cloudflare Wrangler | Cube Agent Auth |
|--------|-------------------|-----------------|
| Mechanism | OAuth 2.0 Authorization Code + PKCE | Custom device code + Ed25519 key registration |
| Localhost port | 8976 | 9876 |
| Browser page | `dash.cloudflare.com/oauth2/auth` | `cube.exchange/agent/authorize?code=...` |
| After approval | Redirect to `localhost:8976/oauth/callback` | Redirect to `localhost:9876/callback?token=...` |
| Success page | "Wrangler is now authorized!" | "Cube is now connected." |
| Headless fallback | API tokens / manual `curl` | Polling-based with `CUBE-XXXX` user code |
| Token storage | `~/.wrangler/config/default.toml` | `~/.cube/credentials.json` |
| Token refresh | OAuth refresh token | Re-run login (6-day key expiry) |

Key difference: Cloudflare uses standard OAuth with access/refresh tokens. Cube registers an Ed25519 signing key — no tokens to refresh, the key itself is the credential until it expires.
