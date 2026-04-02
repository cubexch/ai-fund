# Robinhood Connector

MCP server for trading stocks, ETFs, and crypto on Robinhood. Commission-free. No paid API required — uses your Robinhood account credentials.

## Quick Start

```bash
cd connectors/robinhood/mcp-server
npm install
npm run login
```

Enter your email, password, and MFA code. Tokens are stored in your system keychain (macOS Keychain / Linux libsecret).

## Non-Interactive Login

```bash
ROBINHOOD_USERNAME=user@example.com \
ROBINHOOD_PASSWORD=yourpassword \
ROBINHOOD_MFA_CODE=123456 \
npm run login
```

## Available Tools

| Tool | Description |
|------|-------------|
| `get_tickers` | Real-time quotes for one or more symbols |
| `get_price_history` | Historical OHLCV candles (5min to weekly, up to 5 years) |
| `get_markets` | Search for instruments by symbol or name |
| `get_positions` | Current stock and crypto positions |
| `get_balances` | Account balances, buying power, portfolio equity |
| `get_fills` | Recent filled orders (trade execution history) |
| `place_order` | Place market, limit, stop-loss, or stop-limit orders |
| `cancel_order` | Cancel a pending order |
| `get_order_status` | Check status of a specific order |

## Limitations

- **No paper trading** — Robinhood does not offer a sandbox. All orders execute with real money.
- **REST-only** — No WebSocket streaming. Data is fetched on demand.
- **Unofficial API** — Uses the same endpoints as `robin-stocks` (Python). May break if Robinhood changes their API.
- **MFA required** — Most accounts have MFA enabled. You'll need to enter a code on first login.
- **Rate limits** — Robinhood rate-limits aggressively. The connector handles 429 responses with exponential backoff.

## CLI Commands

```bash
npm run login     # Authenticate with Robinhood
npm run logout    # Remove stored credentials
npm run status    # Check auth status and token expiry
```

## Security

- Credentials are stored in your system's native keychain (macOS) or libsecret (Linux)
- Falls back to `~/.robinhood/credentials.json` with 0600 permissions if no keychain is available
- Access tokens expire and are auto-refreshed using the stored refresh token
- No credentials are ever logged or exposed to the MCP client
