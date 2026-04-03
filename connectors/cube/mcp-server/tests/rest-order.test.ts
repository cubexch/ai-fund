import { describe, it, expect } from 'vitest';
import { IridiumClient } from '../src/client/iridium';

/**
 * Integration test: REST order placement via Iridium client.
 * Tests the full flow: authenticate → convert lots → POST /os/v0/order.
 *
 * Requires a Cube API key with WRITE access (not on waitlist).
 * Skip with: SKIP_ORDER_TESTS=1 npx vitest
 */

const SKIP = process.env.SKIP_ORDER_TESTS === '1';

describe.skipIf(SKIP)('REST Order Placement (integration)', () => {
  let client: IridiumClient;

  it('reaches the order endpoint and gets a structured response', async () => {
    process.env.CUBE_ENV = 'production';
    // Auth resolved from ~/.cube/credentials.json (device login) or env vars
    // Never hardcode real secrets — set CUBE_API_KEY + CUBE_SECRET_KEY in your shell if needed

    client = new IridiumClient();

    // SOLUSDC market 100086: priceTickSize=0.01, quantityTickSize=0.0001
    try {
      const result = await client.placeOrderRest({
        marketId: 100086,
        side: 0,        // BID
        price: 8369,    // 83.69 in lots
        quantity: 119,  // 0.0119 SOL in lots
        orderType: 0,   // LIMIT
        timeInForce: 1, // GFS
      });

      // If we get here, the order was placed
      expect(result).toBeDefined();
      expect(result.marketId).toBe(100086);
    } catch (error: any) {
      // ON_WAITLIST is expected if the API key hasn't been approved
      if (error.message.includes('ON_WAITLIST')) {
        console.log('API key is on waitlist — REST order endpoint is reachable but key needs approval');
        expect(error.message).toContain('ON_WAITLIST');
      } else {
        throw error; // Unexpected error
      }
    }
  }, 15_000);
});
