/**
 * @ai-fund/lib/test-fixtures — shared test utilities for all connectors.
 *
 * Consolidates MockMcpServer, mock exchange clients, mock fetch,
 * canned market data, and HTTP record/replay into one package.
 */

export { MockMcpServer, type RegisteredTool } from './mock-mcp-server';
export {
  createMockExchangeClient,
  type MockCall,
  type MockExchangeOpts,
} from './mock-exchange';
export {
  mockFetch,
  mockFetchRouter,
  type MockResponse,
  type FetchCall,
  type MockRoute,
  type FetchFn,
} from './mock-fetch';
export {
  withCassette,
  cassette,
  type ReplayController,
} from './http-replay';
export {
  // Tickers
  TICKERS, ticker, allTickers, type TickerFixture,
  // Bars
  generateBars, BTC_BARS, ETH_BARS, SOL_BARS, type BarFixture,
  // Order book
  generateOrderBook, BTC_ORDER_BOOK, type OrderBookFixture,
  // Trades
  generateTrades, BTC_TRADES, type TradeFixture,
  // Balances
  BALANCES, type BalanceFixture,
  // Orders
  FILLED_ORDER, OPEN_LIMIT_ORDER, type OrderFixture,
  // Markets
  MARKETS, type MarketFixture,
  // Constants
  BASE_TS,
} from './market-data';
