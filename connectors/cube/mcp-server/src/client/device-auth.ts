/**
 * Device Authorization Flow for Cube Exchange.
 *
 * Two modes:
 * - Interactive (default): Localhost callback server — instant, like `wrangler login`
 * - Headless (fallback): Polling-based — for containers, SSH, CI/CD
 *
 * See docs/agent-auth-brief.md for the full spec.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { CUBE_HOST } from './auth';
import {
  encodeVerificationKey,
  generateKeyPair,
  saveCredentials,
  toHex,
  type Ed25519KeyPair,
} from './signing';

// ── Types ────────────────────────────────────────────────────

export interface DeviceCodeRequest {
  verificationKey: string;
  clientName: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  redirectUri?: string;
  state?: string;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode?: string;
  authorizeUrl: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenRequest {
  deviceCode: string;
  codeVerifier: string;
  code?: string;
}

export interface DeviceTokenResponse {
  verificationKeyId: string;
  publicKey: string;
  expiresAt: number;
  subaccountId?: number;
  registrationMethod: string;
  externalProvider?: string;
}

export interface DeviceTokenError {
  error: 'authorization_pending' | 'access_denied' | 'expired_token' | 'slow_down' | 'invalid_token';
}

export type DeviceAuthEvent =
  | { type: 'keypair_generated'; publicKeyHex: string }
  | { type: 'callback_server_started'; port: number }
  | { type: 'callback_server_failed'; fallbackHeadless: true }
  | { type: 'device_code_received'; authorizeUrl: string; userCode?: string; expiresIn: number }
  | { type: 'browser_opened'; url: string }
  | { type: 'browser_failed'; url: string }
  | { type: 'polling'; elapsed: number }
  | { type: 'approved'; verificationKeyId: string; expiresAt: number; subaccountId?: number }
  | { type: 'denied' }
  | { type: 'credentials_saved'; path: string };

export interface DeviceAuthOptions {
  apiBase: string;
  clientName: string;
  headless?: boolean;
  keyExpirySeconds?: number;
  callbackPort?: number;
  callbackPortRetries?: number;
  openBrowser?: (url: string) => Promise<void>;
  /** Structured event callback for UI rendering. Falls back to console.log if not provided. */
  onEvent?: (event: DeviceAuthEvent) => void | Promise<void>;
  /** @deprecated Use onEvent instead. Simple log callback for backward compat / tests. */
  log?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  /** Reuse an existing keypair instead of generating a new one. */
  existingKeyPair?: Ed25519KeyPair;
}

export interface DeviceAuthResult {
  verificationKeyId: string;
  publicKey: string;
  expiresAt: number;
  subaccountId?: number;
  keyPair: Ed25519KeyPair;
  verificationKeyBase64: string;
}

export interface CallbackServer {
  /** @deprecated Use redirectUri instead. */
  url: string;
  redirectUri: string;
  port: number;
  server: Server;
  state: string;
  /** Wait for the browser redirect callback. Rejects after timeoutMs (default 10 min). */
  waitForCode: (timeoutMs?: number) => Promise<string>;
  /** @deprecated Use waitForCode instead. */
  waitForCallback: (timeoutMs?: number) => Promise<string>;
  completeSuccess: () => Promise<void>;
  completeFailure: (message?: string) => Promise<void>;
  close: () => Promise<void>;
}

export interface PollOptions {
  apiBase: string;
  deviceCode: string;
  codeVerifier: string;
  interval: number;
  expiresIn: number;
  fetchFn?: typeof globalThis.fetch;
  onPending?: () => void;
  signal?: AbortSignal;
}

interface PkcePair {
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  codeVerifier: string;
}

interface WaitForApprovalOptions extends PollOptions {
  waitForCode?: () => Promise<string>;
}

type BrowserCompletion =
  | { status: 'success' }
  | { status: 'failure'; message: string };

interface PendingBrowserResponse {
  res: ServerResponse<IncomingMessage>;
  redirectUrl: string | null;
}

// ── Constants ────────────────────────────────────────────────

