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

import { AuthManager } from '../client/auth';
import { getBackendName } from '../client/credential-store';

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
          // Ctrl+C
          process.exit(1);
        } else if (c === '\u007f' || c === '\b') {
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else if (c.charCodeAt(0) >= 32) {
          // Printable characters only (ignores control chars like Ctrl+V's \x16)
          input += c;
          process.stderr.write(hidden ? '*' : c);
        }
      }
    };
    stdin.on('data', onData);
  });
}

function loginSuccess(username: string): void {
  getBackendName().then(backend => {
    console.error(`\n✓ Authenticated as ${username} (${backend})`);
    console.error('  Tokens saved securely. You can now start the MCP server.\n');
    process.exit(0);
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
  const mfaCode = process.env.ROBINHOOD_MFA_CODE;

  // First attempt
  let result = await auth.login(username, password, { mfaCode });

  if (result.type === 'success') {
    loginSuccess(username);
    return;
  }

  // Verification workflow (new Robinhood flow — SMS/email/app approval via pathfinder)
  if (result.type === 'verification') {
    console.error('\nDevice verification required...');

    const verified = await auth.handleVerificationWorkflow(
      result.deviceToken,
      result.workflowId,
      async (type, message) => {
        console.error(message);
        if (type === 'sms' || type === 'email') {
          return await prompt('Verification code: ');
        }
        // For 'prompt' type, user approves in app — no input needed
      },
      (msg) => console.error(msg),
    );

    if (!verified) {
      console.error('\n✗ Verification failed.');
      process.exit(1);
    }

    // Retry login after verification
    result = await auth.login(username, password);

    if (result.type === 'success') {
      loginSuccess(username);
      return;
    }
  }

  // MFA required (TOTP app)
  if (result.type === 'mfa') {
    console.error(`\nMFA required (type: ${result.mfaType})`);

    const code = mfaCode || await prompt('MFA code: ');
    const mfaResult = await auth.login(username, password, { mfaCode: code });

    if (mfaResult.type === 'success') {
      loginSuccess(username);
      return;
    }

    console.error('\n✗ Authentication failed. Check your MFA code.');
    process.exit(1);
  }

  // Error
  if (result.type === 'error') {
    console.error(`\n✗ ${result.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`\n✗ Login failed: ${err.message}`);
  process.exit(1);
});
