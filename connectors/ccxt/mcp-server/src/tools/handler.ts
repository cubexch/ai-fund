/**
 * Shared tool handler wrapper — eliminates try/catch/sanitize/response
 * boilerplate from every tool registration.
 */

import type { ExchangeClient } from '../client/exchange.js';
import { sanitizeError } from '../client/sanitize.js';

type ToolResult = {
  [x: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

type ToolHandler<T> = (params: T) => Promise<unknown>;

/**
 * Wraps a tool handler with:
 *  - JSON serialization of the return value
 *  - Error catch + sanitization
 *  - Consistent MCP response shape
 */
export function handler<T = Record<string, unknown>>(
  fn: ToolHandler<T>,
): (params: T) => Promise<ToolResult> {
  return async (params: T) => {
    try {
      const result = await fn(params);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text' as const, text: `Failed: ${sanitizeError(error)}` }],
        isError: true,
      };
    }
  };
}

/**
 * Like `handler`, but gates on credentials first.
 * Returns a structured auth error without calling the handler.
 */
export function authHandler<T = Record<string, unknown>>(
  client: ExchangeClient,
  fn: ToolHandler<T>,
): (params: T) => Promise<ToolResult> {
  return handler<T>(async (params: T) => {
    if (!client.hasCredentials) {
      throw new AuthRequiredError();
    }
    return fn(params);
  });
}

class AuthRequiredError extends Error {
  constructor() {
    super('No API credentials configured. Set API key and secret, or run `login`.');
  }
}
