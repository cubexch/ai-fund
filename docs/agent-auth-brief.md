# Agent Auth: Device Authorization Flow for AI Agents

## Overview

Build a Device Authorization Grant (RFC 8628) flow that lets AI agents (MCP servers, Claude Code, CLI tools) register Ed25519 signing keys with Cube Exchange. The agent generates a keypair locally, requests approval, opens the user's browser to a one-click approval page, and polls until approved — no redirects, no cookies, no API keys needed.

## User Experience

### Agent side (terminal)

```
$ npx cube-auth login

Generated signing key.
Opening browser for approval...

Waiting for approval... (approve at cube.exchange/agent)

Approved! Key registered (expires Apr 6, 2026)
Saved to ~/.cube/credentials.json
```

The CLI opens the browser automatically. The user never sees or types a code — it's embedded in the URL.

If the browser can't be opened (headless/SSH), falls back to displaying the URL:

```
$ npx cube-auth login

Generated signing key.
Could not open browser. Open this URL manually:

  https://cube.exchange/agent/CUBE-A3X7

Waiting for approval...
```

### Human side (browser)

The browser opens directly to `cube.exchange/agent/CUBE-A3X7`. The code is in the URL — no typing needed.

1. Page loads with the request pre-filled (already logged in via Google/Apple/Telegram)
2. See: **"AI Crypto Fund" wants to connect** — key expires Apr 6, 2026
3. Click **Approve**
4. See: "Connected. You can close this tab."
5. CLI in the terminal picks it up automatically

If not logged in, the page redirects to login first, then back to the approval page.

## Architecture

```
Agent (CLI/MCP)                    Cube Backend                    User (Browser)
     |                                  |                               |
     |  POST /agent/device/code         |                               |
     |  { verificationKey, clientName } |                               |
     |--------------------------------->|                               |
     |  { deviceCode, userCode,         |                               |
     |    verificationUriComplete }     |                               |
     |<---------------------------------|                               |
     |                                  |                               |
     |  open(verificationUriComplete)   |                               |
     |  ================================================>  browser opens
     |                                  |                               |
     |                                  |   GET /agent/CUBE-A3X7        |
     |                                  |<------------------------------|
     |                                  |   page: "Approve this agent?" |
     |                                  |------------------------------>|
     |                                  |                               |
     |                                  |   POST /agent/device/approve  |
     |                                  |   { userCode, approved }      |
     |                                  |<------------------------------|
     |                                  |                               |
     |                                  |  [registers Ed25519 key       |
     |                                  |   for authenticated user]     |
     |                                  |                               |
     |  POST /agent/device/token        |                               |
     |  { deviceCode }                  |                               |
     |--------------------------------->|                               |
     |  { verificationKeyId,            |                               |
     |    expiresAt, subaccountId }     |                               |
     |<---------------------------------|                               |
```

## Backend: 4 API Endpoints

All endpoints live under `/ir/v0/agent/device/`. They follow RFC 8628 semantics and error codes.

### 1. `POST /ir/v0/agent/device/code`

Agent requests a device code. **No authentication required** (the agent has no credentials yet).

#### Request

```json
{
  "verificationKey": "CioKIhIglStB1pvcV5IVsmN/R/Sc3ewcm6lGYQ69uQmnx5yknSoQ6L3PzgY=",
  "clientName": "AI Crypto Fund"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `verificationKey` | string | yes | Base64-encoded protobuf `VerificationKey` containing Ed25519 public key + expiry |
| `clientName` | string | yes | Display name shown to user on approval page (max 64 chars) |

#### Verification Key Format

The `verificationKey` is a protobuf-encoded message. This is the same format already used by `auth.cube.exchange` and stored in the existing `users/verification-keys` system.

```
VerificationKey {
  v0: VerificationKeyV0 {                    // field 1, length-delimited
    publicKey: PublicKey {                    // field 1, length-delimited
      curve25519: bytes                      // field 2, length-delimited, 32 bytes
    }
    expiresAt: uint64                        // field 2, varint (unix timestamp)
  }
}
```

Wire format example (hex):
```
0a        field 1 (v0), wire type 2 (length-delimited)
2a        length 42
  0a      field 1 (publicKey), wire type 2
  22      length 34
    12    field 2 (curve25519), wire type 2
    20    length 32
    <32 bytes of Ed25519 public key>
  10      field 2 (expiresAt), wire type 0 (varint)
  <varint-encoded unix timestamp>
