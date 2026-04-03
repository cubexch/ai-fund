import { describe, it, expect } from 'vitest';
import { sanitizeError } from '../src/client/sanitize.js';

describe('sanitizeError', () => {
  it('passes through normal error messages unchanged', () => {
    expect(sanitizeError(new Error('insufficient funds'))).toBe('insufficient funds');
    expect(sanitizeError(new Error('symbol not found'))).toBe('symbol not found');
    expect(sanitizeError(new Error('rate limit exceeded'))).toBe('rate limit exceeded');
  });

  it('redacts api_key in error messages', () => {
    const msg = sanitizeError(new Error('Invalid api_key: abc123def456'));
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('abc123def456');
  });

  it('redacts apiKey= patterns', () => {
    const msg = sanitizeError(new Error('request failed apiKey=sk_live_secret123'));
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('sk_live_secret123');
  });

  it('redacts secret= patterns', () => {
    const msg = sanitizeError(new Error('auth error secret: my-super-secret'));
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('my-super-secret');
  });

  it('redacts password= patterns', () => {
    const msg = sanitizeError(new Error('login failed password=hunter2'));
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('hunter2');
  });

  it('redacts passphrase= patterns', () => {
    const msg = sanitizeError(new Error('bad passphrase: my-pass-phrase'));
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('my-pass-phrase');
  });

  it('redacts bearer tokens', () => {
    const msg = sanitizeError(new Error('header: Bearer eyJhbGciOi...'));
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('eyJhbGciOi');
  });

  it('redacts authorization headers', () => {
    const msg = sanitizeError(new Error('authorization: Basic dXNlcjpwYXNz'));
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('dXNlcjpwYXNz');
  });

  it('redacts token= patterns', () => {
    const msg = sanitizeError(new Error('token=tok_abc123 expired'));
    expect(msg).toContain('[REDACTED]');
    expect(msg).not.toContain('tok_abc123');
  });

  it('handles multiple sensitive values in one message', () => {
    const msg = sanitizeError(new Error('apiKey=key123 secret=sec456'));
    expect(msg).not.toContain('key123');
    expect(msg).not.toContain('sec456');
    expect(msg.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('handles non-Error input', () => {
    expect(sanitizeError('string error')).toBe('string error');
    expect(sanitizeError(42)).toBe('42');
    expect(sanitizeError(null)).toBe('null');
    expect(sanitizeError(undefined)).toBe('undefined');
  });

  it('is case-insensitive', () => {
    const msg = sanitizeError(new Error('API_KEY=abc SECRET=def'));
    expect(msg).not.toContain('abc');
    expect(msg).not.toContain('def');
  });
});
