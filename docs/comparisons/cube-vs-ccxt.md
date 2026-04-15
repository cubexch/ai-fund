# When to Use Cube vs CCXT Connector

## The Short Answer

Use **Cube** if you want the fastest execution, lowest fees, and zero-API-key auth.
Use **CCXT** if you need access to Binance, Coinbase, Kraken, or any of 110+ exchanges.
Use **both** for cross-exchange arbitrage.

## Feature Comparison

| Feature | Cube Connector | CCXT Connector |
|---------|---------------|----------------|
| **Exchanges** | Cube only | 110+ (Binance, Coinbase, Kraken, OKX...) |
| **Tools** | 31 | 92 |
| **Auth** | Device login (no API keys) | API key + secret |
| **Matching speed** | 200μs | Exchange-dependent (1-100ms) |
| **WebSocket** | Yes (market data + trading) | Optional streaming |
| **DuckDB store** | No | Yes — historical data persistence |
| **Backtesting** | Via shared lib | Built-in (9 strategies, walk-forward) |
| **Regime detection** | Via shared lib | Built-in tools |
| **Signal scanning** | Via shared lib | Built-in scanner tools |
| **Algo execution** | TWAP, market impact | TWAP, VWAP, iceberg, SOR, sniper |
| **Paper trading** | Staging environment | Exchange sandbox mode |
| **CLI** | Full CLI (`cube account`, `cube market`...) | Status CLI |

## When to Pick Cube

- You want the lowest latency and fees
- You want zero-API-key authentication (Ed25519 device login)
- You trade crypto perps and spot on Cube
- You want a full CLI for terminal-based trading

## When to Pick CCXT

- You already have accounts on Binance/Coinbase/Kraken/etc.
- You want historical data storage in DuckDB
- You need built-in backtesting with walk-forward optimization
- You want regime detection and signal scanning tools
- You want to trade across many exchanges from one connector

## When to Use Both

Cross-exchange strategies shine when both are connected:

```
/hire arbitrageur
> scan all exchanges for BTC price differences
> the arb agent found a 15bps spread between Cube and Binance — execute it
```

The Arbitrageur, Execution Trader, and Market Maker agents all benefit from multiple connected venues. More venues = more alpha.

## Setup

**Cube only:**
```bash
cd connectors/cube/mcp-server
npm run login        # browser-based device auth
npm run status       # verify connection
```

**CCXT only:**
```bash
# Add to .mcp.json or use /setup in Claude Code
# Supports any CCXT exchange: binance, coinbase, kraken, okx, etc.
```

**Both:**
Add both connectors to your `.mcp.json`. Agents automatically detect and use all connected exchanges.
