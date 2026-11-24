import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SECRET_BYTES = 32;

export class WebhookCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookCryptoError';
  }
}

/** Parse exactly 32 bytes from a hex or standard/base64url encoded master key. */
export function parseWebhookMasterKey(raw: string): Buffer {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length === SECRET_BYTES) return bytes;
  }
  throw new WebhookCryptoError(
    'WEFT_SERVER_WEBHOOK_MASTER_KEY must be a 32-byte key encoded as hex or base64',
  );
}

function aad(webhookId: string, projectId: string, secretVersion: number): Buffer {
  return Buffer.from(`weft-webhook:v1:${webhookId}:${projectId}:${secretVersion}`, 'utf8');
}

export function generateWebhookSecret(): string {
  return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * Encrypts a per-webhook secret. The stored byte layout is nonce || tag ||
 * ciphertext. AAD prevents moving a ciphertext between webhooks/projects or
 * versions. Plaintext never leaves this boundary except the one-time admin reply.
 */
export function encryptWebhookSecret(
  masterKey: Buffer,
  webhookId: string,
  projectId: string,
  secretVersion: number,
  secret: string,
): Buffer {
  if (masterKey.length !== SECRET_BYTES) {
    throw new WebhookCryptoError('webhook master key must be exactly 32 bytes');
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, nonce);
  cipher.setAAD(aad(webhookId, projectId, secretVersion));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptWebhookSecret(
  masterKey: Buffer,
  webhookId: string,
  projectId: string,
  secretVersion: number,
  packed: Buffer | Uint8Array | string,
): Buffer {
  if (masterKey.length !== SECRET_BYTES) {
    throw new WebhookCryptoError('webhook master key must be exactly 32 bytes');
  }
  const bytes = typeof packed === 'string' ? Buffer.from(packed, 'base64') : Buffer.from(packed);
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new WebhookCryptoError('invalid webhook secret ciphertext');
  }
  const nonce = bytes.subarray(0, NONCE_BYTES);
  const tag = bytes.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = bytes.subarray(NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, masterKey, nonce);
    decipher.setAAD(aad(webhookId, projectId, secretVersion));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new WebhookCryptoError('webhook secret authentication failed');
  }
}
