/**
 * Robinhood OAuth2 authentication manager.
 *
 * Matches robin_stocks authentication flow:
 * - Username/password login with JSON payload
 * - Verification workflow via /pathfinder/ endpoints
 * - SMS/email challenge handling
 * - MFA (TOTP) support
 * - Token refresh
 * - Auto-refresh on expiry
 */

import { randomUUID } from 'node:crypto';
import {
  loadCredentials,
  loadCredentialsRaw,
  saveCredentials,
  type RobinhoodCredentials,
} from './credential-store';
import { httpRequest } from './http';

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
}

interface MfaRequiredResponse {
  mfa_required: true;
  mfa_type: string;
}

interface VerificationWorkflowResponse {
  verification_workflow: {
    id: string;
    workflow_status: string;
  };
}

interface ChallengeContext {
  id: string;
  type: string;   // 'sms', 'email', or 'prompt'
  status: string;  // 'issued', 'validated', etc.
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LoginResponse = Record<string, any>;

export type LoginResult =
  | { type: 'success' }
  | { type: 'mfa'; mfaType: string }
  | { type: 'verification'; workflowId: string; deviceToken: string }
  | { type: 'error'; message: string };

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
   * Login with username/password. Matches robin_stocks payload exactly.
   */
  async login(
    username: string,
    password: string,
    options?: { mfaCode?: string; challengeId?: string },
  ): Promise<LoginResult> {
    const deviceToken = this.credentials?.deviceToken ?? randomUUID();

    // Match robin_stocks login payload exactly (form-encoded, not JSON)
    // Python's str(False) = 'False', str(True) = 'True'
    const payload: Record<string, string> = {
      client_id: CLIENT_ID,
      expires_in: '86400',
      grant_type: 'password',
      password,
      scope: 'internal',
      username,
      device_token: deviceToken,
      try_passkeys: 'False',
      token_request_path: '/login',
      create_read_only_secondary_token: 'True',
    };

    if (options?.mfaCode) {
      payload.mfa_code = options.mfaCode;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    // If retrying after a validated challenge, include the challenge header
    if (options?.challengeId) {
      headers['X-ROBINHOOD-CHALLENGE-RESPONSE-ID'] = options.challengeId;
    }

    const res = await httpRequest(`${BASE_URL}/oauth2/token/`, {
      method: 'POST',
      headers,
      body: new URLSearchParams(payload).toString(),
    });

    // Handle rate limiting with retry
    if (res.status === 429) {
      return { type: 'error', message: 'Rate limited — too many login attempts. Wait a few minutes and try again.' };
    }

    // Parse response body regardless of status code (robin_stocks does this)
    const text = await res.text();
    let data: LoginResponse;
    try {
      data = JSON.parse(text);
    } catch {
      return { type: 'error', message: `Login failed (${res.status}): ${text}` };
    }

    // Store device token for subsequent attempts
    this.credentials = {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      deviceToken,
    };

    // Check for verification workflow (new Robinhood flow since Dec 2024)
    if ('verification_workflow' in data) {
      const workflow = (data as VerificationWorkflowResponse).verification_workflow;
      return { type: 'verification', workflowId: workflow.id, deviceToken };
    }

    // Check for MFA
    if ('mfa_required' in data && data.mfa_required) {
      return { type: 'mfa', mfaType: (data as MfaRequiredResponse).mfa_type };
    }

    // Check for access token (success)
    if ('access_token' in data) {
      const tokenData = data as TokenResponse;
      this.credentials = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Math.floor(Date.now() / 1000) + tokenData.expires_in,
        deviceToken,
      };
      await saveCredentials(this.credentials);
      return { type: 'success' };
    }

    // Unknown response
    const detail = data.detail ?? JSON.stringify(data);
    return { type: 'error', message: `Login failed: ${detail}` };
  }

