import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCredentials } from '../client/auth.js';
import type { IridiumClient } from '../client/iridium.js';

export function registerPortfolioResources(server: McpServer, iridium: IridiumClient) {
  server.resource(
    'portfolio',
    'cube://portfolio',
    {
      description: 'Current portfolio snapshot: positions, balances, and recent order history.',
      mimeType: 'application/json',
    },
    async () => {
      const subId = getCredentials().subaccountId;

      const [positions, balances, orders] = await Promise.all([
        iridium.getPositions(subId).catch(() => []),
        iridium.getBalances(subId).catch(() => []),
        iridium.getOrderHistory(subId, { limit: 10 }).catch(() => []),
      ]);

      return {
        contents: [
          {
            uri: 'cube://portfolio',
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                subaccountId: subId,
                positions,
                balances,
                recentOrders: orders,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
