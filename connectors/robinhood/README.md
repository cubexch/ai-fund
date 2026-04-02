# Robinhood Connector

## What's supported

Robinhood's **official public API is crypto-only** (launched May 2024).
There is no official, stable API for stocks or options.

| Asset class | Support | API |
|---|---|---|
| Crypto | ✅ Coming soon | Official — docs.robinhood.com/crypto/trading |
| Stocks | ❌ Not supported | No official public API |
| Options | ❌ Not supported | No official public API |

## For US equities

Use the **Alpaca connector** (`connectors/alpaca/`).
Alpaca offers commission-free stocks, ETFs, and options with
an official MCP server and full paper trading support.

## Robinhood crypto support

Robinhood crypto connector is on the roadmap. It will use the
official API at docs.robinhood.com/crypto/trading/ only.
