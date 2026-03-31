#!/usr/bin/env node
/**
 * CLI login command for Cube Exchange.
 *
 * Flow (polling-based, no localhost server needed):
 * 1. Generate Ed25519 keypair locally
 * 2. Encode public key as VerificationKey protobuf → base64 nonce
 * 3. Get CSRF token + cookies from Cube's NextAuth
 * 4. POST to NextAuth signin endpoint with nonce
 * 5. Open Google OAuth URL in user's default browser
 * 6. Poll GET /ir/v0/users/verification-keys until our key appears
 * 7. Save credentials to ~/.cube/credentials.json
 */

import { generateKeyPair, encodeVerificationKey, saveCredentials, loadCredentials, toHex, CREDENTIALS_PATH } from '../client/signing.js';
import { generateSignature } from '../client/auth.js';

const CUBE_BASE = 'https://www.cube.exchange';
const API_BASE = 'https://api.cube.exchange/ir/v0';
const KEY_EXPIRY_SECONDS = 518400; // 6 days (matches Cube's default)
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180_000; // 3 minutes

type Provider = 'google' | 'apple' | 'telegram';

async function main() {
  const provider: Provider = (process.argv[2] as Provider) || 'google';
  const validProviders: Provider[] = ['google', 'apple', 'telegram'];
  if (!validProviders.includes(provider)) {
    console.error(`Invalid provider: ${provider}. Use one of: ${validProviders.join(', ')}`);
    process.exit(1);
  }

  // Check for existing valid credentials
  const existing = await loadCredentials();
  if (existing) {
    const expiresIn = existing.expiresAt - Math.floor(Date.now() / 1000);
    const hours = Math.floor(expiresIn / 3600);
    console.log(`\nExisting credentials found (expires in ${hours}h).`);
    console.log(`  Public key: ${existing.ed25519PublicKey.slice(0, 16)}...`);
    console.log(`  Provider: ${existing.provider}`);
    console.log(`\nTo force re-login, delete ${CREDENTIALS_PATH} and try again.\n`);
    process.exit(0);
  }

  // Check HMAC credentials
  const apiKey = process.env.CUBE_API_KEY;
  const secretKey = process.env.CUBE_SECRET_KEY;
  if (!apiKey || !secretKey) {
    console.error('Missing CUBE_API_KEY or CUBE_SECRET_KEY environment variables.');
    console.error('These are needed to poll for key registration.');
    process.exit(1);
  }

  console.log('\n🔑 Cube Exchange — Agent Login\n');

  // 1. Generate Ed25519 keypair
  console.log('Generating Ed25519 keypair...');
  const keyPair = await generateKeyPair();
  const pubKeyHex = toHex(keyPair.publicKey);
  console.log(`  Public key: ${pubKeyHex.slice(0, 16)}...`);

  // 2. Encode as VerificationKey protobuf
  const expiresAt = Math.floor(Date.now() / 1000) + KEY_EXPIRY_SECONDS;
  const vkBytes = encodeVerificationKey(keyPair.publicKey, expiresAt);
  const vkBase64 = Buffer.from(vkBytes).toString('base64');

  // 3. Get CSRF token from NextAuth
  console.log('Getting CSRF token...');
  const csrfRes = await fetch(`${CUBE_BASE}/api/auth/csrf`);
  if (!csrfRes.ok) {
    console.error(`Failed to get CSRF token: ${csrfRes.status}`);
    process.exit(1);
  }
  const csrfData = await csrfRes.json() as { csrfToken: string };
  const csrfToken = csrfData.csrfToken;

  // Extract cookies from the CSRF response
  const csrfCookies = csrfRes.headers.getSetCookie?.() ?? [];
  const cookieHeader = csrfCookies
    .map(c => c.split(';')[0])
    .join('; ');

  // 4. POST to NextAuth signin with nonce
  console.log(`Initiating ${provider} sign-in...`);
  const signinRes = await fetch(`${CUBE_BASE}/api/auth/signin/${provider}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieHeader,
    },
    body: new URLSearchParams({
      csrfToken,
      json: 'true',
      'x-cube-nextauth-nonce': vkBase64,
    }),
    redirect: 'manual',
  });

  let authUrl: string | null = null;

  if (signinRes.status >= 300 && signinRes.status < 400) {
    // Redirect — the Location header is the OAuth URL
    authUrl = signinRes.headers.get('location');
  } else if (signinRes.ok) {
    // JSON response with URL
    const body = await signinRes.json() as { url?: string };
    authUrl = body.url ?? null;
  }

  if (!authUrl) {
    console.error(`Failed to get OAuth URL. Status: ${signinRes.status}`);
    const body = await signinRes.text().catch(() => '');
    if (body) console.error(body.slice(0, 500));
    process.exit(1);
  }

  // 5. Open browser
  console.log('\nOpening browser for authentication...');
  console.log(`If the browser doesn't open, visit:\n  ${authUrl}\n`);

  // Dynamic import to avoid requiring 'open' as a hard dependency
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const open = ((await import('open' as string)) as { default: (url: string) => Promise<unknown> }).default;
    await open(authUrl);
  } catch {
    // Fallback: try platform-specific commands
    const { exec } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open' :
                process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} "${authUrl}"`);
  }

  // 6. Poll for key registration
  console.log('Waiting for authentication...');
  console.log('(Complete sign-in in your browser, then return here)\n');

  const startTime = Date.now();
  let found = false;

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);

    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = generateSignature(secretKey, timestamp);

      const res = await fetch(`${API_BASE}/users/verification-keys`, {
        headers: {
          'x-api-key': apiKey,
          'x-api-signature': signature,
          'x-api-timestamp': String(timestamp),
        },
      });

      if (!res.ok) continue;

      const data = await res.json() as { result?: Array<{
        verificationKeyId: string;
        verificationKey: string;
        expiresAt: number;
        createdAt: number;
      }> };

      const keys = data.result ?? [];

      // Look for our key by matching the base64-encoded verification key
      const ourKey = keys.find(k => k.verificationKey === vkBase64);

      if (ourKey) {
        found = true;

        // 7. Save credentials
        await saveCredentials({
          ed25519PrivateKey: toHex(keyPair.privateKeyRaw),
          ed25519PublicKey: pubKeyHex,
          verificationKey: vkBase64,
          verificationKeyId: ourKey.verificationKeyId,
          expiresAt: ourKey.expiresAt,
          createdAt: ourKey.createdAt,
          provider,
        });

        const expiryDate = new Date(ourKey.expiresAt * 1000);
        console.log('✅ Authentication successful!\n');
        console.log(`  Key ID: ${ourKey.verificationKeyId}`);
        console.log(`  Public key: ${pubKeyHex.slice(0, 16)}...`);
        console.log(`  Expires: ${expiryDate.toISOString()}`);
        console.log(`  Saved to: ${CREDENTIALS_PATH}\n`);
        break;
      }

      // Progress indicator
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      process.stdout.write(`\r  Polling... ${elapsed}s elapsed`);
    } catch {
      // Network error, keep polling
    }
  }

  if (!found) {
    console.error('\n\n⏰ Authentication timed out after 3 minutes.');
    console.error('Please try again with: npx tsx src/cli/login.ts\n');
    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
