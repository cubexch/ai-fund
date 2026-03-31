import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Credentials Path ──────────────────────────────────────

const CREDENTIALS_DIR = join(homedir(), '.cube');
const CREDENTIALS_PATH = join(CREDENTIALS_DIR, 'credentials.json');

export { CREDENTIALS_PATH };

// ── Ed25519 Key Management ────────────────────────────────

export interface Ed25519KeyPair {
  publicKey: Uint8Array;   // 32 bytes raw
  privateKey: CryptoKey;   // CryptoKey for signing
  privateKeyRaw: Uint8Array; // 32 bytes raw (for storage)
}

/**
 * Generate an Ed25519 keypair using Web Crypto API (Node 20+).
 */
export async function generateKeyPair(): Promise<Ed25519KeyPair> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };

  // Export raw keys
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
  const privateKeyPkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  // PKCS8 for Ed25519 is 48 bytes: 16-byte header + 32-byte seed
  const privateKeySeed = privateKeyPkcs8.slice(16, 48);

  return {
    publicKey: publicKeyRaw,
    privateKey: keyPair.privateKey,
    privateKeyRaw: privateKeySeed,
  };
}

/**
 * Import an Ed25519 private key from raw 32-byte seed.
 */
export async function importPrivateKey(seed: Uint8Array): Promise<CryptoKey> {
  // Rebuild PKCS8 wrapper: fixed 16-byte header + 32-byte seed
  const pkcs8 = new Uint8Array(48);
  // Ed25519 PKCS8 header
  pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  pkcs8.set(seed, 16);
  return crypto.subtle.importKey('pkcs8', pkcs8.buffer.slice(0) as ArrayBuffer, 'Ed25519', false, ['sign']);
}

/**
 * Sign a message with an Ed25519 private key.
 */
export async function signMessage(message: Uint8Array, privateKey: CryptoKey): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signature = await crypto.subtle.sign('Ed25519', privateKey, message as any);
  return new Uint8Array(signature);
}

// ── VerificationKey Protobuf Encoding ─────────────────────
//
// Wire format (confirmed by decoding existing keys from Cube API):
//   VerificationKey {
//     v0 (field 1): VerificationKeyV0 {
//       publicKey (field 1): PublicKey {
//         curve25519 (field 2): bytes  // 32-byte Ed25519 public key
//       }
//       expiresAt (field 2): uint64    // Unix timestamp
//     }
//   }
//
// Protobuf wire:
//   0x0a <len>           // field 1, length-delimited (VerificationKeyV0)
//     0x0a <len>         // field 1, length-delimited (PublicKey)
//       0x12 0x20 <32b>  // field 2, length-delimited, 32 bytes (curve25519)
//     0x10 <varint>      // field 2, varint (expiresAt)

/**
 * Encode a varint (protobuf unsigned integer encoding).
 */
function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = [];
  let v = value >>> 0; // Ensure unsigned 32-bit
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return new Uint8Array(bytes);
}

/**
 * Encode a 64-bit varint for larger timestamps.
 */
function encodeVarint64(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let v = value;
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v & 0x7fn));
  return new Uint8Array(bytes);
}

/**
 * Encode a VerificationKey protobuf for Cube's key registration.
 *
 * @param publicKey - 32-byte Ed25519 public key
 * @param expiresAt - Unix timestamp (seconds) when the key expires
 * @returns Encoded protobuf bytes
 */
export function encodeVerificationKey(publicKey: Uint8Array, expiresAt: number): Uint8Array {
  if (publicKey.length !== 32) {
    throw new Error(`Expected 32-byte public key, got ${publicKey.length}`);
  }

  // PublicKey message: field 2 (curve25519) = 0x12 0x20 <32 bytes>
  const publicKeyMsg = new Uint8Array(2 + 32);
  publicKeyMsg[0] = 0x12; // field 2, length-delimited
  publicKeyMsg[1] = 0x20; // length = 32
  publicKeyMsg.set(publicKey, 2);

  // expiresAt varint
  const expiresAtVarint = expiresAt > 0xffffffff
    ? encodeVarint64(BigInt(expiresAt))
    : encodeVarint(expiresAt);

  // VerificationKeyV0: field 1 (publicKey) + field 2 (expiresAt)
  // 2 bytes (tag+len for publicKey wrapper) + publicKeyMsg + 1 byte (expiresAt tag) + varint
  const v0InnerLen = 2 + publicKeyMsg.length + 1 + expiresAtVarint.length;
  const v0Inner = new Uint8Array(v0InnerLen);
  let offset = 0;
  // field 1 = PublicKey (length-delimited)
  v0Inner[offset++] = 0x0a; // field 1, length-delimited
  v0Inner[offset++] = publicKeyMsg.length;
  v0Inner.set(publicKeyMsg, offset);
  offset += publicKeyMsg.length;
  // field 2 = expiresAt (varint)
  v0Inner[offset++] = 0x10; // field 2, varint
  v0Inner.set(expiresAtVarint, offset);

  // VerificationKey: field 1 (v0) = length-delimited
  const vkLen = 2 + v0Inner.length; // tag + length byte + v0Inner
  const vk = new Uint8Array(vkLen);
  vk[0] = 0x0a; // field 1, length-delimited
  vk[1] = v0Inner.length;
  vk.set(v0Inner, 2);

  return vk;
}

/**
 * Decode the expiresAt from an encoded VerificationKey protobuf.
 * Useful for verifying our encoding matches existing keys.
 */
export function decodeVerificationKeyExpiresAt(bytes: Uint8Array): number {
  // Navigate: outer field 1 → inner field 2
  let pos = 0;
  // Outer: 0x0a <len>
  if (bytes[pos++] !== 0x0a) throw new Error('Invalid VerificationKey: expected field 1');
  const outerLen = bytes[pos++];
  // Inner VerificationKeyV0
  const innerStart = pos;
  // field 1 (PublicKey): 0x0a <len> ... skip
  if (bytes[pos++] !== 0x0a) throw new Error('Invalid V0: expected field 1');
  const pkLen = bytes[pos++];
  pos += pkLen;
  // field 2 (expiresAt): 0x10 <varint>
  if (bytes[pos++] !== 0x10) throw new Error('Invalid V0: expected field 2');
  // Decode varint
  let result = 0n;
  let shift = 0n;
  while (pos < bytes.length) {
    const b = bytes[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return Number(result);
}

// ── Credential Storage ────────────────────────────────────

export interface SigningCredentials {
  ed25519PrivateKey: string;   // hex-encoded 32-byte seed
  ed25519PublicKey: string;    // hex-encoded 32-byte public key
  verificationKey: string;     // base64-encoded protobuf
  verificationKeyId?: string;  // UUID from API (once registered)
  expiresAt: number;           // Unix timestamp
  createdAt: number;           // Unix timestamp
  provider: string;            // 'google' | 'apple' | 'telegram' | 'device'
}

/**
 * Load signing credentials from ~/.cube/credentials.json.
 * Returns null if file doesn't exist or credentials are expired.
 */
export async function loadCredentials(): Promise<SigningCredentials | null> {
  try {
    const data = await readFile(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(data) as SigningCredentials;

    // Check expiry (with 5 min buffer)
    if (creds.expiresAt && creds.expiresAt < Math.floor(Date.now() / 1000) + 300) {
      return null; // Expired or about to expire
    }

    return creds;
  } catch {
    return null;
  }
}

/**
 * Save signing credentials to ~/.cube/credentials.json with restricted permissions.
 */
export async function saveCredentials(creds: SigningCredentials): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true });
  await writeFile(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

// ── Helpers ───────────────────────────────────────────────

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
