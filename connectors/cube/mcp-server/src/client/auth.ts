import { loadCredentials, importPrivateKey, signMessage, fromHex, encodePublicKey, type SigningCredentials } from './signing';

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

// ── Auth Resolution ──────────────────────────────────────

/**
 * Authentication via Ed25519 verification key signing.
 *
 * 1. CUBE_SIGNING_KEY env var (CI/CD) — Ed25519 hex seed + CUBE_VERIFICATION_KEY_ID
 * 2. Credential store (npm run login) — Ed25519 from keychain/file
 *
 * Env vars win over the credential store, since setting them is
 * an intentional override (e.g., different account, testing, CI).
 */

export type AuthMethod =
  | { type: 'signing'; verificationKeyId: string; privateKey: CryptoKey; publicKeyHex: string }
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
    const publicKeyHex = process.env.CUBE_VERIFICATION_PUBLIC_KEY || '';
    _resolvedAuth = { type: 'signing', verificationKeyId: keyId, privateKey, publicKeyHex };
    return _resolvedAuth;
  }

  // 2. Credential store (npm run login)
  const creds = await loadCredentials();
  if (creds?.ed25519PrivateKey && creds?.verificationKeyId) {
    const seed = fromHex(creds.ed25519PrivateKey);
    const privateKey = await importPrivateKey(seed);
    _resolvedAuth = {
      type: 'signing',
      verificationKeyId: creds.verificationKeyId,
      privateKey,
      publicKeyHex: creds.ed25519PublicKey,
    };
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
 * Build authentication headers for Osmium REST API requests.
 * Uses Ed25519 verification key signing.
 *
 * Used by: /os/v0/* endpoints (order placement, cancellation, etc.)
 *
 * Some deployments expect the verification key ID in `x-api-key`, while
 * older integrations used `x-verification-key-id`. Send both for
 * compatibility; both carry the same verification key ID value.
 */
export async function buildOsmiumAuthHeaders(): Promise<Record<string, string>> {
  const auth = await resolveAuth();
  if (!auth) return {};

  const timestamp = Math.floor(Date.now() / 1000);
  const payload = Buffer.alloc(16);
  payload.write('cube.xyz', 0, 'utf-8');
  payload.writeBigInt64LE(BigInt(timestamp), 8);
  const sig = await signMessage(new Uint8Array(payload), auth.privateKey);

  return {
    'x-api-key': auth.verificationKeyId,
    'x-verification-key-id': auth.verificationKeyId,
    'x-api-signature': Buffer.from(sig).toString('base64'),
    'x-api-timestamp': String(timestamp),
  };
}

/**
 * Build authentication headers for Iridium REST API requests.
 * Uses Ed25519 verification key signing.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - Route path without base prefix (e.g. "/users/subaccounts")
 */
export async function buildIridiumAuthHeaders(method?: string, path?: string): Promise<Record<string, string>> {
  const auth = await resolveAuth();
  if (!auth) return {};

  return buildVerificationKeyHeaders(method ?? 'GET', path ?? '/', auth);
}

/**
 * Build authentication headers for a REST request.
 *
 * @param target - 'iridium' or 'osmium'
 * @param method - HTTP method (for iridium verification key auth)
 * @param path - Route path without base prefix (for iridium verification key auth)
 */
export async function buildAuthHeaders(
  target: 'iridium' | 'osmium' = 'osmium',
  method?: string,
  path?: string,
): Promise<Record<string, string>> {
  if (target === 'iridium') {
    return buildIridiumAuthHeaders(method, path);
  }
  return buildOsmiumAuthHeaders();
}

// ── Verification Key Auth Headers ─────────────────────────

/**
 * Build verification key auth headers for Iridium REST endpoints.
 *
 * Format (from core/iridium verification_key.rs):
 *   x-verification-key: protobuf PublicKey { curve25519: <32b> } in base64 no-pad
 *   x-verification-key-signature: Ed25519 sign("{METHOD} {PATH}") in base64 no-pad
 *   x-verification-key-timestamp: unix timestamp string
 *
 * Allowed routes: /users/check, /users/subaccounts,
 *   /wallet/assets, /wallet/submit, /wallet/solana/swap/estimate
 */
export async function buildVerificationKeyHeaders(
  method: string,
  path: string,
  auth: NonNullable<AuthMethod>,
): Promise<Record<string, string>> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = new TextEncoder().encode(`${method.toUpperCase()} ${path}`);
  const sig = await signMessage(message, auth.privateKey);
  // Protobuf-encoded PublicKey in base64 no-pad
  const publicKeyProto = encodePublicKey(fromHex(auth.publicKeyHex));

  return {
    'x-verification-key': publicKeyProto,
    'x-verification-key-signature': Buffer.from(sig).toString('base64').replace(/=+$/, ''),
    'x-verification-key-timestamp': String(timestamp),
  };
}

/**
 * Check if any authentication credentials are available.
 */
export async function hasAuth(): Promise<boolean> {
  const auth = await resolveAuth();
  return auth !== null;
}

/**
 * Check what auth method is available.
 */
export async function getAuthType(): Promise<'signing' | null> {
  const auth = await resolveAuth();
  return auth?.type ?? null;
}

// ── WebSocket Verification Key Auth ──────────────────────

/**
 * Credentials for Osmium WebSocket verification key auth.
 * Maps directly to the @cubexch/client Credentials protobuf.
 */
export interface WsVerificationKeyCredentials {
  accessKeyId: string;       // empty for verification key auth
  signature: string;         // Ed25519 sign("GET /os\n{userKey}\n{timestamp}")
  timestamp: bigint;
  flags: bigint;
  verificationKey: string;   // protobuf PublicKey base64 no-pad
  userKey: string;           // Cube user key UUID
}

let _userKeyCache: string | null = null;

/**
 * Get the Cube user key (UUID) via /users/check with verification key auth.
 * Cached after first call.
 */
export async function getUserKey(): Promise<string> {
  if (_userKeyCache) return _userKeyCache;

  const auth = await resolveAuth();
  if (!auth) {
    throw new Error('No credentials available — run npm run login');
  }

  const env = getEnvironment(process.env.CUBE_ENV);
  const headers = await buildVerificationKeyHeaders('GET', '/users/check', auth);
  const response = await fetch(`${env.restUrl}/users/check`, { headers });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to fetch user key: ${response.status} ${body}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const result = (data.result ?? data) as Record<string, string>;
  _userKeyCache = result.id;
  return _userKeyCache;
}

/**
 * Build Osmium WebSocket Credentials for verification key auth.
 *
 * Signing message format: "GET /os\n{userKey}\n{timestamp}"
 * (from core/osmium/src/modules/auth.rs)
 */
export async function buildWsVerificationKeyCredentials(): Promise<WsVerificationKeyCredentials> {
  const auth = await resolveAuth();
  if (!auth) {
    throw new Error('No credentials available for WebSocket auth');
  }

  const userKey = await getUserKey();
  const timestamp = Math.floor(Date.now() / 1000);
  const message = new TextEncoder().encode(`GET /os\n${userKey}\n${timestamp}`);
  const sig = await signMessage(message, auth.privateKey);
  const verificationKey = encodePublicKey(fromHex(auth.publicKeyHex));

  return {
    accessKeyId: '',
    signature: Buffer.from(sig).toString('base64').replace(/=+$/, ''),
    timestamp: BigInt(timestamp),
    flags: 0n,
    verificationKey,
    userKey,
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
