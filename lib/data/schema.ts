/**
 * DuckDB schema definitions for the local market data store.
 * All tables use INSERT OR IGNORE semantics via primary keys
 * to support safe incremental re-ingestion.
 */

export const SCHEMA_SQL = `
-- OHLCV candlestick data (the primary dataset for backtesting)
CREATE TABLE IF NOT EXISTS ohlcv (
    source      VARCHAR NOT NULL,
    symbol      VARCHAR NOT NULL,
    interval    VARCHAR NOT NULL,
    ts          TIMESTAMP NOT NULL,
    open        DOUBLE NOT NULL,
    high        DOUBLE NOT NULL,
    low         DOUBLE NOT NULL,
    close       DOUBLE NOT NULL,
    volume      DOUBLE NOT NULL,
    quote_volume DOUBLE,
    trades      INTEGER,
    PRIMARY KEY (source, symbol, interval, ts)
);

-- Recent trades (tick-level)
CREATE TABLE IF NOT EXISTS trades (
    source      VARCHAR NOT NULL,
    symbol      VARCHAR NOT NULL,
    trade_id    VARCHAR NOT NULL,
    ts          TIMESTAMP NOT NULL,
    price       DOUBLE NOT NULL,
    quantity    DOUBLE NOT NULL,
    side        VARCHAR,
    PRIMARY KEY (source, symbol, trade_id)
);

-- Perpetual swap funding rates
CREATE TABLE IF NOT EXISTS funding_rates (
    source      VARCHAR NOT NULL,
    symbol      VARCHAR NOT NULL,
    ts          TIMESTAMP NOT NULL,
    rate        DOUBLE NOT NULL,
    mark_price  DOUBLE,
    index_price DOUBLE,
    PRIMARY KEY (source, symbol, ts)
);

-- Aggregate open interest
CREATE TABLE IF NOT EXISTS open_interest (
    source      VARCHAR NOT NULL,
    symbol      VARCHAR NOT NULL,
    ts          TIMESTAMP NOT NULL,
    oi_value    DOUBLE NOT NULL,
    oi_quantity DOUBLE,
    PRIMARY KEY (source, symbol, ts)
);

-- L2 order book snapshots (sampled at intervals)
CREATE TABLE IF NOT EXISTS orderbook_snapshots (
    source      VARCHAR NOT NULL,
    symbol      VARCHAR NOT NULL,
    ts          TIMESTAMP NOT NULL,
    side        VARCHAR NOT NULL,
    level       INTEGER NOT NULL,
    price       DOUBLE NOT NULL,
    quantity    DOUBLE NOT NULL,
    PRIMARY KEY (source, symbol, ts, side, level)
);

-- Macro economic indicators (DXY, yields, CPI, M2, etc.)
CREATE TABLE IF NOT EXISTS macro (
    series_id   VARCHAR NOT NULL,
    source      VARCHAR NOT NULL,
    ts          TIMESTAMP NOT NULL,
    value       DOUBLE NOT NULL,
    PRIMARY KEY (series_id, ts)
);

-- Tracks what has been fetched for incremental sync
CREATE TABLE IF NOT EXISTS sync_state (
    source      VARCHAR NOT NULL,
    symbol      VARCHAR NOT NULL,
    data_type   VARCHAR NOT NULL,
    last_ts     TIMESTAMP NOT NULL,
    last_synced TIMESTAMP NOT NULL,
    record_count BIGINT DEFAULT 0,
    PRIMARY KEY (source, symbol, data_type)
);
`;

/** Interval durations in milliseconds, used for pagination calculations. */
export const INTERVAL_MS: Record<string, number> = {
  '1s':  1_000,
  '1m':  60_000,
  '15m': 900_000,
  '1h':  3_600_000,
  '4h':  14_400_000,
  '1d':  86_400_000,
};
