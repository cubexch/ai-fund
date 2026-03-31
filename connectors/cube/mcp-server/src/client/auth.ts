import { createHmac } from 'node:crypto';
import { loadCredentials, importPrivateKey, type SigningCredentials } from './signing.js';

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

export function getEnvironment(env?: string): CubeEnvironment {
  return ENVIRONMENTS[env || 'staging'] || ENVIRONMENTS.staging;
}

export function getCredentials(): CubeCredentials {
  const apiKey = process.env.CUBE_API_KEY;
  const secretKey = process.env.CUBE_SECRET_KEY;

  if (!apiKey || !secretKey) {
    throw new Error('Missing CUBE_API_KEY or CUBE_SECRET_KEY. Run /setup to configure.');
  }

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
