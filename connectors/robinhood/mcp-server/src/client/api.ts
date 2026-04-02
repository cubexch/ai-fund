/**
 * Robinhood API client — auth scaffolding only.
 *
 * All unofficial stock/crypto endpoints have been removed.
 * This file preserves the base client infrastructure (auth, retry, pagination)
 * for future use with the official crypto API at docs.robinhood.com/crypto/trading.
 */

import { AuthManager } from './auth.js';
import { httpRequest } from './http.js';

// ── Constants ────────────────────────────────────────────────

const BASE_URL = 'https://api.robinhood.com';

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;

// ── Pagination ──────────────────────────────────────────────

export interface PaginatedResponse<T> {
  next: string | null;
  previous: string | null;
  results: T[];
}

// ── Client ──────────────────────────────────────────────────

export class RobinhoodClient {
  constructor(private auth: AuthManager) {}

  /**
   * Authenticated GET request with auto-refresh on 401 and backoff on 429.
   */
  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', path, undefined, params);
  }

  /**
   * Authenticated POST request.
   */
  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /**
   * Paginated GET — follows `next` links to collect all results.
   */
  async getAll<T>(path: string, params?: Record<string, string>): Promise<T[]> {
    const results: T[] = [];
    let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }

    while (url) {
      const page = await this.request<PaginatedResponse<T>>('GET', url);
      results.push(...page.results);
      url = page.next ?? '';
    }

    return results;
  }

  // ── Internal ────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string>,
  ): Promise<T> {
    let url = path.startsWith('http') ? path : `${BASE_URL}${path}`;

    if (params) {
      const qs = new URLSearchParams(params).toString();
      url += (url.includes('?') ? '&' : '?') + qs;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const token = await this.auth.getAccessToken();
      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      };

      const options: Record<string, unknown> = { method, headers };
      if (body) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
      }

      const res = await httpRequest(url, options as any);
      const text = await res.text();

      // Auto-refresh on 401 — getAccessToken() handles refresh internally
      if (res.status === 401 && attempt < MAX_RETRIES) {
        continue;
      }

      // Exponential backoff on 429
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const delay = BACKOFF_BASE_MS * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      if (res.status >= 400) {
        throw new Error(`Robinhood API error (${res.status}): ${text}`);
      }

      return JSON.parse(text) as T;
    }

    throw new Error('Max retries exceeded');
  }
}
