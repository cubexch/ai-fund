/**
 * Test helpers — re-exports shared fixtures and provides Alpaca-specific helpers.
 *
 * Mock fetch and MockMcpServer now live in @ai-fund/lib/test-fixtures.
 * This file re-exports them for backwards compatibility and adds
 * Alpaca-specific wrappers (createMockClient with AlpacaClient).
 */

// Re-export shared fixtures
export {
  MockMcpServer,
  mockFetch,
  type MockResponse,
  type FetchCall,
} from '@ai-fund/lib/test-fixtures';

export {
  TICKERS, BALANCES, MARKETS,
  BTC_BARS, ETH_BARS, SOL_BARS,
  FILLED_ORDER, OPEN_LIMIT_ORDER,
  generateBars,
} from '@ai-fund/lib/test-fixtures/market-data';

/**
 * Create an AlpacaClient with a mock fetch function.
 */
export async function createMockClient(responses: import('@ai-fund/lib/test-fixtures').MockResponse[]) {
  const { AlpacaClient } = await import('../src/client/api');
  const { mockFetch: mf } = await import('@ai-fund/lib/test-fixtures');
  const fetch = mf(responses);
  const client = new AlpacaClient({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    paper: true,
    fetchFn: fetch,
  });
  return { client, fetch };
}
