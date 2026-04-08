import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as signing from '../src/client/signing';
import {
  CONNECTED_HTML,
  type CallbackServer,
  DeviceAuthError,
  deviceAuthFlow,
  pollForToken,
  requestDeviceCode,
  requestDeviceToken,
  startCallbackServer,
  type DeviceCodeResponse,
  type DeviceTokenResponse,
} from '../src/client/device-auth';
import { generateKeyPair } from '../src/client/signing';

vi.mock('../src/client/signing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client/signing')>();
  return {
    ...actual,
    saveCredentials: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Helpers ──────────────────────────────────────────────────

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  } as Response;
}

function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof globalThis.fetch {
  let callIndex = 0;
  const fn = vi.fn(async () => {
    const resp = responses[callIndex++] ?? { status: 500, body: { error: 'no_more_responses' } };
    return mockResponse(resp.status, resp.body);
  });
  return fn as typeof globalThis.fetch;
}

function getRequestBody(fetchFn: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  const init = fetchFn.mock.calls[callIndex]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

const MOCK_DEVICE_CODE_RESPONSE: DeviceCodeResponse = {
  deviceCode: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  authorizeUrl: 'https://cube.exchange/agent/authorize?code=a1b2c3d4',
  expiresIn: 600,
  interval: 0,
};

const MOCK_HEADLESS_CODE_RESPONSE: DeviceCodeResponse = {
  deviceCode: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  userCode: 'brave-solar-mint-echo',
  authorizeUrl: 'https://cube.exchange/agent/brave-solar-mint-echo',
  expiresIn: 600,
  interval: 0,
};

const MOCK_TOKEN_RESPONSE: DeviceTokenResponse = {
  verificationKeyId: 'd97c889a-fbd8-471d-955d-acc2829dffa5',
  publicKey: 'EiCUxgK/kgIZtV+cGdopP7kO7FFowmZcucDBInc44nINiA==',
  expiresAt: 1743955200,
  subaccountId: 1,
  registrationMethod: 'device',
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── requestDeviceCode ────────────────────────────────────────

describe('requestDeviceCode', () => {
  it('sends correct request for interactive mode', async () => {
    const fetchFn = mockFetch([{ status: 200, body: MOCK_DEVICE_CODE_RESPONSE }]);

    const result = await requestDeviceCode(
      'https://api.cube.exchange/ir/v0',
      {
        verificationKey: 'base64key==',
        clientName: 'AI Fund',
        codeChallenge: 'pkce-challenge',
        codeChallengeMethod: 'S256',
        redirectUri: 'http://127.0.0.1:9876/callback',
        state: 'oauth-state-123',
      },
      fetchFn,
    );

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.cube.exchange/ir/v0/agent/device/code',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'cube-cli' },
        body: JSON.stringify({
          verificationKey: 'base64key==',
          clientName: 'AI Fund',
          codeChallenge: 'pkce-challenge',
          codeChallengeMethod: 'S256',
          redirectUri: 'http://127.0.0.1:9876/callback',
          state: 'oauth-state-123',
        }),
      }),
    );
    expect(result.deviceCode).toBe(MOCK_DEVICE_CODE_RESPONSE.deviceCode);
    expect(result.authorizeUrl).toContain('cube.exchange');
  });

  it('sends correct request for headless mode without redirect state', async () => {
    const fetchFn = mockFetch([{ status: 200, body: MOCK_HEADLESS_CODE_RESPONSE }]);

    const result = await requestDeviceCode(
      'https://api.cube.exchange/ir/v0',
      {
        verificationKey: 'base64key==',
        clientName: 'AI Fund',
        codeChallenge: 'pkce-challenge',
        codeChallengeMethod: 'S256',
      },
      fetchFn,
    );

    const body = getRequestBody(fetchFn as ReturnType<typeof vi.fn>);
    expect(body.redirectUri).toBeUndefined();
    expect(body.state).toBeUndefined();
    expect(body.codeChallenge).toBe('pkce-challenge');
    expect(body.codeChallengeMethod).toBe('S256');
    expect(result.userCode).toBe('brave-solar-mint-echo');
  });

  it('throws DeviceAuthError on invalid_verification_key', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'invalid_verification_key' } }]);

    await expect(
      requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'garbage',
        clientName: 'Test',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      }, fetchFn),
    ).rejects.toThrow(DeviceAuthError);

    try {
      await requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'garbage',
        clientName: 'Test',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      }, mockFetch([{ status: 400, body: { error: 'invalid_verification_key' } }]));
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('invalid_verification_key');
      expect((err as DeviceAuthError).status).toBe(400);
    }
  });

  it('throws DeviceAuthError on invalid_client_name', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'invalid_client_name' } }]);

    await expect(
      requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'base64key==',
        clientName: '',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      }, fetchFn),
    ).rejects.toThrow(DeviceAuthError);
  });

  it('throws DeviceAuthError on rate_limited', async () => {
    const fetchFn = mockFetch([{ status: 429, body: { error: 'rate_limited' } }]);

    await expect(
      requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'base64key==',
        clientName: 'Test',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      }, fetchFn),
    ).rejects.toThrow(DeviceAuthError);
  });

  it('extracts error from nested { error: { error: { reason } } } format', async () => {
    const fetchFn = mockFetch([{
      status: 400,
      body: { error: { error: { reason: 'invalid_verification_key' } } },
    }]);

    try {
      await requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'garbage',
        clientName: 'Test',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('invalid_verification_key');
    }
  });

  it('extracts error from double-wrapped JSON string format', async () => {
    const fetchFn = mockFetch([{
      status: 400,
      body: { error: JSON.stringify({ error: { reason: 'invalid_client_name' } }) },
    }]);

    try {
      await requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'base64key==',
        clientName: '',
        codeChallenge: 'challenge',
        codeChallengeMethod: 'S256',
      }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('invalid_client_name');
    }
  });

  it('unwraps response from { result: ... } envelope', async () => {
    const fetchFn = mockFetch([{
      status: 200,
      body: { result: MOCK_DEVICE_CODE_RESPONSE },
    }]);

    const result = await requestDeviceCode('https://api.cube.exchange/ir/v0', {
      verificationKey: 'base64key==',
      clientName: 'Test',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
    }, fetchFn);

    expect(result.deviceCode).toBe(MOCK_DEVICE_CODE_RESPONSE.deviceCode);
  });
});

