#!/usr/bin/env node

/**
 * Interactive Robinhood login CLI.
 *
 * Usage:
 *   npm run login
 *
 * Or with env vars (non-interactive):
 *   ROBINHOOD_USERNAME=user@example.com ROBINHOOD_PASSWORD=... npm run login
 *   ROBINHOOD_USERNAME=user@example.com ROBINHOOD_PASSWORD=... ROBINHOOD_MFA_CODE=123456 npm run login
 */

import * as readline from 'node:readline';
import { AuthManager } from '../client/auth.js';
import { getBackendName } from '../client/credential-store.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stderr,
});

function prompt(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    if (hidden) {
      process.stderr.write(question);
      // Read password without echo
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      if (stdin.isTTY) stdin.setRawMode(true);

      let input = '';
      const onData = (char: Buffer) => {
        const c = char.toString();
        if (c === '\n' || c === '\r') {
          stdin.removeListener('data', onData);
          if (stdin.isTTY && wasRaw !== undefined) stdin.setRawMode(wasRaw);
          process.stderr.write('\n');
          resolve(input);
        } else if (c === '\u0003') {
          // Ctrl+C
          process.exit(1);
        } else if (c === '\u007f' || c === '\b') {
          // Backspace
          input = input.slice(0, -1);
        } else {
          input += c;
        }
      };
      stdin.on('data', onData);
    } else {
      rl.question(question, answer => resolve(answer.trim()));
    }
  });
}

async function main() {
  console.error('\n🔐 Robinhood Login\n');

  const username = process.env.ROBINHOOD_USERNAME || await prompt('Email: ');
  const password = process.env.ROBINHOOD_PASSWORD || await prompt('Password: ', true);

  if (!username || !password) {
    console.error('Error: Username and password are required.');
    process.exit(1);
  }

  const auth = new AuthManager();
  let mfaCode = process.env.ROBINHOOD_MFA_CODE;

  // First attempt
  const result = await auth.login(username, password, mfaCode);

  if (result === 'success') {
    const backend = await getBackendName();
    console.error(`\n✓ Authenticated as ${username} (${backend})`);
    console.error('  Tokens saved securely. You can now start the MCP server.\n');
    rl.close();
    process.exit(0);
  }

  // MFA required
  console.error(`\nMFA required (type: ${result})`);

  if (!mfaCode) {
    mfaCode = await prompt('MFA code: ');
  }

  const mfaResult = await auth.login(username, password, mfaCode);

  if (mfaResult === 'success') {
    const backend = await getBackendName();
    console.error(`\n✓ Authenticated as ${username} (${backend})`);
    console.error('  Tokens saved securely. You can now start the MCP server.\n');
  } else {
    console.error('\n✗ Authentication failed. Check your credentials and MFA code.');
    process.exit(1);
  }

  rl.close();
}

main().catch(err => {
  console.error(`\n✗ Login failed: ${err.message}`);
  rl.close();
  process.exit(1);
});
