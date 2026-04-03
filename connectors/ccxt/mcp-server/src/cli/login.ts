#!/usr/bin/env node

/**
 * CCXT login CLI — saves exchange credentials to the credential store.
 *
 * Usage:
 *   npm run login                          # Coinbase (default)
 *   npm run login -- --exchange binance    # Binance
 *   npm run login -- --sandbox             # Sandbox/testnet mode
 *
 * Or non-interactive (headless / CI):
 *   COINBASE_API_KEY=... COINBASE_SECRET=... npm run login
 *
 * Validates credentials by calling fetchBalance before saving.
 */

import { ExchangeClient } from '../client/exchange.js';
import { saveCredentials, getBackendName } from '../client/credential-store.js';
import { parseArgs, envPrefix } from './common.js';

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
  const { exchangeId, sandbox } = parseArgs();
  const prefix = envPrefix(exchangeId);

  console.error(`\nCCXT Login — ${exchangeId} (${sandbox ? 'sandbox' : 'LIVE'})\n`);

  if (!sandbox) {
    console.error('WARNING: No --sandbox flag. Credentials will connect to LIVE trading.\n');
  }

  // Read from exchange-specific env vars, generic CCXT vars, or prompt
  const apiKey = process.env[`${prefix}_API_KEY`]
    ?? process.env.CCXT_API_KEY
    ?? await prompt('API Key: ');

  const secret = process.env[`${prefix}_SECRET`]
    ?? process.env.CCXT_SECRET
    ?? await prompt('Secret: ', true);

  if (!apiKey || !secret) {
    console.error('Error: API key and secret are required.');
    process.exit(1);
  }

  const password = process.env[`${prefix}_PASSWORD`]
    ?? process.env[`${prefix}_PASSPHRASE`]
    ?? process.env.CCXT_PASSWORD
    ?? await prompt('Password/Passphrase (press Enter to skip): ', true);

  // Validate by connecting and fetching balance
  console.error('\nValidating credentials...');
  const client = new ExchangeClient({
    exchangeId,
    apiKey,
    secret,
    password: password || undefined,
    sandbox,
  });

  try {
    const balances = await client.getBalance();

    await saveCredentials({
      exchangeId,
      apiKey,
      secret,
      password: password || undefined,
      sandbox,
    });
    const backend = await getBackendName();

    console.error(`\nAuthenticated on ${client.name} (stored in ${backend})`);
    console.error(`  Mode:     ${sandbox ? 'sandbox/testnet' : 'LIVE'}`);
    console.error(`  Assets:   ${balances.length} with non-zero balance`);
    if (balances.length > 0) {
      const top = balances.slice(0, 5);
      for (const b of top) {
        console.error(`    ${b.currency}: ${b.total} (${b.free} free)`);
      }
      if (balances.length > 5) {
        console.error(`    ... and ${balances.length - 5} more`);
      }
    }
    console.error('\n  Credentials saved. You can now start the MCP server.\n');
  } catch (error: any) {
    console.error(`\nAuthentication failed: ${error.message}`);
    console.error('\nCheck your credentials and try again.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\nLogin failed: ${err.message}`);
  process.exit(1);
});
