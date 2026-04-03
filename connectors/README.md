# Exchange Connectors

ai-fund connects to exchanges via typed connectors that implement `ExchangeConnector` from `lib/connector-interface.ts`. Skills are connector-agnostic — add an exchange, no skill files change. Write a skill, no connector files change.

## Available Connectors

| Exchange | Connector | Install | Status |
|----------|-----------|---------|--------|
| **[Cube Exchange](https://cube.exchange)** | Built-in | Ships with this repo | ✅ Ready — 200μs matching, lowest fees |
| **[Alpaca](https://alpaca.markets)** | Built-in | Ships with this repo | ✅ Ready — stocks, ETFs, crypto, paper trading |
| **[OKX](https://okx.com)** | `@okx_ai/okx-trade-mcp` | `npm i -g @okx_ai/okx-trade-mcp` | ✅ Ready — 107 tools, spot/futures/options |
| **[Kraken](https://kraken.com)** | `kraken-cli` | [Install Kraken CLI](https://github.com/krakenfx/kraken-cli) | ✅ Ready — 134 commands, built-in paper trading |
| **[Binance](https://binance.com)** | `ccxt-mcp` | `npm i -g ccxt-mcp` | ✅ Via CCXT — 100+ exchanges |
| **[Bybit](https://bybit.com)** | `ccxt-mcp` | `npm i -g ccxt-mcp` | ✅ Via CCXT |
| **[Robinhood](https://robinhood.com)** | Built-in | Ships with this repo | 🗓 Roadmap — crypto only (official API), no stocks |
| **[Coinbase](https://coinbase.com)** | `@coinbase/agentkit` | [AgentKit docs](https://github.com/coinbase/agentkit) | ✅ Ready — wallet + trading |
| **[Hyperliquid](https://hyperliquid.xyz)** | Community MCP | [Options](https://github.com/search?q=hyperliquid+mcp) | 🔧 Community |

## Architecture

All connectors implement `ExchangeConnector` from `lib/connector-interface.ts`. Skills call the interface, never the connector directly:

```
Agent (skill)
  → ExchangeConnector interface (lib/connector-interface.ts)
    → Connector (connectors/<name>/index.ts)
      → Exchange REST API (direct HTTP calls)
```

No MCP-to-MCP indirection. No leaked tool surfaces. Each connector is a thin REST wrapper.

## Credentials

All connectors store secrets outside the repo via the shared credential store (`lib/credential-store.ts`):
- macOS: system keychain
- Linux: libsecret
- Fallback: `~/.ai-fund/<connector>/credentials.json` (0600 permissions)

Environment variables are accepted as a fallback for CI/testing only.

## Adding a Connector

1. Create `connectors/<name>/`
2. Implement `ExchangeConnector` from `lib/connector-interface.ts`
3. Use `lib/credential-store.ts` for secrets
4. Register in `lib/connector-registry.ts` on setup
5. Add to `/setup` command
6. Write README and tests
7. Paper/testnet must be the default

## Quick Setup

### Cube Exchange (built-in, recommended)

```bash
cd connectors/cube/mcp-server && npm run login
```

### Alpaca (US equities)

Run `/setup` → select Alpaca → enter paper API keys. See `connectors/alpaca/README.md`.

### Hyperliquid (on-chain perps)

Run `/setup` → select Hyperliquid → enter wallet address and private key. See `connectors/hyperliquid/README.md`.

### Any CCXT Exchange (Binance, Bybit, 100+ more)

Run `/setup` → select "Other exchange via CCXT" → enter exchange name and API keys. See `connectors/ccxt/README.md`.

## Unified Tool API

All connectors implement the same interface:

| Method | Description |
|---|---|
| `getAccount()` | Account summary, buying power, portfolio value |
| `getPositions()` | Current positions with P&L |
| `getOrders()` | Open/closed orders |
| `placeOrder()` | Market, limit, stop, stop-limit orders |
| `cancelOrder()` | Cancel by order ID |
| `cancelAllOrders()` | Cancel all open orders |
| `getQuote()` | Current bid/ask/last |
| `getBars()` | OHLCV historical candles |
| `getPortfolioHistory()` | Equity curve over time |
| `isMarketOpen()` | Market hours check |
| `isPaper()` | Paper/testnet mode check |