// ── requestDeviceToken ───────────────────────────────────────

describe('requestDeviceToken', () => {
  it('returns token response on success', async () => {
    const fetchFn = mockFetch([{ status: 200, body: MOCK_TOKEN_RESPONSE }]);

    const result = await requestDeviceToken(
      'https://api.cube.exchange/ir/v0',
      { deviceCode: 'abc123', codeVerifier: 'pkce-verifier', code: 'authorization-code-123' },
      fetchFn,
    );

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.cube.exchange/ir/v0/agent/device/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          deviceCode: 'abc123',
          codeVerifier: 'pkce-verifier',
          code: 'authorization-code-123',
        }),
      }),
    );
    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(result.subaccountId).toBe(1);
  });

  it('throws authorization_pending', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'authorization_pending' } }]);

    try {
      await requestDeviceToken('https://api.cube.exchange/ir/v0', { deviceCode: 'abc', codeVerifier: 'verifier' }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('authorization_pending');
    }
  });

  it('throws access_denied', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'access_denied' } }]);

    try {
      await requestDeviceToken('https://api.cube.exchange/ir/v0', { deviceCode: 'abc', codeVerifier: 'verifier' }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('access_denied');
    }
  });

  it('throws expired_token', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'expired_token' } }]);

    try {
      await requestDeviceToken('https://api.cube.exchange/ir/v0', { deviceCode: 'abc', codeVerifier: 'verifier' }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('expired_token');
    }
  });

  it('throws slow_down', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'slow_down' } }]);

    try {
      await requestDeviceToken('https://api.cube.exchange/ir/v0', { deviceCode: 'abc', codeVerifier: 'verifier' }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('slow_down');
    }
  });

  it('unwraps response from { result: ... } envelope', async () => {
    const fetchFn = mockFetch([{
      status: 200,
      body: { result: MOCK_TOKEN_RESPONSE },
    }]);

    const result = await requestDeviceToken(
      'https://api.cube.exchange/ir/v0',
      { deviceCode: 'abc123', codeVerifier: 'pkce-verifier' },
      fetchFn,
    );

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
  });
});

