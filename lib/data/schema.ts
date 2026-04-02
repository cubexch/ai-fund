/**
 * DuckDB schema definitions for the local market data store.
 *
 * Architecture follows institutional patterns (Citadel, Two Sigma, Man AHL):
 *
 *   Reference   — Instrument master, exchange metadata (slowly-changing dims)
 *   Bronze      — Raw data as received from exchange (Parquet, append-only)
 *   Silver      — Cleaned, deduped, normalized (DuckDB tables + Parquet)
 *   Gold        — Computed features, signals, aggregates (DuckDB tables + Parquet)
 *
 * Convention from kdb+ tick databases: first two columns are always ts, iid
 * (timestamp, instrument ID). DuckDB's dictionary encoding on VARCHAR gives
 * the same compression benefit as kdb+'s grouped symbol enumeration.
 */

// ── Reference layer ────────────────────────────────────────

export const REFERENCE_SQL = `
-- Canonical instrument registry: normalizes identifiers across venues + asset classes.
-- Every time-series table references iid as the instrument key.
CREATE TABLE IF NOT EXISTS instruments (
    iid             VARCHAR PRIMARY KEY,   -- 'cube:BTCUSDC', 'yahoo:AAPL'
    symbol          VARCHAR NOT NULL,      -- normalized: 'BTC/USDC', 'AAPL'
    asset_class     VARCHAR NOT NULL,      -- 'crypto', 'equity', 'fx', 'commodity', 'rate'
    instrument_type VARCHAR NOT NULL,      -- 'spot', 'perpetual', 'future', 'option', 'index'
    base            VARCHAR,               -- 'BTC', 'AAPL', 'EUR'
    quote           VARCHAR,               -- 'USDC', 'USD'
    exchange        VARCHAR NOT NULL,      -- 'cube', 'binance', 'nyse', 'fred'
    tick_size       DOUBLE,
    lot_size        DOUBLE,
    is_active       BOOLEAN DEFAULT true,
    meta            VARCHAR                -- JSON string for asset-class-specific attrs
);

-- Exchange reference data
CREATE TABLE IF NOT EXISTS exchanges (
    exchange        VARCHAR PRIMARY KEY,   -- 'cube', 'binance', 'nyse'
    name            VARCHAR NOT NULL,      -- 'Cube Exchange'
    exchange_type   VARCHAR NOT NULL,      -- 'cex', 'dex', 'stock', 'data'
    base_url        VARCHAR,
    is_active       BOOLEAN DEFAULT true
);
`;

// ── Silver layer (cleaned, normalized) ─────────────────────

export const SILVER_SQL = `
-- OHLCV candlestick bars (universal across all asset classes).
-- kdb+ convention: ts first, then instrument key.
CREATE TABLE IF NOT EXISTS ohlcv (
    ts              TIMESTAMP NOT NULL,
    iid             VARCHAR NOT NULL,
    interval        VARCHAR NOT NULL,      -- '1s', '1m', '15m', '1h', '4h', '1d'
    open            DOUBLE NOT NULL,
    high            DOUBLE NOT NULL,
    low             DOUBLE NOT NULL,
    close           DOUBLE NOT NULL,
    volume          DOUBLE NOT NULL,
    vwap            DOUBLE,
    trades_count    INTEGER,
    PRIMARY KEY (iid, interval, ts)
);

-- Tick-level trades (universal across all asset classes).
CREATE TABLE IF NOT EXISTS trades (
    ts              TIMESTAMP NOT NULL,
    iid             VARCHAR NOT NULL,
    trade_id        VARCHAR NOT NULL,
    price           DOUBLE NOT NULL,
    size            DOUBLE NOT NULL,
    side            VARCHAR,               -- 'buy', 'sell'
    PRIMARY KEY (iid, trade_id)
);

-- Top-of-book quotes / BBO (best bid/offer).
CREATE TABLE IF NOT EXISTS quotes (
    ts              TIMESTAMP NOT NULL,
    iid             VARCHAR NOT NULL,
    bid             DOUBLE,
    ask             DOUBLE,
    bid_size        DOUBLE,
    ask_size        DOUBLE,
    PRIMARY KEY (iid, ts)
);

-- L2 order book snapshots.
CREATE TABLE IF NOT EXISTS orderbook (
    ts              TIMESTAMP NOT NULL,
    iid             VARCHAR NOT NULL,
    side            VARCHAR NOT NULL,      -- 'bid', 'ask'
    level           INTEGER NOT NULL,      -- 0 = best, 1 = second, etc.
    price           DOUBLE NOT NULL,
    size            DOUBLE NOT NULL,
    PRIMARY KEY (iid, ts, side, level)
);
`;

