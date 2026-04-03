/**
 * Shared CLI utilities — arg parsing and credential resolution.
 * Used by index.ts, login.ts, logout.ts, and status.ts.
 */

import { loadCredentials } from '../client/credential-store.js';

// ── CLI arg parsing ────────────────────────────────────────────

export interface CliArgs {
  exchangeId: string;
  sandbox: boolean;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliArgs {
  let exchangeId = 'coinbase';
  let sandbox = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exchange' && argv[i + 1]) {
      exchangeId = argv[i + 1];
      i++;
    }
    if (argv[i] === '--sandbox') {
      sandbox = true;
    }
  }

  exchangeId = process.env.CCXT_EXCHANGE ?? exchangeId;
  sandbox = process.env.CCXT_SANDBOX === 'true' || sandbox;

  return { exchangeId, sandbox };
}

// ── Credential resolution ──────────────────────────────────────

export interface ResolvedCredentials {
  apiKey: string;
  secret: string;
  password: string;
  sandbox: boolean;
  source: 'env' | string;
}

/**
 * Resolves credentials from env vars (per-exchange, then generic CCXT_*),
 * falling back to the credential store (keychain/secret-tool/file).
 */
export async function resolveCredentials(exchangeId: string, sandbox: boolean): Promise<ResolvedCredentials> {
  const prefix = exchangeId.toUpperCase().replace(/-/g, '_');

  let apiKey = process.env[`${prefix}_API_KEY`] ?? process.env.CCXT_API_KEY ?? '';
  let secret = process.env[`${prefix}_SECRET`] ?? process.env.CCXT_SECRET ?? '';
  let password = process.env[`${prefix}_PASSWORD`] ?? process.env[`${prefix}_PASSPHRASE`] ?? process.env.CCXT_PASSWORD ?? '';
  sandbox = process.env[`${prefix}_SANDBOX`] === 'true' || sandbox;
  let source: 'env' | string = 'env';

  if (!apiKey || !secret) {
    const creds = await loadCredentials(exchangeId);
    if (creds) {
      apiKey = creds.apiKey;
      secret = creds.secret;
      password = creds.password ?? password;
      sandbox = creds.sandbox || sandbox;
      source = 'store';
    }
  }

  return { apiKey, secret, password, sandbox, source };
}

/**
 * Returns the per-exchange env var prefix (e.g., "COINBASE" for "coinbase").
 */
export function envPrefix(exchangeId: string): string {
  return exchangeId.toUpperCase().replace(/-/g, '_');
}