const DEFAULT_KEY_EXPIRY_SECONDS = 518400; // 6 days
const DEFAULT_CALLBACK_PORT = 9876;
const DEFAULT_PORT_RETRIES = 3;
const POLL_JITTER_MS = 500;
const DEFAULT_CALLBACK_TIMEOUT_MS = 600_000; // 10 minutes (matches device code expiry)
const CALLBACK_SERVER_FORCE_CLOSE_TIMEOUT_MS = 1_000;

// ── Connected Page HTML ──────────────────────────────────────

export const CONNECTED_HTML = `<!DOCTYPE html>
<html>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fff;">
  <div style="text-align: center;">
    <div style="font-size: 48px; margin-bottom: 16px;">✓</div>
    <h1 style="margin: 0 0 8px;">Connected</h1>
    <p style="color: #888;">Cube is now connected. You can close this tab.</p>
  </div>
</body>
</html>`;

const renderFailureHtml = (message: string) => `<!DOCTYPE html>
<html>
<body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #0a0a0a; color: #fff;">
  <div style="max-width: 560px; padding: 24px; text-align: center;">
    <div style="font-size: 48px; margin-bottom: 16px;">!</div>
    <h1 style="margin: 0 0 8px;">Connection failed</h1>
    <p style="color: #b3b3b3; line-height: 1.6;">${message}</p>
    <p style="color: #888; line-height: 1.6;">Return to your terminal and start a fresh authorization request if needed.</p>
  </div>
</body>
</html>`;

const DEFAULT_HOSTED_REDIRECT_ORIGINS = new Set([
  'https://cube.exchange',
  'https://www.cube.exchange',
  'https://staging.cube.exchange',
  'https://dev.cube.exchange',
  'https://w.cube.ngrok.app',
  'https://p.cube.ngrok.app',
  'https://b.cube.ngrok.app',
]);

function resolveTrustedHostedRedirectUrl(redirectUrl: string | null): string | null {
  if (!redirectUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(redirectUrl);
  } catch {
    return null;
  }

  if (CUBE_HOST && parsed.host === CUBE_HOST) {
    return parsed.toString();
  }

  return DEFAULT_HOSTED_REDIRECT_ORIGINS.has(parsed.origin) ? parsed.toString() : null;
}

// ── Localhost Callback Server ────────────────────────────────

/**
 * Start a localhost HTTP server that waits for the browser redirect callback.
 * Returns the authorization code from the query params `?code=...&state=...`.
 *
 * Tries ports starting from `startPort`, retrying up to `maxRetries` times
 * on EADDRINUSE.
 */
