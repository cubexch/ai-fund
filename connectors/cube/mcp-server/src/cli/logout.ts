#!/usr/bin/env node
/**
 * Log out of Cube Exchange — delete stored credentials.
 *
 * Usage: npm run logout
 */

import { deleteCredentials, getBackendName } from '../client/signing.js';

const isColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: isColor ? '\x1b[0m' : '',
  bold:  isColor ? '\x1b[1m' : '',
  dim:   isColor ? '\x1b[2m' : '',
  green: isColor ? '\x1b[32m' : '',
};

async function main() {
  const backend = await getBackendName();
  await deleteCredentials();

  const store = backend === 'keychain' ? 'macOS Keychain'
    : backend === 'secret-tool' ? 'System keyring'
    : '~/.cube/credentials.json';

  console.log('');
  console.log(`  ${c.green}${c.bold}Logged out${c.reset}`);
  console.log(`  ${c.dim}Credentials removed from ${store}.${c.reset}`);
  console.log('');
}

main().catch(err => {
  console.error(`  Error: ${err.message}`);
  process.exit(1);
});
