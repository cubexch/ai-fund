# Cube Connector Architecture

## Overview

The Cube connector bridges Claude Code to the Cube Exchange via three specialized clients: REST (Iridium), WebSocket market data (Mendelev), and WebSocket trading (Osmium). It uses Ed25519 verification key authentication with device authorization flow (RFC 8628).

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
  ┌────┴────┐
  ▼         ▼
Tools (7)  Resources (2)
  │         │
  ▼         ▼
┌─────────────────────────────────────────┐
│           Client Layer                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐│
│  │ Iridium  │ │Mendelev  │ │ Osmium   ││
│  │ (REST)   │ │ (WS data)│ │(WS trade)││
│  └──────────┘ └──────────┘ └──────────┘│
│  ┌──────────┐ ┌──────────┐ ┌──────────┐│
│  │  auth.ts │ │signing.ts│ │cred-store││
│  └──────────┘ └──────────┘ └──────────┘│
└─────────────────────────────────────────┘
       │
       ▼
  Cube Exchange API
```

## Directory Layout

```
mcp-server/src/
├── index.ts              Entry point — creates McpServer, clients, registers tools
├── cli/
│   ├── cube.ts           CLI wrapper (1877 lines — refactor candidate)
│   ├── device-login.ts   RFC 8628 device authorization flow
│   ├── logout.ts         Clear credentials
│   └── status.ts         Check auth and connectivity
├── client/
│   ├── iridium.ts        REST API client (markets, account, orders)
│   ├── mendelev.ts       WebSocket market data (no auth required)
│   ├── osmium.ts         WebSocket trading (Ed25519 auth)
│   ├── auth.ts           Verification key resolution
│   ├── device-auth.ts    Device authorization helpers
│   ├── credential-store.ts  Persistent credential storage
│   └── signing.ts        Ed25519 signing utilities
├── tools/
│   ├── account.ts        get_positions, get_account, get_fills, etc.
│   ├── analysis.ts       get_technical_analysis, confluence, squeeze
│   ├── content.ts        Content discovery
│   ├── defi.ts           DeFi trading tools
│   ├── market-data.ts    get_tickers, get_bars, get_quote, etc.
│   ├── orders.ts         place_order, cancel_order, execute_trade
│   └── risk.ts           calculate_position_size, stress test
├── resources/
│   ├── markets.ts        Market metadata resource
│   └── portfolio.ts      Portfolio state resource
└── tests/                20 test files
```

## Key Invariants

1. **Three-client architecture**: Iridium (REST) is always available as fallback. Mendelev (WS) connects eagerly for real-time market data. Osmium (WS) connects lazily only when trading is needed.
2. **Auth is separate from connectivity**: All tools register regardless of auth. Public endpoints (market data) work without auth. Trading tools return auth errors at call time.
3. **Ed25519 signing**: All authenticated requests are signed with a locally-generated Ed25519 keypair. No API keys transit the wire.
4. **WebSocket auto-reconnect**: Mendelev falls back to REST on connection failure.

## Extension Points

- **Add a new tool**: Create a `registerXTools()` function in `src/tools/`, call it from `index.ts`. Follow the pattern in `account.ts`.
- **Add a new resource**: Create a `registerXResources()` function in `src/resources/`, call it from `index.ts`.
- **Add a CLI command**: Add a case to `PUBLIC_COMMANDS` in `src/cli/cube.ts` with path, target tool/resource, and renderer.

## Auth Flow

```
npx tsx src/cli/device-login.ts
  1. Generate Ed25519 keypair locally
  2. Request device code from Cube
  3. User opens URL in browser, approves
  4. Poll until approved (up to 10 minutes)
  5. Store verification key in credential store
```

## Risk Considerations

- `src/cli/cube.ts` (1877 lines) is the highest-risk file — large fan-in, handles all CLI routing. Splitting by command groups and renderers is a planned refactor.
- `src/client/iridium.ts` has high fan-in — all tools depend on it.
