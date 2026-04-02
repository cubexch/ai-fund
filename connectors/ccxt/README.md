# CCXT Connector

Universal adapter for 100+ cryptocurrency exchanges. CCXT is used as an internal dependency — agents see only the normalized `ExchangeConnector` interface, never raw CCXT methods.

## Supported Exchanges

Binance, Coinbase, Bybit, Gate.io, KuCoin, Bitfinex, Huobi, MEXC, and [100+ more](https://github.com/ccxt/ccxt#supported-exchanges).

## Setup

1. Create an API key on your exchange
2. Run `/setup` in Claude Code and select "Other exchange via CCXT"
3. Enter your exchange name, API key, and secret

Credentials are stored in your system keychain (macOS) or `~/.ai-fund/ccxt-<exchange>/credentials.json` (0600 permissions).

## Sandbox / Testnet

Sandbox mode is **on by default**. Not all exchanges support testnet — check your exchange's documentation.

| Exchange | Testnet |
|---|---|
| Binance | ✅ testnet.binance.vision |
| Bybit | ✅ testnet.bybit.com |
| Coinbase | ✅ sandbox |
| Gate.io | ❌ |
| KuCoin | ✅ sandbox |

## Credentials

Resolved in order:
1. **Shared credential store** — `~/.ai-fund/ccxt-<exchange>/`
2. **Environment variables** — fallback for CI/testing

| Variable | Description |
|---|---|
| `CCXT_EXCHANGE` | Exchange name (e.g. `binance`, `coinbase`) |
| `CCXT_API_KEY` | API key |
| `CCXT_SECRET` | API secret |
| `CCXT_SANDBOX` | `true` (default) or `false` for live |

## Architecture

```
Agent (skill)
  → ExchangeConnector interface
    → CcxtConnector (this file)
      → CCXT unified API (internal)
        → Exchange REST API
```

Agents never import or reference CCXT. The CCXT connector wraps all CCXT calls and normalizes responses to the shared `ExchangeConnector` types.
