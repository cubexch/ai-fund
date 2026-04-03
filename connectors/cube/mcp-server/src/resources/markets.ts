import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IridiumClient } from '../client/iridium';

export function registerMarketResources(server: McpServer, iridium: IridiumClient) {
  server.resource(
    'markets',
    'cube://markets',
    {
      description: 'All available trading markets on Cube Exchange with symbols, precision, and limits.',
      mimeType: 'application/json',
    },
    async () => {
      const markets = await iridium.getMarkets();
      return {
        contents: [
          {
            uri: 'cube://markets',
            mimeType: 'application/json',
            text: JSON.stringify(markets, null, 2),
          },
        ],
      };
    }
  );

  server.resource(
    'tickers',
    'cube://tickers',
    {
      description: 'Real-time ticker data for all markets: prices, volume, 24h change.',
      mimeType: 'application/json',
    },
    async () => {
      const tickers = await iridium.getTickers();
      return {
        contents: [
          {
            uri: 'cube://tickers',
            mimeType: 'application/json',
            text: JSON.stringify(tickers, null, 2),
          },
        ],
      };
    }
  );
}
