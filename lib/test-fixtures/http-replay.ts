/**
 * Lightweight HTTP record/replay for integration tests.
 *
 * Records real API responses to JSON cassette files on first run,
 * then replays them on subsequent runs (no network needed).
 *
 * Usage:
 *   import { withCassette } from '@ai-fund/lib/test-fixtures/http-replay';
 *
 *   // First run (RECORD=1): hits real API, saves to cassettes/my-test.json
 *   // Subsequent runs: replays from cassette
 *   describe('my integration test', () => {
 *     const replay = withCassette('my-test', __dirname);
 *
 *     beforeAll(() => replay.start());
 *     afterAll(() => replay.stop());
 *
 *     it('fetches ticker', async () => {
 *       const res = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
 *       expect(res.ok).toBe(true);
 *     });
 *   });
 *
 * Environment:
 *   RECORD=1  — hit real APIs and save responses to cassette files
 *   (default) — replay from existing cassettes, fail if cassette missing
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────

interface CassetteEntry {
  request: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
  };
  timestamp: string;
}

interface Cassette {
  name: string;
  recordedAt: string;
  entries: CassetteEntry[];
}

// ── Replay Controller ────────────────────────────────────────

export interface ReplayController {
  /** Start intercepting fetch. Call in beforeAll/beforeEach. */
  start(): void;
  /** Stop intercepting, save cassette if recording. Call in afterAll/afterEach. */
  stop(): void;
  /** Whether we're in record mode. */
  isRecording: boolean;
}

/**
 * Create a record/replay controller for a named cassette.
 *
 * @param name    Cassette name (used as filename: `<name>.cassette.json`)
 * @param baseDir Directory to store cassette files (typically `__dirname`)
 */
export function withCassette(name: string, baseDir: string): ReplayController {
  const cassettesDir = join(baseDir, '__cassettes__');
  const cassetteFile = join(cassettesDir, `${name}.cassette.json`);
  const isRecording = process.env.RECORD === '1';

  let originalFetch: typeof globalThis.fetch;
  let entries: CassetteEntry[] = [];
  let replayIndex = 0;

  return {
    isRecording,

    start() {
      originalFetch = globalThis.fetch;
      entries = [];
      replayIndex = 0;

      if (isRecording) {
        // Record mode: pass through to real fetch, capture responses
        globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
          const method = init?.method ?? 'GET';
          const body = init?.body ? String(init.body) : undefined;

          const realResponse = await originalFetch(input, init);

          // Clone so the caller can still consume the body
          const clone = realResponse.clone();
          const responseBody = await clone.text();
          const responseHeaders: Record<string, string> = {};
          clone.headers.forEach((v, k) => { responseHeaders[k] = v; });

          entries.push({
            request: { url, method, body },
            response: {
              status: realResponse.status,
              statusText: realResponse.statusText,
              headers: responseHeaders,
              body: responseBody,
            },
            timestamp: new Date().toISOString(),
          });

          return realResponse;
        };
      } else {
        // Replay mode: return canned responses from cassette
        if (!existsSync(cassetteFile)) {
          throw new Error(
            `Cassette not found: ${cassetteFile}\n` +
            `Run with RECORD=1 to record API responses first.`
          );
        }

        const cassette: Cassette = JSON.parse(readFileSync(cassetteFile, 'utf-8'));
        entries = cassette.entries;

        globalThis.fetch = async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

          if (replayIndex >= entries.length) {
            throw new Error(
              `Cassette "${name}" exhausted — ${entries.length} entries recorded but got request #${replayIndex + 1} to ${url}\n` +
              `Re-record with RECORD=1 if the API calls have changed.`
            );
          }

          const entry = entries[replayIndex++];

          // Warn on URL mismatch (don't fail — order may differ slightly)
          if (entry.request.url !== url) {
            process.stderr.write(
              `[http-replay] Warning: expected ${entry.request.url} but got ${url} (entry ${replayIndex})\n`
            );
          }

          return new Response(entry.response.body, {
            status: entry.response.status,
            statusText: entry.response.statusText,
            headers: entry.response.headers,
          });
        };
      }
    },

    stop() {
      globalThis.fetch = originalFetch;

      if (isRecording && entries.length > 0) {
        if (!existsSync(cassettesDir)) {
          mkdirSync(cassettesDir, { recursive: true });
        }

        const cassette: Cassette = {
          name,
          recordedAt: new Date().toISOString(),
          entries,
        };

        writeFileSync(cassetteFile, JSON.stringify(cassette, null, 2));
        process.stderr.write(`[http-replay] Saved ${entries.length} entries to ${cassetteFile}\n`);
      }
    },
  };
}

/**
 * Convenience: create a cassette controller scoped to a specific test file.
 * Automatically derives cassette dir from the calling test file.
 */
export function cassette(name: string): ReplayController {
  // Use cwd-relative cassettes dir as fallback
  return withCassette(name, join(process.cwd(), 'tests'));
}
