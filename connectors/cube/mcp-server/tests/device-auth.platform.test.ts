import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startCallbackServer,
  requestDeviceCode,
  requestDeviceToken,
  pollForToken,
  deviceAuthFlow,
  DeviceAuthError,
  CONNECTED_HTML,
  type DeviceCodeResponse,
  type DeviceTokenResponse,
  type CallbackServer,
} from '../src/client/device-auth';
import { generateKeyPair } from '../src/client/signing';

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
  return fn;
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

// ── requestDeviceCode ────────────────────────────────────────

describe('requestDeviceCode', () => {
  it('sends correct request for interactive mode', async () => {
    const fetchFn = mockFetch([{ status: 200, body: MOCK_DEVICE_CODE_RESPONSE }]);

    const result = await requestDeviceCode(
      'https://api.cube.exchange/ir/v0',
      {
        verificationKey: 'base64key==',
        clientName: 'AI Fund',
        callbackUrl: 'http://localhost:9876/callback',
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
          callbackUrl: 'http://localhost:9876/callback',
        }),
      }),
    );
    expect(result.deviceCode).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    expect(result.authorizeUrl).toContain('cube.exchange');
  });

  it('sends correct request for headless mode (no callbackUrl)', async () => {
    const fetchFn = mockFetch([{ status: 200, body: MOCK_HEADLESS_CODE_RESPONSE }]);

    const result = await requestDeviceCode(
      'https://api.cube.exchange/ir/v0',
      {
        verificationKey: 'base64key==',
        clientName: 'AI Fund',
      },
      fetchFn,
    );

    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
    expect(body.callbackUrl).toBeUndefined();
    expect(result.userCode).toBe('brave-solar-mint-echo');
  });

  it('throws DeviceAuthError on invalid_verification_key', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'invalid_verification_key' } }]);

    await expect(
      requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'garbage',
        clientName: 'Test',
      }, fetchFn),
    ).rejects.toThrow(DeviceAuthError);

    try {
      await requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'garbage',
        clientName: 'Test',
      }, mockFetch([{ status: 400, body: { error: 'invalid_verification_key' } }]));
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
      }, fetchFn),
    ).rejects.toThrow(DeviceAuthError);
  });

  it('throws DeviceAuthError on invalid_callback_url', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'invalid_callback_url' } }]);

    await expect(
      requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'base64key==',
        clientName: 'Test',
        callbackUrl: 'https://evil.com/callback',
      }, fetchFn),
    ).rejects.toThrow(DeviceAuthError);
  });

  it('throws DeviceAuthError on rate_limited', async () => {
    const fetchFn = mockFetch([{ status: 429, body: { error: 'rate_limited' } }]);

    await expect(
      requestDeviceCode('https://api.cube.exchange/ir/v0', {
        verificationKey: 'base64key==',
        clientName: 'Test',
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
      { deviceCode: 'abc123', callbackToken: 'jwt-token' },
      fetchFn,
    );

    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.cube.exchange/ir/v0/agent/device/token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ deviceCode: 'abc123', callbackToken: 'jwt-token' }),
      }),
    );
    expect(result.verificationKeyId).toBe('d97c889a-fbd8-471d-955d-acc2829dffa5');
    expect(result.subaccountId).toBe(1);
  });

  it('throws authorization_pending', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'authorization_pending' } }]);

    try {
      await requestDeviceToken('https://api.cube.exchange/ir/v0', { deviceCode: 'abc' }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('authorization_pending');
    }
  });

  it('throws access_denied', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'access_denied' } }]);

    try {
      await requestDeviceToken('https://api.cube.exchange/ir/v0', { deviceCode: 'abc' }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('access_denied');
    }
  });

  it('throws expired_token', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'expired_token' } }]);

    try {
      await requestDeviceToken('https://api.cube.exchange/ir/v0', { deviceCode: 'abc' }, fetchFn);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DeviceAuthError);
      expect((err as DeviceAuthError).code).toBe('expired_token');
    }
  });

  it('throws slow_down', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'slow_down' } }]);

    try {
      await requestDeviceToken('https://api.cube.exchange/ir/v0', { deviceCode: 'abc' }, fetchFn);
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
      { deviceCode: 'abc123' },
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
      interval: 0, // no delay for tests
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
      interval: 0,
      expiresIn: 60,
      fetchFn,
    });

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    // The second call should have been delayed longer (interval went from 0 to 5)
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
        interval: 0,
        expiresIn: 60,
        fetchFn,
      }),
    ).rejects.toThrow(DeviceAuthError);

    // Should have stopped after access_denied (2 calls total)
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws on expired_token without retrying', async () => {
    const fetchFn = mockFetch([
      { status: 400, body: { error: 'expired_token' } },
    ]);

    await expect(
      pollForToken({
        apiBase: 'https://api.cube.exchange/ir/v0',
        deviceCode: 'abc123',
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
        interval: 0,
        expiresIn: 60,
        fetchFn,
        signal: controller.signal,
      }),
    ).rejects.toThrow('aborted');

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws expired_token when deadline exceeded', async () => {
    // expiresIn: 0 means immediate expiry
    const fetchFn = mockFetch([
      { status: 400, body: { error: 'authorization_pending' } },
    ]);

    await expect(
      pollForToken({
        apiBase: 'https://api.cube.exchange/ir/v0',
        deviceCode: 'abc123',
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

  afterEach(() => {
    server?.close();
    server = null;
  });

  it('starts and returns a valid port and URL', async () => {
    server = await startCallbackServer(19876);
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://localhost:${server.port}/callback`);
  });

  it('serves connected HTML on /callback with token', async () => {
    server = await startCallbackServer(19877);

    const res = await fetch(`http://127.0.0.1:${server.port}/callback?token=test-jwt-token`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toBe(CONNECTED_HTML);
    expect(html).toContain('Connected');
    expect(html).toContain('You can close this tab');
  });

  it('resolves waitForCallback with the token', async () => {
    server = await startCallbackServer(19878);

    const tokenPromise = server.waitForCallback();
    await fetch(`http://127.0.0.1:${server.port}/callback?token=my-secret-token`).catch(() => { });

    const token = await tokenPromise;
    expect(token).toBe('my-secret-token');
  });

  it('rejects waitForCallback when no token param', async () => {
    server = await startCallbackServer(19879);

    // Attach rejection handler immediately to prevent unhandled rejection
    const tokenPromise = server.waitForCallback();
    const caughtPromise = tokenPromise.catch((err) => err);

    await fetch(`http://127.0.0.1:${server.port}/callback`).catch(() => { });

    const err = await caughtPromise;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('without token');
  });

  it('returns 404 for non-callback paths', async () => {
    server = await startCallbackServer(19880);

    const res = await fetch(`http://127.0.0.1:${server.port}/other`);
    expect(res.status).toBe(404);
  });

  it('times out waitForCallback when no redirect arrives', async () => {
    server = await startCallbackServer(19882);

    const result = server.waitForCallback(100).catch((err) => err); // 100ms timeout
    const err = await result;
    expect(err).toBeInstanceOf(DeviceAuthError);
    expect((err as DeviceAuthError).code).toBe('callback_timeout');
  });

  it('retries on port conflict', async () => {
    const server1 = await startCallbackServer(19881);
    const usedPort = server1.port;

    try {
      server = await startCallbackServer(usedPort, 3);
      expect(server.port).toBe(usedPort + 1);
    } finally {
      server1.close();
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
  // Mock saveCredentials to avoid touching filesystem
  vi.mock('../src/client/signing.js', async (importOriginal) => {
    const actual = await importOriginal() as Record<string, unknown>;
    return {
      ...actual,
      saveCredentials: vi.fn().mockResolvedValue(undefined),
    };
  });

  it('interactive flow: generates key, starts server, opens browser, exchanges token', async () => {
    const browserUrls: string[] = [];
    const logs: string[] = [];

    let callbackPort = 0;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        const body = JSON.parse(init?.body as string);
        callbackPort = parseInt(new URL(body.callbackUrl).port, 10);

        return mockResponse(200, {
          ...MOCK_DEVICE_CODE_RESPONSE,
          authorizeUrl: `https://cube.exchange/agent/authorize?code=test`,
        });
      }

      if (urlStr.includes('/agent/device/token')) {
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }

      return mockResponse(404, {});
    });

    const openBrowser = vi.fn(async (url: string) => {
      browserUrls.push(url);
      // Simulate the browser redirect after a short delay
      setTimeout(async () => {
        try {
          await fetch(`http://127.0.0.1:${callbackPort}/callback?token=test-callback-token`);
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
      log: (msg) => logs.push(msg),
      fetch: fetchFn as typeof globalThis.fetch,
    });

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(result.subaccountId).toBe(1);
    expect(result.expiresAt).toBe(MOCK_TOKEN_RESPONSE.expiresAt);
    expect(result.keyPair.publicKey.length).toBe(32);
    expect(result.verificationKeyBase64).toBeTruthy();

    expect(openBrowser).toHaveBeenCalledOnce();
    expect(browserUrls[0]).toContain('cube.exchange');

    expect(fetchFn).toHaveBeenCalledTimes(2);

    const codeCallBody = getRequestBody(fetchFn);
    expect(codeCallBody.callbackUrl).toContain('localhost');
    expect(codeCallBody.clientName).toBe('AI Fund');
    expect(codeCallBody.verificationKey).toBeTruthy();

    const tokenCallBody = getRequestBody(fetchFn, 1);
    expect(tokenCallBody.deviceCode).toBe(MOCK_DEVICE_CODE_RESPONSE.deviceCode);
    expect(tokenCallBody.callbackToken).toBe('test-callback-token');

    expect(logs.some(l => l.includes('Generating'))).toBe(true);
    expect(logs.some(l => l.includes('Successfully logged in'))).toBe(true);
  });

  it('headless flow: generates key, prints URL, polls until approved', async () => {
    const logs: string[] = [];
    const onPending = vi.fn();

    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }

      if (urlStr.includes('/agent/device/token')) {
        // First call: pending. Second call: approved.
        if (fetchFn.mock.calls.filter((c: unknown[]) => (c[0] as string).includes('/agent/device/token')).length <= 1) {
          return mockResponse(400, { error: 'authorization_pending' });
        }
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }

      return mockResponse(404, {});
    });

    // Suppress stdout.write in polling
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const result = await deviceAuthFlow({
      apiBase: 'https://api.cube.exchange/ir/v0',
      clientName: 'AI Fund',
      headless: true,
      openBrowser: vi.fn(),
      log: (msg) => logs.push(msg),
      fetch: fetchFn as typeof globalThis.fetch,
    });

    stdoutSpy.mockRestore();

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);

    // Verify no callbackUrl in device code request
    const codeCallBody = getRequestBody(fetchFn);
    expect(codeCallBody.callbackUrl).toBeUndefined();

    // Verify URL was printed
    expect(logs.some(l => l.includes('Open this URL'))).toBe(true);
    expect(logs.some(l => l.includes(MOCK_HEADLESS_CODE_RESPONSE.authorizeUrl))).toBe(true);
  });

  it('falls back to headless when callback server fails', async () => {
    const logs: string[] = [];

    // Token poll responses: pending, then approved
    let tokenCalls = 0;
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }

      if (urlStr.includes('/agent/device/token')) {
        tokenCalls++;
        if (tokenCalls <= 1) {
          return mockResponse(400, { error: 'authorization_pending' });
        }
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }

      return mockResponse(404, {});
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    // Use an invalid port range to force server failure -> headless fallback
    const result = await deviceAuthFlow({
      apiBase: 'https://api.cube.exchange/ir/v0',
      clientName: 'AI Fund',
      headless: false,
      callbackPort: -1, // will fail to bind
      callbackPortRetries: 0,
      openBrowser: vi.fn(),
      log: (msg) => logs.push(msg),
      fetch: fetchFn as typeof globalThis.fetch,
    });

    stdoutSpy.mockRestore();

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(logs.some(l => l.includes('falling back to headless'))).toBe(true);
  });

  it('handles browser open failure gracefully', async () => {
    const logs: string[] = [];

    let callbackPort = 0;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.includes('/agent/device/code')) {
        const body = JSON.parse(init?.body as string);
        callbackPort = parseInt(new URL(body.callbackUrl).port, 10);

        // Simulate manual browser redirect after delay
        setTimeout(async () => {
          try {
            await fetch(`http://127.0.0.1:${callbackPort}/callback?token=manual-token`);
          } catch { /* ignore */ }
        }, 100);

        return mockResponse(200, MOCK_DEVICE_CODE_RESPONSE);
      }

      if (urlStr.includes('/agent/device/token')) {
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
      log: (msg) => logs.push(msg),
      fetch: fetchFn as typeof globalThis.fetch,
    });

    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
    expect(logs.some(l => l.includes('Browser failed to open'))).toBe(true);
    expect(logs.some(l => l.includes('open this URL manually'))).toBe(true);
  });

  it('falls back to headless when all ports exhausted', async () => {
    const logs: string[] = [];

    // Occupy a port range
    const blockers = await Promise.all([
      startCallbackServer(19893),
      startCallbackServer(19894),
    ]);

    let tokenCalls = 0;
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.includes('/agent/device/code')) {
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }
      if (urlStr.includes('/agent/device/token')) {
        tokenCalls++;
        if (tokenCalls <= 1) {
          return mockResponse(400, { error: 'authorization_pending' });
        }
        return mockResponse(200, MOCK_TOKEN_RESPONSE);
      }
      return mockResponse(404, {});
    });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      const result = await deviceAuthFlow({
        apiBase: 'https://api.cube.exchange/ir/v0',
        clientName: 'Test',
        headless: false,
        callbackPort: 19893, // occupied
        callbackPortRetries: 1, // only try 19893 and 19894 — both occupied
        openBrowser: vi.fn(),
        log: (msg) => logs.push(msg),
        fetch: fetchFn as typeof globalThis.fetch,
      });

      expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);
      expect(logs.some(l => l.includes('falling back to headless'))).toBe(true);
    } finally {
      blockers.forEach(b => b.close());
      stdoutSpy.mockRestore();
    }
  });

  it('propagates device code request errors', async () => {
    const fetchFn = mockFetch([{ status: 400, body: { error: 'invalid_verification_key' } }]);

    await expect(
      deviceAuthFlow({
        apiBase: 'https://api.cube.exchange/ir/v0',
        clientName: 'Test',
        headless: true,
        openBrowser: vi.fn(),
        log: vi.fn(),
        fetch: fetchFn,
      }),
    ).rejects.toThrow(DeviceAuthError);
  });

  it('propagates access_denied from polling', async () => {
    const fetchFn = vi.fn(async (url: string, _init?: RequestInit) => {
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
        log: vi.fn(),
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
        return mockResponse(200, MOCK_HEADLESS_CODE_RESPONSE);
      }

      if (urlStr.includes('/agent/device/token')) {
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
      log: vi.fn(),
      fetch: fetchFn as typeof globalThis.fetch,
      existingKeyPair,
    });

    stdoutSpy.mockRestore();

    // The returned keypair should be the same object we passed in
    expect(result.keyPair).toBe(existingKeyPair);
    expect(Buffer.from(result.keyPair.publicKey).toString('hex')).toBe(existingPubHex);
    expect(result.verificationKeyId).toBe(MOCK_TOKEN_RESPONSE.verificationKeyId);

    // The verification key in the device code request should use the existing public key
    const codeCallBody = getRequestBody(fetchFn);
    expect(codeCallBody.verificationKey).toBeTruthy();
    // Decode the base64 verification key and check it contains our public key bytes
    // Protobuf layout: outer(0x0a, len) -> V0(0x0a, len) -> PublicKey(0x12, 0x20, <32 bytes>)
    const vkBytes = Buffer.from(String(codeCallBody.verificationKey), 'base64');
    const pubKeyInVk = vkBytes.subarray(6, 38);
    expect(Buffer.from(existingKeyPair.publicKey).equals(pubKeyInVk)).toBe(true);
  });
});