// ── pollForToken ─────────────────────────────────────────────

describe('pollForToken', () => {
  it('returns immediately when approved on first poll', async () => {
    const fetchFn = mockFetch([{ status: 200, body: MOCK_TOKEN_RESPONSE }]);

    const result = await pollForToken({
      apiBase: 'https://api.cube.exchange/ir/v0',
      deviceCode: 'abc123',
      codeVerifier: 'pkce-verifier',
      interval: 0,
      expiresIn: 60,
      fetchFn,
    });

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
  });

  it('retries on authorization_pending then succeeds', async () => {
    const fetchFn = mockFetch([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: MOCK_TOKEN_RESPONSE },
    ]);
    const onPending = vi.fn();

    const result = await pollForToken({
      apiBase: 'https://api.cube.exchange/ir/v0',
      deviceCode: 'abc123',
      codeVerifier: 'pkce-verifier',
      interval: 0,
      expiresIn: 60,
      fetchFn,
      onPending,
    });

    expect(onPending).toHaveBeenCalledTimes(2);
    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
  });

  it('increases interval on slow_down then succeeds', async () => {
    const fetchFn = mockFetch([
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: MOCK_TOKEN_RESPONSE },
    ]);

    const result = await pollForToken({
      apiBase: 'https://api.cube.exchange/ir/v0',
      deviceCode: 'abc123',
      codeVerifier: 'pkce-verifier',
      interval: 0,
      expiresIn: 60,
      fetchFn,
    });

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('throws on access_denied without retrying', async () => {
    const fetchFn = mockFetch([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'access_denied' } },
    ]);

    await expect(
      pollForToken({
        apiBase: 'https://api.cube.exchange/ir/v0',
        deviceCode: 'abc123',
        codeVerifier: 'pkce-verifier',
        interval: 0,
        expiresIn: 60,
        fetchFn,
      }),
    ).rejects.toThrow(DeviceAuthError);

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws on expired_token without retrying', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'expired_token' } }]);

    await expect(
      pollForToken({
        apiBase: 'https://api.cube.exchange/ir/v0',
        deviceCode: 'abc123',
        codeVerifier: 'pkce-verifier',
        interval: 0,
        expiresIn: 60,
        fetchFn,
      }),
    ).rejects.toThrow(DeviceAuthError);
  });

  it('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();

    const fetchFn = mockFetch([]);

    await expect(
      pollForToken({
        apiBase: 'https://api.cube.exchange/ir/v0',
        deviceCode: 'abc123',
        codeVerifier: 'pkce-verifier',
        interval: 0,
        expiresIn: 60,
        fetchFn,
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws expired_token when deadline exceeded', async () => {
    const fetchFn = mockFetch([
      { status: 400, body: { error: 'authorization_pending' } },
    ]);

    await expect(
      pollForToken({
        apiBase: 'https://api.cube.exchange/ir/v0',
        deviceCode: 'abc123',
        codeVerifier: 'pkce-verifier',
        interval: 0,
        expiresIn: 0,
        fetchFn,
      }),
    ).rejects.toThrow('expired');
  });
});

// ── Callback Server ──────────────────────────────────────────

