# Alpaca Connector Architecture

## Overview

The Alpaca connector provides access to stocks, ETFs, and crypto through Alpaca's trading API. It has the simplest architecture of the built-in connectors: a single REST client with four tool groups. Paper trading is built in via Alpaca's native sandbox.

## Component Diagram

```
Claude Code (MCP protocol)
    │
    ▼
┌──────────────┐
│  index.ts    │  ← MCP server entry point
│  McpServer   │
└──────┬───────┘
       │
       ▼
  Tools (4 files)
       │
       ▼
┌──────────────┐
│ AlpacaClient │  ← Single REST API wrapper
│   (api.ts)   │
└──────┬───────┘
       │
       ▼
  Alpaca API
```

## Directory Layout

```
mcp-server/src/
├── index.ts              Entry point — resolves credentials, creates client
├── cli/
│   ├── login.ts          Store API credentials
│   ├── logout.ts         Clear credentials
│   └── status.ts         Check auth and connectivity
├── client/
│   ├── api.ts            Alpaca REST API wrapper
│   └── credential-store.ts  API key persistence
├── tools/
│   ├── account.ts        get_positions, get_account
│   ├── analysis.ts       Technical analysis tools
│   ├── market-data.ts    get_tickers, get_bars, search_assets
│   └── orders.ts         place_order, cancel_order, get_fills
└── tests/                7 test files
```

## Key Invariants

1. **Paper by default**: `APCA_PAPER=true` unless explicitly set to `false`. Uses Alpaca's paper trading endpoint.
2. **Credential priority**: Environment variables (`APCA_API_KEY_ID`, `APCA_API_SECRET_KEY`) take precedence over credential store.
3. **Single client**: No WebSocket — all operations are REST-based.
4. **Multi-asset**: Supports stocks, ETFs, and crypto through the same API.

## Extension Points

- **Add a new tool group**: Create `src/tools/my-tools.ts` with a `registerMyTools()` function, call from `index.ts`. Follow `account.ts` as a pattern.
- **Add WebSocket support**: Create `src/client/stream.ts` wrapping Alpaca's streaming API, initialize lazily from `index.ts`.
- **Add options/futures**: Extend `api.ts` with new endpoint methods, register corresponding tools.

## Auth Flow

```
npx tsx src/cli/login.ts
  1. Prompt for API key ID and secret
  2. Store in credential store
  3. Verify with a test account call
```

Alternatively, set environment variables:
```
export APCA_API_KEY_ID=...
export APCA_API_SECRET_KEY=...
export APCA_PAPER=true
```

## Risk Considerations

- Simplest connector — low complexity, low risk.
- `api.ts` is the single point of failure — all tools depend on it.
- No rate limiting built in — relies on Alpaca's generous limits.
