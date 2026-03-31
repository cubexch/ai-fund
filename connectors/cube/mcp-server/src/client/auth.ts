import { createHmac } from 'node:crypto';

export interface CubeCredentials {
  apiKey: string;
  secretKey: string;
  subaccountId: number;
}

export interface CubeEnvironment {
  restUrl: string;
  wsTradeUrl: string;
  wsMarketDataUrl: string;
}

const ENVIRONMENTS: Record<string, CubeEnvironment> = {
  production: {
    restUrl: 'https://api.cube.exchange/ir/v0',
    wsTradeUrl: 'wss://api.cube.exchange/os',
    wsMarketDataUrl: 'wss://api.cube.exchange/md',
  },
  staging: {
    restUrl: 'https://staging.cube.exchange/ir/v0',
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
  const subaccountId = process.env.CUBE_SUBACCOUNT_ID;

  if (!apiKey || !secretKey) {
    throw new Error('Missing CUBE_API_KEY or CUBE_SECRET_KEY. Run /setup to configure.');
  }

  return {
    apiKey,
    secretKey,
    subaccountId: subaccountId ? parseInt(subaccountId, 10) : 1,
  };
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
