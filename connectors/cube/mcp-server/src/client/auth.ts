import { createHmac } from 'node:crypto';
import { loadCredentials, importPrivateKey, signMessage, fromHex, type SigningCredentials } from './signing.js';

export interface CubeCredentials {
  apiKey: string;
  secretKey: string;
}

export type { SigningCredentials };

export interface CubeEnvironment {
  restUrl: string;
  mdRestUrl: string;
  osRestUrl: string;
  wsTradeUrl: string;
  wsMarketDataUrl: string;
}

const ENVIRONMENTS: Record<string, CubeEnvironment> = {
  production: {
    restUrl: 'https://api.cube.exchange/ir/v0',
    mdRestUrl: 'https://api.cube.exchange/md',
    osRestUrl: 'https://api.cube.exchange/os/v0',
    wsTradeUrl: 'wss://api.cube.exchange/os',
    wsMarketDataUrl: 'wss://api.cube.exchange/md',
  },
  staging: {
    restUrl: 'https://staging.cube.exchange/ir/v0',
    mdRestUrl: 'https://staging.cube.exchange/md',
    osRestUrl: 'https://staging.cube.exchange/os/v0',
    wsTradeUrl: 'wss://staging.cube.exchange/os',
    wsMarketDataUrl: 'wss://staging.cube.exchange/md',
  },
};

/**
 * CUBE_HOST override — replace the host in all URLs and prepend /api to paths.
 * e.g. CUBE_HOST=w.cube.ngrok.app routes through the Next.js frontend proxy.
 */
export const CUBE_HOST = process.env.CUBE_HOST || '';

export function rewriteUrl(url: string): string {
  if (!CUBE_HOST) return url;
  return url.replace(/\/\/[^/]+(\/.*)?$/, `//${CUBE_HOST}/api$1`);
}

export function getEnvironment(env?: string): CubeEnvironment {
  const base = ENVIRONMENTS[env || 'staging'] || ENVIRONMENTS.staging;

  if (CUBE_HOST) {
    return {
      restUrl: rewriteUrl(base.restUrl),
      mdRestUrl: rewriteUrl(base.mdRestUrl),
      osRestUrl: rewriteUrl(base.osRestUrl),
      wsTradeUrl: rewriteUrl(base.wsTradeUrl),
      wsMarketDataUrl: rewriteUrl(base.wsMarketDataUrl),
    };
  }

  return base;
}

/**
 * Try to get HMAC credentials from env vars.
 * Returns null if not set (instead of throwing).
 */
export function getCredentials(): CubeCredentials | null {
  const apiKey = process.env.CUBE_API_KEY;
  const secretKey = process.env.CUBE_SECRET_KEY;

  if (!apiKey || !secretKey) return null;

  return { apiKey, secretKey };
}

/**
 * Generate HMAC-SHA256 signature for Osmium WebSocket authentication.
 * Input: UTF-8 "cube.xyz" + little-endian 8-byte timestamp
 * Secret: hex-decoded 32-byte secret key
 * Output: base-64 encoded signature
 */
export function generateSignature(secretKey: string, timestamp: number): string {
  const secretBytes = Buffer.from(secretKey, 'hex');
  const payload = Buffer.alloc(16);
  payload.write('cube.xyz', 0, 'utf-8');
  payload.writeBigInt64LE(BigInt(timestamp), 8);

  const hmac = createHmac('sha256', secretBytes);
  hmac.update(payload);
  return hmac.digest('base64');
}

/**
 * Generate Ed25519 signature for REST authentication.
 * Same payload format as HMAC: "cube.xyz" (8 bytes) + timestamp LE (8 bytes).
 * Output: base-64 encoded Ed25519 signature.
 */
export async function generateEd25519Signature(privateKey: CryptoKey, timestamp: number): Promise<string> {
  const payload = Buffer.alloc(16);
  payload.write('cube.xyz', 0, 'utf-8');
  payload.writeBigInt64LE(BigInt(timestamp), 8);
  const sig = await signMessage(new Uint8Array(payload), privateKey);
  return Buffer.from(sig).toString('base64');
}

// ── Auth Resolution ──────────────────────────────────────

