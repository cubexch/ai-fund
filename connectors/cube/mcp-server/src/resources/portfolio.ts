import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { IridiumClient } from '../client/iridium';

export function registerPortfolioResources(server: McpServer, iridium: IridiumClient) {
  server.resource(
    'portfolio',
    'cube://portfolio',
    {
      description: 'Current portfolio snapshot: positions, balances, and recent order history.',
      mimeType: 'application/json',
    },
    async () => {
      const subId = await iridium.getDefaultSubaccountId();

      const [positions, orders] = await Promise.all([
        iridium.getPositions(subId).catch(() => ({})),
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
