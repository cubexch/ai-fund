/**
 * Shared credential store for all connectors.
 *
 * Priority:
 *   1. macOS Keychain (via `security` CLI)
 *   2. Linux libsecret (via `secret-tool` CLI)
 *   3. File fallback: ~/.ai-fund/<connector>/credentials.json (0o600)
 *
 * Secrets live outside the repo — never committed by accident.
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

// ── Helpers ─────────────────────────────────────────────────

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

async function isCommandAvailable(cmd: string): Promise<boolean> {
  try {
    await exec('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

// ── Backend Implementations ─────────────────────────────────

type Backend = 'keychain' | 'secret-tool' | 'file';

interface StoreBackend {
  readonly backend: Backend;
  load(service: string, account: string, filePath: string): Promise<string | null>;
  save(service: string, account: string, label: string, filePath: string, data: string): Promise<void>;
  remove(service: string, account: string, filePath: string): Promise<void>;
}

const keychainBackend: StoreBackend = {
  backend: 'keychain',
  async load(service, account) {
    try {
      return await exec('security', ['find-generic-password', '-a', account, '-s', service, '-w']);
    } catch { return null; }
  },
  async save(service, account, label, _filePath, data) {
    await exec('security', ['add-generic-password', '-a', account, '-s', service, '-l', label, '-w', data, '-U']);
  },
  async remove(service, account) {
    try { await exec('security', ['delete-generic-password', '-a', account, '-s', service]); } catch { /* noop */ }
  },
};

const secretToolBackend: StoreBackend = {
  backend: 'secret-tool',
  async load(service, account) {
    try {
      const result = await exec('secret-tool', ['lookup', 'service', service, 'account', account]);
      return result || null;
    } catch { return null; }
  },
  async save(service, account, label, _filePath, data) {
    await exec('secret-tool', ['store', '--label', label, 'service', service, 'account', account], data);
  },
  async remove(service, account) {
    try { await exec('secret-tool', ['clear', 'service', service, 'account', account]); } catch { /* noop */ }
  },
};

const fileBackend: StoreBackend = {
  backend: 'file',
  async load(_service, _account, filePath) {
    try { return await readFile(filePath, 'utf-8'); } catch { return null; }
  },
  async save(_service, _account, _label, filePath, data) {
    const dir = join(filePath, '..');
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, data, { mode: 0o600 });
  },
  async remove(_service, _account, filePath) {
    try { await unlink(filePath); } catch { /* noop */ }
  },
};

async function detectBackend(): Promise<StoreBackend> {
  const os = platform();
  if (os === 'darwin') return keychainBackend;
  if (os === 'linux' && await isCommandAvailable('secret-tool')) return secretToolBackend;
  return fileBackend;
}

let _backend: StoreBackend | null = null;

async function getBackend(): Promise<StoreBackend> {
  if (!_backend) _backend = await detectBackend();
  return _backend;
}

// ── Public API ──────────────────────────────────────────────

/**
 * Load credentials for a connector.
 * Returns parsed JSON or null if not found.
 */
export async function loadCredentials<T>(connector: string): Promise<T | null> {
  const backend = await getBackend();
  const service = `ai-fund-${connector}`;
  const filePath = join(homedir(), '.ai-fund', connector, 'credentials.json');

  const raw = await backend.load(service, connector, filePath);
  if (!raw) return null;

  try { return JSON.parse(raw) as T; } catch { return null; }
}

/**
 * Save credentials for a connector.
 */
export async function saveCredentials<T>(connector: string, creds: T): Promise<void> {
  const backend = await getBackend();
  const service = `ai-fund-${connector}`;
  const label = `AI Fund — ${connector}`;
  const filePath = join(homedir(), '.ai-fund', connector, 'credentials.json');

  await backend.save(service, connector, label, filePath, JSON.stringify(creds));
}

/**
 * Delete credentials for a connector.
 */
export async function deleteCredentials(connector: string): Promise<void> {
  const backend = await getBackend();
  const service = `ai-fund-${connector}`;
  const filePath = join(homedir(), '.ai-fund', connector, 'credentials.json');

  await backend.remove(service, connector, filePath);
}

/**
 * Get which backend is in use.
 */
export async function getBackendName(): Promise<Backend> {
  const backend = await getBackend();
  return backend.backend;
}
