# Robinhood Connector Architecture

> **Status**: Auth-ready, crypto-only, awaiting official API tool implementation.

## Scope

This connector targets **Robinhood's official crypto API only** (docs.robinhood.com/crypto/trading). Stocks, ETFs, and options are not supported — there is no official public API for those asset classes. For US equities, use the Alpaca connector.

## Component Diagram

```
┌─────────────────────────────────────────────────┐
│                 MCP Server (index.ts)            │
│  Registers tool handlers from src/tools/         │
├─────────────────────────────────────────────────┤
│           Tool Layer (placeholder)               │
│  market-data.ts │ orders.ts │ account.ts         │
│  (empty — awaiting official crypto API)          │
├─────────────────────────────────────────────────┤
│              Client Layer                        │
│  api.ts          HTTP client with retry/backoff  │
│  auth.ts         OAuth2 + MFA + verification     │
│  http.ts         TLS-fingerprint-safe HTTPS      │
│  credential-store.ts  Cross-platform keychain    │
├─────────────────────────────────────────────────┤
│             CLI Layer                            │
│  login.ts │ logout.ts │ status.ts                │
└─────────────────────────────────────────────────┘
```

## Directory Layout

```
mcp-server/
├── src/
│   ├── index.ts              MCP server entry point
│   ├── client/
│   │   ├── api.ts            RobinhoodClient (GET/POST/pagination/retry)
│   │   ├── auth.ts           AuthManager (OAuth2, MFA, verification)
│   │   ├── http.ts           Raw HTTPS with Chrome-like TLS fingerprint
│   │   └── credential-store.ts  Keychain → libsecret → file fallback
│   ├── tools/
│   │   ├── market-data.ts    Placeholder
│   │   ├── orders.ts         Placeholder
│   │   └── account.ts        Placeholder
│   └── cli/
│       ├── login.ts          Interactive login
│       ├── logout.ts         Delete credentials
│       └── status.ts         Check auth status
└── tests/
    ├── auth.test.ts           16 tests — OAuth2 format validation
    ├── api-client.test.ts     13 tests — retry, pagination, errors
    └── credential-store.test.ts 10 tests — save/load/expiry
```

## Key Invariants

1. **Crypto only**: No stock, ETF, or options endpoints. This is enforced by the absence of any non-crypto tool implementations.

2. **robin_stocks compatibility**: The HTTP layer exactly replicates Python `robin_stocks` session headers, form encoding, and cipher suite ordering. This avoids CloudFront WAF TLS fingerprint blocking.

3. **Cross-platform credentials**: Priority chain: macOS Keychain → Linux libsecret → file fallback (`~/.robinhood/credentials.json` with 0o600 permissions).

4. **Token expiry with buffer**: `loadCredentials()` returns null if the token expires within 5 minutes. `loadCredentialsRaw()` returns expired tokens for refresh flow.

5. **Retry with backoff**: API client retries on 401 (auth refresh) and 429 (rate limit) with exponential backoff (1s, 2s, 4s). Max 3 retries.

## Auth Flow

```
User credentials
  → AuthManager.login(username, password)
    → POST /oauth2/token/ (form-encoded, robin_stocks format)
      → Response: success | mfa_required | verification_workflow | error
        → If MFA: re-call with mfaCode
        → If verification: poll /pathfinder/ until approved
        → If success: save tokens to credential store
```

## Extension Points

When the official crypto API launches:
- Implement `registerMarketDataTools()` in `src/tools/market-data.ts`
- Implement `registerOrderTools()` in `src/tools/orders.ts`
- Implement `registerAccountTools()` in `src/tools/account.ts`
- All tools should use `RobinhoodClient` for authenticated requests
- Use `toolError()` from `@ai-fund/lib/tool-errors` for error responses
