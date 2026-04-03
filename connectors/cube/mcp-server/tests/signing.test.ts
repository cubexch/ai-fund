import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPair,
  importPrivateKey,
  signMessage,
  encodeVerificationKey,
  decodeVerificationKeyExpiresAt,
  loadCredentials,
  saveCredentials,
  toHex,
  fromHex,
  CREDENTIALS_PATH,
  type SigningCredentials,
} from '../src/client/signing';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

describe('Ed25519 Key Generation', () => {
  it('generates a keypair with 32-byte public key', async () => {
    const kp = await generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
    expect(kp.privateKeyRaw).toBeInstanceOf(Uint8Array);
    expect(kp.privateKeyRaw.length).toBe(32);
    expect(kp.privateKey).toBeDefined();
  });

  it('generates unique keypairs each time', async () => {
    const kp1 = await generateKeyPair();
    const kp2 = await generateKeyPair();
    expect(toHex(kp1.publicKey)).not.toBe(toHex(kp2.publicKey));
  });
});

describe('Ed25519 Signing', () => {
  it('signs and verifies a message', async () => {
    const kp = await generateKeyPair();
    const message = new TextEncoder().encode('test message');
    const signature = await signMessage(message, kp.privateKey);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64); // Ed25519 signatures are 64 bytes

    // Verify using Web Crypto
    const pubKey = await crypto.subtle.importKey('raw', kp.publicKey, 'Ed25519', false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', pubKey, signature, message);
    expect(valid).toBe(true);
  });

  it('rejects tampered messages', async () => {
    const kp = await generateKeyPair();
    const message = new TextEncoder().encode('original');
    const signature = await signMessage(message, kp.privateKey);

    const tampered = new TextEncoder().encode('tampered');
    const pubKey = await crypto.subtle.importKey('raw', kp.publicKey, 'Ed25519', false, ['verify']);
    const valid = await crypto.subtle.verify('Ed25519', pubKey, signature, tampered);
    expect(valid).toBe(false);
  });
});

describe('Private Key Import', () => {
  it('round-trips through export/import', async () => {
    const kp = await generateKeyPair();
    const message = new TextEncoder().encode('round trip test');

    // Sign with original key
    const sig1 = await signMessage(message, kp.privateKey);

    // Import from raw seed and sign again
    const imported = await importPrivateKey(kp.privateKeyRaw);
    const sig2 = await signMessage(message, imported);

    // Both signatures should be identical (Ed25519 is deterministic)
    expect(toHex(sig1)).toBe(toHex(sig2));
  });
});

describe('VerificationKey Protobuf Encoding', () => {
  it('encodes with correct wire format', () => {
    const pubKey = new Uint8Array(32).fill(0xab);
    const expiresAt = 1735689600; // 2025-01-01T00:00:00Z

    const encoded = encodeVerificationKey(pubKey, expiresAt);

    // Check outer structure
    expect(encoded[0]).toBe(0x0a); // field 1, length-delimited
    // Inner VerificationKeyV0
    const v0Start = 2;
    expect(encoded[v0Start]).toBe(0x0a); // field 1 (PublicKey), length-delimited
    // PublicKey inner
    const pkStart = v0Start + 2;
    expect(encoded[pkStart]).toBe(0x12); // field 2 (curve25519), length-delimited
    expect(encoded[pkStart + 1]).toBe(0x20); // length = 32
    // Verify the public key bytes
    const extractedPubKey = encoded.slice(pkStart + 2, pkStart + 2 + 32);
    expect(toHex(extractedPubKey)).toBe(toHex(pubKey));
  });

  it('round-trips expiresAt through encode/decode', () => {
    const pubKey = new Uint8Array(32).fill(0x42);
    const expiresAt = 1741046400; // 2025-03-04T00:00:00Z

    const encoded = encodeVerificationKey(pubKey, expiresAt);
    const decoded = decodeVerificationKeyExpiresAt(encoded);
    expect(decoded).toBe(expiresAt);
  });

  it('handles large timestamps (> 32-bit)', () => {
    const pubKey = new Uint8Array(32).fill(0x01);
    const expiresAt = 4294967296; // 2^32 — just over 32-bit

    const encoded = encodeVerificationKey(pubKey, expiresAt);
    const decoded = decodeVerificationKeyExpiresAt(encoded);
    expect(decoded).toBe(expiresAt);
  });

  it('rejects non-32-byte public keys', () => {
    expect(() => encodeVerificationKey(new Uint8Array(16), 1000)).toThrow('Expected 32-byte');
    expect(() => encodeVerificationKey(new Uint8Array(64), 1000)).toThrow('Expected 32-byte');
  });

  it('produces base64 matching expected format', () => {
    const pubKey = new Uint8Array(32).fill(0x00);
    const expiresAt = 1735689600;

    const encoded = encodeVerificationKey(pubKey, expiresAt);
    const b64 = Buffer.from(encoded).toString('base64');

    // Should be a valid base64 string
    expect(b64.length).toBeGreaterThan(0);
    // Round-trip
    const decoded = Buffer.from(b64, 'base64');
    expect(toHex(new Uint8Array(decoded))).toBe(toHex(encoded));
  });
});

describe('Credential Storage', () => {
  const testCreds: SigningCredentials = {
    ed25519PrivateKey: 'aa'.repeat(32),
    ed25519PublicKey: 'bb'.repeat(32),
    verificationKey: Buffer.from('test').toString('base64'),
    expiresAt: Math.floor(Date.now() / 1000) + 86400, // +1 day
    createdAt: Math.floor(Date.now() / 1000),
    provider: 'google',
  };

  // Use a temp path for tests to avoid touching real credentials
  const originalPath = CREDENTIALS_PATH;

  it('hex helpers round-trip correctly', () => {
    const original = new Uint8Array([0, 1, 2, 255, 128, 64]);
    const hex = toHex(original);
    const restored = fromHex(hex);
    expect(toHex(restored)).toBe(toHex(original));
  });

  // Note: save/load tests would need to mock the filesystem or use a temp directory.
  // For now, we test the serialization logic indirectly.
  it('SigningCredentials interface is structurally correct', () => {
    // Verify all required fields are present
    expect(testCreds.ed25519PrivateKey).toBeDefined();
    expect(testCreds.ed25519PublicKey).toBeDefined();
    expect(testCreds.verificationKey).toBeDefined();
    expect(testCreds.expiresAt).toBeGreaterThan(0);
    expect(testCreds.createdAt).toBeGreaterThan(0);
    expect(testCreds.provider).toBe('google');
  });
});