```

Reference: decode any existing key from `GET /ir/v0/users/verification-keys` — the `publicKey` field on each key is the inner `PublicKey` protobuf (just `0x12 0x20 <32 bytes>`). The full `VerificationKey` wraps it with the `v0`/`expiresAt` envelope.

#### Response (200)

```json
{
  "deviceCode": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "userCode": "CUBE-A3X7",
  "verificationUri": "https://cube.exchange/agent",
  "verificationUriComplete": "https://cube.exchange/agent/CUBE-A3X7",
  "expiresIn": 600,
  "interval": 5
}
```

| Field | Type | Description |
|-------|------|-------------|
| `deviceCode` | string | Opaque secret token for polling. Never shown to user. UUID v4. |
| `userCode` | string | Short code embedded in URL. Format: `CUBE-XXXX` (4 alphanumeric chars, uppercase, no ambiguous chars 0/O/1/I/L). |
| `verificationUri` | string | Base URL for manual entry |
| `verificationUriComplete` | string | **Primary URL the agent opens in the browser.** Code is in the path — no manual entry needed. |
| `expiresIn` | number | Seconds until this code expires (600 = 10 minutes) |
| `interval` | number | Minimum polling interval in seconds |

#### Backend Logic

1. Validate `verificationKey`: decode protobuf, ensure 32-byte curve25519 key, ensure `expiresAt` is in the future and not more than 30 days out
2. Generate `deviceCode` (UUID v4) and `userCode` (`CUBE-` + random 4 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`)
3. Store in a `device_codes` table/store:
   ```
   {
     deviceCode: uuid,
     userCode: "CUBE-A3X7",
     verificationKey: "<base64>",
     clientName: "AI Crypto Fund",
     status: "pending",
     createdAt: now,
     expiresAt: now + 600s,
     userId: null,
     keyId: null
   }
   ```
4. User codes must be unique among non-expired entries
5. Rate limit: 10 requests per minute per IP. Return `429` with `Retry-After` header if exceeded.

#### Errors

| Status | Code | Reason |
|--------|------|--------|
| 400 | E10002 | Invalid verificationKey (malformed protobuf, expired, too far in future) |
| 400 | E10002 | clientName too long or empty |
| 429 | E10003 | Rate limited |

---

### 2. `POST /ir/v0/agent/device/token`

Agent polls this endpoint to check if the user has approved. **No authentication required.**

#### Request