// ── Asset-class extension tables ───────────────────────────

export const EXTENSIONS_SQL = `
-- Crypto: perpetual swap funding rates.
CREATE TABLE IF NOT EXISTS funding_rates (
    ts              TIMESTAMP NOT NULL,
    iid             VARCHAR NOT NULL,
    rate            DOUBLE NOT NULL,
    mark_price      DOUBLE,
    index_price     DOUBLE,
    PRIMARY KEY (iid, ts)
);

-- Crypto: aggregate open interest.
CREATE TABLE IF NOT EXISTS open_interest (
    ts              TIMESTAMP NOT NULL,
    iid             VARCHAR NOT NULL,
    oi_value        DOUBLE,                -- in USD
    oi_contracts    DOUBLE,                -- in base currency
    PRIMARY KEY (iid, ts)
);

-- Macro economic indicators (DXY, yields, CPI, VIX, M2).
-- These use series_id as the key since they don't map to a tradeable instrument.
CREATE TABLE IF NOT EXISTS macro (
    ts              TIMESTAMP NOT NULL,
    series_id       VARCHAR NOT NULL,      -- 'DXY', 'US10Y', 'VIX', 'CPIAUCSL'
    value           DOUBLE NOT NULL,
    PRIMARY KEY (series_id, ts)
);
`;

// ── Gold layer (precomputed features) ──────────────────────

export const GOLD_SQL = `
-- Precomputed technical features for backtesting and ML.
-- Avoids recomputing indicators on every backtest run.
CREATE TABLE IF NOT EXISTS features (
    ts              TIMESTAMP NOT NULL,
    iid             VARCHAR NOT NULL,
    interval        VARCHAR NOT NULL,
    sma_20          DOUBLE,
    sma_50          DOUBLE,
    ema_12          DOUBLE,
    ema_26          DOUBLE,
    rsi_14          DOUBLE,
    macd            DOUBLE,
    macd_signal     DOUBLE,
    macd_histogram  DOUBLE,
    bb_upper        DOUBLE,
    bb_middle       DOUBLE,
    bb_lower        DOUBLE,
    atr_14          DOUBLE,
    adx_14          DOUBLE,
    obv             DOUBLE,
    volatility_30d  DOUBLE,
    PRIMARY KEY (iid, interval, ts)
);
`;

// ── Sync metadata ──────────────────────────────────────────

export const SYNC_SQL = `
-- Tracks what has been fetched for incremental sync.
-- Uses iid (not source+symbol) to align with instrument master.
CREATE TABLE IF NOT EXISTS sync_state (
    iid             VARCHAR NOT NULL,
    data_type       VARCHAR NOT NULL,      -- 'ohlcv_1h', 'trades', 'orderbook', 'funding'
    last_ts         TIMESTAMP NOT NULL,
    last_synced     TIMESTAMP NOT NULL,
    record_count    BIGINT DEFAULT 0,
    PRIMARY KEY (iid, data_type)
);
`;

/** Full schema init: run all layers in order. */
export const SCHEMA_SQL = [REFERENCE_SQL, SILVER_SQL, EXTENSIONS_SQL, GOLD_SQL, SYNC_SQL].join('\n');

/** Interval durations in milliseconds, used for pagination calculations. */
export const INTERVAL_MS: Record<string, number> = {
  '1s':  1_000,
  '1m':  60_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
};

/** Valid asset classes. */
export type AssetClass = 'crypto' | 'equity' | 'fx' | 'commodity' | 'rate';

/** Valid instrument types. */
export type InstrumentType = 'spot' | 'perpetual' | 'future' | 'option' | 'index';