export async function startCallbackServer(
  startPort: number = DEFAULT_CALLBACK_PORT,
  maxRetries: number = DEFAULT_PORT_RETRIES,
): Promise<CallbackServer> {
  const state = createAuthorizationState();
  const sockets = new Set<Socket>();
  let resolveCode: ((code: string) => void) | undefined;
  let rejectCode: ((err: Error) => void) | undefined;
  let codeSettled = false;
  let pendingBrowserResponse: PendingBrowserResponse | null = null;
  let browserCompletion: BrowserCompletion | null = null;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // Avoid unhandled rejections when the server closes after no caller is awaiting the code.
  void codePromise.catch(() => undefined);

  const settleCodeSuccess = (code: string) => {
    if (codeSettled) {
      return;
    }
    codeSettled = true;
    resolveCode?.(code);
  };

  const settleCodeFailure = (err: Error) => {
    if (codeSettled) {
      return;
    }
    codeSettled = true;
    rejectCode?.(err);
  };

  const sendBrowserCompletion = (
    res: ServerResponse<IncomingMessage>,
    redirectUrl: string | null,
    completion: BrowserCompletion,
  ) => {
    if (completion.status === 'success') {
      res.writeHead(redirectUrl ? 302 : 200, {
        'cache-control': 'no-store',
        ...(redirectUrl ? { location: redirectUrl } : {}),
        'content-type': 'text/html; charset=utf-8',
        connection: 'close',
      });
      res.end(redirectUrl ? '' : CONNECTED_HTML);
      return;
    }

    res.writeHead(502, {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8',
      connection: 'close',
    });
    res.end(renderFailureHtml(completion.message));
  };

  const settleBrowserCompletion = async (completion: BrowserCompletion) => {
    browserCompletion = completion;
    if (!pendingBrowserResponse) {
      return;
    }

    const { res, redirectUrl } = pendingBrowserResponse;
    pendingBrowserResponse = null;
    sendBrowserCompletion(res, redirectUrl, completion);
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname !== '/callback') {
      res.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'close',
      });
      res.end('Not found');
      return;
    }

    if (req.method !== 'GET') {
      res.writeHead(405, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'close',
      });
      res.end('Method not allowed.');
      return;
    }

    const receivedState = url.searchParams.get('state');
    if (receivedState !== state) {
      res.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'close',
      });
      res.end('Invalid authorization state.');
      return;
    }

    const code = url.searchParams.get('code');
    const redirectUrl = resolveTrustedHostedRedirectUrl(url.searchParams.get('cubeRedirectUrl'));
    if (!code) {
      res.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'close',
      });
      res.end('Missing authorization code.');
      return;
    }

    if (browserCompletion) {
      sendBrowserCompletion(res, redirectUrl, browserCompletion);
      settleCodeSuccess(code);
      return;
    }

    pendingBrowserResponse = { res, redirectUrl };
    res.on('close', () => {
      if (pendingBrowserResponse?.res === res) {
        pendingBrowserResponse = null;
      }
    });
    settleCodeSuccess(code);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => {
      sockets.delete(socket);
    });
  });

  const port = await listenWithRetry(server, startPort, maxRetries);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const waitForCode = (timeoutMs: number = DEFAULT_CALLBACK_TIMEOUT_MS) => Promise.race([
    codePromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new DeviceAuthError('callback_timeout', 0, 'Browser callback timed out. The user may not have completed approval, or localhost may be unreachable.')),
        timeoutMs,
      ),
    ),
  ]);

  return {
    url: redirectUri,
    redirectUri,
    port,
    server,
    state,
    waitForCode,
    waitForCallback: waitForCode,
    completeSuccess: async () => {
      await settleBrowserCompletion({ status: 'success' });
    },
    completeFailure: async (message = 'Cube could not finish setup for this authorization.') => {
      await settleBrowserCompletion({ status: 'failure', message });
    },
    close: async () => {
      if (!browserCompletion) {
        await settleBrowserCompletion({
          status: 'failure',
          message: 'The local callback server stopped before setup completed.',
        });
      }

      const closePromise = new Promise<void>((resolve, reject) => {
        server.close((err) => err ? reject(err) : resolve());
      });
      const forceCloseTimer = setTimeout(() => {
        for (const socket of sockets) {
          socket.destroy();
        }
      }, CALLBACK_SERVER_FORCE_CLOSE_TIMEOUT_MS);

      try {
        await closePromise;
      } finally {
        clearTimeout(forceCloseTimer);
      }

      settleCodeFailure(new Error('callback_server_closed'));
    },
  };
}

/**
 * Try to listen on startPort, incrementing on EADDRINUSE up to maxRetries.
 * Returns the actual bound port (important when startPort is 0).
 */
export function listenWithRetry(server: Server, startPort: number, maxRetries: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    let currentPort = startPort;

    const tryListen = () => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts < maxRetries) {
          attempts++;
          currentPort++;
          tryListen();
        } else {
          reject(err);
        }
      });

      server.listen(currentPort, '127.0.0.1', () => {
        const addr = server.address();
        const boundPort = (typeof addr === 'object' && addr !== null) ? addr.port : currentPort;
        resolve(boundPort);
      });
    };

    tryListen();
  });
}

// ── API Calls ────────────────────────────────────────────────

/**
 * POST /agent/device/code — request a device code for authorization.
 */
export async function requestDeviceCode(
  apiBase: string,
  request: DeviceCodeRequest,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<DeviceCodeResponse> {
  const res = await fetchFn(`${apiBase}/agent/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'cube-cli' },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errorCode = await extractErrorCode(res);
    throw new DeviceAuthError(errorCode, res.status);
  }

  const json = await res.json() as Record<string, unknown>;
  return (json.result ?? json) as DeviceCodeResponse;
}

/**
 * POST /agent/device/token — exchange device code for key registration details.
 */
export async function requestDeviceToken(
  apiBase: string,
  request: DeviceTokenRequest,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<DeviceTokenResponse> {
  const res = await fetchFn(`${apiBase}/agent/device/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'cube-cli' },
    body: JSON.stringify(request),
  });

  if (!res.ok) {
    const errorCode = await extractErrorCode(res);
    throw new DeviceAuthError(errorCode, res.status);
  }

  const json = await res.json() as Record<string, unknown>;
  return (json.result ?? json) as DeviceTokenResponse;
}