/**
 * Authentication methods, in priority order:
 *
 * 1. CUBE_SIGNING_KEY env var (CI/CD) — Ed25519 hex seed + CUBE_VERIFICATION_KEY_ID
 * 2. CUBE_API_KEY + CUBE_SECRET_KEY env vars — HMAC auth (explicit override)
 * 3. Credential store (npm run login) — Ed25519 from keychain/file
 *
 * Env vars always win over the credential store, since setting them is
 * an intentional override (e.g., different account, testing, CI).
 */

export type AuthMethod =
  | { type: 'signing'; verificationKeyId: string; privateKey: CryptoKey }
  | { type: 'hmac'; apiKey: string; secretKey: string }
  | null;

let _resolvedAuth: AuthMethod | undefined;

/**
 * Resolve the best available auth method. Resolved lazily on first call.
 * Call resetAuth() to clear the cache (e.g., when env vars change).
 * Returns null if no credentials are available (public endpoints only).
 */
export async function resolveAuth(): Promise<AuthMethod> {
  if (_resolvedAuth !== undefined) return _resolvedAuth;

  // 1. CUBE_SIGNING_KEY env var (CI/CD, Docker)
  const signingKeyEnv = process.env.CUBE_SIGNING_KEY;
  if (signingKeyEnv) {
    const keyId = process.env.CUBE_VERIFICATION_KEY_ID;
    if (!keyId) {
      throw new Error('CUBE_SIGNING_KEY requires CUBE_VERIFICATION_KEY_ID. Get it from: npm run status');
    }
    const seed = fromHex(signingKeyEnv);
    const privateKey = await importPrivateKey(seed);
    _resolvedAuth = { type: 'signing', verificationKeyId: keyId, privateKey };
    return _resolvedAuth;
  }

  // 2. CUBE_API_KEY + CUBE_SECRET_KEY env vars (explicit override)
  const hmacCreds = getCredentials();
  if (hmacCreds) {
    _resolvedAuth = { type: 'hmac', ...hmacCreds };
    return _resolvedAuth;
  }

  // 3. Credential store (npm run login)
  const creds = await loadCredentials();
  if (creds?.ed25519PrivateKey && creds?.verificationKeyId) {
    const seed = fromHex(creds.ed25519PrivateKey);
    const privateKey = await importPrivateKey(seed);
    _resolvedAuth = { type: 'signing', verificationKeyId: creds.verificationKeyId, privateKey };
    return _resolvedAuth;
  }

  _resolvedAuth = null;
  return null;
}

/**
 * Reset cached auth (for testing).
 */
export function resetAuth(): void {
  _resolvedAuth = undefined;
  _signingCredentials = undefined;
  _signingKey = null;
}

/**
 * Build authentication headers for a REST request.
 * Returns empty object if no auth is available.
 */
export async function buildAuthHeaders(): Promise<Record<string, string>> {
  const auth = await resolveAuth();
  if (!auth) return {};

  const timestamp = Math.floor(Date.now() / 1000);

  if (auth.type === 'hmac') {
    return {
      'x-api-key': auth.apiKey,
      'x-api-signature': generateSignature(auth.secretKey, timestamp),
      'x-api-timestamp': String(timestamp),
    };
  }

  // Ed25519 signing auth
  const signature = await generateEd25519Signature(auth.privateKey, timestamp);
  return {
    'x-verification-key-id': auth.verificationKeyId,
    'x-api-signature': signature,
    'x-api-timestamp': String(timestamp),
  };
}

// ── Signing Credentials (Ed25519) ─────────────────────────

let _signingCredentials: SigningCredentials | null | undefined;
let _signingKey: CryptoKey | null = null;

/**
 * Load Ed25519 signing credentials from ~/.cube/credentials.json.
 * Cached after first call. Returns null if no valid credentials.
 */
export async function getSigningCredentials(): Promise<SigningCredentials | null> {
  if (_signingCredentials !== undefined) return _signingCredentials;
  _signingCredentials = await loadCredentials();
  return _signingCredentials;
}

/**
 * Get the Ed25519 CryptoKey for signing intents.
 * Returns null if no signing credentials are available.
 */
export async function getSigningKey(): Promise<CryptoKey | null> {
  if (_signingKey) return _signingKey;
  const creds = await getSigningCredentials();
  if (!creds) return null;
  const seed = new Uint8Array(Buffer.from(creds.ed25519PrivateKey, 'hex'));
  _signingKey = await importPrivateKey(seed);
  return _signingKey;
}
