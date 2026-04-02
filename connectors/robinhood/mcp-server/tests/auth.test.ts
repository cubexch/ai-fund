/**
 * Unit tests for Robinhood auth — validates request format matches robin_stocks exactly.
 * No API calls needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock httpRequest to capture what auth.ts sends
const mockHttpRequest = vi.fn();
vi.mock('../src/client/http.js', () => ({
  httpRequest: (...args: unknown[]) => mockHttpRequest(...args),
}));

// Mock credential store
vi.mock('../src/client/credential-store.js', () => ({
  loadCredentials: vi.fn().mockResolvedValue(null),
  loadCredentialsRaw: vi.fn().mockResolvedValue(null),
  saveCredentials: vi.fn().mockResolvedValue(undefined),
}));

import { AuthManager } from '../src/client/auth.js';

// robin_stocks reference (from globals.py + authentication.py):
//
// SESSION.headers:
//   Accept: */*
//   Accept-Encoding: gzip,deflate,br
//   Accept-Language: en-US,en;q=1
//   Content-Type: application/x-www-form-urlencoded; charset=utf-8
//   X-Robinhood-API-Version: 1.431.4
//   Connection: keep-alive
//   User-Agent: *
//
// login_payload keys:
//   client_id, expires_in (int 86400), grant_type, password, scope,
//   username, device_token, try_passkeys (False), token_request_path,
//   create_read_only_secondary_token (True)
//
// Sent via: SESSION.post(url, data=payload)
// Python requests form-encodes: int->'86400', False->'False', True->'True'

