/**
 * Shared MCP tool error helpers.
 * Provides type-safe error extraction and consistent error response formatting.
 */

/**
 * Extract a human-readable message from an unknown caught value.
 * Handles Error objects, strings, and arbitrary values without `any` casts.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Build a standard MCP tool error response.
 * Use this in catch blocks instead of inline object construction.
 *
 * @example
 * ```ts
 * try { ... }
 * catch (error) { return toolError(error); }
 * ```
 */
export function toolError(error: unknown, prefix?: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  const msg = errorMessage(error);
  const text = prefix ? `${prefix}: ${msg}` : `Failed: ${msg}`;
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}
