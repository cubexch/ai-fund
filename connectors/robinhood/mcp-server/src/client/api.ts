/**
 * Robinhood REST API client.
 *
 * Thin wrapper around fetch with:
 * - Bearer token auth
 * - Auto-refresh on 401
 * - Rate limit handling (429 → exponential backoff)
 * - Pagination support
 */

import { AuthManager } from './auth.js';

// ── Constants ────────────────────────────────────────────────

const BASE_URL = 'https://api.robinhood.com';

const DEFAULT_HEADERS = {
  'Accept': 'application/json',
  'X-Robinhood-API-Version': '1.431.4',
};

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

// ── Types ────────────────────────────────────────────────────

export interface PaginatedResponse<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}

// ── Client ───────────────────────────────────────────────────

export class RobinhoodClient {
  constructor(private auth: AuthManager) {}

  /**
   * GET request with auth and auto-retry.
   */
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    if (params) {
      const search = new URLSearchParams(params);
      url += (url.includes('?') ? '&' : '?') + search.toString();
    }
    return this.request<T>('GET', url);
  }

  /**
   * POST request with auth and auto-retry.
   */
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    return this.request<T>('POST', url, body);
  }

  /**
   * Fetch all pages of a paginated endpoint.
   */
  async getAll<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
    if (params) {
      const search = new URLSearchParams(params);
      url += (url.includes('?') ? '&' : '?') + search.toString();
    }

    while (url) {
      const page = await this.request<PaginatedResponse<T>>('GET', url);
      results.push(...page.results);
      url = page.next ?? '';
    }

    return results;
  }

  // ── Internal ────────────────────────────────────────────────

  private async request<T>(method: string, url: string, body?: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const token = await this.auth.getAccessToken();

      const res = await fetch(url, {
        method,
        headers: {
          ...DEFAULT_HEADERS,
          'Authorization': `Bearer ${token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      // Handle 401 — refresh and retry
      if (res.status === 401 && attempt < MAX_RETRIES) {
        const refreshed = await this.auth.handleUnauthorized();
        if (refreshed) continue;
      }

      // Handle 429 — rate limited, backoff and retry
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Robinhood API error ${res.status} ${method} ${url}: ${text}`);
      }

      return await res.json() as T;
    }

    throw new Error(`Robinhood API: max retries exceeded for ${method} ${url}`);
  }
}
