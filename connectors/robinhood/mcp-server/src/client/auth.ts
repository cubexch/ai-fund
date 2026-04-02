/**
 * Robinhood OAuth2 authentication manager.
 *
 * Supports:
 * - Username/password login with MFA
 * - Token refresh
 * - Auto-refresh on expiry
 * - Device token persistence
 */

import { randomUUID } from 'node:crypto';
import {
  loadCredentials,
  loadCredentialsRaw,
  saveCredentials,
  type RobinhoodCredentials,
} from './credential-store.js';

// ── Constants ────────────────────────────────────────────────

const BASE_URL = 'https://api.robinhood.com';

// Robinhood's public OAuth2 client ID (used by all unofficial clients)
const CLIENT_ID = 'c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS';

// ── Types ────────────────────────────────────────────────────

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  mfa_required?: boolean;
  mfa_type?: string;
}

interface MfaRequiredResponse {
  mfa_required: true;
  mfa_type: string;
}

type AuthResponse = TokenResponse | MfaRequiredResponse;

// ── Auth Manager ─────────────────────────────────────────────

export class AuthManager {
  private credentials: RobinhoodCredentials | null = null;
  private refreshPromise: Promise<void> | null = null;

  /**
   * Initialize the auth manager. Loads existing credentials from keychain.
   * Returns true if valid credentials were found.
   */
  async init(): Promise<boolean> {
    this.credentials = await loadCredentials();
    if (this.credentials) return true;

    // Try refresh if we have expired credentials with a refresh token
    const raw = await loadCredentialsRaw();
    if (raw?.refreshToken) {
      try {
        await this.refresh(raw);
        return true;
      } catch {
        // Refresh failed, need fresh login
      }
    }

    return false;
  }

  /**
   * Get a valid access token, refreshing if necessary.
   */
  async getAccessToken(): Promise<string> {
    if (this.credentials && this.credentials.expiresAt > Math.floor(Date.now() / 1000) + 60) {
      return this.credentials.accessToken;
    }

    // Try refresh
    const raw = this.credentials ?? await loadCredentialsRaw();
    if (raw?.refreshToken) {
      await this.ensureRefresh(raw);
      if (this.credentials) return this.credentials.accessToken;
    }

    throw new Error(
      'Not authenticated. Run `npm run login` in connectors/robinhood/mcp-server to authenticate.'
    );
  }

  /**
   * Login with username/password. Returns the MFA type if MFA is required.
   */
  async login(username: string, password: string, mfaCode?: string): Promise<'success' | string> {
    const deviceToken = this.credentials?.deviceToken ?? randomUUID();

    const body: Record<string, string> = {
      grant_type: 'password',
      client_id: CLIENT_ID,
      username,
      password,
      device_token: deviceToken,
      scope: 'internal',
    };

    if (mfaCode) {
      body.mfa_code = mfaCode;
    }

    const res = await fetch(`${BASE_URL}/oauth2/token/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Robinhood-API-Version': '1.431.4',
      },
      body: new URLSearchParams(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Login failed (${res.status}): ${text}`);
    }

    const data = await res.json() as AuthResponse;

    if ('mfa_required' in data && data.mfa_required) {
      // Store device token so MFA retry uses the same one
      this.credentials = {
        accessToken: '',
        refreshToken: '',
        expiresAt: 0,
        deviceToken,
      };
      return data.mfa_type;
    }

    const tokenData = data as TokenResponse;
    this.credentials = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + tokenData.expires_in,
      deviceToken,
    };

    await saveCredentials(this.credentials);
    return 'success';
  }

  /**
   * Refresh the access token using the refresh token.
   */
  private async refresh(creds: RobinhoodCredentials): Promise<void> {
    const res = await fetch(`${BASE_URL}/oauth2/token/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Robinhood-API-Version': '1.431.4',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: creds.refreshToken,
        device_token: creds.deviceToken,
        scope: 'internal',
      }),
    });

    if (!res.ok) {
      throw new Error(`Token refresh failed (${res.status})`);
    }

    const data = await res.json() as TokenResponse;
    this.credentials = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
      deviceToken: creds.deviceToken,
      accountUrl: creds.accountUrl,
      accountId: creds.accountId,
    };

    await saveCredentials(this.credentials);
  }

  /**
   * Ensure only one refresh is in-flight at a time.
   */
  private async ensureRefresh(creds: RobinhoodCredentials): Promise<void> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refresh(creds).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  /**
   * Handle a 401 response by refreshing and retrying.
   * Returns true if refresh succeeded (caller should retry).
   */
  async handleUnauthorized(): Promise<boolean> {
    const raw = this.credentials ?? await loadCredentialsRaw();
    if (!raw?.refreshToken) return false;

    try {
      await this.ensureRefresh(raw);
      return true;
    } catch {
      return false;
    }
  }

  get isAuthenticated(): boolean {
    return this.credentials !== null && this.credentials.accessToken !== '';
  }

  get deviceToken(): string | undefined {
    return this.credentials?.deviceToken;
  }
}
