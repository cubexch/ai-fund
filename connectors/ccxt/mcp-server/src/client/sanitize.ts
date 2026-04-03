/**
 * Sanitize error messages before returning to users.
 * Strips potential credential leaks from exchange error responses.
 */

const SENSITIVE_PATTERNS = [
  /api[_-]?key[=:]\s*\S+/gi,
  /secret[=:]\s*\S+/gi,
  /password[=:]\s*\S+/gi,
  /passphrase[=:]\s*\S+/gi,
  /bearer\s+\S+/gi,
  /authorization[=:]\s*\S+(\s+\S+)?/gi,
  /token[=:]\s*\S+/gi,
];

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  return sanitized;
}
