/**
 * Cross-platform credential storage for CCXT exchanges.
 *
 * Each exchange gets its own credential entry — you can have Coinbase,
 * Binance, and Bybit credentials stored simultaneously.
 *
 * Priority:
 *   1. macOS Keychain (via `security` CLI)
 *   2. Linux libsecret (via `secret-tool` CLI — GNOME Keyring, KWallet, etc.)
 *   3. File fallback: ~/.ccxt/<exchange>/credentials.json with 0o600 permissions
 *
 * Same pattern as the Alpaca and Cube credential stores.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

// ── Constants ────────────────────────────────────────────────

const BASE_DIR = join(homedir(), '.ccxt');
const EXCHANGE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function validateExchangeId(exchangeId: string): void {
  if (!EXCHANGE_ID_RE.test(exchangeId)) {
    throw new Error(`Invalid exchange ID: "${exchangeId}". Must be lowercase alphanumeric with hyphens/underscores.`);
  }
}

function service(exchangeId: string) { return `ccxt-${exchangeId}`; }
function label(exchangeId: string) { return `CCXT ${exchangeId} credentials`; }
function credentialsDir(exchangeId: string) { validateExchangeId(exchangeId); return join(BASE_DIR, exchangeId); }
function credentialsFile(exchangeId: string) { return join(credentialsDir(exchangeId), 'credentials.json'); }

export { credentialsFile, validateExchangeId };

// ── Credential Shape ────────────────────────────────────────

export interface CcxtCredentials {
  exchangeId: string;
  apiKey: string;
  secret: string;
  password?: string;
  sandbox: boolean;
}

// ── Store Interface ──────────────────────────────────────────

export interface CredentialStore {
  readonly backend: 'keychain' | 'secret-tool' | 'file';
  load(exchangeId: string): Promise<CcxtCredentials | null>;
  save(creds: CcxtCredentials): Promise<void>;
  delete(exchangeId: string): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────

function exec(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

// ── macOS Keychain Store ─────────────────────────────────────

class KeychainStore implements CredentialStore {
  readonly backend = 'keychain' as const;

  async load(exchangeId: string): Promise<CcxtCredentials | null> {
    try {
      const json = await exec('security', [
        'find-generic-password',
        '-a', exchangeId,
        '-s', service(exchangeId),
        '-w',
      ]);
      return JSON.parse(json) as CcxtCredentials;
    } catch {
      return null;
    }
  }

  async save(creds: CcxtCredentials): Promise<void> {
    const json = JSON.stringify(creds);
    await exec('security', [
      'add-generic-password',
      '-a', creds.exchangeId,
      '-s', service(creds.exchangeId),
      '-l', label(creds.exchangeId),
      '-w', json,
      '-U',
    ]);
  }

  async delete(exchangeId: string): Promise<void> {
    try {
      await exec('security', [
        'delete-generic-password',
        '-a', exchangeId,
        '-s', service(exchangeId),
      ]);
    } catch {
      // Already deleted or doesn't exist
    }
  }
}

// ── Linux libsecret Store ────────────────────────────────────

class SecretToolStore implements CredentialStore {
  readonly backend = 'secret-tool' as const;

  async load(exchangeId: string): Promise<CcxtCredentials | null> {
    try {
      const json = await exec('secret-tool', [
        'lookup',
        'service', service(exchangeId),
        'account', exchangeId,
      ]);
      if (!json) return null;
      return JSON.parse(json) as CcxtCredentials;
    } catch {
      return null;
    }
  }

  async save(creds: CcxtCredentials): Promise<void> {
    const json = JSON.stringify(creds);
    await exec('secret-tool', [
      'store',
      '--label', label(creds.exchangeId),
      'service', service(creds.exchangeId),
      'account', creds.exchangeId,
    ], json);
  }

  async delete(exchangeId: string): Promise<void> {
    try {
      await exec('secret-tool', [
        'clear',
        'service', service(exchangeId),
        'account', exchangeId,
      ]);
    } catch {
      // Already deleted or doesn't exist
    }
  }
}

// ── File Fallback Store ──────────────────────────────────────

class FileStore implements CredentialStore {
  readonly backend = 'file' as const;

  async load(exchangeId: string): Promise<CcxtCredentials | null> {
    try {
      const data = await readFile(credentialsFile(exchangeId), 'utf-8');
      return JSON.parse(data) as CcxtCredentials;
    } catch {
      return null;
    }
  }

  async save(creds: CcxtCredentials): Promise<void> {
    await mkdir(credentialsDir(creds.exchangeId), { recursive: true });
    await writeFile(credentialsFile(creds.exchangeId), JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  async delete(exchangeId: string): Promise<void> {
    try {
      await unlink(credentialsFile(exchangeId));
    } catch {
      // Doesn't exist
    }
  }
}

// ── Store Detection ──────────────────────────────────────────

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await exec('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

export async function detectStore(): Promise<CredentialStore> {
  const os = platform();

  if (os === 'darwin') {
    return new KeychainStore();
  }

  if (os === 'linux') {
    if (await isCommandAvailable('secret-tool')) {
      return new SecretToolStore();
    }
  }

  return new FileStore();
}

// ── Convenience API ──────────────────────────────────────────

let _store: CredentialStore | null = null;

async function getStore(): Promise<CredentialStore> {
  if (!_store) {
    _store = await detectStore();
  }
  return _store;
}

export function setStore(store: CredentialStore): void {
  _store = store;
}

export function resetStore(): void {
  _store = null;
}

export async function loadCredentials(exchangeId: string): Promise<CcxtCredentials | null> {
  validateExchangeId(exchangeId);
  const store = await getStore();
  return store.load(exchangeId);
}

export async function saveCredentials(creds: CcxtCredentials): Promise<void> {
  validateExchangeId(creds.exchangeId);
  const store = await getStore();
  await store.save(creds);
}

export async function deleteCredentials(exchangeId: string): Promise<void> {
  validateExchangeId(exchangeId);
  const store = await getStore();
  await store.delete(exchangeId);
}

export async function getBackendName(): Promise<string> {
  const store = await getStore();
  return store.backend;
}
