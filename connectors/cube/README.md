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
2. Run the device login to authenticate:

```bash
cd connectors/cube/mcp-server && npm run login
```

This opens your browser, authenticates via Google/Apple, and saves an Ed25519 verification key to `~/.cube/credentials.json`. No API keys needed.

3. Set `CUBE_ENV` in `.mcp.json` to `staging` for paper trading (default) or `production` for live trading:

```json
{
  "cube": {
    "env": {
      "CUBE_ENV": "staging"
    }
  }
}
```

**Never put API keys in `.mcp.json`** — they show up in terminal output. Use `npm run login` instead, or set `CUBE_API_KEY` / `CUBE_SECRET_KEY` in your shell profile if you need HMAC auth.

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
│   │   ├── mendelev.ts         # WebSocket — real-time market data (no auth)
│   │   ├── osmium.ts           # WebSocket — real-time order management
│   │   ├── iridium.ts          # REST — account data, market data, orders, DeFi
│   │   ├── auth.ts             # Auth resolution: verification key > HMAC > credential store
│   │   ├── signing.ts          # Ed25519 keypair management
│   │   └── device-auth.ts      # Device login flow (browser-based auth)
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