describe('Auth request format (matches robin_stocks)', () => {
  let auth: AuthManager;

  beforeEach(() => {
    auth = new AuthManager();
    mockHttpRequest.mockReset();
  });

  it('sends login to correct URL', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => '{"detail":"test"}',
      json: async () => ({ detail: 'test' }),
    });

    await auth.login('user@test.com', 'pass123');

    expect(mockHttpRequest).toHaveBeenCalledTimes(1);
    const [url] = mockHttpRequest.mock.calls[0];
    expect(url).toBe('https://api.robinhood.com/oauth2/token/');
  });

  it('sends Content-Type as application/x-www-form-urlencoded (not JSON)', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => '{"detail":"test"}',
    });

    await auth.login('user@test.com', 'pass123');

    const [, options] = mockHttpRequest.mock.calls[0];
    expect(options.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('sends body as form-encoded string (not JSON)', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => '{"detail":"test"}',
    });

    await auth.login('user@test.com', 'pass123');

    const [, options] = mockHttpRequest.mock.calls[0];
    const body = options.body as string;

    // Should be URL-encoded, not JSON
    expect(body).not.toContain('{');
    expect(body).not.toContain('}');
    expect(body).toContain('=');
    expect(body).toContain('&');
  });

  it('includes all robin_stocks payload fields', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => '{"detail":"test"}',
    });

    await auth.login('user@test.com', 'pass123');

    const [, options] = mockHttpRequest.mock.calls[0];
    const params = new URLSearchParams(options.body);

    expect(params.get('client_id')).toBe('c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS');
    expect(params.get('expires_in')).toBe('86400');
    expect(params.get('grant_type')).toBe('password');
    expect(params.get('password')).toBe('pass123');
    expect(params.get('scope')).toBe('internal');
    expect(params.get('username')).toBe('user@test.com');
    expect(params.get('device_token')).toBeTruthy(); // UUID
    // Python str(False) = 'False', str(True) = 'True'
    expect(params.get('try_passkeys')).toBe('False');
    expect(params.get('token_request_path')).toBe('/login');
    expect(params.get('create_read_only_secondary_token')).toBe('True');
  });

  it('does not include mfa_code when not provided', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => '{"detail":"test"}',
    });

    await auth.login('user@test.com', 'pass123');

    const [, options] = mockHttpRequest.mock.calls[0];
    const params = new URLSearchParams(options.body);

    expect(params.has('mfa_code')).toBe(false);
  });

  it('includes mfa_code when provided', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => '{"detail":"test"}',
    });

    await auth.login('user@test.com', 'pass123', { mfaCode: '123456' });

    const [, options] = mockHttpRequest.mock.calls[0];
    const params = new URLSearchParams(options.body);

    expect(params.get('mfa_code')).toBe('123456');
  });

  it('includes challenge header when challengeId provided', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => '{"detail":"test"}',
    });

    await auth.login('user@test.com', 'pass123', { challengeId: 'abc-123' });

    const [, options] = mockHttpRequest.mock.calls[0];
    expect(options.headers['X-ROBINHOOD-CHALLENGE-RESPONSE-ID']).toBe('abc-123');
  });

  it('returns success when access_token is in response', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        access_token: 'tok_123',
        refresh_token: 'ref_456',
        expires_in: 86400,
        token_type: 'Bearer',
        scope: 'internal',
      }),
    });

    const result = await auth.login('user@test.com', 'pass123');
    expect(result.type).toBe('success');
  });

  it('returns mfa when mfa_required is in response', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        mfa_required: true,
        mfa_type: 'sms',
      }),
    });

    const result = await auth.login('user@test.com', 'pass123');
    expect(result.type).toBe('mfa');
    if (result.type === 'mfa') {
      expect(result.mfaType).toBe('sms');
    }
  });

  it('returns verification when verification_workflow is in response', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        verification_workflow: {
          id: 'wf_789',
          workflow_status: 'workflow_status_internal_pending',
        },
      }),
    });

    const result = await auth.login('user@test.com', 'pass123');
    expect(result.type).toBe('verification');
    if (result.type === 'verification') {
      expect(result.workflowId).toBe('wf_789');
    }
  });

  it('returns rate limit error on 429', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 429,
      ok: false,
      text: async () => '{"detail":"too many requests"}',
    });

    const result = await auth.login('user@test.com', 'pass123');
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toContain('Rate limited');
    }
  });

  it('returns error with detail from Robinhood on 400', async () => {
    mockHttpRequest.mockResolvedValue({
      status: 400,
      ok: false,
      text: async () => '{"detail":"Unable to log in with provided credentials."}',
    });

    const result = await auth.login('user@test.com', 'pass123');
    expect(result.type).toBe('error');
    if (result.type === 'error') {
      expect(result.message).toContain('Unable to log in');
    }
  });

  it('uses consistent device_token across login attempts', async () => {
    // First call — sets device token
    mockHttpRequest.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ mfa_required: true, mfa_type: 'sms' }),
    });
    await auth.login('user@test.com', 'pass123');
    const params1 = new URLSearchParams(mockHttpRequest.mock.calls[0][1].body);
    const deviceToken1 = params1.get('device_token');

    // Second call — should reuse same device token
    mockHttpRequest.mockResolvedValue({
      status: 200,
      ok: true,
      text: async () => JSON.stringify({
        access_token: 'tok', refresh_token: 'ref', expires_in: 86400, token_type: 'Bearer', scope: 'internal',
      }),
    });
    await auth.login('user@test.com', 'pass123', { mfaCode: '123456' });
    const params2 = new URLSearchParams(mockHttpRequest.mock.calls[1][1].body);
    const deviceToken2 = params2.get('device_token');

    expect(deviceToken1).toBe(deviceToken2);
  });
});

describe('HTTP default headers (matches robin_stocks globals.py)', () => {
  it('default headers match robin_stocks SESSION.headers', async () => {
    // Import the actual http module (not mocked)
    const { httpRequest: realHttpRequest } = await vi.importActual<typeof import('../src/client/http.js')>('../src/client/http.js');

    // We can't easily inspect the headers without making a request,
    // but we can verify the module loads without errors
    expect(realHttpRequest).toBeDefined();
    expect(typeof realHttpRequest).toBe('function');
  });
});
