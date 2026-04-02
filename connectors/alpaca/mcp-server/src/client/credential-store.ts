/**
 * Cross-platform credential storage for Alpaca.
 *
 * Priority:
 *   1. macOS Keychain (via `security` CLI)
 *   2. Linux libsecret (via `secret-tool` CLI — GNOME Keyring, KWallet, etc.)
 *   3. File fallback: ~/.alpaca/credentials.json with 0o600 permissions
 *
 * Same pattern as the Cube and Robinhood credential stores.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

// ── Constants ────────────────────────────────────────────────

const SERVICE = 'alpaca-cli';
const ACCOUNT = 'alpaca';
const LABEL = 'Alpaca Trading CLI';

const CREDENTIALS_DIR = join(homedir(), '.alpaca');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

export { CREDENTIALS_FILE };

// ── Credential Shape ────────────────────────────────────────

export interface AlpacaCredentials {
  apiKey: string;
  apiSecret: string;
  paper: boolean;
}

// ── Store Interface ──────────────────────────────────────────

export interface CredentialStore {
  readonly backend: 'keychain' | 'secret-tool' | 'file';
  load(): Promise<AlpacaCredentials | null>;
  save(creds: AlpacaCredentials): Promise<void>;
  delete(): Promise<void>;
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

  async load(): Promise<AlpacaCredentials | null> {
    try {
      const json = await exec('security', [
        'find-generic-password',
        '-a', ACCOUNT,
        '-s', SERVICE,
        '-w',
      ]);
      return JSON.parse(json) as AlpacaCredentials;
    } catch {
      return null;
    }
  }

  async save(creds: AlpacaCredentials): Promise<void> {
    const json = JSON.stringify(creds);
    await exec('security', [
      'add-generic-password',
      '-a', ACCOUNT,
      '-s', SERVICE,
      '-l', LABEL,
      '-w', json,
      '-U',
    ]);
  }

  async delete(): Promise<void> {
    try {
      await exec('security', [
        'delete-generic-password',
        '-a', ACCOUNT,
        '-s', SERVICE,
      ]);
    } catch {
      // Already deleted or doesn't exist
    }
  }
}

// ── Linux libsecret Store ────────────────────────────────────

class SecretToolStore implements CredentialStore {
  readonly backend = 'secret-tool' as const;

  async load(): Promise<AlpacaCredentials | null> {
    try {
      const json = await exec('secret-tool', [
        'lookup',
        'service', SERVICE,
        'account', ACCOUNT,
      ]);
      if (!json) return null;
      return JSON.parse(json) as AlpacaCredentials;
    } catch {
      return null;
    }
  }

  async save(creds: AlpacaCredentials): Promise<void> {
    const json = JSON.stringify(creds);
    await exec('secret-tool', [
      'store',
      '--label', LABEL,
      'service', SERVICE,
      'account', ACCOUNT,
    ], json);
  }

  async delete(): Promise<void> {
    try {
      await exec('secret-tool', [
        'clear',
        'service', SERVICE,
        'account', ACCOUNT,
      ]);
    } catch {
      // Already deleted or doesn't exist
    }
  }
}

// ── File Fallback Store ──────────────────────────────────────

class FileStore implements CredentialStore {
  readonly backend = 'file' as const;

  async load(): Promise<AlpacaCredentials | null> {
    try {
      const data = await readFile(CREDENTIALS_FILE, 'utf-8');
      return JSON.parse(data) as AlpacaCredentials;
    } catch {
      return null;
    }
  }

  async save(creds: AlpacaCredentials): Promise<void> {
    await mkdir(CREDENTIALS_DIR, { recursive: true });
    await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  async delete(): Promise<void> {
    try {
      await unlink(CREDENTIALS_FILE);
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

export async function loadCredentials(): Promise<AlpacaCredentials | null> {
  const store = await getStore();
  return store.load();
}

export async function saveCredentials(creds: AlpacaCredentials): Promise<void> {
  const store = await getStore();
  await store.save(creds);
}

export async function deleteCredentials(): Promise<void> {
  const store = await getStore();
  await store.delete();
}

export async function getBackendName(): Promise<string> {
  const store = await getStore();
  return store.backend;
}
