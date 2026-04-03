#!/usr/bin/env node

/**
 * Check Alpaca connection status and account info.
 *
 * Loads credentials from:
 *   1. Environment variables (APCA_API_KEY_ID, APCA_API_SECRET_KEY)
 *   2. Credential store (~/.alpaca/credentials.json or keychain)
 */

import { AlpacaClient } from '../client/api';
import { loadCredentials, getBackendName } from '../client/credential-store';

async function main() {
  const backend = await getBackendName();
  console.error(`Backend: ${backend}`);

  // Try env vars first, then credential store
  let apiKey = process.env.APCA_API_KEY_ID ?? '';
  let apiSecret = process.env.APCA_API_SECRET_KEY ?? '';
  let paper = process.env.APCA_PAPER !== 'false';
  let source = 'environment';

  if (!apiKey || !apiSecret) {
    const creds = await loadCredentials();
    if (creds) {
      apiKey = creds.apiKey;
      apiSecret = creds.apiSecret;
      paper = creds.paper;
      source = 'credential store';
    }
  }

  if (!apiKey || !apiSecret) {
    console.error('Status: not configured');
    console.error('Run: npm run login');
    process.exit(1);
  }

  console.error(`Source: ${source}`);
  const client = new AlpacaClient({ apiKey, apiSecret, paper });
  console.error(`Mode: ${paper ? 'Paper Trading' : 'LIVE TRADING'}`);

  try {
    const account = await client.getAccount();
    console.error(`Account: ${account.account_number} (${account.status})`);
    console.error(`Equity: $${parseFloat(account.equity).toFixed(2)}`);
    console.error(`Cash: $${parseFloat(account.cash).toFixed(2)}`);
    console.error(`Buying Power: $${parseFloat(account.buying_power).toFixed(2)}`);
    console.error(`Portfolio Value: $${parseFloat(account.portfolio_value).toFixed(2)}`);

    if (account.trading_blocked) {
      console.error('WARNING: Trading is blocked on this account');
    }
    if (account.pattern_day_trader) {
      console.error(`Day Trade Count: ${account.daytrade_count}`);
    }
  } catch (error: any) {
    console.error(`Connection failed: ${error.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`Status check failed: ${err.message}`);
  process.exit(1);
});
