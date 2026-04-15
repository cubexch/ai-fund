# Connector Reliability Scorecards

Last updated: 2026-04-04

## Scoring Rubric

Each connector is scored across 6 dimensions on a 0–3 scale:

| Score | Meaning |
|-------|---------|
| 3 | Production-ready: comprehensive tests, docs, error handling |
| 2 | Solid: good coverage, minor gaps |
| 1 | Minimal: basic functionality, significant gaps |
| 0 | Missing or placeholder |

**Dimensions:**
- **Test Coverage**: Unit test count, edge cases, error paths
- **Error Handling**: Type-safe errors, retry logic, graceful degradation
- **Documentation**: ARCHITECTURE.md, inline docs, README
- **Tool Breadth**: Number of tool categories (market data, orders, account, strategy, execution)
- **Auth & Security**: Credential storage, key management, paper mode enforcement
- **Production Readiness**: Rate limiting, reconnection, health checks

---

## Cube Exchange

| Dimension | Score | Details |
|-----------|-------|---------|
| Test Coverage | 3 | 418 tests across 22 files — auth, signing, indicators, REST orders, WebSocket, credential store, device auth |
| Error Handling | 3 | Type-safe `toolError()` across all tool files, retry on transient failures |
| Documentation | 3 | Full ARCHITECTURE.md, auth brief, trade flow docs |
| Tool Breadth | 2 | 7 tool files — market data, orders, account, portfolio, technical analysis. Missing: advanced execution algos (handled by lib/) |
| Auth & Security | 3 | Ed25519 device auth (RFC 8628), cross-platform keychain, no API keys needed |
| Production Readiness | 3 | 3-client architecture (REST + 2 WebSocket), auto-reconnect, staging/prod separation |

**Overall: 17/18 — Production-grade**

**Gaps**: Could add more execution algorithm tools (TWAP/VWAP are in lib/ but not exposed as MCP tools).

---

## CCXT (Universal)

| Dimension | Score | Details |
|-----------|-------|---------|
| Test Coverage | 3 | 1,324 tests across 22+ files — most comprehensive suite in the project |
| Error Handling | 3 | Type-safe `toolError()`, exchange-specific error mapping |
| Documentation | 3 | Full ARCHITECTURE.md, exchange-agnostic design documented |
| Tool Breadth | 3 | 22 tool files — market data, orders, account, strategy, execution, datastore (DuckDB), algorithms, risk, backtesting, regime detection, signal scanning |
| Auth & Security | 2 | API key management via env vars, sandbox mode support. No keychain integration (keys stored in config). |
| Production Readiness | 2 | Rate limiting, latency tracking, trade journal. Missing: auto-reconnect for WebSocket streams, health endpoint |

**Overall: 16/18 — Near production-grade**

**Gaps**: WebSocket reconnection and credential keychain storage would bring it to full production.

---

## Alpaca

| Dimension | Score | Details |
|-----------|-------|---------|
| Test Coverage | 2 | 108 tests across 4+ files — good coverage of core paths, could use more edge cases |
| Error Handling | 3 | Type-safe `toolError()` across all tool files |
| Documentation | 2 | ARCHITECTURE.md present, minimal inline docs |
| Tool Breadth | 2 | 4 tool files — market data, orders, account, risk. Missing: DeFi tools are placeholder |
| Auth & Security | 2 | API key auth with credential store. Paper trading built-in. |
| Production Readiness | 2 | Single REST client, paper mode by default. Missing: WebSocket streaming, health checks |

**Overall: 13/18 — Solid foundation**

**Gaps**: More tests (especially order lifecycle), WebSocket market data, DeFi tool implementation.

---

## Robinhood

| Dimension | Score | Details |
|-----------|-------|---------|
| Test Coverage | 2 | 39 tests across 3 files — auth, API client, credential store well-tested |
| Error Handling | 2 | Retry with backoff on 401/429, but tool files are placeholders |
| Documentation | 1 | README with crypto-only notice, no ARCHITECTURE.md |
| Tool Breadth | 0 | All 3 tool files are empty placeholders (awaiting official crypto API) |
| Auth & Security | 3 | OAuth2 with MFA support, cross-platform keychain, robin_stocks compatible |
| Production Readiness | 1 | Auth infrastructure complete, no trading functionality yet |

**Overall: 9/18 — Auth-ready, trading-blocked**

**Gaps**: Waiting on Robinhood's official crypto API (docs.robinhood.com/crypto/trading). Auth layer is production-quality; tools need implementation once API launches.

---

## Summary Matrix

| Connector | Tests | Errors | Docs | Tools | Auth | Prod | Total |
|-----------|-------|--------|------|-------|------|------|-------|
| Cube | 3 | 3 | 3 | 2 | 3 | 3 | **17/18** |
| CCXT | 3 | 3 | 3 | 3 | 2 | 2 | **16/18** |
| Alpaca | 2 | 3 | 2 | 2 | 2 | 2 | **13/18** |
| Robinhood | 2 | 2 | 1 | 0 | 3 | 1 | **9/18** |

## Priority Improvements

### High Impact (do first)
1. **Robinhood**: Add ARCHITECTURE.md (brings docs from 1→2)
2. **Alpaca**: Add more order lifecycle tests (coverage 2→3)
3. **CCXT**: Add keychain credential storage (auth 2→3)

### Medium Impact
4. **Cube**: Expose TWAP/VWAP/Iceberg as MCP tools (tools 2→3)
5. **Alpaca**: Implement DeFi tools or remove placeholder (tools 2→3)
6. **CCXT**: Add WebSocket auto-reconnect (prod 2→3)

### Low Impact (polish)
7. **Robinhood**: Implement tools when API launches (tools 0→3)
8. **Alpaca**: Add WebSocket market data streaming (prod 2→3)
