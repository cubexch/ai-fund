#!/usr/bin/env node
/**
 * Show current auth status for Cube Exchange.
 *
 * Usage: npm run status
 */

import { loadCredentials, getBackendName, CREDENTIALS_PATH } from '../client/signing';
import { resolveAuth, resetAuth } from '../client/auth';

const isColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  reset: isColor ? '\x1b[0m' : '',
  bold:  isColor ? '\x1b[1m' : '',
  dim:   isColor ? '\x1b[2m' : '',
  cyan:  isColor ? '\x1b[36m' : '',
  green: isColor ? '\x1b[32m' : '',
  red:   isColor ? '\x1b[31m' : '',
  yellow:isColor ? '\x1b[33m' : '',
};

async function main() {
  // Resolve what auth the MCP server will use
  resetAuth();
  const auth = await resolveAuth();

  const creds = await loadCredentials();
  const hasSigningEnv = !!(process.env.CUBE_SIGNING_KEY && process.env.CUBE_VERIFICATION_KEY_ID);

  if (!creds && !hasSigningEnv) {
    console.log('');
    console.log(`  ${c.yellow}${c.bold}Not logged in${c.reset}`);
    console.log(`  ${c.dim}Market data tools work without login.${c.reset}`);
    console.log(`  ${c.dim}Run npm run login to enable trading.${c.reset}`);
    console.log('');
    process.exit(0);
  }

  // Show active auth method
  console.log('');
  const authLabel = auth ? 'Ed25519 signing' : 'none';
  const authSource = hasSigningEnv ? 'CUBE_SIGNING_KEY env'
    : creds ? 'credential store'
    : 'none';
  console.log(`  ${c.green}${c.bold}Authenticated${c.reset} ${c.dim}(${authLabel} via ${authSource})${c.reset}`);

  // Show signing credentials if available
  if (creds) {
    const backend = await getBackendName();
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = creds.expiresAt - now;
    const days = Math.floor(expiresIn / 86400);
    const hours = Math.floor((expiresIn % 86400) / 3600);
    const timeStr = days > 0 ? `${days}d ${hours}h` : `${hours}h`;
    const expiry = new Date(creds.expiresAt * 1000).toLocaleDateString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
    const warn = days <= 1;

    console.log('');
    console.log(`  ${c.cyan}Signing Key${c.reset}${warn ? ` ${c.yellow}(expires in ${timeStr})${c.reset}` : ` ${c.dim}(expires in ${timeStr})${c.reset}`}`);
    console.log(`    ${c.dim}Key${c.reset}        ${creds.ed25519PublicKey.slice(0, 16)}...`);
    if (creds.verificationKeyId) {
      console.log(`    ${c.dim}Key ID${c.reset}     ${creds.verificationKeyId}`);
    }
    console.log(`    ${c.dim}Provider${c.reset}   ${creds.provider}`);
    console.log(`    ${c.dim}Expires${c.reset}    ${expiry}`);
    console.log(`    ${c.dim}Backend${c.reset}    ${backend === 'keychain' ? 'macOS Keychain' : backend === 'secret-tool' ? 'System keyring' : 'File (~/.cube/credentials.json)'}`);
  }

  if (hasSigningEnv) {
    console.log('');
    console.log(`  ${c.cyan}Signing Key${c.reset} ${c.dim}(from env)${c.reset}`);
    console.log(`    ${c.dim}Key ID${c.reset}     ${process.env.CUBE_VERIFICATION_KEY_ID}`);
  }

  console.log('');
}

main().catch(err => {
  console.error(`  Error: ${err.message}`);
  process.exit(1);
});
