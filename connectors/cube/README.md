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

3. Optional: validate auth/session state from the CLI:

```bash
cd connectors/cube/mcp-server && npm run status
```

4. Set `CUBE_ENV` in `.mcp.json` to `staging` for paper trading (default) or `production` for live trading:

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

## CLI Commands

The Cube connector now ships with a typed CLI (`cube`) for both auth/session management and direct tool execution.

```bash
cd connectors/cube/mcp-server
npm run cube -- --help
```

Top-level commands:

- `cube login` — browser-based device auth
- `cube status` — auth/connection diagnostics
- `cube logout` — clear local session credentials
- `cube start` — launch MCP server

Command groups:

- `cube account ...` (positions, account summary, order/fill history, subaccounts, deposits, portfolio)
- `cube market ...` (markets, tickers, order book, trades, candles, fees, TA/confluence/squeeze/microstructure, asset search/trending)
- `cube order ...` (place, cancel, modify, cancel-all, close, list open)
- `cube risk ...` (position sizing, portfolio risk checks, stress tests)
- `cube trade ...` (smart execution, TWAP planning, market impact estimation)

Legacy aliases such as `cube get_positions` remain available for compatibility.

## Available MCP Tools

The Cube connector currently exposes **31 MCP tools** across account, market, order, risk, analysis, and smart-trade flows.

| Category | Tool | Description |
|---|---|---|
| Account | `get_positions` | Current holdings and balances |
| Account | `get_account` | Account-level summary and value |
| Account | `get_order_history` | Historical order activity |
| Account | `get_fills` | Recent fills/executions |
| Account | `get_subaccounts` | List subaccounts for the credential |
| Account | `get_account_deposit` | Deposit link/instructions for funding |
| Market | `get_assets` | Tradable markets/assets with metadata |
| Market | `get_tickers` | Live ticker snapshot |
| Market | `get_order_book` | Current L2 order book |
| Market | `get_trades` | Recent market trades |
| Market | `get_bars` | Historical OHLCV candles |
| Market | `get_fees` | Fee estimation for an order |
| Market | `get_technical_analysis` | Built-in indicator/TA analysis |
| Order | `place_order` | Place market/limit orders |
| Order | `cancel_order` | Cancel a specific order |
| Order | `modify_order` | Amend price/size on an open order |
| Order | `cancel_all_orders` | Mass cancel open orders |
| Order | `get_orders` | List currently open orders |
| Order | `close_position` | Close an open position by market |
| Risk | `get_portfolio` | Portfolio allocations and analytics |
| Risk | `calculate_position_size` | Position sizing recommendation |
| Analysis | `detect_confluence` | Multi-signal confluence analysis |
| Analysis | `detect_bb_squeeze` | Bollinger-band squeeze detection |
| Analysis | `assess_portfolio_risk` | Portfolio VaR/risk diagnostics |
| Analysis | `simulate_stress_test` | Stress test under shock scenarios |
| Analysis | `plan_twap` | TWAP schedule planning |
| Analysis | `simulate_market_impact` | Slippage/impact simulation |
| Analysis | `get_market_microstructure` | Order book microstructure signals |
| Trade/DeFi | `search_assets` | Search cross-venue tradable assets |
| Trade/DeFi | `get_trending` | Trending asset discovery |
| Trade/DeFi | `execute_trade` | Smart-routed execution helper |

## Advanced Tools (Detailed)

These are the higher-level decision/execution tools that go beyond basic market-data or order CRUD. They are the fastest way to turn signal discovery into executable plans.

### Analysis Toolkit

| Tool | What it does | Typical inputs | Typical output/use |
|---|---|---|---|
| `detect_confluence` | Aggregates multiple technical signals into a confluence score. | Market, timeframe, indicator params. | Structured bullish/bearish/neutral evidence for setup ranking. |
| `detect_bb_squeeze` | Detects volatility compression and potential expansion setups. | Market + window/band params. | Squeeze state + breakout watch levels for pre-positioning. |
| `assess_portfolio_risk` | Computes portfolio-level risk diagnostics (exposure concentration, directional bias). | Position set + optional scenario assumptions. | Risk posture summary to gate new trades. |
| `simulate_stress_test` | Shock-tests portfolio value/PnL under predefined adverse moves. | Shock percentages / scenario templates. | Scenario-by-scenario drawdown projections for limit checks. |
| `plan_twap` | Builds a time-sliced execution schedule for large orders. | Side, size, duration, slice controls. | Child-order schedule minimizing timing footprint. |
| `simulate_market_impact` | Estimates slippage/impact for large notional execution. | Side, size, liquidity assumptions. | Cost curve and expected slippage before live routing. |
| `get_market_microstructure` | Reads book shape/liquidity imbalance and microstructure pressure. | Market + depth/time window. | Spread/imbalance diagnostics to avoid toxic entries. |

### Smart Trading Toolkit

| Tool | What it does | Typical inputs | Typical output/use |
|---|---|---|---|
| `search_assets` | Finds tradable assets across venue metadata and symbols. | Query string, base/quote hints. | Candidate instruments for strategy universe selection. |
| `get_trending` | Surfaces currently active/high-interest assets. | Optional market filters. | Momentum watchlist seed for discretionary/quant scans. |
| `execute_trade` | Orchestrates execution pathing with available market + risk context. | Market, side, size/notional, execution preferences. | Actionable execution plan (or live routing path, depending on mode). |

### Recommended Analyst-to-Execution Flow

1. **Screen** with `get_trending` and `search_assets`
2. **Validate signal quality** with `detect_confluence` / `detect_bb_squeeze`
3. **Check safety** with `assess_portfolio_risk` + `simulate_stress_test`
4. **Plan execution** with `plan_twap` + `simulate_market_impact`
5. **Execute** via `execute_trade`, then monitor with market/account tools

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
│   │   ├── risk.ts             # portfolio summary, position sizing
│   │   ├── analysis.ts         # confluence, squeeze, stress test, TWAP, impact
│   │   └── defi.ts             # search/trending assets and smart execution
│   └── resources/
│       ├── markets.ts          # cube://markets resource
│       └── portfolio.ts        # cube://portfolio resource
├── package.json
└── tsconfig.json
```
