#!/usr/bin/env node

import { loadCredentials, loadCredentialsRaw, getBackendName } from '../client/credential-store.js';

async function main() {
  const backend = await getBackendName();
  const creds = await loadCredentials();
  const raw = creds ? null : await loadCredentialsRaw();

  console.error(`Backend: ${backend}`);

  if (creds) {
    const expiresIn = creds.expiresAt - Math.floor(Date.now() / 1000);
    console.error(`Status: authenticated`);
    console.error(`Token expires in: ${Math.round(expiresIn / 60)} minutes`);
    console.error(`Device token: ${creds.deviceToken.slice(0, 8)}...`);
  } else if (raw) {
    console.error(`Status: expired (refresh token available)`);
    console.error(`Device token: ${raw.deviceToken.slice(0, 8)}...`);
  } else {
    console.error(`Status: not authenticated`);
    console.error(`Run: npm run login`);
  }
}

main().catch(err => {
  console.error(`✗ Status check failed: ${err.message}`);
  process.exit(1);
});
