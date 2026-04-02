# Exchange Connectors

ai-fund connects to exchanges via MCP (Model Context Protocol) servers. Each exchange has its own MCP server that exposes trading tools. The trading desk skills work with any exchange — they use generic capabilities (place orders, get prices, manage positions) that every exchange MCP provides.

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

Cube ships built-in. Authenticate with device login (no API keys needed):

```bash
cd connectors/cube/mcp-server && npm run login
```

This opens your browser, authenticates via Google/Apple, and saves credentials to `~/.cube/credentials.json`.

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

## Unified Tool API

All connectors follow a standard tool naming convention (inspired by Alpaca). This makes skills exchange-agnostic — the same skill works with Cube, OKX, Robinhood, or any other connector.

### Required tools (minimum viable connector):

| Tool | Description |
|------|-------------|
| `place_order` | Submit an order (market, limit). Accept `symbol` or `marketId`. Side: `buy`/`sell`. |
| `cancel_order` | Cancel an order by ID |
| `get_positions` | Current positions/holdings |
| `get_account` | Account summary with balances and total portfolio value |
| `get_tickers` | Current prices for all assets |

### Recommended tools:

| Tool | Description |
|------|-------------|
| `get_bars` | OHLCV candlestick history |
| `get_fills` | Trade execution history |
| `get_orders` | Open/resting orders (with `status` filter: `open` \| `all`) |
| `get_order_history` | Historical orders |
| `get_order_book` | Order book depth (bids/asks) |
| `get_trades` | Recent trades for a market |
| `modify_order` | Modify an existing order |
| `cancel_all_orders` | Cancel all resting orders |
| `close_position` | Close a position by symbol (with optional `percentage`) |

### Advanced tools:

| Tool | Description |
|------|-------------|
| `get_quote` | Get a price quote across venues (CEX orderbook, DEX aggregator, etc.) |
| `execute_trade` | Execute via best available venue |
| `compare_venues` | Compare execution across venues (CEX vs DEX, cross-exchange) |
| `search_assets` | Search for tradable assets by name or symbol |
| `get_trending` | Currently trending assets |
| `get_portfolio` | Portfolio with allocations and current prices |
| `get_fees` | Fee estimates for a trade |
| `get_technical_analysis` | Technical indicators (RSI, MACD, Bollinger, etc.) |
| `calculate_position_size` | Risk-based position sizing (Kelly criterion, fixed fractional) |

### Naming conventions:
- **snake_case** everywhere (not kebab-case or camelCase)
- **`get_`** prefix for read operations
- **`place_`** / **`cancel_`** / **`modify_`** for write operations
- Accept both `symbol` (string) and `marketId` (number) where applicable
- `side` accepts both `'buy'`/`'sell'` and `'BID'`/`'ASK'`

See `cube/mcp-server/` for the reference implementation (25 tools).
