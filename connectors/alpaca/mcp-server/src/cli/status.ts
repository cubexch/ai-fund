#!/usr/bin/env node

/**
 * Check Alpaca connection status and account info.
 */

import { AlpacaClient } from '../client/api.js';

const client = new AlpacaClient();

if (!client.hasCredentials) {
  console.log('Not configured. Set environment variables:');
  console.log('  APCA_API_KEY_ID=your-key');
  console.log('  APCA_API_SECRET_KEY=your-secret');
  console.log('  APCA_PAPER=true  (default, set to false for live)');
  process.exit(1);
}

console.log(`Mode: ${client.isPaper ? 'Paper Trading' : 'LIVE TRADING'}`);

try {
  const account = await client.getAccount();
  console.log(`Account: ${account.account_number} (${account.status})`);
  console.log(`Equity: $${parseFloat(account.equity).toFixed(2)}`);
  console.log(`Cash: $${parseFloat(account.cash).toFixed(2)}`);
  console.log(`Buying Power: $${parseFloat(account.buying_power).toFixed(2)}`);
  console.log(`Portfolio Value: $${parseFloat(account.portfolio_value).toFixed(2)}`);

  if (account.trading_blocked) {
    console.log('WARNING: Trading is blocked on this account');
  }
  if (account.pattern_day_trader) {
    console.log(`Day Trade Count: ${account.daytrade_count}`);
  }
} catch (error: any) {
  console.error(`Connection failed: ${error.message}`);
  process.exit(1);
}
