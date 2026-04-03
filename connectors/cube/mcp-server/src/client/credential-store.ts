/**
 * Cross-platform credential storage for Cube Exchange.
 *
 * Priority:
 *   1. macOS Keychain (via `security` CLI)
 *   2. Linux libsecret (via `secret-tool` CLI — GNOME Keyring, KWallet, etc.)
 *   3. File fallback: ~/.cube/credentials.json with 0o600 permissions
 *
 * Same pattern as `gh auth` (GitHub CLI) and Supabase CLI.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import type { SigningCredentials } from './signing';

// ── Persistent Credential Audit Log ─────────────────────────
//
// Traces every load / save / delete / expiry-reject to ~/.cube/credential-ops.log
// so we can figure out what is deleting credentials.

const AUDIT_LOG = join(homedir(), '.cube', 'credential-ops.log');

async function auditLog(op: string, detail: string): Promise<void> {
  const ts = new Date().toISOString();
  const pid = process.pid;
  const stack = new Error().stack?.split('\n').slice(2, 6).map(l => l.trim()).join(' <- ') ?? '';
  const line = `[${ts}] pid=${pid} op=${op} ${detail} | ${stack}\n`;
  try {
    await mkdir(join(homedir(), '.cube'), { recursive: true });
    await appendFile(AUDIT_LOG, line);
  } catch { /* best-effort */ }
}

// ── Constants ────────────────────────────────────────────────

const SERVICE = 'cube-cli';
const ACCOUNT = 'cube-exchange';
const LABEL = 'Cube Exchange CLI';

const CREDENTIALS_DIR = join(homedir(), '.cube');
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, 'credentials.json');

export { CREDENTIALS_FILE };

// ── Store Interface ──────────────────────────────────────────

export interface CredentialStore {
  readonly backend: 'keychain' | 'secret-tool' | 'file';
  load(): Promise<SigningCredentials | null>;
  save(creds: SigningCredentials): Promise<void>;
  delete(): Promise<void>;
}

// ── macOS Keychain Store ─────────────────────────────────────

function exec(cmd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
    if (stdin !== undefined && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }
  });
}

class KeychainStore implements CredentialStore {
  readonly backend = 'keychain' as const;

  async load(): Promise<SigningCredentials | null> {
    try {
      const json = await exec('security', [
        'find-generic-password',
        '-a', ACCOUNT,
        '-s', SERVICE,
        '-w',
      ]);
      const creds = JSON.parse(json) as SigningCredentials;
      await auditLog('load', `backend=keychain keyId=${creds.verificationKeyId ?? '?'} expiresAt=${creds.expiresAt}`);
      return creds;
    } catch {
      await auditLog('load', 'backend=keychain result=null (not found or parse error)');
      return null;
    }
  }

  async save(creds: SigningCredentials): Promise<void> {
    await auditLog('save', `backend=keychain keyId=${creds.verificationKeyId ?? '?'} expiresAt=${creds.expiresAt}`);
    const json = JSON.stringify(creds);
    // -U = update if exists, -a = account, -s = service, -w = password, -l = label
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
    await auditLog('DELETE', 'backend=keychain *** CREDENTIALS BEING DELETED ***');
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

  async load(): Promise<SigningCredentials | null> {
    try {
      const json = await exec('secret-tool', [
        'lookup',
        'service', SERVICE,
        'account', ACCOUNT,
      ]);
      if (!json) {
        await auditLog('load', 'backend=secret-tool result=null (empty)');
        return null;
      }
      const creds = JSON.parse(json) as SigningCredentials;
      await auditLog('load', `backend=secret-tool keyId=${creds.verificationKeyId ?? '?'} expiresAt=${creds.expiresAt}`);
      return creds;
    } catch {
      await auditLog('load', 'backend=secret-tool result=null (not found or parse error)');
      return null;
    }
  }

  async save(creds: SigningCredentials): Promise<void> {
    await auditLog('save', `backend=secret-tool keyId=${creds.verificationKeyId ?? '?'} expiresAt=${creds.expiresAt}`);
    const json = JSON.stringify(creds);
    await exec('secret-tool', [
      'store',
      '--label', LABEL,
      'service', SERVICE,
      'account', ACCOUNT,
    ], json);
  }

  async delete(): Promise<void> {
    await auditLog('DELETE', 'backend=secret-tool *** CREDENTIALS BEING DELETED ***');
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

  async load(): Promise<SigningCredentials | null> {
    try {
      const data = await readFile(CREDENTIALS_FILE, 'utf-8');
      const creds = JSON.parse(data) as SigningCredentials;
      await auditLog('load', `backend=file keyId=${creds.verificationKeyId ?? '?'} expiresAt=${creds.expiresAt}`);
      return creds;
    } catch {
      await auditLog('load', 'backend=file result=null (not found or parse error)');
      return null;
    }
  }

  async save(creds: SigningCredentials): Promise<void> {
    await auditLog('save', `backend=file keyId=${creds.verificationKeyId ?? '?'} expiresAt=${creds.expiresAt}`);
    await mkdir(CREDENTIALS_DIR, { recursive: true });
    await writeFile(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  async delete(): Promise<void> {
    await auditLog('DELETE', 'backend=file *** CREDENTIALS BEING DELETED ***');
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

/**
 * Detect the best credential store for the current platform.
 * Priority: Keychain (macOS) > libsecret (Linux) > file.
 */
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

// ── Convenience API (with expiry check) ──────────────────────

let _store: CredentialStore | null = null;

async function getStore(): Promise<CredentialStore> {
  if (!_store) {
    _store = await detectStore();
  }
  return _store;
}

/** Override the store (for testing). */
export function setStore(store: CredentialStore): void {
  _store = store;
}

/** Reset the cached store (for testing). */
export function resetStore(): void {
  _store = null;
}

/**
 * Load credentials from the best available store.
 * Returns null if missing or expired (with 5-minute buffer).
 */
export async function loadCredentials(): Promise<SigningCredentials | null> {
  const store = await getStore();
  const creds = await store.load();

  if (!creds) {
    await auditLog('loadCredentials', 'result=null (store returned null)');
    return null;
  }

  // Check expiry with 5 min buffer
  const now = Math.floor(Date.now() / 1000);
  if (creds.expiresAt && creds.expiresAt < now + 300) {
    await auditLog('EXPIRY_REJECT', `keyId=${creds.verificationKeyId ?? '?'} expiresAt=${creds.expiresAt} now=${now} delta=${creds.expiresAt - now}s *** CREDENTIALS REJECTED AS EXPIRED ***`);
    return null;
  }

  return creds;
}

/**
 * Save credentials to the best available store.
 */
export async function saveCredentials(creds: SigningCredentials): Promise<void> {
  await auditLog('saveCredentials', `keyId=${creds.verificationKeyId ?? '?'} expiresAt=${creds.expiresAt}`);
  const store = await getStore();
  await store.save(creds);
}

/**
 * Delete credentials from the best available store.
 */
export async function deleteCredentials(): Promise<void> {
  await auditLog('deleteCredentials', '*** EXPLICIT DELETE CALLED ***');
  const store = await getStore();
  await store.delete();
}

/**
 * Get the name of the active credential backend.
 */
export async function getBackendName(): Promise<string> {
  const store = await getStore();
  return store.backend;
}
