# Cube Exchange Connector

The default and recommended exchange connector for ai-fund.

## Why Cube?

- **200μs matching engine** — The fastest matching engine in crypto. Critical for market making and scalping.
- **Low fees** — Competitive maker/taker fees with volume discounts
- **Paper trading** — Built-in staging environment for risk-free testing
- **HFT-grade API** — WebSocket (Osmium) for real-time trading, REST (Iridium) for account data
- **Ships with this repo** — Zero additional installation required

## Setup

1. Create an account at [cube.exchange](https://cube.exchange)
2. Go to Settings → API Keys → Create a new key
3. Edit `.mcp.json` in the repo root:

```json
{
  "cube": {
    "env": {
      "CUBE_API_KEY": "your-api-key-uuid",
      "CUBE_SECRET_KEY": "your-secret-key-hex",
      "CUBE_SUBACCOUNT_ID": "1",
      "CUBE_ENV": "staging"
    }
  }
}
```

4. Set `CUBE_ENV` to `staging` for paper trading (default) or `production` for live trading.

## Available Tools

| Tool | Description |
|------|-------------|
| `place_order` | Place limit/market orders with post-only, cancel-on-disconnect options |
| `cancel_order` | Cancel a specific order |
| `modify_order` | Modify price/quantity of a resting order |
| `mass_cancel` | Cancel all orders (optionally filtered by market) |
| `get_markets` | Available trading pairs with tick/lot sizes |
| `get_tickers` | Current prices, spreads, 24h volume |
| `get_price_history` | OHLCV candles for any timeframe |
| `get_positions` | Open positions with entry prices and PnL |
| `get_balances` | Account balances per asset |
| `get_fills` | Trade execution history |
| `get_order_history` | Historical orders |
| `get_estimated_fees` | Fee estimates for trades |
| `get_portfolio_summary` | Full portfolio with allocations |
| `calculate_position_size` | Kelly criterion and fixed fractional sizing |

## Architecture

```
mcp-server/
├── src/
│   ├── index.ts                # MCP server entry point (stdio transport)
│   ├── client/
│   │   ├── osmium.ts           # WebSocket — real-time order management
│   │   ├── iridium.ts          # REST — account data, market data, history
│   │   └── auth.ts             # HMAC-SHA256 API authentication
│   ├── tools/
│   │   ├── orders.ts           # place, cancel, modify, mass cancel
│   │   ├── market-data.ts      # markets, tickers, candles, fees
│   │   ├── account.ts          # positions, balances, fills, orders
│   │   └── risk.ts             # portfolio summary, position sizing
│   └── resources/
│       ├── markets.ts          # cube://markets resource
│       └── portfolio.ts        # cube://portfolio resource
├── package.json
└── tsconfig.json
```