// ── Polling ──────────────────────────────────────────────────

/**
 * Poll POST /agent/device/token until approved, denied, or expired.
 * Respects the `slow_down` response by increasing the interval.
 */
export async function pollForToken(options: PollOptions): Promise<DeviceTokenResponse> {
  const {
    apiBase,
    deviceCode,
    codeVerifier,
    expiresIn,
    fetchFn = globalThis.fetch,
    onPending,
    signal,
  } = options;
  let interval = options.interval;

  const deadline = Date.now() + expiresIn * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DeviceAuthError('aborted', 0);
    }

    await sleep(interval * 1000 + Math.random() * POLL_JITTER_MS);

    try {
      return await requestDeviceToken(apiBase, { deviceCode, codeVerifier }, fetchFn);
    } catch (err) {
      if (!(err instanceof DeviceAuthError)) {
        throw err;
      }

      switch (err.code) {
        case 'authorization_pending':
          onPending?.();
          continue;
        case 'slow_down':
          interval += 5;
          continue;
        case 'access_denied':
          throw new DeviceAuthError('access_denied', 400, 'User denied the authorization request');
        case 'expired_token':
          throw new DeviceAuthError('expired_token', 400, 'Device code has expired');
        default:
          throw err;
      }
    }
  }

  throw new DeviceAuthError('expired_token', 400, 'Device code has expired (timeout)');
}

async function waitForApproval(options: WaitForApprovalOptions): Promise<DeviceTokenResponse> {
  const {
    apiBase,
    deviceCode,
    codeVerifier,
    expiresIn,
    fetchFn = globalThis.fetch,
    onPending,
    signal,
    waitForCode,
  } = options;
  let interval = options.interval;
  let authorizationCode: string | undefined;

  const deadline = Date.now() + expiresIn * 1000;
  const callbackPromise = waitForCode?.()
    .then((code) => {
      authorizationCode = code;
      return code;
    })
    .catch(() => undefined);

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new DeviceAuthError('aborted', 0);
    }

    try {
      return await requestDeviceToken(
        apiBase,
        {
          deviceCode,
          codeVerifier,
          ...(authorizationCode ? { code: authorizationCode } : {}),
        },
        fetchFn,
      );
    } catch (err) {
      if (!(err instanceof DeviceAuthError)) {
        throw err;
      }

      switch (err.code) {
        case 'authorization_pending':
          onPending?.();
          break;
        case 'slow_down':
          interval += 5;
          break;
        case 'access_denied':
          throw new DeviceAuthError('access_denied', 400, 'User denied the authorization request');
        case 'expired_token':
          throw new DeviceAuthError('expired_token', 400, 'Device code has expired');
        default:
          throw err;
      }
    }

    const waiters: Promise<unknown>[] = [sleep(interval * 1000 + Math.random() * POLL_JITTER_MS)];
    if (callbackPromise) {
      waiters.push(callbackPromise);
    }
    await Promise.race(waiters);
  }

  throw new DeviceAuthError('expired_token', 400, 'Device code has expired (timeout)');
}

// ── Browser Opening ──────────────────────────────────────────

/**
 * Default browser opener. Returns false if it couldn't open.
 */
export async function openBrowserDefault(url: string): Promise<void> {
  try {
    const open = ((await import('open' as string)) as { default: (url: string) => Promise<unknown> }).default;
    await open(url);
  } catch {
    const { exec } = await import('node:child_process');
    const cmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    exec(`${cmd} "${url}"`);
  }
}

// ── Main Flow ────────────────────────────────────────────────

