#!/usr/bin/env node

import { deleteCredentials, getBackendName } from '../client/credential-store';

async function main() {
  const backend = await getBackendName();
  await deleteCredentials();
  console.error(`Alpaca credentials removed from ${backend}`);
}

main().catch(err => {
  console.error(`Logout failed: ${err.message}`);
  process.exit(1);
});
