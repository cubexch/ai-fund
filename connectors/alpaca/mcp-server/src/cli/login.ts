#!/usr/bin/env node

/**
 * Alpaca login CLI — saves API key + secret to credential store.
 *
 * Usage:
 *   npm run login
 *
 * Or with env vars (non-interactive / headless):
 *   APCA_API_KEY_ID=... APCA_API_SECRET_KEY=... npm run login
 *
 * Validates credentials by calling GET /v2/account before saving.
 * Defaults to paper trading unless --live is passed.
 */

import { AlpacaClient } from '../client/api.js';
import { saveCredentials, getBackendName } from '../client/credential-store.js';

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    process.stderr.write(question);

    const stdin = process.stdin;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let input = '';
    const onData = (chunk: Buffer) => {
      const str = chunk.toString();
      for (const c of str) {
        if (c === '\n' || c === '\r') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY) stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          resolve(input);
          return;
        } else if (c === '\u0003') {
          process.exit(1);
        } else if (c === '\u007f' || c === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else if (c.charCodeAt(0) >= 32) {
          input += c;
          process.stderr.write(hidden ? '*' : c);
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const isLive = process.argv.includes('--live');
  const paper = !isLive;

  console.error(`\nAlpaca Login (${paper ? 'paper' : 'LIVE'} trading)\n`);

  if (!paper) {
    console.error('WARNING: You are connecting to LIVE trading. Real money will be used.\n');
  }

  // Read from env vars or prompt
  const apiKey = process.env.APCA_API_KEY_ID || await prompt('API Key ID: ');
  const apiSecret = process.env.APCA_API_SECRET_KEY || await prompt('API Secret Key: ', true);

  if (!apiKey || !apiSecret) {
    console.error('Error: API key and secret are required.');
    console.error('Get yours at https://app.alpaca.markets/paper/dashboard/overview');
    process.exit(1);
  }

  // Validate by calling /v2/account
  console.error('\nValidating credentials...');
  const client = new AlpacaClient({ apiKey, apiSecret, paper });

  try {
    const account = await client.getAccount();

    // Save to credential store
    await saveCredentials({ apiKey, apiSecret, paper });
    const backend = await getBackendName();

    console.error(`\nAuthenticated as ${account.account_number} (${backend})`);
    console.error(`  Mode: ${paper ? 'Paper Trading' : 'LIVE'}`);
    console.error(`  Equity: $${parseFloat(account.equity).toFixed(2)}`);
    console.error(`  Buying Power: $${parseFloat(account.buying_power).toFixed(2)}`);
    console.error('\n  Credentials saved. You can now start the MCP server.\n');
  } catch (error: any) {
    console.error(`\nAuthentication failed: ${error.message}`);
    console.error('\nCheck your API key and secret at:');
    console.error(`  ${paper ? 'https://app.alpaca.markets/paper/dashboard/overview' : 'https://app.alpaca.markets/brokerage/dashboard/overview'}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\nLogin failed: ${err.message}`);
  process.exit(1);
});
