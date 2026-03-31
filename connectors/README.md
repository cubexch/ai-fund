# Exchange Connectors

ai-crypto-fund connects to exchanges via MCP (Model Context Protocol) servers. Each exchange has its own MCP server that exposes trading tools. The trading desk skills work with any exchange — they use generic capabilities (place orders, get prices, manage positions) that every exchange MCP provides.

## Supported Exchanges

| Exchange | Connector | Install | Status |
|----------|-----------|---------|--------|
| **[Cube Exchange](https://cube.exchange)** | Built-in | Ships with this repo | ✅ Ready — 200μs matching, lowest fees |
| **[OKX](https://okx.com)** | `@okx_ai/okx-trade-mcp` | `npm i -g @okx_ai/okx-trade-mcp` | ✅ Ready — 107 tools, spot/futures/options |
| **[Kraken](https://kraken.com)** | `kraken-cli` | [Install Kraken CLI](https://github.com/krakenfx/kraken-cli) | ✅ Ready — 134 commands, built-in paper trading |
| **[Binance](https://binance.com)** | `ccxt-mcp` | `npm i -g ccxt-mcp` | ✅ Via CCXT — 100+ exchanges |
| **[Bybit](https://bybit.com)** | `ccxt-mcp` | `npm i -g ccxt-mcp` | ✅ Via CCXT |
| **[Coinbase](https://coinbase.com)** | `@coinbase/agentkit` | [AgentKit docs](https://github.com/coinbase/agentkit) | ✅ Ready — wallet + trading |
| **[Hyperliquid](https://hyperliquid.xyz)** | Community MCP | [Options](https://github.com/search?q=hyperliquid+mcp) | 🔧 Community |

## How It Works

When you connect multiple exchanges, each exchange's tools are namespaced:

```
cube → place_order, get_tickers, get_positions, ...
okx  → spot_place_order, market_get_ticker, ...
kraken → place_order, get_ticker, ...
```

The trading desk skills understand this. When you `/hire arbitrageur`, it can scan prices across ALL connected exchanges and find cross-exchange opportunities. When you `/hire execution-trader`, it can route orders to the exchange with the best price.

## Quick Setup

### 1. Cube Exchange (default, recommended)

Cube ships built-in. Just add your API keys:

```bash
# Get keys at https://cube.exchange → Settings → API Keys
# Edit .mcp.json and fill in CUBE_API_KEY and CUBE_SECRET_KEY
```

### 2. Add OKX

```bash
npm install -g @okx_ai/okx-trade-mcp
```

Then enable it in `.mcp.json`:
```json
{
  "okx": {
    "disabled": false,
    "env": {
      "OKX_API_KEY": "your-key",
      "OKX_SECRET_KEY": "your-secret",
      "OKX_PASSPHRASE": "your-passphrase"
    }
  }
}
```

### 3. Add Kraken

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

### 4. Add Any CCXT Exchange (Binance, Bybit, 100+ more)

```bash
npm install -g ccxt-mcp
```

```json
{
  "binance": {
    "disabled": false,
    "args": ["ccxt-mcp", "--exchange", "binance"],
    "env": {
      "BINANCE_API_KEY": "your-key",
      "BINANCE_API_SECRET": "your-secret"
    }
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

## Building a Custom Connector

Any MCP server that exposes trading tools works with the hedge fund skills. At minimum, your connector should provide:

**Required tools:**
- `place_order` — Submit an order (market, limit)
- `cancel_order` — Cancel an order
- `get_positions` — Current positions
- `get_balances` — Account balances
- `get_tickers` — Current prices

**Recommended tools:**
- `get_price_history` — OHLCV candles
- `get_fills` — Trade history
- `get_order_history` — Order history
- `modify_order` — Modify an existing order
- `mass_cancel` — Cancel all orders

See `cube/mcp-server/` for a reference implementation.
