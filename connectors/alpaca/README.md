# Alpaca Connector

Commission-free US equities and ETFs with full paper trading support. Direct REST API wrapper — no SDK, no MCP dependencies.

## What's Supported

| Feature | Support |
|---|---|
| Stocks & ETFs | ✅ |
| Crypto | ✅ (BTC/USD, ETH/USD, etc.) |
| Options | ❌ Not yet |
| Paper trading | ✅ Default |
| Fractional shares | ✅ |
| Short selling | ❌ Paper mode |
| Pre/post market | Limited |

## Setup

1. Create a free account at [alpaca.markets](https://alpaca.markets)
2. Go to **Paper Trading** > **API Keys** > **Generate**
3. Run `/setup` in Claude Code and select Alpaca — enter your keys when prompted

Credentials are stored in your system keychain (macOS) or `~/.ai-fund/alpaca/credentials.json` (with 0600 permissions). They never live inside the repo.

## Paper vs Live

Paper trading is **on by default**. The connector uses `https://paper-api.alpaca.markets`.

To trade live, you must explicitly configure live mode during `/setup`. The connector will refuse live orders by default.

## Market Hours

NYSE/NASDAQ: Monday-Friday 9:30 AM - 4:00 PM ET.

The connector checks market hours before placing orders. If the market is closed:
- Orders with `timeInForce: 'gtc'` are queued for next open
- All other orders are rejected with a descriptive error

## Pattern Day Trader (PDT) Rule

If your account equity is under $25,000, FINRA limits you to 3 day trades per rolling 5-day period. The connector:
- Warns when you've used 2 of 3 day trades
- Blocks orders that would trigger a 4th day trade

## Credentials

Credentials are resolved in this order:
1. **Shared credential store** — `~/.ai-fund/alpaca/` (keychain on macOS, libsecret on Linux, file fallback)
2. **Environment variables** — fallback for CI/testing only

| Variable | Description |
|---|---|
| `ALPACA_API_KEY` | API key (env fallback) |
| `ALPACA_SECRET_KEY` | Secret key (env fallback) |
| `ALPACA_PAPER_TRADE` | `true` (default) or `false` for live (env fallback) |

## Not Supported (Yet)

- Options trading
- Short selling in paper mode
- Extended hours trading (pre-market, after-hours)
- Streaming/WebSocket market data

## Suggested Agents

```
/hire equity-risk-manager
/hire warren-buffett
/hire peter-lynch
```