/**
 * Run the full device authorization flow.
 *
 * Interactive mode (default):
 *   1. Generate Ed25519 keypair
 *   2. Start localhost callback server
 *   3. POST /agent/device/code with redirectUri + state + PKCE challenge
 *   4. Open browser to authorizeUrl
 *   5. Wait for browser redirect to localhost
 *   6. POST /agent/device/token with PKCE verifier and optional callback code
 *   7. Save credentials
 *
 * Headless mode:
 *   1. Generate Ed25519 keypair
 *   2. POST /agent/device/code with PKCE challenge only
 *   3. Print URL with user code
 *   4. Poll /agent/device/token with PKCE verifier until approved
 *   5. Save credentials
 */
export async function deviceAuthFlow(options: DeviceAuthOptions): Promise<DeviceAuthResult> {
  const {
    apiBase,
    clientName,
    headless = false,
    keyExpirySeconds = DEFAULT_KEY_EXPIRY_SECONDS,
    callbackPort = DEFAULT_CALLBACK_PORT,
    callbackPortRetries = DEFAULT_PORT_RETRIES,
    openBrowser = openBrowserDefault,
    log = console.log,
    onEvent,
    fetch: fetchFn = globalThis.fetch,
  } = options;

  const emit = async (event: DeviceAuthEvent) => {
    if (onEvent) {
      await onEvent(event);
      return;
    }

    switch (event.type) {
      case 'keypair_generated':
        log(`Generating Ed25519 keypair...\n  Public key: ${event.publicKeyHex.slice(0, 16)}...`);
        break;
      case 'callback_server_started':
        log(`  Callback server listening on port ${event.port}`);
        break;
      case 'callback_server_failed':
        log('  Could not start callback server, falling back to headless mode...');
        break;
      case 'device_code_received':
        log(event.userCode ? `\n  Open this URL in any browser:\n\n    ${event.authorizeUrl}\n` : `\n  Opening ${event.authorizeUrl}\n`);
        break;
      case 'browser_opened':
        log('  Waiting for approval in browser...\n');
        break;
      case 'browser_failed':
        log(`  Browser failed to open. Please open this URL manually:\n    ${event.url}\n`);
        break;
      case 'polling':
        break;
      case 'approved':
        log(`\n  ✓ Successfully logged in.\n    Key expires: ${new Date(event.expiresAt * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);
        break;
      case 'credentials_saved':
        log(`    Credentials saved to ${event.path}`);
        break;
    }
  };

  // 1. Generate or reuse Ed25519 keypair
  const keyPair = options.existingKeyPair ?? await generateKeyPair();
  const pubKeyHex = toHex(keyPair.publicKey);
  await emit({ type: 'keypair_generated', publicKeyHex: pubKeyHex });

  // 2. Encode as VerificationKey protobuf
  const expiresAt = Math.floor(Date.now() / 1000) + keyExpirySeconds;
  const vkBytes = encodeVerificationKey(keyPair.publicKey, expiresAt);
  // Cube backend uses STANDARD_NO_PAD base64 — strip trailing '='
  const vkBase64 = Buffer.from(vkBytes).toString('base64').replace(/=+$/, '');
  const pkce = createPkcePair();

  let callbackServer: CallbackServer | null = null;
  let useHeadless = headless;

  // 3. Start localhost callback server (interactive mode)
  if (!useHeadless) {
    try {
      callbackServer = await startCallbackServer(callbackPort, callbackPortRetries);
      await emit({ type: 'callback_server_started', port: callbackServer.port });
    } catch {
      await emit({ type: 'callback_server_failed', fallbackHeadless: true });
      useHeadless = true;
    }
  }

  try {
    // 4. Request device code
    const codeRequest: DeviceCodeRequest = {
      verificationKey: vkBase64,
      clientName,
      codeChallenge: pkce.codeChallenge,
      codeChallengeMethod: pkce.codeChallengeMethod,
      ...(callbackServer ? {
        redirectUri: callbackServer.redirectUri,
        state: callbackServer.state,
      } : {}),
    };

    const codeResponse = await requestDeviceCode(apiBase, codeRequest, fetchFn);

    // Rewrite authorizeUrl host when CUBE_HOST is set (browser page, not API — no /api prefix)
    let authorizeUrl = codeResponse.authorizeUrl;
    if (CUBE_HOST) {
      authorizeUrl = authorizeUrl.replace(/\/\/[^/]+/, `//${CUBE_HOST}`);
    }

    await emit({
      type: 'device_code_received',
      authorizeUrl,
      userCode: codeResponse.userCode,
      expiresIn: codeResponse.expiresIn,
    });

    // 5. Open browser or print URL
    if (!useHeadless) {
      try {
        await openBrowser(authorizeUrl);
        await emit({ type: 'browser_opened', url: authorizeUrl });
      } catch {
        await emit({ type: 'browser_failed', url: authorizeUrl });
      }
    }

    // 6. Wait for approval
    const pollStartTime = Date.now();
    let tokenResponse: DeviceTokenResponse;

    if (callbackServer && !useHeadless) {
      try {
        tokenResponse = await waitForApproval({
          apiBase,
          deviceCode: codeResponse.deviceCode,
          codeVerifier: pkce.codeVerifier,
          interval: codeResponse.interval,
          expiresIn: codeResponse.expiresIn,
          fetchFn,
          onPending: () => {
            void emit({ type: 'polling', elapsed: Math.floor((Date.now() - pollStartTime) / 1000) });
          },
          waitForCode: () => callbackServer.waitForCode(),
        });
        await callbackServer.completeSuccess();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await callbackServer.completeFailure(message);
        throw err;
      }
    } else {
      tokenResponse = await pollForToken({
        apiBase,
        deviceCode: codeResponse.deviceCode,
        codeVerifier: pkce.codeVerifier,
        interval: codeResponse.interval,
        expiresIn: codeResponse.expiresIn,
        fetchFn,
        onPending: () => {
          void emit({ type: 'polling', elapsed: Math.floor((Date.now() - pollStartTime) / 1000) });
        },
      });
    }

    await emit({
      type: 'approved',
      verificationKeyId: tokenResponse.verificationKeyId,
      expiresAt: tokenResponse.expiresAt,
      subaccountId: tokenResponse.subaccountId,
    });

    // 7. Save credentials
    await saveCredentials({
      ed25519PrivateKey: toHex(keyPair.privateKeyRaw),
      ed25519PublicKey: pubKeyHex,
      verificationKey: vkBase64,
      verificationKeyId: tokenResponse.verificationKeyId,
      expiresAt: tokenResponse.expiresAt,
      createdAt: Math.floor(Date.now() / 1000),
      provider: 'device',
    });

    await emit({ type: 'credentials_saved', path: '~/.cube/credentials.json' });

    return {
      verificationKeyId: tokenResponse.verificationKeyId,
      publicKey: tokenResponse.publicKey,
      expiresAt: tokenResponse.expiresAt,
      subaccountId: tokenResponse.subaccountId,
      keyPair,
      verificationKeyBase64: vkBase64,
    };
  } finally {
    await callbackServer?.close();
  }
}

// ── Error Class ──────────────────────────────────────────────

export class DeviceAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'DeviceAuthError';
  }
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Extract a human-readable error code from an error response.
 * Handles JSON bodies, HTML bodies, and network errors gracefully.
 */
async function extractErrorCode(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      // Backend format: { error: { code, reason } } or { error: "string" }
      // Next.js proxy may double-wrap: { error: "{\"error\":{...}}" }
      let err = json.error;
      if (typeof err === 'string') {
        try { err = JSON.parse(err); } catch { return err; }
      }
      if (typeof err === 'object' && err !== null) {
        // Unwrap nested { error: { code, reason } }
        const inner = (err as Record<string, unknown>).error ?? err;
        if (typeof inner === 'object' && inner !== null && 'reason' in inner) {
          return (inner as Record<string, string>).reason;
        }
      }
      if (typeof json.message === 'string') {
        return json.message;
      }
    } catch {
      // Not JSON — could be HTML 404 page etc.
    }
    // Return a truncated snippet of the body for debugging
    const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim();
    return snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function base64UrlEncode(value: Uint8Array | Buffer): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createPkcePair(): PkcePair {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  return {
    codeChallenge: base64UrlEncode(
      createHash('sha256')
        .update(codeVerifier)
        .digest(),
    ),
    codeChallengeMethod: 'S256',
    codeVerifier,
  };
}

function createAuthorizationState(): string {
  return base64UrlEncode(randomBytes(32));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