```json
{
  "deviceCode": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

#### Response — Pending (400)

```json
{
  "error": "authorization_pending"
}
```

Agent should retry after `interval` seconds.

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

This is the signal to the agent that the key is registered and ready to use.

#### Response — Denied (400)

```json
{
  "error": "access_denied"
}
```

User explicitly denied. Agent should exit.

#### Response — Expired (400)

```json
{
  "error": "expired_token"
}
```

The 10-minute window passed without approval. Agent should restart the flow.

#### Response — Slow Down (400)

```json
{
  "error": "slow_down"
}
```

Agent is polling too fast. Increase interval by 5 seconds.

#### Backend Logic

1. Look up `deviceCode` in the store
2. If not found: return `400 { "error": "expired_token" }`
3. If expired (createdAt + 600s < now): return `400 { "error": "expired_token" }`, delete entry
4. If status == "pending": return `400 { "error": "authorization_pending" }`
5. If status == "denied": return `400 { "error": "access_denied" }`, delete entry
6. If status == "approved": return `200` with key details, delete entry
7. Track last poll time per deviceCode. If polled faster than `interval`: return `400 { "error": "slow_down" }`

---

### 3. `GET /ir/v0/agent/device/info?userCode=CUBE-A3X7`

Frontend calls this to show request details before the user approves. **Requires authentication** (session cookie or HMAC API key).

#### Response (200)

```json
{
  "clientName": "AI Crypto Fund",
  "verificationKeyExpiresAt": 1743955200,
  "createdAt": 1743436800
}
```

#### Response (404)

```json
{
  "error": "code_not_found"
}
```

Code is invalid, expired, or already used.

---

### 4. `POST /ir/v0/agent/device/approve`

User approves or denies the agent request. **Requires authentication** (session cookie or HMAC API key).

#### Request

```json
{
  "userCode": "CUBE-A3X7",
  "approved": true
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userCode` | string | yes | The code from the URL (case-insensitive matching) |
| `approved` | boolean | yes | true = approve, false = deny |

#### Response — Approved (200)

```json
{
  "status": "approved",
  "verificationKeyId": "d97c889a-fbd8-471d-955d-acc2829dffa5",
  "clientName": "AI Crypto Fund",
  "expiresAt": 1743955200
}
```

#### Response — Denied (200)

```json
{
  "status": "denied"
}
```

#### Backend Logic (Approve Path)

1. Validate user is authenticated (session or API key auth)
2. Look up `userCode` in device_codes store (case-insensitive, non-expired, status == "pending")
3. If not found: return `404 { "error": "code_not_found" }`
4. If `approved == false`: set status to "denied", return
5. If `approved == true`:
   a. Decode the `verificationKey` protobuf to extract the Ed25519 public key
   b. Register it via the **existing** verification key registration system (same as `POST /ir/v0/users/verification-keys` does internally for OpenID registrations)
   c. Set `registrationMethod: "device"` (vs `"openId"` for Google/Apple flow)
   d. Associate with the authenticated user's account
   e. Update device_codes entry: `status = "approved"`, `userId`, `keyId`
   f. Return the key details

#### Errors

| Status | Code | Reason |
|--------|------|--------|
| 401 | E99999 | Missing or invalid authentication |
| 404 | E10000 | User code not found or expired |
| 409 | E99999 | User code already approved/denied |

---

## Frontend: `/agent/[code]` Page

A single page at `cube.exchange/agent/CUBE-A3X7` that shows the approval prompt.

### Route Structure

- `/agent` — Base page with a text input to enter a code manually (fallback for when URL can't be opened)
- `/agent/[code]` — Direct approval page with code pre-loaded from the URL path

Both routes render the same component. The `[code]` variant just skips the input step.

### Requires Authentication

If the user is not logged in, redirect to `/login` with a return URL back to `/agent/[code]`. After login (Google/Apple/Telegram), they land back on the approval page automatically.

### Page States

**1. Loading** (code in URL, fetching info)

```
┌──────────────────────────────────┐
│                                  │
│         Loading...               │
│                                  │
└──────────────────────────────────┘
```

Calls `GET /ir/v0/agent/device/info?userCode=CUBE-A3X7` to fetch details.

**2. Approval Prompt** (info loaded)

```
┌──────────────────────────────────┐
│                                  │
│  "AI Crypto Fund"                │
│  wants to connect                │
│                                  │
│  This agent will be able to      │
│  trade and sign transactions     │
│  on your behalf.                 │
│                                  │
│  Expires: Apr 6, 2026            │
│                                  │
│  [Approve]     [Deny]            │
│                                  │
└──────────────────────────────────┘
```

**3. Success**

```
┌──────────────────────────────────┐
│                                  │
│  Connected.                      │
│  You can close this tab.         │
│                                  │
└──────────────────────────────────┘
```

**4. Denied**

```
┌──────────────────────────────────┐
│                                  │
│  Connection denied.              │
│                                  │
└──────────────────────────────────┘
```

**5. Error / Expired**

```
┌──────────────────────────────────┐
│                                  │
│  This link has expired.          │
│  Ask the agent to try again.     │
│                                  │
└──────────────────────────────────┘
```

**6. Manual Entry** (no code in URL, `/agent` base route)

```
┌──────────────────────────────────┐
│                                  │
│  Enter agent code                │
│                                  │
│  [CUBE-_ _ _ _]  [Connect]      │
│                                  │
└──────────────────────────────────┘
```

After entering, navigates to `/agent/CUBE-XXXX` or directly fetches info and shows the approval prompt.

### API Calls

1. On load (if code in URL): `GET /ir/v0/agent/device/info?userCode=CUBE-A3X7`
2. On Approve click: `POST /ir/v0/agent/device/approve` with `{ userCode, approved: true }`
3. On Deny click: `POST /ir/v0/agent/device/approve` with `{ userCode, approved: false }`

All calls include session cookie automatically (same-origin).

---

## Data Model

### `device_codes` table

| Column | Type | Description |
|--------|------|-------------|
| `device_code` | UUID | Primary key, the secret polling token |
| `user_code` | VARCHAR(10) | Human-readable code, unique among active entries |
| `verification_key` | TEXT | Base64-encoded protobuf VerificationKey |
| `client_name` | VARCHAR(64) | Display name of the agent |
| `status` | ENUM('pending', 'approved', 'denied') | Current state |
| `created_at` | TIMESTAMP | When the code was generated |
| `expires_at` | TIMESTAMP | When the code expires (created_at + 10 min) |
| `user_id` | UUID | Set when approved, the user who approved |
| `verification_key_id` | UUID | Set when approved, FK to registered verification keys |
| `last_polled_at` | TIMESTAMP | For rate limiting polls |

- Index on `user_code` (unique among status='pending' + non-expired)
- Index on `device_code`
- TTL/cleanup: delete entries older than 1 hour regardless of status

---

## Security

- **User codes expire in 10 minutes** — short window limits phishing risk
- **User codes are single-use** — once approved/denied, can't be reused
- **deviceCode is secret** — only the agent that requested it knows it; never in URLs or shown to user
- **No credentials transmitted** — the Ed25519 private key never leaves the agent's machine; only the public key is sent
- **Rate limiting** — 10 code requests/min per IP, polling enforced at `interval` seconds
- **Authentication required for approval** — only a logged-in user can approve
- **Existing key infrastructure** — registered keys go through the same system as OpenID-registered keys, including expiry and the ability to list/revoke via `GET/DELETE /ir/v0/users/verification-keys`

---

## Cleanup / TTL

- Pending entries: delete after `expiresAt` (10 minutes)
- Approved/denied entries: delete after 1 hour (agent has already polled the result)
- Run cleanup on a cron or use DB TTL indexes

---

## Test Plan

1. **Happy path**: Agent requests code → CLI opens browser → user clicks Approve → agent polls and gets key ID → key appears in `GET /ir/v0/users/verification-keys` with `registrationMethod: "device"`
2. **Denial**: Agent requests code → user clicks Deny → agent polls and gets `access_denied`
3. **Expiry**: Agent requests code → wait 10+ minutes → agent polls and gets `expired_token`
4. **Not logged in**: Open `/agent/CUBE-A3X7` without session → redirected to login → redirected back → approval prompt shown
5. **Invalid code**: Open `/agent/CUBE-XXXX` with wrong code → "expired or invalid" message
6. **Rate limiting**: Agent polls faster than interval → gets `slow_down`
7. **Malformed verificationKey**: Agent sends garbage → `400` with clear error
8. **Unauthenticated approval**: Call approve endpoint without session → `401`
9. **Already used code**: Approve same code twice → `409`
10. **Manual entry fallback**: Open `/agent` (no code) → input field shown → enter code → approval prompt
11. **Headless fallback**: Agent can't open browser → prints URL to terminal → user opens manually → same approval flow

---

## Reference: Existing Verification Key System

The agent auth flow registers keys into the **existing** verification key system. For context:

- `GET /ir/v0/users/verification-keys` — lists all registered keys (works with HMAC API key auth)
- Each key has: `id`, `publicKey` (base64 protobuf), `issuedAt`, `expiresAt`, `registrationMethod`
- Existing `registrationMethod` values: `"openId"` (Google/Apple via web login)
- New value from this feature: `"device"` (agent device code flow)
- Keys are used to sign orders and DeFi intents via the wallet WebSocket (`wss://api.cube.exchange/os/wallet`)
- The `publicKey` field in the API response is the inner `PublicKey` protobuf (`0x12 0x20 <32 bytes>`), not the full `VerificationKey` envelope