  /**
   * Handle verification workflow via /pathfinder/ endpoints.
   * Matches robin_stocks _validate_sherrif_id flow.
   *
   * @param onPrompt - callback for user interaction (SMS code input, app approval wait message)
   */
  async handleVerificationWorkflow(
    deviceToken: string,
    workflowId: string,
    onPrompt: (type: 'sms' | 'email' | 'prompt', message: string) => Promise<string | void>,
    onStatus?: (message: string) => void,
  ): Promise<boolean> {
    const log = onStatus ?? (() => {});

    // Step 1: POST to /pathfinder/user_machine/
    log('Starting verification process...');
    const machineRes = await httpRequest(`${BASE_URL}/pathfinder/user_machine/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: deviceToken,
        flow: 'suv',
        input: { workflow_id: workflowId },
      }),
    });

    if (!machineRes.ok) {
      log('Failed to initiate verification workflow.');
      return false;
    }

    const machineData = await machineRes.json() as { id?: string };
    if (!machineData.id) {
      log('No verification ID returned.');
      return false;
    }

    const machineId = machineData.id;
    const inquiriesUrl = `${BASE_URL}/pathfinder/inquiries/${machineId}/user_view/`;

    // Step 2: Poll for challenge
    const startTime = Date.now();
    const timeoutMs = 120_000; // 2 minutes

    while (Date.now() - startTime < timeoutMs) {
      await sleep(5000);

      const inquiryRes = await httpRequest(inquiriesUrl, { method: 'GET' });
      if (!inquiryRes.ok) {
        log('No response from Robinhood API. Retrying...');
        continue;
      }

      const inquiry = await inquiryRes.json() as Record<string, unknown>;
      const context = inquiry.context as Record<string, unknown> | undefined;
      const challenge = context?.sheriff_challenge as ChallengeContext | undefined;

      if (!challenge) continue;

      if (challenge.type === 'prompt') {
        // App-based approval — poll the prompt status
        log('Check Robinhood app for device approval...');
        await onPrompt('prompt', 'Approve the login in your Robinhood app.');
        const promptUrl = `${BASE_URL}/push/${challenge.id}/get_prompts_status/`;

        while (Date.now() - startTime < timeoutMs) {
          await sleep(5000);
          const promptRes = await httpRequest(promptUrl, { method: 'GET' });
          if (promptRes.ok) {
            const promptData = await promptRes.json() as { challenge_status?: string };
            if (promptData.challenge_status === 'validated') break;
          }
        }
        break;
      }

      if (challenge.status === 'validated') {
        log('Verification successful!');
        break;
      }

      if ((challenge.type === 'sms' || challenge.type === 'email') && challenge.status === 'issued') {
        const code = await onPrompt(challenge.type, `Enter the ${challenge.type} verification code:`);
        if (!code) return false;

        const challengeRes = await httpRequest(`${BASE_URL}/challenge/${challenge.id}/respond/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: code }),
        });

        if (challengeRes.ok) {
          const challengeData = await challengeRes.json() as { status?: string };
          if (challengeData.status === 'validated') break;
        }
      }
    }

    // Step 3: Confirm workflow approval
    let retries = 5;
    while (Date.now() - startTime < timeoutMs && retries > 0) {
      try {
        const confirmRes = await httpRequest(inquiriesUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sequence: 0, user_input: { status: 'continue' } }),
        });

        if (confirmRes.ok) {
          const confirmData = await confirmRes.json() as Record<string, unknown>;
          const typeContext = confirmData.type_context as Record<string, unknown> | undefined;
          if (typeContext?.result === 'workflow_status_approved') {
            log('Verification successful!');
            return true;
          }
        }
      } catch {
        retries--;
        log('Retrying workflow status check...');
      }
      await sleep(5000);
    }

    // Assume approved after timeout (matches robin_stocks behavior)
    log('Timeout reached. Proceeding with login...');
    return true;
  }

  /**
   * Refresh the access token using the refresh token.
   */
  private async refresh(creds: RobinhoodCredentials): Promise<void> {
    const res = await httpRequest(`${BASE_URL}/oauth2/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: creds.refreshToken,
        device_token: creds.deviceToken,
        scope: 'internal',
      }).toString(),
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
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
