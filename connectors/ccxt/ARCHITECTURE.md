# CCXT Connector Architecture

## Overview

The CCXT connector is a universal exchange adapter supporting 100+ exchanges (Coinbase, Binance, Kraken, etc.) through the CCXT library. It includes DuckDB-backed historical data storage, backtesting, regime detection, signal generation, and algorithmic execution.

## Component Diagram

```
Claude Code (MCP protocol)
    │
    ▼
┌──────────────┐
│  index.ts    │  ← MCP server entry point (dynamic: ccxt-{exchangeId})
│  McpServer   │
└──────┬───────┘
       │
       ▼
  Tools (22 files, 11 groups)
       │
  ┌────┴────────────────────┐
  ▼                         ▼
┌──────────────┐   ┌───────────────────┐
│ExchangeClient│   │ MarketDataStore   │
│ (CCXT wrap)  │   │ (DuckDB columnar) │
└──────┬───────┘   └───────────────────┘
       │
       ▼
  Any CCXT Exchange
```

## Directory Layout

```
mcp-server/src/
├── index.ts                Entry point — resolves exchange, creates client + store
├── cli/
│   ├── common.ts           Arg parsing, credential resolution
│   ├── login.ts            Store API credentials
│   ├── logout.ts           Clear credentials
│   └── status.ts           Check connectivity
├── client/
│   ├── exchange.ts         Main CCXT wrapper (any exchange)
│   ├── backtester.ts       Strategy backtesting engine
│   ├── regime-detector.ts  Market regime classification
│   ├── signal-generator.ts Multi-indicator signal scanning
│   ├── trade-journal.ts    Trade history and P&L tracking
│   ├── stream.ts           Real-time data streaming
│   ├── latency-tracker.ts  Order latency metrics
│   ├── rate-limiter.ts     Exchange rate limit management
│   ├── credential-store.ts API key persistence
│   └── sanitize.ts         Data validation/sanitization
├── tools/
│   ├── account.ts          get_positions, get_account
│   ├── orders.ts           place_order, cancel_order, get_fills
│   ├── market-data.ts      get_tickers, get_bars
│   ├── strategy.ts         get_technical_analysis, get_fees
│   ├── strategy-*.ts       Portfolio, entry, info, analysis tools
│   ├── execution.ts        Spread monitor, order flow
│   ├── execution-*.ts      Analytics, microstructure, infra
│   ├── algorithms.ts       TWAP, VWAP, iceberg, SOR
│   ├── datastore.ts        Ingest, query, cache management
│   ├── datastore-*.ts      Analysis, ingest, journal tools
│   ├── backtest.ts         Strategy backtesting tools
│   ├── regime.ts           Regime detection tools
│   ├── risk.ts             VaR, drawdown, exposure, stress test
│   ├── scanner.ts          Signal scanning, breakout detection
│   └── handler.ts          Tool registration helpers
└── tests/                  19 test files (190+ tests)
```

## Key Invariants

1. **Exchange-agnostic**: The `ExchangeClient` wraps any CCXT-supported exchange. Exchange ID is passed at startup via CLI args or env var.
2. **Sandbox by default**: Passes `sandbox: true` to CCXT unless explicitly configured for production.
3. **DuckDB store**: Historical data persists in `.desk/data/{exchangeId}.duckdb`. Lazy-initialized on first datastore tool call.
4. **Rate limiting**: Built-in rate limiter respects per-exchange limits from CCXT metadata.

## Extension Points

- **Add a new exchange**: No code changes needed — pass the CCXT exchange ID at startup.
- **Add a new tool group**: Create `src/tools/my-tools.ts` with a `registerMyTools()` function, call from `index.ts`.
- **Add a new strategy**: Extend `src/client/backtester.ts` with a new strategy function, register in backtest tools.
- **Add a new client module**: Place in `src/client/`, import where needed. Follow `regime-detector.ts` as a pattern.

## Data Flow

```
Exchange API  ──►  ExchangeClient  ──►  Tool Handler  ──►  MCP Response
                       │
                       ▼
                 MarketDataStore (DuckDB)
                       │
                 ┌─────┴─────┐
                 ▼           ▼
            Backtester   Analytics
```

## Auth Flow

```
npx tsx src/cli/login.ts <exchangeId>
  1. Prompt for API key and secret
  2. Optionally prompt for password (exchange-specific)
  3. Store in credential store (~/.cube-credentials or env)
  4. Verify with a test API call
```

## Risk Considerations

- `src/client/exchange.ts` has the highest fan-in — all tools depend on it.
- `src/tools/` has 22 files — largest tool surface in the repo.
- Rate limiter is critical for production use — exceeding exchange limits causes IP bans.
