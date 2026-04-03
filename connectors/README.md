# Exchange Connectors

ai-fund connects to exchanges via typed connectors that implement `ExchangeConnector` from `lib/connector-interface.ts`. Skills are connector-agnostic — add an exchange, no skill files change. Write a skill, no connector files change.

## Available Connectors

| Exchange | Connector | Install | Status |
|----------|-----------|---------|--------|
| **[Cube Exchange](https://cube.exchange)** | Built-in | Ships with this repo | ✅ Ready — 200μs matching, lowest fees |
| **[Alpaca](https://alpaca.markets)** | Built-in | Ships with this repo | ✅ Ready — stocks, ETFs, crypto, paper trading |
| **[OKX](https://okx.com)** | `@okx_ai/okx-trade-mcp` | `npm i -g @okx_ai/okx-trade-mcp` | ✅ Ready — 107 tools, spot/futures/options |
| **[Kraken](https://kraken.com)** | `kraken-cli` | [Install Kraken CLI](https://github.com/krakenfx/kraken-cli) | ✅ Ready — 134 commands, built-in paper trading |
| **[Coinbase](https://coinbase.com)** | Built-in (CCXT) | Ships with this repo | ✅ Ready — default exchange for CCXT connector |
| **[Binance](https://binance.com)** | Built-in (CCXT) | Ships with this repo | ✅ Ready — via `--exchange binance` |
| **[Bybit](https://bybit.com)** | Built-in (CCXT) | Ships with this repo | ✅ Ready — via `--exchange bybit` |
| **100+ more** | Built-in (CCXT) | Ships with this repo | ✅ Any CCXT-supported exchange |
| **[Robinhood](https://robinhood.com)** | Built-in | Ships with this repo | 🧪 Beta — crypto-focused connector, narrower coverage than Cube/Alpaca/CCXT |
| **[Hyperliquid](https://hyperliquid.xyz)** | Built-in | Ships with this repo | 🧪 Beta — read-only until EIP-712 signing is implemented |
| **Gateway** | Experimental | `connectors/gateway/index.ts` | ⚠️ Experimental — not part of default PR CI yet |

## Capability Matrix

Connectors now declare their governed status plus a capability matrix in `ConnectorMeta`. The gateway uses that matrix to avoid registering unsupported tools.

| Connector | Status | Account | Positions | Orders | Quote | Bars | Portfolio History | Place/Cancel Orders | Notes |
|-----------|--------|---------|-----------|--------|-------|------|-------------------|---------------------|-------|
| Cube | `ready` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full built-in MCP server plus normalized connector |
| Alpaca | `ready` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Paper mode default, weekday market hours |
| CCXT | `ready` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Exchange-specific behavior normalized behind one adapter |
| Robinhood | `beta` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Narrower surface and test coverage than the ready connectors |
| Hyperliquid | `beta` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | Read-only beta until signing is implemented and verified |
| Gateway | `experimental` | Varies | Varies | Varies | Varies | Varies | Varies | Varies | Capability-driven surface over loaded connectors |

## Architecture

All connectors implement `ExchangeConnector` from `lib/connector-interface.ts`. Skills call the interface, never the connector directly:

```
Agent (skill)
  → ExchangeConnector interface (lib/connector-interface.ts)
    → Connector (connectors/<name>/index.ts)
      → Exchange REST API (direct HTTP calls)
```

No MCP-to-MCP indirection. No leaked tool surfaces. Each connector is a thin REST wrapper. Connector metadata also carries a governed `status` plus per-method `capabilities`, so tooling can distinguish ready adapters from beta or experimental surfaces.

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

Run `/setup` → select Hyperliquid → enter wallet address and private key. The current repo exposes Hyperliquid as read-only beta until EIP-712 signing lands. See `connectors/hyperliquid/README.md`.

### Any CCXT Exchange (Binance, Bybit, 100+ more)

```bash
# Install Kraken CLI: https://github.com/krakenfx/kraken-cli
curl -sSf https://raw.githubusercontent.com/krakenfx/kraken-cli/main/install.sh | sh
kraken auth login
```

Then enable it in `.mcp.json`:
```json
{
  "kraken": {
    "disabled": false
  }
}
```

### 4. Add Coinbase (or any CCXT exchange)

The built-in CCXT connector supports Coinbase, Binance, Bybit, and 100+ exchanges. No extra install needed.

Credentials are per-exchange via env vars: `<EXCHANGE>_API_KEY`, `<EXCHANGE>_SECRET`, `<EXCHANGE>_PASSWORD`. Falls back to generic `CCXT_*` vars.

**Coinbase (default):**
```json
{
  "coinbase": {
    "disabled": false,
    "command": "npx",
    "args": ["tsx", "connectors/ccxt/mcp-server/src/index.ts"],
    "env": {
      "COINBASE_API_KEY": "your-api-key",
      "COINBASE_SECRET": "your-api-secret",
      "COINBASE_PASSPHRASE": "your-passphrase",
      "COINBASE_SANDBOX": "true"
    }
  }
}
```

**Binance:**
```json
{
  "binance": {
    "disabled": false,
    "command": "npx",
    "args": ["tsx", "connectors/ccxt/mcp-server/src/index.ts", "--exchange", "binance"],
    "env": {
      "BINANCE_API_KEY": "your-key",
      "BINANCE_SECRET": "your-secret",
      "BINANCE_SANDBOX": "true"
    }
  }
}
```

**Market data only (no API key needed):**
```json
{
  "coinbase": {
    "disabled": false,
    "command": "npx",
    "args": ["tsx", "connectors/ccxt/mcp-server/src/index.ts"]
  }
}
```

## Multi-Exchange Strategies

With multiple exchanges connected, the desk unlocks powerful strategies:

| Strategy | How It Works |
|----------|-------------|
| **Cross-Exchange Arbitrage** | The Arbitrageur scans all connected exchanges for price discrepancies. Buy on the cheaper exchange, sell on the more expensive one. |
| **Smart Order Routing** | The Execution Trader routes large orders to the exchange with the deepest liquidity and tightest spread. |
| **Multi-Venue Market Making** | The Market Maker quotes on multiple exchanges simultaneously, capturing spreads across venues. |
| **Best Execution** | Compare fill quality across exchanges. Route to the venue that consistently delivers the best fills. |

## Unified Tool API

All connectors implement the same interface. Ready connectors expose the full set below; beta and experimental connectors may expose a capability-gated subset:

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