describe('startCallbackServer', () => {
  let server: CallbackServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('starts and returns a valid port and redirect URI', async () => {
    server = await startCallbackServer(19876);
    expect(server.port).toBeGreaterThan(0);
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}/callback`);
    expect(server.url).toBe(server.redirectUri);
    expect(server.state).toBeTruthy();
  });

  it('serves connected HTML after successful completion', async () => {
    server = await startCallbackServer(19877);

    const waitForCode = server.waitForCode();
    const responsePromise = fetch(`${server.redirectUri}?code=test-auth-code&state=${server.state}`);

    expect(await waitForCode).toBe('test-auth-code');
    expect(
      await Promise.race([
        responsePromise.then(() => 'resolved'),
        new Promise(resolve => setTimeout(() => resolve('pending'), 25)),
      ]),
    ).toBe('pending');

    await server.completeSuccess();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(CONNECTED_HTML);
  });

  it('shows a failure page when setup fails after the callback arrives', async () => {
    server = await startCallbackServer(19878);

    const waitForCode = server.waitForCode();
    const responsePromise = fetch(`${server.redirectUri}?code=test-auth-code&state=${server.state}`);

    expect(await waitForCode).toBe('test-auth-code');
    await server.completeFailure('Remote exchange failed.');

    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Remote exchange failed.');
  });

  it('rejects callbacks with the wrong state and keeps waiting for the real code', async () => {
    server = await startCallbackServer(19879);

    const waitForCode = server.waitForCode();

    const invalidResponse = await fetch(`${server.redirectUri}?code=wrong-code&state=wrong-state`);
    expect(invalidResponse.status).toBe(400);
    expect(await invalidResponse.text()).toContain('Invalid authorization state.');

    const validResponsePromise = fetch(`${server.redirectUri}?code=good-code&state=${server.state}`);
    expect(await waitForCode).toBe('good-code');
    await server.completeSuccess();

    const validResponse = await validResponsePromise;
    expect(validResponse.status).toBe(200);
  });

  it('rejects waitForCode when no code param is provided', async () => {
    server = await startCallbackServer(19880);

    const waitForCode = server.waitForCode(100).catch((err) => err);
    const response = await fetch(`${server.redirectUri}?state=${server.state}`);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('Missing authorization code.');
    const err = await waitForCode;
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as DeviceAuthError).code).toBe('callback_timeout');
  });

  it('returns 404 for non-callback paths', async () => {
    server = await startCallbackServer(19881);

    const res = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(res.status).toBe(404);
  });

  it('times out waitForCode when no redirect arrives', async () => {
    server = await startCallbackServer(19882);

    const err = await server.waitForCode(100).catch((caught) => caught);
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as DeviceAuthError).code).toBe('callback_timeout');
  });

  it('retries on port conflict', async () => {
    const server1 = await startCallbackServer(19883);
    const usedPort = server1.port;

    try {
      server = await startCallbackServer(usedPort, 3);
      expect(server.port).toBe(usedPort + 1);
    } finally {
      await server1.close();
    }
  });
});

// ── DeviceAuthError ──────────────────────────────────────────

describe('DeviceAuthError', () => {
  it('stores code and status', () => {
    const err = new DeviceAuthError('invalid_verification_key', 400);
    expect(err.code).toBe('invalid_verification_key');
    expect(err.status).toBe(400);
    expect(err.message).toBe('invalid_verification_key');
    expect(err.name).toBe('DeviceAuthError');
  });

  it('accepts custom message', () => {
    const err = new DeviceAuthError('access_denied', 400, 'User denied the request');
    expect(err.message).toBe('User denied the request');
    expect(err.code).toBe('access_denied');
  });

  it('is an instance of Error', () => {
    const err = new DeviceAuthError('test', 500);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DeviceAuthError);
  });
});

// ── CONNECTED_HTML ───────────────────────────────────────────

describe('CONNECTED_HTML', () => {
  it('is valid HTML with expected content', () => {
    expect(CONNECTED_HTML).toContain('<!DOCTYPE html>');
    expect(CONNECTED_HTML).toContain('Connected');
    expect(CONNECTED_HTML).toContain('You can close this tab');
    expect(CONNECTED_HTML).toContain('✓');
  });
});

// ── deviceAuthFlow (integration-style with mocks) ────────────

describe('deviceAuthFlow', () => {
  it('interactive flow uses callback state and PKCE, then exchanges with the authorization code', async () => {
    const events: string[] = [];
    const tokenBodies: Array<Record<string, unknown>> = [];
    let callbackPort = 0;
    let callbackState = '';

    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
        callbackPort = parseInt(new URL(body.redirectUri).port, 10);
        callbackState = body.state;

        expect(body.clientName).toBe('AI Fund');
        expect(body.verificationKey).toBeTruthy();
        expect(body.codeChallenge).toBeTruthy();
        expect(body.codeChallengeMethod).toBe('S256');
        expect(body.redirectUri).toBeTruthy();
        expect(body.state).toBeTruthy();

        return mockResponse(200, {
          ...MOCK_DEVICE_CODE_RESPONSE,
          authorizeUrl: 'https://cube.exchange/agent/authorize?code=test',
        });
      }

      if (urlStr.includes('/agent/device/token')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        tokenBodies.push(body);
        if (!body.code) {
          expect(body.codeVerifier).toBeTruthy();
          return mockResponse(400, { error: 'authorization_pending' });
        }

        expect(body.code).toBe('authorization-code-123');
        expect(body.codeVerifier).toBeTruthy();
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }

      return mockResponse(404, {});
    });

    const openBrowser = vi.fn(async () => {
      setTimeout(async () => {
        try {
          await fetch(`http://127.0.0.1:${callbackPort}/callback?code=authorization-code-123&state=${callbackState}`);
        } catch {
          // ignore
        }
      }, 100);
    });

    const result = await deviceAuthFlow({
      apiBase: 'https://api.cube.exchange/ir/v0',
      clientName: 'AI Fund',
      headless: false,
      callbackPort: 19890,
      openBrowser,
      onEvent: async (event) => {
        events.push(event.type);
      },
      fetch: fetchFn as typeof globalThis.fetch,
    });

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(result.subaccountId).toBe(1);
    expect(result.expiresAt).toBe(MOCK_TOKEN_RESPONSE.expiresAt);
    expect(result.keyPair.publicKey.length).toBe(32);
    expect(result.verificationKeyBase64).toBeTruthy();

    expect(openBrowser).toHaveBeenCalledOnce();
    expect(tokenBodies).toHaveLength(2);
    expect(tokenBodies[0].code).toBeUndefined();
    expect(tokenBodies[0].codeVerifier).toBeTruthy();
    expect(tokenBodies[1].code).toBe('authorization-code-123');
    expect(events).toContain('callback_server_started');
    expect(events).toContain('browser_opened');
    expect(events).toContain('approved');
  });

  it('headless flow sends PKCE and polls with the verifier until approved', async () => {
    const events: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.redirectUri).toBeUndefined();
        expect(body.state).toBeUndefined();
        expect(body.codeChallenge).toBeTruthy();
        expect(body.codeChallengeMethod).toBe('S256');
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }

      if (urlStr.includes('/agent/device/token')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.codeVerifier).toBeTruthy();
        if (fetchFn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('/agent/device/token')).length <= 1) {
          return mockResponse(400, { error: 'authorization_pending' });
        }
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }

      return mockResponse(404, {});
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const result = await deviceAuthFlow({
      apiBase: 'https://api.cube.exchange/ir/v0',
      clientName: 'AI Fund',
      headless: true,
      openBrowser: vi.fn(),
      onEvent: async (event) => {
        events.push(event.type);
      },
      fetch: fetchFn as typeof globalThis.fetch,
    });

    stdoutSpy.mockRestore();

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(events).toContain('device_code_received');
    expect(events).toContain('polling');
  });

  it('falls back to headless when callback server fails', async () => {
    const events: string[] = [];
    let tokenCalls = 0;

    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.redirectUri).toBeUndefined();
        expect(body.state).toBeUndefined();
        expect(body.codeChallenge).toBeTruthy();
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }

      if (urlStr.includes('/agent/device/token')) {
        tokenCalls++;
        if (tokenCalls === 1) {
          return mockResponse(400, { error: 'authorization_pending' });
        }
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }

      return mockResponse(404, {});
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const result = await deviceAuthFlow({
      apiBase: 'https://api.cube.exchange/ir/v0',
      clientName: 'AI Fund',
      headless: false,
      callbackPort: -1,
      callbackPortRetries: 0,
      openBrowser: vi.fn(),
      onEvent: async (event) => {
        events.push(event.type);
      },
      fetch: fetchFn as typeof globalThis.fetch,
    });

    stdoutSpy.mockRestore();

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(events).toContain('callback_server_failed');
  });

  it('handles browser open failure gracefully and still completes the callback flow', async () => {
    const events: string[] = [];
    let callbackPort = 0;
    let callbackState = '';

    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
        callbackPort = parseInt(new URL(body.redirectUri).port, 10);
        callbackState = body.state;

        setTimeout(async () => {
          try {
            await fetch(`http://127.0.0.1:${callbackPort}/callback?code=manual-code-123&state=${callbackState}`);
          } catch {
            // ignore
          }
        }, 100);

        return mockResponse(200, MOCK_DEVICE_CODE_RESPONSE);
      }

      if (urlStr.includes('/agent/device/token')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (!body.code) {
          return mockResponse(400, { error: 'authorization_pending' });
        }
        expect(body.code).toBe('manual-code-123');
        expect(body.codeVerifier).toBeTruthy();
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }

      return mockResponse(404, {});
    });

    const openBrowser = vi.fn(async () => {
      throw new Error('No browser available');
    });

    const result = await deviceAuthFlow({
      apiBase: 'https://api.cube.exchange/ir/v0',
      clientName: 'AI Fund',
      headless: false,
      callbackPort: 19892,
      openBrowser,
      onEvent: async (event) => {
        events.push(event.type);
      },
      fetch: fetchFn as typeof globalThis.fetch,
    });

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(events).toContain('browser_failed');
  });

  it('propagates device code request errors', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'invalid_verification_key' } }]);

    await expect(
      deviceAuthFlow({
        apiBase: 'https://api.cube.exchange/ir/v0',
        clientName: 'Test',
        headless: true,
        openBrowser: vi.fn(),
        fetch: fetchFn,
      }),
    ).rejects.toThrow(DeviceAuthError);
  });

  it('propagates access_denied from polling', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      const urlStr = url.toString();
      if (urlStr.includes('/agent/device/code')) {
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }
      if (urlStr.includes('/agent/device/token')) {
        return mockResponse(400, { error: 'access_denied' });
      }
      return mockResponse(404, {});
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(
      deviceAuthFlow({
        apiBase: 'https://api.cube.exchange/ir/v0',
        clientName: 'Test',
        headless: true,
        openBrowser: vi.fn(),
        fetch: fetchFn as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(DeviceAuthError);

    stdoutSpy.mockRestore();
  });

  it('reuses existingKeyPair instead of generating a new one', async () => {
    const existingKeyPair = await generateKeyPair();
    const existingPubHex = Buffer.from(existingKeyPair.publicKey).toString('hex');

    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.codeChallenge).toBeTruthy();
        expect(body.codeChallengeMethod).toBe('S256');
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }

      if (urlStr.includes('/agent/device/token')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        expect(body.codeVerifier).toBeTruthy();
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }

      return mockResponse(404, {});
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const result = await deviceAuthFlow({
      apiBase: 'https://api.cube.exchange/ir/v0',
      clientName: 'AI Fund',
      headless: true,
      openBrowser: vi.fn(),
      fetch: fetchFn as typeof globalThis.fetch,
      existingKeyPair,
    });

    stdoutSpy.mockRestore();

    expect(result.keyPair).toBe(existingKeyPair);
    expect(Buffer.from(result.keyPair.publicKey).toString('hex')).toBe(existingPubHex);
    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);

    const codeCallBody = getRequestBody(fetchFn);
    expect(codeCallBody.verificationKey).toBeTruthy();
    const vkBytes = Buffer.from(String(codeCallBody.verificationKey), 'base64');
    const pubKeyInVk = vkBytes.subarray(6, 38);
    expect(Buffer.from(existingKeyPair.publicKey).equals(pubKeyInVk)).toBe(true);
  });

  it('saves credentials after a successful login', async () => {
    const saveCredentialsSpy = vi.mocked(signing.saveCredentials);

    const fetchFn = vi.fn(async (url: string) => {
      const urlStr = url.toString();
      if (urlStr.includes('/agent/device/code')) {
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }
      if (urlStr.includes('/agent/device/token')) {
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }
      return mockResponse(404, {});
    });

    await deviceAuthFlow({
      apiBase: 'https://api.cube.exchange/ir/v0',
      clientName: 'AI Fund',
      headless: true,
      openBrowser: vi.fn(),
      fetch: fetchFn as typeof globalThis.fetch,
    });

    expect(saveCredentialsSpy).toHaveBeenCalledOnce();
  });
});
